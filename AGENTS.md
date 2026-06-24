# AGENTS.md

Guidance for AI agents and human contributors working in this repository.

## What this is

A **production** TypeScript/Node background service that syncs Obsidian
**Tasks**-plugin markdown tasks with multiple external task managers,
**bidirectionally** and with **multi-target fan-out** (one task can sync to
several backends at once). Backends shipped:

- **Microsoft To Do** (Microsoft Graph)
- **Supernote To Do** (Supernote Private Cloud MariaDB)

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
   ├─ mapping/       Task → listKey (tag/file/hybrid) + sync-id generation
   ├─ state/         baseline hashes + ExternalLink per (syncId, backend) + delta tokens
   ├─ writer/        minimal-diff, atomic, optimistic-concurrency writer
   ├─ sync/conflict  policy resolution (vault-wins/external-wins/newer)
   └─ sync/backendRegistry → SyncAdapter[] (generic interface)
        ├─ adapters/msTodo    → GraphClient → Microsoft Graph (delta)
        │                       └─ auth (MSAL) → encrypted token cache (AES-GCM)
        └─ adapters/supernote → MariaDB (mysql2) t_schedule_task / _group
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
- **Hybrid list mapping** (tag first, folder fallback).
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

### Supernote (MariaDB)
- Tables: `t_schedule_task` (tasks) and `t_schedule_task_group` (lists). **Inbox
  = `task_list_id IS NULL`** (no row for it).
- **Always filter `is_deleted = 'N'`**; use **soft deletes** only.
- **Timestamps are Unix epoch in milliseconds**.
- Status is only `needsAction` / `completed`.
- Task/list IDs are **32-char lowercase hex** (`randomUUID().replace(/-/g,'')`).
- DB charset is 3-byte `utf8`: **encode emoji as `[U+XXXX]`** before writing,
  decode on read; `detail` is `varchar(255)` — truncate **after** encoding.
- **Preserve the `links` column** on updates (Base64 notebook link).
- Scope all queries/inserts by `user_id`.
- **Parameterized queries only** (mysql2 placeholders). Never string-concatenate.
- Connectivity: primary = same Docker network (host = container name); TCP
  host:port fallback.

## Testing approach

- Pure modules have direct unit tests. The engine is tested end-to-end with an
  in-memory fake adapter (`tests/helpers/fakeAdapter.ts`) — no network/DB.
- Synthetic vault fixtures live under `tests/fixtures/vault`.
- Live integration tests (Graph, MariaDB) are credential-gated and skipped
  unless the relevant env vars are set.

## When extending

- New backend → implement `SyncAdapter` in `src/adapters/<name>/`, keep field
  mapping pure and unit-tested, route I/O through an injectable client.
- Changing on-line metadata format → update `vault/taskMeta.ts` and its
  round-trip tests together.
- Update [`docs/strategy-report.md`](docs/strategy-report.md) and this file when
  a design decision changes.
