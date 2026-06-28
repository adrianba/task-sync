# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this is

A **production** TypeScript/Node background service that syncs Obsidian
**Tasks**-plugin markdown tasks with multiple external task managers,
**bidirectionally** and with **multi-target fan-out** (one task can sync to
several backends at once). Backends shipped:

- **Microsoft To Do** (Microsoft Graph)
- **Supernote To Do** (via the `supernote-task-service` REST API)

Read [`README.md`](README.md) for usage and [`docs/strategy-report.md`](docs/strategy-report.md)
for design rationale.

## Tooling & commands

- Runtime: **Node 24+**, **npm**, ESM (`"type": "module"`), `NodeNext` modules.
- Source is TypeScript under `src/`; tests under `tests/` use **Vitest**.

```bash
npm run typecheck     # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm run lint          # eslint (flat config, type-checked rules)
npm test              # vitest run
npm run build         # tsc → dist/
npx tsx src/index.ts --once --dry-run   # local smoke run
```

Always run `typecheck`, `lint`, and `test` before committing. Keep all three green.

## Conventions

- **ESM import paths use the `.js` extension** even for `.ts` files (NodeNext).
  e.g. `import { parseDocument } from "../vault/document.js";`
- Strict TypeScript incl. `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` — guard array/regex-group access; do not assign
  `undefined` to optional properties, omit them instead.
- **Keep pure logic separate from I/O** so it stays unit-testable:
  - field parse/serialize (`vault/taskMeta.ts`), mapping (`mapping/`), backend
    field mapping (`adapters/*/mapping.ts`), conflict resolution (`sync/conflict.ts`)
    are pure with direct unit tests;
  - network/DB/auth/file I/O is isolated behind injectable clients.
- Use the `logger` (`src/logger.ts`), **never `console`**, in `src/`
  (`no-console` is an eslint error). The logger emits structured JSON and
  redacts secret-bearing keys.
- Comments explain *why*, not *what*.
- All file writes go through `util/atomicFile.ts` (temp + fsync + rename).
- All secrets come from env/Docker secrets; never commit them, never log them.

## Architecture map

```
VaultWatcher (chokidar, debounced, self-write suppression, per-file change sets)
      │ changed files
      ▼
SyncEngine (incremental, per-file, 3-way reconcile, multi-target fan-out)
   ├─ vault/         remark pipeline: parse mdast → Task[]; serialize mutations
   │                  blocks.ts resolves which defined-tag block governs each item
   ├─ mapping/       Task → listKey (block tag → tag-path) + sync-id generation
   ├─ state/         baseline hashes + ExternalLink per (syncId, backend) + delta tokens
   ├─ writer/        minimal-diff, atomic, optimistic-concurrency writer
   ├─ sync/conflict  policy resolution (vault-wins/external-wins/newer)
   └─ sync/backendRegistry → SyncAdapter[] (generic interface)
        ├─ adapters/msTodo    → GraphClient → Microsoft Graph (delta)
        │                       └─ auth (MSAL) → encrypted token cache (AES-GCM)
        └─ adapters/supernote → SupernoteHttpClient → supernote-task-service (/v1)
```

The `SyncEngine` depends only on the generic `SyncAdapter`
(`src/adapters/types.ts`). Add backends by implementing it; never couple the
engine to a specific provider.

## Key design decisions (and why)

- **Multi-target fan-out:** one vault `syncId` maps to one `ExternalLink` *per
  backend* (`model/task.ts`). State is keyed by `(syncId, backend)`.
- **Correlation ID = HTML comment** `<!-- sync-id: … -->` on the task line.
  Invisible in preview, travels with the task text, does **not** collide with
  the Tasks plugin's `🆔` field. Never reuse `🆔`; never key on line numbers.
- **Vault layer uses unified/remark** (remark-parse + remark-gfm +
  remark-stringify + unist-util-visit) for document structure (list items,
  checkboxes, code fences) and a pure `taskMeta` module for emoji/Dataview
  field parsing — avoiding fragile hand-rolled markdown parsing.
- **Block-tag list mapping (obsidian-checklist-plugin model).** A **defined** tag
  (default `#todo`, configured via `tags` / `TASK_SYNC_TODO_TAGS`) on the
  non-task line *above* a checklist governs that block; only items under such a
  block are synced (others are ignored). `vault/blocks.ts` (pure) resolves
  line→tag from the mdast (a heading/paragraph whose text contains a defined tag
  governs the immediately following sibling `list`; first defined tag wins).
  The list key is the **tag path** (`#todo/groceries` ⇒ `todo/groceries`);
  sub-tags count only if their main tag is defined; matching is case-insensitive.
  Resolution is **per backend**: a backend's `tagListMap` only *renames* a tag
  path to a custom list (`MS_TAG_LIST_MAP` / `SUPERNOTE_TAG_LIST_MAP` or the
  `tagListMap` config key); overrides never leak between backends
  (`SyncEngine.resolveListForBackend`). Moving a synced task out of a tagged
  block deletes its backend task (vault-wins). Two safety guards protect against
  mass deletion from a tag misconfiguration: the deletion sweep is skipped if
  `tags` is empty, **and** if a full pass finds checklist items present but none
  under a defined tag while external links exist (likely a typo'd allow-list).
  Inbound tasks are imported only if
  their list maps to a defined tag, into an existing block or a new tagged block
  in the Sync Inbox.
- **3-way reconciliation** with content hashing on sync-relevant fields only.
  Conflict policy is configurable per backend; default `newer`, **Supernote
  defaults to `vault-wins`** (its device sync is undocumented/last-write-wins).
- **Optimistic concurrency** in the writer: each edit carries `expectedLine`;
  skip if the on-disk line changed. All writes are atomic.
- **Loop protection:** the writer calls `suppressNext(path)` before writing.
- **Encrypted token cache:** MSAL cache is AES-256-GCM encrypted at rest on a
  mounted volume; key from `TASK_SYNC_TOKEN_KEY` (`util/crypto.ts`).

## Backend gotchas

### Microsoft To Do (Graph)
- Recurrence is lossy (`🔁 every …` text vs `patternedRecurrence`); completing a
  recurring task creates a new task.
- `cancelled` has no native state → maps to `notStarted`.
- Graph **delta tokens** can return `HTTP 410 Gone` → discard and full-resync.
- MSAL `/common` + device code can fail `AADSTS90133` for some personal
  accounts → auth-code + PKCE fallback.

### Supernote (supernote-task-service HTTP API)
- task-sync talks to [`adrianba/supernote-task-service`](https://github.com/adrianba/supernote-task-service)
  over `/v1/tasks` + `/v1/lists`; it no longer touches MariaDB directly. The
  service owns emoji `[U+XXXX]` encoding, `links` preservation, soft deletes, ms
  timestamps, column limits, and `user_id` scoping.
- **Auth:** bearer **API key** (`SUPERNOTE_API_KEY`); base URL
  `SUPERNOTE_SERVICE_URL`. Client uses global `fetch` + `AbortSignal.timeout`,
  retries `429`/`503` with backoff honoring `Retry-After`.
- **Delta:** `GET /v1/tasks?since=<ms>` returns rows with `since <= last_modified`
  including completed + soft-deleted; page while `has_more` is true, passing the
  returned `cursor` as the next `since`. The lower bound is **inclusive** (the
  boundary row is re-delivered) → stay idempotent. The **first page / full
  resync omits `since`** (active mode, excludes deleted) — required because the
  service can reject a stale/zero `since` with `410 cursor_expired` when
  `CURSOR_MAX_AGE_MS` is enabled; continuation pages pass the numeric cursor.
  A `410 cursor_expired` mid-sync discards the token and full-resyncs (parity
  with Graph `410 Gone`).
- **Inbox = `list_id: null`**; the adapter maps it to/from `INBOX_ID` (`""`).
  The service's `/v1/lists` does **not** include the implicit Inbox (and the
  client filters null ids), so `SupernoteAdapter.listLists()` injects a synthetic
  `{ id: INBOX_ID, name: "Inbox" }` entry (de-duped). This is required for
  **inbound**: `pullInbound` enumerates `listLists()`, so without it tasks
  created in the Supernote Inbox would never be imported. Importing them still
  requires `inbox` to be a defined tag (`TASK_SYNC_TODO_TAGS`).
- **Priority round-trips** via the service's `importance` field (int 1–5/null).
- **Task order round-trips** via the service's 0-based per-list `sort` field,
  surfaced on the generic `ExternalTask.order` (`adapters/types.ts`); the adapter
  sets `ordered = true`. Engine ordering logic lives in `syncEngine.ts`
  (`reconcileOrdering` + helpers) and runs only on the **full** `reconcile()`
  pass (needs the whole vault), not on watcher-driven incremental passes.
  - Service `sort` semantics: **create** omits it to append or sends an explicit
    index; **update** sends `sort` to move (`null` is ignored, cannot clear);
    explicit indices do **not** renumber siblings; list/sync responses are **not**
    ordered by `sort` (stable `last_modified ASC, task_id ASC`) so we read it per
    task and order ourselves. We renumber **densely** outbound to avoid collisions.
  - Unit of ordering is the **(file, list)** group. Outbound numbers files in
    vault-path order, tasks in document order. Inbound reorders task lines within
    each file to the device order via `reorderTaskLines` (atomic, optimistic, only
    permutes the participating task lines). Change detection compares **relative**
    id sequences (`seqEqual`) so cross-file offsets don't cause false churn.
  - Conflict (both reordered) → **vault-wins**. `lastKnownSort` on `ExternalLink`
    (`model/task.ts`) is the per-link baseline; it JSON-round-trips with state.
  - Limitation: cross-file interleaving on the device is unrepresentable in one
    file — per-file relative order is honoured, global order is grouped by file path.
- **Optimistic concurrency:** updates send `If-Unmodified-Since: <ms>` from the
  freshly-read `lastModified`; a `409` surfaces as `ExternalConflictError`
  (`src/adapters/types.ts`) which the engine catches and defers. Deletes are
  unconditional (vault-wins deletion should win) and **idempotent**: a `404`
  (task already gone, e.g. deleted on the device) is treated as success so the
  engine prunes the stale link instead of re-attempting the same DELETE every
  reconcile pass. The engine also prunes defensively on any not-found-typed
  error (`isNotFoundError` in `syncEngine.ts`).
- **Not round-tripped:** completed (`done`) date and a task `start` date — the
  service sets completion time itself and has no start-date column.
- IDs are still **32-char lowercase hex**; status is `needsAction` / `completed`.
- The injectable `SupernoteServiceClient` interface (`adapters/supernote/client.ts`)
  keeps the adapter unit-testable with a fake — **no network in tests**.

## Testing approach

- Pure modules have direct unit tests. The engine is tested end-to-end with an
  in-memory fake adapter (`tests/helpers/fakeAdapter.ts`) — no network/DB.
- Synthetic vault fixtures live under `tests/fixtures/vault`.
- Live integration tests (Graph, supernote-task-service) are credential-gated
  and skipped unless the relevant env vars are set.

## When extending

- New backend → implement `SyncAdapter` in `src/adapters/<name>/`, keep field
  mapping pure and unit-tested, route I/O through an injectable client.
- Changing on-line metadata format → update `vault/taskMeta.ts` and its
  round-trip tests together.
- Update [`docs/strategy-report.md`](docs/strategy-report.md) and this file when
  a design decision changes.

## Versioning & releases

- `VERSION` lives in `src/version.ts`, read once from `package.json` at runtime
  via `new URL("../package.json", import.meta.url)` (no static JSON import — that
  would break `rootDir: src` / `verbatimModuleSyntax`). Falls back to
  `"0.0.0-dev"` if unreadable. It is surfaced by `--version`, the `--help`
  banner, and the `"Starting task-sync"` log line.
- The Dockerfile copies `package.json` next to `dist/` in the image so the
  runtime read resolves to the released version.
- Releases are cut by `.github/workflows/release.yml` (manual `workflow_dispatch`
  with a `version` input). It gates on typecheck/lint/test/build, then bumps
  `package.json`, commits + tags `v<version>` on `main`, and pushes the image to
  `ghcr.io/adrianba/task-sync:<version>` and `:latest`. Build the image **after**
  the version bump so the image carries the right version.

