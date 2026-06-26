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
   ├─ mapping/listMapping  Task → list (tag / file / hybrid)
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

---

## Configuration

Configuration is layered, later sources winning:

1. Built-in defaults
2. `config.json`, then `config.local.json` (or a file passed via `--config`)
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
| `listMapping` | `TASK_SYNC_LIST_MAPPING` | `hybrid` | `tag` \| `file` \| `hybrid`. |
| `conflictPolicy` | `TASK_SYNC_CONFLICT_POLICY` | `newer` | Default policy (per-backend overridable). |
| `inboundInboxFile` | `TASK_SYNC_INBOX_FILE` | `Sync Inbox.md` | Note that receives externally-created tasks. |
| `watchDebounceMs` | — | `300` | Debounce window for file changes. |
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
```

The backend:

- authenticates with a **bearer API key** and retries `429`/`503` with backoff
  (honoring `Retry-After`),
- syncs incrementally via the service's `?since=<ms>` **delta** cursor
  (paging while `has_more` is true), splitting changed vs. soft-deleted rows,
- maps **priority** losslessly through the service's `importance` field (1–5),
- uses **optimistic concurrency** on updates (`If-Unmodified-Since`); on a `409`
  it skips the task for the pass and lets the next reconcile resolve it,
- defaults to a **`vault-wins`** conflict policy (lower-trust backend).

> **Limitations:** the completed (`done`) date and a task `start` date are not
> round-tripped — the service sets completion time itself and has no start-date
> column. Recurrence and other rich fields follow the service's own model.

---

## List mapping & tags

`listMapping` controls which external list a task is placed in:

- **`tag`** — a task's `#tag` selects the list.
- **`file`** — the containing note/folder selects the list.
- **`hybrid`** (default) — prefer a known/mapped `#tag`, otherwise fall back to
  the containing file.

Map specific tags to specific external lists per backend via `tagListMap`:

```jsonc
"backends": {
  "msTodo": { "enabled": true, "clientId": "…",
    "tagListMap": { "work": "Work", "home": "Personal" } }
}
```

Externally-created tasks that have no vault counterpart are appended to the
shared **Sync Inbox** note (`inboundInboxFile`).

---

## Conflict resolution

When both sides changed since the last sync, a **whole-task** conflict policy
decides the winner (per-backend overridable):

| Policy | Behaviour |
|---|---|
| `vault-wins` | The markdown vault always wins (default for Supernote). |
| `external-wins` | The external manager wins when it has state. |
| `newer` | Compare vault mtime vs the external `lastModified`; ties go to the vault (default for Microsoft To Do). |

Field-level merge is intentionally **not** performed; see
[Limitations](#limitations).

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
