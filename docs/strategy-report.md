# Strategy & Options Report — Production task-sync

This report records the architecture and synchronization decisions for the
**production** `task-sync` service: a Node.js/TypeScript background daemon that
syncs Obsidian **Tasks**-plugin markdown tasks bidirectionally with multiple
external task managers, including multi-target fan-out from one vault task to
several backends.

It updates the earlier prototype decision record for the production codebase.
The still-valid research foundation remains in [`docs/research/`](./research/),
with primary-source notes for Microsoft Graph To Do, Obsidian Tasks format, and
Morgen's Obsidian integration:

- [`docs/research/research-graph-todo.md`](./research/research-graph-todo.md)
- [`docs/research/research-tasks-format.md`](./research/research-tasks-format.md)
- [`docs/research/research-morgen.md`](./research/research-morgen.md)

Production source references in this document are real files in this repository,
not prototype APIs.

---

## 1. Summary of recommendations

| Question | Recommendation |
|---|---|
| List mapping | **Hybrid** remains the default: prefer an explicit/known `#tag`, fall back to file/folder placement. |
| Correlation-ID persistence | **HTML comment** `<!-- sync-id: … -->` on the task line. Do not reuse the Tasks plugin `🆔` field. |
| Multi-target fan-out | One vault `syncId` may link to multiple external tasks; persisted state is keyed by **`(syncId, backend)`**. |
| Conflict resolution | **Whole-task 3-way detection** using the stored baseline; policies are `vault-wins`, `external-wins`, or `newer`, with per-backend overrides. |
| Microsoft To Do conflict default | **`newer`**: compare vault file mtime to Graph `lastModifiedDateTime`. |
| Supernote conflict default | **`vault-wins`** because the Supernote Private Cloud DB/device sync path is lower-trust and less documented. |
| Field-level merge | **Deferred**. Conflicts resolve at whole-task granularity. |
| Markdown parsing | Use **unified/remark** for document structure and `vault/taskMeta.ts` for pure Tasks/Dataview field grammar. |
| Markdown writing | Minimal-diff, line-based, idempotent, optimistic-concurrency writes through atomic temp+fsync+rename. |
| Backend architecture | Keep the engine coupled only to the generic `SyncAdapter`; use `BackendRegistry` for enabled backend fan-out. |
| Microsoft auth in containers | Device-code flow, MSAL token cache encrypted at rest with AES-256-GCM using `TASK_SYNC_TOKEN_KEY`, stored on a mounted volume. |
| Supernote backend | Bidirectional sync through MariaDB (`t_schedule_task`, `t_schedule_task_group`), but with `vault-wins` default and strict DB safety rules. |
| Reliability | Isolate backend failures, retry transient Graph/DB errors, handle Graph `410 Gone` with full resync, drain/flush on shutdown, debounce and suppress self-writes. |
| Deferred/lossy items | Recurrence, field-level merge, per-list inbox notes, and creating Supernote `links` from vault data remain deferred or lossy. |

---

## 2. List-mapping strategy

**Problem:** each external backend expects a task to live in a concrete list, but
Obsidian tasks may be grouped by tag, file, folder, heading, or convention.

**Options considered**

1. **Tag-based** — a task's `#tag` selects the external list.
   - ✅ Explicit and matches many Obsidian workflows.
   - ❌ Ambiguous with multiple tags; undefined when no tag exists.
2. **File/folder-based** — the note or folder selects the external list.
   - ✅ Always available for file-organized vaults.
   - ❌ Ignores cross-cutting tags; a single note can contain several domains.
3. **Hybrid (chosen)** — prefer configured/usable tags, then fall back to file or
   folder placement.
   - ✅ Works with both tag-oriented and file-oriented vaults.
   - ✅ Ensures every task has an external destination.

Production keeps this strategy. Configuration exposes `listMapping: "tag" |
"file" | "hybrid"` and per-backend `tagListMap` overrides in `src/config.ts`.
Runtime list resolution is called from `src/sync/syncEngine.ts` via
`resolveListKey()` in `src/mapping/listMapping.ts` before fan-out.

**Decision:** default to **hybrid**. Keep list mapping deterministic and
single-list per backend. Multi-list fan-out within a single backend remains a
future option; current fan-out means one vault task can sync to several
**backends**, not several lists within one backend.

---

## 3. Correlation-ID persistence

**Problem:** a markdown task needs a stable local identifier that survives line
moves, note renames, edits, and multi-backend synchronization.

| Option | Markdown noise | Robust to edits/moves | Tool compatibility | Merge-friendly |
|---|---|---|---|---|
| Inline Dataview `[sync-id:: …]` | Visible-ish | High | Good | Good |
| Tasks-plugin `🆔` id | Visible emoji | High | ⚠️ Collides with Tasks dependency/id semantics | Good |
| Block reference `^id` | Low | Medium; must stay line-last | Native Obsidian | Poor |
| Sidecar-only index | None | Poor after edits/moves without heuristics | N/A | N/A |
| **HTML comment `<!-- sync-id: … -->`** | **Invisible in preview** | **High** | **Good** | **Good** |

**Decision:** use the task-line HTML comment form:

```markdown
- [ ] Review quarterly plan 📅 2026-07-01 <!-- sync-id: abc123 -->
```

The writer emits this form through `src/vault/syncId.ts` and
`src/writer/markdownWriter.ts`. The parser reads it through
`src/vault/taskMeta.ts` / `src/vault/syncId.ts` while leaving the Tasks plugin's
own `🆔` field untouched. This deliberately diverges from Morgen's `🆔` reuse,
which is documented in [`research-morgen.md`](./research/research-morgen.md), to
avoid collisions with Tasks-plugin IDs and dependencies.

Production adds **multi-target fan-out**. The vault task has one `syncId`, but
`src/state/stateStore.ts` stores one `ExternalLink` per backend. Links are
indexed as `(syncId, backend)`, so the same markdown task can be correlated with,
for example, both a Microsoft To Do task and a Supernote To Do row.

---

## 4. Conflict resolution

**Model:** production uses whole-task **3-way reconciliation** in
`src/sync/syncEngine.ts` with a stored baseline in `src/state/stateStore.ts`.
The sync-relevant baseline hash is produced by `hashTask()` and intentionally
ignores cosmetic markdown formatting.

For each `(syncId, backend)` link:

- `vaultChanged` = `hash(currentTask) !== link.lastKnownHash`
- `externalChanged` = `external.lastModified !== link.lastExternalModified`

| vaultChanged | externalChanged | Action |
|---|---|---|
| yes | no | Push vault → backend. |
| no | yes | Apply backend → vault. |
| no | no | No-op. |
| yes | yes | Conflict; resolve by policy. |

Policies are defined in `src/config.ts` and implemented in
`src/sync/conflict.ts`:

| Policy | Result |
|---|---|
| `vault-wins` | Always write the vault task outbound. |
| `external-wins` | Prefer inbound external state when available. |
| `newer` | Compare vault file mtime to external `lastModified`; ties go to the vault. |

The global `conflictPolicy` defaults to `newer`, but each backend has its own
policy setting through `backends.<name>.conflictPolicy` in `src/config.ts`.
Production defaults are intentionally asymmetric:

- **Microsoft To Do:** `newer`, because Graph exposes reliable
  `lastModifiedDateTime` and delta semantics.
- **Supernote:** `vault-wins`, because direct MariaDB synchronization is lower
  trust than Graph and Supernote device sync semantics are not as explicit.

**Deferred:** field-level merge is not implemented. A conflict is resolved at
whole-task level even when, for example, only the due date changed externally and
only the title changed in the vault. This is simpler, auditable, and safer for
the first production release.

---

## 5. Status and field mapping

Production keeps the normalized internal task model from the prototype:
`todo`, `in-progress`, `done`, `cancelled`, and `other`, with dates and priority
represented as normalized fields in `src/model/task.ts` and adapter-specific
mapping files.

### Status mapping

| Obsidian checkbox | Normalized | Microsoft To Do | Supernote To Do |
|---|---|---|---|
| `[ ]` | `todo` | `notStarted` | `needsAction` |
| `[/]` | `in-progress` | `inProgress` | `needsAction` |
| `[x]` / `[X]` | `done` | `completed` | `completed` |
| `[-]` | `cancelled` | `notStarted` | `needsAction` |
| custom char | `other` | `notStarted` | `needsAction` |

Microsoft mapping lives in `src/adapters/msTodo/mapping.ts`. Supernote mapping
lives in `src/adapters/supernote/mapping.ts`; Supernote has only
`needsAction` / `completed`, so non-done states are lossy on round trip.

### Field mapping

| Field | Vault representation | Microsoft To Do | Supernote To Do | Notes |
|---|---|---|---|---|
| Title | task description | `title` | `title` | Supernote title is encoded/truncated to DB limits. |
| Due | `📅 YYYY-MM-DD` / Dataview `due` | `dueDateTime` | `due_time` ms | Date granularity. |
| Start | `🛫 YYYY-MM-DD` / Dataview `start` | `startDateTime` | not written by current Supernote columns | Supernote adapter exposes no start column. |
| Done | `✅ YYYY-MM-DD` / Dataview `completion` | `completedDateTime` | `completed_time` ms | Completion status may synthesize done time externally. |
| Priority | Tasks priority emoji / Dataview `priority` | `importance` | `importance` | Microsoft collapses to low/normal/high; Supernote stores numeric strings. |
| Recurrence | `🔁 every …` / Dataview `repeat` | not round-tripped | not round-tripped | Explicitly lossy/deferred. |

Graph field constraints and recurrence behavior are documented in
[`research-graph-todo.md`](./research/research-graph-todo.md). Obsidian Tasks
field grammar and custom status behavior are documented in
[`research-tasks-format.md`](./research/research-tasks-format.md).

---

## 6. Markdown layer

The prototype used a hand-rolled markdown scanner. Production moved to a layered
parser:

1. `src/vault/document.ts` uses **unified/remark** (`remark-parse` +
   `remark-gfm`) to parse markdown structure into mdast.
2. It uses `unist-util-visit` to locate real `listItem` nodes.
3. It checks the source line against the Tasks-compatible checkbox grammar.
4. It delegates inline task metadata parsing to the pure field-grammar layer in
   `src/vault/taskMeta.ts`.

**Why this change matters:** markdown structure is hard to parse correctly with
line regexes alone. The remark layer avoids false positives in fenced/indented
code blocks, handles nested lists through the AST, and keeps custom checkbox
status characters compatible with the Tasks plugin's one-character status model.
The pure `taskMeta.ts` layer then focuses only on task-line metadata: Tasks emoji
fields, Dataview fields, tags, block references, priorities, recurrence text,
and sync-id extraction.

The writer is intentionally not a full markdown reserializer.
`src/writer/markdownWriter.ts` performs **minimal-diff, line-based** edits to
only the task lines being changed. Safety properties:

- **Optimistic concurrency:** each mutation carries the exact `expectedLine` last
  parsed. If the on-disk line changed, the edit is skipped and retried on a
  future reconcile.
- **Idempotence:** applying the same mutation again should not create duplicate
  metadata.
- **Atomic writes:** all file writes route through `src/util/atomicFile.ts`,
  which writes a temporary file in the target directory, fsyncs it, then renames
  over the target.
- **Loop protection:** the engine passes `suppressNext(path)` before self-writes
  so the watcher does not re-trigger an infinite sync loop.

---

## 7. Multi-backend architecture

Production generalizes the prototype's single Microsoft backend into a backend
interface plus registry.

```text
VaultWatcher (debounced, self-write suppression)
      │ changed files
      ▼
SyncEngine (incremental, per-file, 3-way reconcile, multi-target fan-out)
   ├─ vault/         remark parsing + taskMeta field grammar
   ├─ mapping/       tag/file/hybrid list mapping + sync-id generation
   ├─ state/         baseline hashes, ExternalLink per (syncId, backend), delta tokens
   ├─ writer/        minimal-diff optimistic atomic writes
   └─ sync/backendRegistry → SyncAdapter[]
        ├─ adapters/msTodo    → Microsoft Graph + MSAL encrypted token cache
        └─ adapters/supernote → MariaDB t_schedule_task / t_schedule_task_group
```

`src/adapters/types.ts` defines the generic `SyncAdapter` interface:

- backend identity (`backend`),
- lifecycle (`init`, `close`),
- list operations (`listLists`, `ensureList`),
- task CRUD (`listTasks`, `getTask`, `createTask`, `updateTask`, `deleteTask`),
- optional incremental `delta()`.

`src/sync/backendRegistry.ts` builds enabled adapters from validated config and
pairs each one with its conflict policy and tag-list overrides. `SyncEngine`
depends only on `BackendEntry` / `SyncAdapter`; it does not import Graph or
Supernote DB details, except for the Microsoft delta-expiration error type used
to convert Graph `410 Gone` into a full listing fallback.

**Decision:** new backends must implement `SyncAdapter` under
`src/adapters/<name>/`, keep provider field mapping in a pure `mapping.ts`, and
avoid engine-specific coupling.

---

## 8. Supernote To Do backend

Production adds a Supernote Private Cloud backend under
`src/adapters/supernote/`. It synchronizes directly with MariaDB rather than a
public HTTP API.

### Storage model

| Concept | Supernote DB representation | Production handling |
|---|---|---|
| Tasks | `t_schedule_task` | Read/write through `SupernoteDb` in `src/adapters/supernote/db.ts`. |
| Lists | `t_schedule_task_group` | Exposed as external lists. |
| Inbox | `task_list_id IS NULL` | Adapter exposes Inbox as list id `""`; DB uses `NULL`. |
| Active rows | `is_deleted = 'N'` | Always filter active reads by `is_deleted = 'N'`. |
| Deletes | `is_deleted = 'Y'` | Use soft deletes only. |
| Timestamps | Unix epoch milliseconds | Convert to/from ISO dates where needed. |
| IDs | 32-character lowercase hex | Generated from `randomUUID().replace(/-/g, "")`. |
| User scope | `user_id` | All queries and writes are scoped by configured `user_id`. |

### Encoding and limits

Supernote's DB behavior requires special string handling:

- Non-BMP emoji are encoded as `[U+XXXX]` before writes and decoded on reads in
  `src/adapters/supernote/emoji.ts`.
- `title` is capped at `600` characters in `src/adapters/supernote/mapping.ts`.
- The Supernote `detail` column is known to be `varchar(255)`; when detail/body
  support is added, truncate **after** emoji encoding to avoid splitting encoded
  tokens.
- Updates preserve the existing `links` column in `src/adapters/supernote/db.ts`
  so notebook links are not erased by task sync.

### Query and connectivity rules

- Use parameterized mysql2 placeholders only; never concatenate SQL values.
- Connect through Docker networking by default (`supernote-mariadb` container
  hostname in `src/config.ts`), with normal TCP `host:port` fallback via the same
  mysql2 connection path.
- Keep all DB I/O in `SupernoteDb`; keep field conversion in pure mapping code.

### Recommendation

Supernote sync is **bidirectional**, including delta-style polling by
`last_modified` in `SupernoteAdapter.delta()`. However, its default conflict
policy is **`vault-wins`**. The vault remains the safer source of truth when the
same task changes in both places.

Deferred Supernote work:

- creating or updating Supernote `links` from vault note context,
- richer body/detail mapping,
- documenting any vendor schema changes beyond the observed MariaDB tables.

---

## 9. Microsoft To Do backend and auth

Microsoft To Do remains the best-supported external backend because Graph has a
stable documented API, delta queries, delegated OAuth, and explicit
`lastModifiedDateTime` fields.

### API and mapping

`src/adapters/msTodo/graphClient.ts` uses Microsoft Graph v1.0 endpoints under
`/me/todo/lists` and `/me/todo/lists/{listId}/tasks`.
`src/adapters/msTodo/mapping.ts` maps between Graph `todoTask` fields and the
normalized `ExternalTask` model.

Important production behaviors:

- Graph task delta is exposed through `MsTodoAdapter.delta()`.
- Graph `410 Gone` during a delta request becomes `DeltaTokenExpiredError`; the
  engine logs a warning, discards the stale path, and performs a full listing for
  that list.
- Graph `429` and `5xx` responses are retried with exponential backoff and
  `Retry-After` support in `GraphClient`.
- Microsoft `cancelled` has no native To Do status and maps to `notStarted`.
- Recurrence remains lossy: Graph has structured recurrence and To Do creates a
  new task for the next occurrence when a recurring task is completed.

See [`research-graph-todo.md`](./research/research-graph-todo.md) for the
primary-source Graph endpoint, schema, delta, throttling, and recurrence notes.

### Auth and token persistence in containers

Production does **not** rely on an OS keychain, because the intended deployment
is container-friendly. `src/adapters/msTodo/auth.ts` uses MSAL device-code flow
for headless operation. Configuration defaults are in `src/config.ts`:

- authority: `https://login.microsoftonline.com/common`,
- scopes: `Tasks.ReadWrite`, `offline_access`, `User.Read`,
- token cache path: `/data/msal-cache.enc`.

The MSAL token cache is encrypted at rest:

- `src/adapters/msTodo/tokenCache.ts` implements an MSAL cache plugin.
- `src/util/crypto.ts` uses AES-256-GCM with a random 96-bit IV and auth tag.
- The encryption key is parsed from `TASK_SYNC_TOKEN_KEY` / `config.tokenKey` as
  either 32 bytes base64 or 64 hex characters.
- The encrypted cache is written through `atomicWriteFile()` with mode `0o600`,
  suitable for a mounted Docker volume.

MSAL `/common` device-code can fail with `AADSTS90133` for some personal-account
cases. The code surfaces a clear error instructing operators to use the auth-code
+ PKCE fallback for those accounts; the main daemon path remains device-code.

---

## 10. Reliability and daemon behavior

Production hardens the prototype's sync loop for long-running daemon use.

| Reliability concern | Production behavior / recommendation | Source |
|---|---|---|
| One backend fails | Backend exceptions are caught per task/per backend so another backend can continue. | `src/sync/syncEngine.ts` |
| Transient Graph errors | Retry `429` and `5xx` with backoff and `Retry-After`. | `src/adapters/msTodo/graphClient.ts` |
| Expired Graph delta token | Treat `410 Gone` as expired token and fall back to full list resync. | `src/adapters/msTodo/msTodoAdapter.ts`, `src/sync/syncEngine.ts` |
| Transient DB/connectivity errors | `SyncAdapter` requires transient failures to be retried/backed off internally. Graph does this today; Supernote DB failures are isolated and retried by the next scheduled pass, with an internal DB retry wrapper still recommended. | `src/adapters/types.ts`, `src/adapters/msTodo/graphClient.ts`, `src/adapters/supernote/db.ts` |
| Concurrent vault edits | Writer uses exact-line optimistic concurrency and skips stale edits. | `src/writer/markdownWriter.ts` |
| Partial file writes | All persistent writes use temp + fsync + rename. | `src/util/atomicFile.ts` |
| Watcher feedback loops | Self-writes call `suppressNext(path)`. | `src/sync/syncEngine.ts`, `src/writer/markdownWriter.ts` |
| Shutdown | `Service.stop()` clears timers, stops watcher/health, closes adapters, and flushes state. | `src/service.ts`, `src/sync/backendRegistry.ts`, `src/state/stateStore.ts` |

The service should continue to use debounced file watching and periodic/inbound
pulls: local changes are reconciled per changed file, while backend changes are
pulled through `delta()` when available and through listing otherwise.

---

## 11. Deferred and lossy items

These are intentional production boundaries, not accidental omissions.

| Item | Status | Rationale |
|---|---|---|
| Recurrence | Lossy/deferred | Obsidian Tasks recurrence text and Graph `patternedRecurrence` do not round-trip cleanly; To Do recurring completion creates a new task. |
| Field-level merge | Deferred | Whole-task 3-way resolution is simpler and auditable; field merge can be added after conflict telemetry. |
| Per-list inbound inbox notes | Deferred | Production currently appends externally-created tasks to shared `inboundInboxFile` (`Sync Inbox.md` by default). |
| Supernote `links` creation from vault | Deferred | Existing DB `links` are preserved, but sync does not synthesize notebook links from markdown context. |
| Supernote detail/body mapping | Deferred | Title/status/date/priority are implemented; `detail varchar(255)` requires encode-then-truncate behavior before enabling. |
| Custom status fidelity | Lossy externally | Obsidian custom status chars normalize to `other`; Microsoft and Supernote cannot preserve arbitrary checkbox chars. |
| Cancelled status | Lossy externally | Microsoft maps to `notStarted`; Supernote maps to `needsAction`. |

---

## 12. Key production decisions captured

- Keep the vault as portable markdown using existing Tasks emoji/Dataview
  conventions rather than inventing frontmatter or sidecar-only schema.
- Use `<!-- sync-id: … -->` as the correlation marker and never reuse `🆔`.
- Key persistent links by `(syncId, backend)` to support multi-target fan-out.
- Keep markdown parsing structural with unified/remark and field parsing pure in
  `src/vault/taskMeta.ts`.
- Keep writes minimal, optimistic, and atomic; do not reserialize whole notes.
- Keep the sync engine backend-agnostic through `SyncAdapter` and
  `BackendRegistry`.
- Use per-backend conflict defaults: Microsoft `newer`, Supernote `vault-wins`.
- Encrypt container token caches with operator-provided `TASK_SYNC_TOKEN_KEY`;
  do not depend on an OS keychain inside containers.
- Treat Supernote MariaDB as a careful bidirectional backend with strict scoping,
  soft deletes, parameterized queries, emoji encoding, and link preservation.
