# task-sync

A production background service that watches an [Obsidian](https://obsidian.md)
vault, parses [Obsidian **Tasks**-plugin](https://publish.obsidian.md/tasks/)
markdown tasks, and **bidirectionally synchronizes** them with multiple external
task managers:

- **Microsoft To Do** (via Microsoft Graph, delta queries)
- **Supernote To Do** (via the [`supernote-task-service`](https://github.com/adrianba/supernote-task-service) REST API)

A single vault task can **fan out to several backends at once**. The service is
designed to run as a long-lived daemon inside a **Docker container**.

> **Status:** the markdown vault is the source of truth. External managers are
> kept in sync from it, and externally-made changes are reconciled back into the
> vault according to a configurable conflict policy.

---

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start (local)](#quick-start-local)
- [Running in Docker](#running-in-docker)
- [Volumes](#volumes)
- [Configuration](#configuration)
- [Microsoft To Do setup](#microsoft-to-do-setup)
- [Supernote To Do setup](#supernote-to-do-setup)
- [List mapping & tags](#list-mapping--tags)
- [Conflict resolution](#conflict-resolution)
- [Task ordering (Supernote)](#task-ordering-supernote)
- [Observability](#observability)
- [Security](#security)
- [CLI](#cli)
- [Development](#development)
- [Limitations](#limitations)

---

## How it works

```
VaultWatcher (chokidar, debounced, self-write suppression)
      │ changed file paths
      ▼
SyncEngine  (incremental, per-file; multi-target fan-out; 3-way reconcile)
   ├─ vault/document.ts    unified/remark → mdast → Task[]  (+ minimal-diff writer)
   ├─ vault/blocks.ts      defined-tag block resolver → which checklist is in scope
   ├─ mapping/listMapping  Task → list (block tag → tag-path, per-backend rename)
   ├─ state/stateStore     baseline hashes + links keyed by (syncId, backend)
   └─ BackendRegistry      fan-out to N SyncAdapters
         ├─ msTodo     → Microsoft Graph (delta) ← MSAL → AES-GCM token cache
         └─ supernote  → supernote-task-service (HTTP /v1, API key, delta)
```

- The vault is parsed with a **unified / remark** pipeline (`remark-parse` +
  `remark-gfm` + `unist-util-visit`) to robustly locate task list items and skip
  code fences, plus a pure field grammar for the Tasks-plugin emoji and Dataview
  metadata. This replaces hand-rolled parsing to avoid edge-case bugs.
- Each task is correlated to its external counterparts via an HTML comment
  `<!-- sync-id: … -->` appended to the task line. State is tracked **per
  `(syncId, backend)`** so one task can link to multiple managers.
- Writes back to the vault are **minimal-diff, line-based, optimistic-concurrency
  checked, and atomic** (temp file + `fsync` + `rename`).

See [`docs/strategy-report.md`](./docs/strategy-report.md) for the full design
rationale and [`AGENTS.md`](./AGENTS.md) for architecture and conventions.

---

## Requirements

- **Node.js 24+** and **npm** (for local runs / development)
- **Docker** (for the recommended deployment)
- A backend to sync with:
  - Microsoft To Do: an **Entra ID (Azure AD) app registration** (public client)
  - Supernote To Do: a running [`supernote-task-service`](https://github.com/adrianba/supernote-task-service) instance and its **API key**

---

## Quick start (local)

```bash
npm ci
npm run build

# Create a config (start from the example) and edit it.
cp config.example.json config.json
$EDITOR config.json

# A 32-byte AES key (base64) is required when Microsoft To Do is enabled.
export TASK_SYNC_TOKEN_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"

# Run a single reconciliation pass (no daemon) to validate setup:
node dist/index.js --once

# Run the long-lived service:
node dist/index.js
```

Use `--dry-run` to observe what *would* change without writing to the vault or
any backend.

---

## Running in Docker

A multi-stage [`Dockerfile`](./Dockerfile) (based on `node:24-alpine`) builds a
small, **non-root** runtime image with a `HEALTHCHECK` that probes `/healthz`.

Pull a released image from the GitHub Container Registry:

```bash
docker pull ghcr.io/adrianba/task-sync:latest
# or a specific version
docker pull ghcr.io/adrianba/task-sync:1.0.0
```

Or build it locally:

```bash
docker build -t task-sync:latest .
```

The simplest way to run is with the provided
[`docker-compose.example.yml`](./docker-compose.example.yml):

```bash
cp docker-compose.example.yml docker-compose.yml
# Edit volumes (point ./vault at your real vault) and set secrets via env / .env.
docker compose up -d
```

Provide secrets through the environment or a `.env` file (never commit it):

```dotenv
TASK_SYNC_TOKEN_KEY=<32-byte base64 or hex key>
MS_ENABLED=true
MS_CLIENT_ID=<your Entra app client id>
SUPERNOTE_ENABLED=true
SUPERNOTE_SERVICE_URL=https://tasks.example.com
SUPERNOTE_API_KEY=<service api key>
```

### Using a `config.json` file in Docker

The image does **not** bundle a `config.json` — by default the example compose
configures everything through `TASK_SYNC_*` / `MS_*` / `SUPERNOTE_*` env vars.

If you prefer a JSON file (or need a setting that has no env var, such as
`health.host`), mount one into the container. The service resolves config files
**relative to its working directory `/app`**, looking for `config.json` then
`config.local.json`, so the simplest option is to bind-mount to
`/app/config.json`:

```yaml
services:
  task-sync:
    volumes:
      - ./vault:/vault
      - task-sync-data:/data
      - ./config.json:/app/config.json:ro   # picked up automatically
```

To keep it elsewhere, mount it to any path and point at it explicitly:

```yaml
    volumes:
      - ./config.json:/data/config.json:ro
    command: ["--config", "/data/config.json"]
```

Env vars still **override** values from the file (see the layering order under
[Configuration](#configuration)), so you can keep non-secret settings in the
file and inject secrets via the environment. Both commented bind-mounts are in
[`docker-compose.example.yml`](./docker-compose.example.yml).

---

## Volumes

The container is stateless except for two mounts:

| Mount path | Purpose | Notes |
|---|---|---|
| `/vault` | Your Obsidian vault | Read **and written**. Bind-mount your real vault. |
| `/data`  | Service state | Holds `state.json` (sync baselines & links) and the encrypted MSAL token cache `msal-cache.enc`. Use a **named volume** so auth and sync state survive restarts. |

> Losing `/data` means the next run re-establishes baselines (and Microsoft auth
> must be re-done). It will not lose vault data, but may re-create external tasks
> for links it no longer remembers — back it up.

### File permissions

The container runs as a **non-root user, UID:GID `1000:1000`** (the image's
`node` user). The bind-mounted `/vault` must therefore be writable by that UID,
or task-sync fails its reconcile pass with `EACCES: permission denied` when
writing the atomic temp file (it writes `<!-- sync-id -->` markers back into
your notes). Choose one:

- **Make the vault writable by `1000`:** `sudo chown -R 1000:1000 /path/to/vault`.
- **Run as your own user** (keeps vault files owned by you on the host): set
  `user: "${PUID:-1000}:${PGID:-1000}"` in compose and export `PUID=$(id -u)` /
  `PGID=$(id -g)` (e.g. via `.env`). When you do this, also switch `/data` from
  the named volume to a host directory you own (the named volume is initialized
  as `1000:1000` and a different UID can't write it) — see the commented
  bind-mount in [`docker-compose.example.yml`](./docker-compose.example.yml).

---

## Configuration

Configuration is layered, later sources winning:

1. Built-in defaults
2. `config.json`, then `config.local.json` (or a file passed via `--config`),
   resolved **relative to the working directory** — `/app` in the Docker image,
   so a file mounted at `/app/config.json` is loaded automatically (see
   [Using a `config.json` file in Docker](#using-a-configjson-file-in-docker))
3. Environment variables
4. CLI flags (`--dry-run`)

It is validated with [zod](https://zod.dev); invalid config fails fast with a
readable error. See [`config.example.json`](./config.example.json) for the full
shape.

### Core options

| Config key | Env var | Default | Description |
|---|---|---|---|
| `vaultPath` | `TASK_SYNC_VAULT_PATH` | `/vault` | Path to the Obsidian vault. |
| `statePath` | `TASK_SYNC_STATE_PATH` | `/data/state.json` | Sync state file. |
| `tags` | `TASK_SYNC_TODO_TAGS` | `todo` | Defined tags that mark a checklist block as synced tasks (comma-separated env; leading `#` optional). |
| `inboundInboxFile` | `TASK_SYNC_INBOX_FILE` | `Sync Inbox.md` | Note that receives externally-created tasks. |
| `watchDebounceMs` | — | `300` | Debounce window for file changes. |
| `inboundIntervalMs` | `TASK_SYNC_INBOUND_INTERVAL_MS` | `60000` | How often (ms) to poll backends for inbound changes. The vault is watched in real time; this only governs the pull direction. |
| `dryRun` | `TASK_SYNC_DRY_RUN` | `false` | Observe-only. |
| `tokenKey` | `TASK_SYNC_TOKEN_KEY` | — | AES-256-GCM key (32 bytes, base64 or hex). Required when Microsoft To Do is enabled. |
| `log.level` | `TASK_SYNC_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `health.port` | — | `8080` | Health server port. |

At least one backend must be enabled.

---

## Microsoft To Do setup

1. In the [Entra admin center](https://entra.microsoft.com), register a new
   application as a **public client** (mobile & desktop). Enable the
   *device code flow* / "Allow public client flows".
2. Add delegated permissions: `Tasks.ReadWrite`, `offline_access`, `User.Read`.
3. Note the **Application (client) ID**.
4. Configure and enable the backend:

   ```jsonc
   // config.json
   "backends": {
     "msTodo": { "enabled": true, "clientId": "<client id>", "conflictPolicy": "newer" }
   }
   ```

   or via environment:

   ```dotenv
   MS_ENABLED=true
   MS_CLIENT_ID=<client id>
   TASK_SYNC_TOKEN_KEY=<32-byte base64/hex key>
   ```

5. On first run, the service uses the **device-code flow**: it logs a URL and a
   one-time code. Visit the URL, enter the code, and sign in. The resulting
   token cache is **encrypted with AES-256-GCM** and stored at
   `MS_TOKEN_CACHE_PATH` (default `/data/msal-cache.enc`) so subsequent runs are
   non-interactive.

| Env var | Default | Description |
|---|---|---|
| `MS_ENABLED` | `false` | Enable the backend. |
| `MS_CLIENT_ID` | — | Entra application (client) ID. |
| `MS_AUTHORITY` | `https://login.microsoftonline.com/common` | Authority URL. |
| `MS_SCOPES` | `Tasks.ReadWrite,offline_access,User.Read` | Delegated scopes (comma-separated). |
| `MS_TOKEN_CACHE_PATH` | `/data/msal-cache.enc` | Encrypted token cache location. |
| `MS_TAG_LIST_MAP` | — | JSON `{tag: listName}` for this backend (see List mapping). |

---

## Supernote To Do setup

The Supernote backend talks to a running
[`supernote-task-service`](https://github.com/adrianba/supernote-task-service)
over its REST API (`/v1/tasks`, `/v1/lists`). The service owns all direct
database access, emoji `[U+XXXX]` encoding, `links` preservation, soft deletes,
ms-epoch timestamps, and `user_id` scoping — task-sync only speaks HTTP.

```dotenv
SUPERNOTE_ENABLED=true
SUPERNOTE_SERVICE_URL=https://tasks.example.com   # base URL of the service
SUPERNOTE_API_KEY=<api key>                        # provide via env / Docker secret
SUPERNOTE_REQUEST_TIMEOUT_MS=15000                 # optional (default 15000)
SUPERNOTE_TAG_LIST_MAP='{"work":"Work"}'           # optional per-backend tag→list map
```

The backend:

- authenticates with a **bearer API key** and retries `429`/`503` with backoff
  (honoring `Retry-After`),
- syncs incrementally via the service's `?since=<ms>` **delta** cursor
  (paging while `has_more` is true), splitting changed vs. soft-deleted rows;
  a stale cursor (`410 cursor_expired`, when the service enables a retention
  window) triggers an automatic full resync,
- maps **priority** losslessly through the service's `importance` field (1–5),
- uses **optimistic concurrency** on updates (`If-Unmodified-Since`); on a `409`
  it skips the task for the pass and lets the next reconcile resolve it,
- defaults to a **`vault-wins`** conflict policy (lower-trust backend).

> **Limitations:** the completed (`done`) date and a task `start` date are not
> round-tripped — the service sets completion time itself and has no start-date
> column. Recurrence and other rich fields follow the service's own model.

---

## List mapping & tags

task-sync uses the **block-tag** model (the same convention as the
[Obsidian Checklist plugin](https://github.com/delashum/obsidian-checklist-plugin)):
a **defined tag** on the line *before* a checklist governs every item in that
list. Items that are **not** under a defined-tag block are ignored — they are
treated as ordinary checkboxes, not synced tasks.

### How it works

```markdown
#todo
- [ ] Buy milk          ← synced to list "todo"
- [ ] Call the dentist  ← synced to list "todo"

## Groceries #todo/groceries
- [ ] Eggs              ← synced to list "todo/groceries"

Some prose, not a tag line.
- [ ] This is ignored   ← no governing tag block → never synced
```

Rules:

1. A tag is **defined** via the `tags` config / `TASK_SYNC_TODO_TAGS` env
   (default: `todo`). Only defined tags route tasks.
2. The tag must sit on a **non-task line** (a heading or paragraph) and the
   **immediately following list** is the governed block. One blank line between
   the tag line and the list is allowed.
3. Tags are **consolidated across files** — the same tag path means the same
   list everywhere in the vault.
4. **Sub-tags are their own list:** `#todo/groceries` ⇒ list `todo/groceries`.
   A sub-tag counts only if its **main** tag (`todo`) is defined.
5. If a governing line carries several tags, the **first defined tag wins**
   (one list per task — no fan-out across lists).
6. Tag matching is **case-insensitive**; the resolved list key is lowercased.

> **Moving a task out of a tagged block deletes it from the backend.** Because an
> out-of-scope item is no longer a tracked task, the next full reconcile treats
> its previously-synced backend task as removed (vault-wins deletion). Re-tagging
> it later re-syncs it as a new task.
>
> **Safety guard:** if a full reconcile finds the vault *still has checklist
> items* but **none** are under a defined tag (while external links exist),
> task-sync logs an error and **skips** the deletion sweep instead of mass-
> deleting every backend task. This catches a misconfigured `tags` allow-list
> (e.g. a typo) or lost tag lines. Genuinely emptying the vault (no checkboxes
> left) is unaffected and still deletes as expected.

### Renaming a tag to a custom list name (per backend)

By default the list name **is** the tag path. Use a backend's `tagListMap` to
rename a tag path to a specific external list. Resolution is **per backend**, so
the same task can land in differently-named lists in Microsoft To Do and
Supernote, and one backend's overrides never leak into another.

```jsonc
"backends": {
  "msTodo": { "enabled": true, "clientId": "…",
    "tagListMap": { "todo": "Work", "todo/groceries": "Shopping" } }
}
```

```bash
# Env-only deployments (Docker): defined tags + per-backend rename maps
TASK_SYNC_TODO_TAGS="todo,work"
SUPERNOTE_TAG_LIST_MAP='{"todo":"Work","todo/groceries":"Shopping"}'
```

### Inbound (externally-created) tasks

Externally-created tasks are pulled back into the vault **only if their list maps
to a defined tag** — directly (the list name matches a defined tag path) or via
the inverse of that backend's `tagListMap`. A matching task is inserted into an
existing block for that tag anywhere in the vault, or, if none exists, a new
`#<tag>` block is created in the shared **Sync Inbox** note (`inboundInboxFile`).

> Tasks living in arbitrary device lists that don't map to a defined tag are
> **not** imported — otherwise they would be written without a governing tag and
> immediately deleted again on the next pass.

**Supernote Inbox.** Tasks created in the Supernote **Inbox** (the implicit
`list_id: null` list) are imported too, but only if `inbox` is a **defined tag**.
Add it to your tag allow-list, e.g.:

```yaml
TASK_SYNC_TODO_TAGS: "todo,inbox"
```

Imported Inbox tasks land under an `#inbox` checklist block (an existing one if
present, otherwise a new block appended to the **Sync Inbox** note). No
`SUPERNOTE_TAG_LIST_MAP` entry is needed — the adapter handles the Inbox
specially in both directions.

---

## Conflict resolution

When both sides changed since the last sync, a **whole-task** conflict policy
decides the winner (configured per backend):

| Policy | Behaviour |
|---|---|
| `vault-wins` | The markdown vault always wins (default for Supernote). |
| `external-wins` | The external manager wins when it has state. |
| `newer` | Compare vault mtime vs the external `lastModified`; ties go to the vault (default for Microsoft To Do). |

Field-level merge is intentionally **not** performed; see
[Limitations](#limitations).

---

## Task ordering (Supernote)

The Supernote backend keeps each list **in the same order as your markdown**, in
both directions. (Microsoft To Do has no stable ordering API and is unaffected.)

- **Outbound (vault → device):** within a list, tasks are numbered densely in
  **document order**. When several notes feed one list, files are taken in
  **vault path order**, then tasks in document order within each file.
- **Inbound (device → vault):** if you reorder a list on the device, task-sync
  physically reorders those task lines in the markdown to match — moving only the
  task lines, leaving headings and blank lines untouched. The rewrite is atomic
  and loop-protected.
- **Conflict (both reordered):** **vault-wins** — the markdown order is pushed to
  the device and the conflict is logged.

Notes:

- Ordering reconciles on the **periodic full pass** (and at startup), not on every
  individual file-watch event, because it needs the whole vault to project order.
- Cross-file interleaving on the device cannot be represented in a single file, so
  per-file relative order is honoured but global cross-file order is grouped by
  file path. Keep a list in one note if you need exact device order.

---

## Observability

- **Structured JSON logs** to stdout with **secret redaction**.
- **Health HTTP server** (binds **loopback `127.0.0.1:8080`** by default; set
  `health.host` to `0.0.0.0` to expose it):
  - `GET /healthz` — liveness (process is up).
  - `GET /readyz` — readiness (backends initialized).
  Responses carry only a coarse `{ "status": … }` — never internal errors or
  task content (details go to logs only).
- Docker **HEALTHCHECK** probes `/healthz`.
- **Graceful shutdown** on `SIGTERM`/`SIGINT`: drains in-flight work and flushes
  state before exit.

---

## Security

- Secrets are read only from **environment / Docker secrets** and are never
  logged (logger redaction).
- The Microsoft token cache is **encrypted at rest** (AES-256-GCM, random IV,
  auth tag) using `TASK_SYNC_TOKEN_KEY`; the file is written with `0600` perms.
- Supernote access goes through the `supernote-task-service` over HTTPS with a
  **bearer API key**; the service enforces parameterized queries, soft deletes,
  and per-`user_id` scoping on its side.
- All vault writes are **atomic** with optimistic-concurrency checks and a
  compare-and-swap re-read to avoid clobbering concurrent edits.
- A single backend failure is **isolated**: a backend that fails to initialize is
  marked degraded and skipped while the others keep syncing; the daemon stays up
  as long as one backend is healthy.
- Network and database calls are **time-bounded** (request/query timeouts) so a
  stuck call cannot wedge the sync loop.
- The **health server binds to loopback** by default, returns no internal error
  detail, and the container runs as a **non-root** user on a minimal base image.

Generate a token key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## CLI

```
task-sync [options]

  --once          Run a single reconciliation pass and exit
  --dry-run       Observe-only; never write to the vault or backends
  --config <path> Path to a JSON config file
  -h, --help      Show help
```

---

## Development

```bash
npm ci
npm run dev        # watch mode (tsx)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run build      # compile to dist/
```

CI (GitHub Actions) runs typecheck, lint, tests, and a Docker build on every
push/PR. See [`AGENTS.md`](./AGENTS.md) for conventions and gotchas before
contributing.

The running version is read from `package.json` at startup and surfaced by
`task-sync --version`, the `--help` banner, and the `"Starting task-sync"` log
line.

---

## Releasing

Releases are cut with the **Release** GitHub Actions workflow
([`.github/workflows/release.yml`](./.github/workflows/release.yml)):

1. In the repo, open **Actions → Release → Run workflow**.
2. Enter the new **version** (semver, no leading `v` — e.g. `1.2.3`).

The workflow then:

- validates the version is semver and the tag `v<version>` does not already exist;
- runs typecheck, lint, tests, and build as a gate;
- bumps `version` in `package.json`/`package-lock.json`, commits it to `main`,
  and pushes an annotated tag `v<version>`;
- builds the Docker image and pushes it to the GitHub Container Registry as
  `ghcr.io/adrianba/task-sync:<version>` and `:latest`.

> First release only: the GHCR package is created as **private** by default.
> Make it public (or grant pull access) via the package settings under the
> repository's **Packages** if you want unauthenticated `docker pull`.

---

## Limitations

- **Recurrence** is treated as lossy (round-tripped as text, not structured).
- **Field-level merge** is deferred — conflicts resolve at whole-task
  granularity. Inbound edits update status/dates; inbound title changes are not
  written back over a vault task.
- **Deletions:** a task removed from the vault is deleted in the backends (links
  cleaned up); a task deleted in a backend has its link cleared and, under the
  default vault-wins policy, is re-created from the vault on the next pass.
- One task maps to **one list per backend**; per-list fan-out is deferred.
- Supernote `links` (notebook pages) are preserved by the service but not
  created from the vault. The Supernote completed-date and `start` date are not
  round-tripped (service-side limitations).

---

## License

[MIT](./LICENSE).
