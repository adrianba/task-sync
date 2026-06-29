/**
 * Layered, validated configuration.
 *
 * Precedence (lowest → highest): built-in defaults → config file (JSON) →
 * environment variables → programmatic/CLI overrides. Secrets (client IDs,
 * DB passwords, encryption keys) come from the environment or Docker secrets,
 * never the committed config file.
 *
 * The shape is validated with zod so misconfiguration fails fast with a clear,
 * actionable message at startup rather than deep inside the sync loop.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "./logger.js";
import { normalizeIgnorePath } from "./util/ignore.js";

export type ListMappingStrategy = "tag" | "file" | "hybrid";
export type ConflictPolicy = "vault-wins" | "external-wins" | "newer";

const conflictPolicy = z.enum(["vault-wins", "external-wins", "newer"]);
const logLevel = z.enum(["debug", "info", "warn", "error"]);

const tagListMap = z.record(z.string(), z.string());

const msTodoBackendSchema = z.object({
  enabled: z.boolean().default(false),
  conflictPolicy: conflictPolicy.default("newer"),
  clientId: z.string().default(""),
  authority: z.string().default("https://login.microsoftonline.com/common"),
  scopes: z
    .array(z.string())
    .default(["Tasks.ReadWrite", "offline_access", "User.Read"]),
  /** Where the AES-GCM-encrypted MSAL token cache is stored (mounted volume). */
  tokenCachePath: z.string().default("/data/msal-cache.enc"),
  tagListMap: tagListMap.default({}),
});

const supernoteServiceSchema = z.object({
  /** Base URL of the supernote-task-service (e.g. https://tasks.example.com). */
  baseUrl: z.string().default(""),
  /** API key sent as a Bearer token on every request. */
  apiKey: z.string().default(""),
  /** Per-request timeout (ms) for HTTP calls to the service. */
  requestTimeoutMs: z.number().int().positive().default(15_000),
});

const supernoteBackendSchema = z.object({
  enabled: z.boolean().default(false),
  conflictPolicy: conflictPolicy.default("vault-wins"),
  service: supernoteServiceSchema.prefault({}),
  tagListMap: tagListMap.default({}),
});

const healthSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(8080),
});

const configSchema = z.object({
  vaultPath: z.string().min(1, "vaultPath is required"),
  statePath: z.string().default("/data/state.json"),
  ignore: z
    .array(z.string())
    .default([".obsidian", ".trash", ".git", "node_modules"]),
  /**
   * Additional vault-relative path prefixes to exclude from scanning/watching
   * (e.g. `Tasks/Templates`). Matched on a segment boundary, case-insensitive.
   * The standard {@link ignore} directory names are always skipped on top of
   * these.
   */
  ignorePaths: z
    .array(z.string())
    .default([])
    .transform((arr) => arr.map(normalizeIgnorePath).filter((p) => p !== "")),
  /**
   * Defined checklist tags (obsidian-checklist-plugin model). A tag on the
   * non-task line above a checklist governs that block; only these tags (and
   * their sub-tags) are synced. Stored without the leading '#', lowercased.
   */
  tags: z
    .array(z.string())
    .default(["todo"])
    .transform((arr) => arr.map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter((t) => t !== ""))
    .refine((arr) => arr.length > 0, "tags must contain at least one non-empty tag"),
  watchDebounceMs: z.number().int().positive().default(300),
  /**
   * How often (ms) to poll backends for inbound changes (delta/listing). The
   * vault is watched in real time; this only governs the pull direction. Default
   * 60s; exposed for future tuning via `TASK_SYNC_INBOUND_INTERVAL_MS`.
   */
  inboundIntervalMs: z.number().int().positive().default(60_000),
  inboundInboxFile: z.string().default("Sync Inbox.md"),
  dryRun: z.boolean().default(false),
  /** AES-256-GCM key (base64/hex, 32 bytes) for the token cache. */
  tokenKey: z.string().optional(),
  health: healthSchema.prefault({}),
  log: z.object({ level: logLevel.default("info") }).prefault({}),
  backends: z
    .object({
      msTodo: msTodoBackendSchema.optional(),
      supernote: supernoteBackendSchema.optional(),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;
export type MsTodoBackendConfig = z.infer<typeof msTodoBackendSchema>;
export type SupernoteBackendConfig = z.infer<typeof supernoteBackendSchema>;
export type SupernoteServiceConfig = z.infer<typeof supernoteServiceSchema>;

/** Deep-merge helper for plain objects (arrays/scalars are replaced). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function loadFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse config file ${path}`, { cause: err });
  }
}

/**
 * Parse a per-backend tag→list-name map from a JSON env var. Returns undefined
 * for an unset var; throws a clear error for malformed JSON or a non-object so
 * misconfiguration fails fast at startup.
 */
function parseTagListMapEnv(
  raw: string | undefined,
  name: string,
): Record<string, string> | undefined {
  if (!raw || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be a JSON object of {tag: listName}`, { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of {tag: listName}`);
  }
  const out: Record<string, string> = {};
  for (const [tag, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${name} values must be strings (tag "${tag}")`);
    }
    out[tag.replace(/^#/, "")] = value;
  }
  return out;
}

/** Read overrides from environment variables. */
function fromEnv(): Record<string, unknown> {
  const env = process.env;
  const out: Record<string, unknown> = {};
  const backends: Record<string, unknown> = {};

  if (env.TASK_SYNC_VAULT_PATH) out.vaultPath = env.TASK_SYNC_VAULT_PATH;
  if (env.TASK_SYNC_STATE_PATH) out.statePath = env.TASK_SYNC_STATE_PATH;
  if (env.TASK_SYNC_DRY_RUN) out.dryRun = env.TASK_SYNC_DRY_RUN === "true";
  if (env.TASK_SYNC_TODO_TAGS)
    out.tags = env.TASK_SYNC_TODO_TAGS.split(",")
      .map((s) => s.trim().replace(/^#/, ""))
      .filter(Boolean);
  if (env.TASK_SYNC_INBOX_FILE) out.inboundInboxFile = env.TASK_SYNC_INBOX_FILE;
  if (env.TASK_SYNC_IGNORE_PATHS)
    out.ignorePaths = env.TASK_SYNC_IGNORE_PATHS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (env.TASK_SYNC_INBOUND_INTERVAL_MS) {
    const n = Number(env.TASK_SYNC_INBOUND_INTERVAL_MS);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error("TASK_SYNC_INBOUND_INTERVAL_MS must be a positive integer (milliseconds)");
    }
    out.inboundIntervalMs = n;
  }
  if (env.TASK_SYNC_LOG_LEVEL)
    out.log = { level: env.TASK_SYNC_LOG_LEVEL as LogLevel };
  if (env.TASK_SYNC_TOKEN_KEY) out.tokenKey = env.TASK_SYNC_TOKEN_KEY;

  // Microsoft To Do
  const ms: Record<string, unknown> = {};
  if (env.MS_ENABLED) ms.enabled = env.MS_ENABLED === "true";
  if (env.MS_CLIENT_ID) ms.clientId = env.MS_CLIENT_ID;
  if (env.MS_AUTHORITY) ms.authority = env.MS_AUTHORITY;
  if (env.MS_SCOPES)
    ms.scopes = env.MS_SCOPES.split(",").map((s) => s.trim()).filter(Boolean);
  if (env.MS_TOKEN_CACHE_PATH) ms.tokenCachePath = env.MS_TOKEN_CACHE_PATH;
  const msTagMap = parseTagListMapEnv(env.MS_TAG_LIST_MAP, "MS_TAG_LIST_MAP");
  if (msTagMap) ms.tagListMap = msTagMap;
  if (Object.keys(ms).length > 0) backends.msTodo = ms;

  // Supernote
  const sn: Record<string, unknown> = {};
  const service: Record<string, unknown> = {};
  if (env.SUPERNOTE_ENABLED) sn.enabled = env.SUPERNOTE_ENABLED === "true";
  if (env.SUPERNOTE_SERVICE_URL) service.baseUrl = env.SUPERNOTE_SERVICE_URL;
  if (env.SUPERNOTE_API_KEY) service.apiKey = env.SUPERNOTE_API_KEY;
  if (env.SUPERNOTE_REQUEST_TIMEOUT_MS)
    service.requestTimeoutMs = Number(env.SUPERNOTE_REQUEST_TIMEOUT_MS);
  if (Object.keys(service).length > 0) sn.service = service;
  const snTagMap = parseTagListMapEnv(env.SUPERNOTE_TAG_LIST_MAP, "SUPERNOTE_TAG_LIST_MAP");
  if (snTagMap) sn.tagListMap = snTagMap;
  if (Object.keys(sn).length > 0) backends.supernote = sn;

  if (Object.keys(backends).length > 0) out.backends = backends;
  return out;
}

export interface LoadConfigOptions {
  /** Path to a JSON config file. Defaults to ./config.json then ./config.local.json. */
  configPath?: string;
  /** Programmatic overrides applied last (e.g. CLI flags). */
  overrides?: Record<string, unknown>;
  /** Skip reading process.env (useful for tests). */
  skipEnv?: boolean;
}

/**
 * Load, merge and validate configuration. Throws a single, readable error when
 * validation fails. Resolves filesystem paths to absolute form.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const filePaths = options.configPath
    ? [options.configPath]
    : ["config.json", "config.local.json"];

  let merged: Record<string, unknown> = {};
  for (const p of filePaths) {
    merged = deepMerge(merged, loadFile(resolve(p)));
  }
  if (!options.skipEnv) merged = deepMerge(merged, fromEnv());
  if (options.overrides) merged = deepMerge(merged, options.overrides);

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const config = parsed.data;
  config.vaultPath = resolve(config.vaultPath);
  config.statePath = resolve(config.statePath);

  validateCrossFields(config);
  return config;
}

/** Validation that spans multiple fields (zod handles per-field rules). */
function validateCrossFields(config: Config): void {
  const errors: string[] = [];
  if (config.backends.msTodo?.enabled) {
    if (!config.tokenKey) {
      errors.push(
        "tokenKey (TASK_SYNC_TOKEN_KEY) is required when the msTodo backend is enabled.",
      );
    }
    if (!config.backends.msTodo.clientId) {
      errors.push("backends.msTodo.clientId (MS_CLIENT_ID) is required when enabled.");
    }
  }
  if (config.backends.supernote?.enabled) {
    if (!config.backends.supernote.service.baseUrl) {
      errors.push(
        "backends.supernote.service.baseUrl (SUPERNOTE_SERVICE_URL) is required when enabled.",
      );
    }
    if (!config.backends.supernote.service.apiKey) {
      errors.push(
        "backends.supernote.service.apiKey (SUPERNOTE_API_KEY) is required when enabled.",
      );
    }
  }
  const anyBackend =
    config.backends.msTodo?.enabled || config.backends.supernote?.enabled;
  if (!anyBackend) {
    errors.push(
      "At least one backend must be enabled (backends.msTodo or backends.supernote).",
    );
  }
  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}
