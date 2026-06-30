#!/usr/bin/env bash
#
# sync-once.sh — run task-sync a single time in a throwaway Docker container.
#
# Ideal for cron or other scripted environments where you don't want the
# long-lived daemon: it performs ONE full reconcile and exits. The container's
# exit code is propagated, so this script exits non-zero if the pass failed, a
# backend errored, or a backend failed to initialize (e.g. first-run Microsoft
# auth was never completed) — letting cron/monitoring detect failures.
#
# First run with Microsoft To Do: the device-code flow is interactive and waits
# for you to sign in. Seed the token cache ONCE interactively before scripting:
#
#     INTERACTIVE=1 ./scripts/sync-once.sh
#
# Watch the log for the URL + one-time code, sign in, and the encrypted token
# cache is written to the /data volume. Subsequent non-interactive runs reuse it.
#
# Usage:
#     ./scripts/sync-once.sh [extra docker-run args...]
#
# Configuration (override via environment or a .env file — see ENV_FILE below):
#     IMAGE       Container image           (default: ghcr.io/adrianba/task-sync:latest)
#     VAULT_PATH  Host path to your vault   (default: ./vault)
#     DATA_VOLUME Named volume for /data    (default: task-sync-data)
#     ENV_FILE    Optional env file with secrets (default: .env if present)
#     INTERACTIVE Set to 1 to allocate a TTY for first-run device-code auth
#     DRY_RUN     Set to 1 to add --dry-run (observe-only; no writes)
#
# Example:
#     IMAGE=ghcr.io/adrianba/task-sync:1.0.0 VAULT_PATH=/srv/obsidian/vault \
#       ./scripts/sync-once.sh
#
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/adrianba/task-sync:latest}"
VAULT_PATH="${VAULT_PATH:-./vault}"
DATA_VOLUME="${DATA_VOLUME:-task-sync-data}"
ENV_FILE="${ENV_FILE:-.env}"

# Resolve the vault to an absolute path so `docker run -v` accepts it.
if [ ! -d "${VAULT_PATH}" ]; then
  echo "error: vault path '${VAULT_PATH}' does not exist (set VAULT_PATH)" >&2
  exit 2
fi
VAULT_ABS="$(cd "${VAULT_PATH}" && pwd)"

docker_args=(
  run --rm
  --name "task-sync-once-$$"
  -v "${VAULT_ABS}:/vault"
  -v "${DATA_VOLUME}:/data"
)

# Load secrets/config from an env file when one is available.
if [ -f "${ENV_FILE}" ]; then
  docker_args+=(--env-file "${ENV_FILE}")
fi

# Allocate an interactive TTY only when seeding first-run device-code auth.
if [ "${INTERACTIVE:-0}" = "1" ]; then
  docker_args+=(-it)
fi

# task-sync flags: always --once; optionally --dry-run.
app_args=(--once)
if [ "${DRY_RUN:-0}" = "1" ]; then
  app_args+=(--dry-run)
fi

# Trailing "$@" lets callers pass extra docker-run args (e.g. another -v) — they
# land before the image, so they configure docker, not the app.
exec docker "${docker_args[@]}" "$@" "${IMAGE}" "${app_args[@]}"
