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

const supernoteDbSchema = z.object({
  host: z.string().default("supernote-mariadb"),
  port: z.number().int().positive().default(3306),
  user: z.string().default("supernote"),
  password: z.string().default(""),
  database: z.string().default("supernotedb"),
  /** Private-cloud user scope (single-user default). */
  userId: z.number().int().nonnegative().default(1),
  /** Optional connection timeout (ms). */
  connectTimeoutMs: z.number().int().positive().default(10_000),
});

const supernoteBackendSchema = z.object({
  enabled: z.boolean().default(false),
  conflictPolicy: conflictPolicy.default("vault-wins"),
  db: supernoteDbSchema,
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
  listMapping: z.enum(["tag", "file", "hybrid"]).default("hybrid"),
  watchDebounceMs: z.number().int().positive().default(300),
  /** Default conflict policy; each backend may override. */
  conflictPolicy: conflictPolicy.default("newer"),
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
export type SupernoteDbConfig = z.infer<typeof supernoteDbSchema>;

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

/** Read overrides from environment variables. */
function fromEnv(): Record<string, unknown> {
  const env = process.env;
  const out: Record<string, unknown> = {};
  const backends: Record<string, unknown> = {};

  if (env.TASK_SYNC_VAULT_PATH) out.vaultPath = env.TASK_SYNC_VAULT_PATH;
  if (env.TASK_SYNC_STATE_PATH) out.statePath = env.TASK_SYNC_STATE_PATH;
  if (env.TASK_SYNC_DRY_RUN) out.dryRun = env.TASK_SYNC_DRY_RUN === "true";
  if (env.TASK_SYNC_LIST_MAPPING) out.listMapping = env.TASK_SYNC_LIST_MAPPING;
  if (env.TASK_SYNC_CONFLICT_POLICY)
    out.conflictPolicy = env.TASK_SYNC_CONFLICT_POLICY;
  if (env.TASK_SYNC_INBOX_FILE) out.inboundInboxFile = env.TASK_SYNC_INBOX_FILE;
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
  if (Object.keys(ms).length > 0) backends.msTodo = ms;

  // Supernote
  const sn: Record<string, unknown> = {};
  const db: Record<string, unknown> = {};
  if (env.SUPERNOTE_ENABLED) sn.enabled = env.SUPERNOTE_ENABLED === "true";
  if (env.SUPERNOTE_DB_HOST) db.host = env.SUPERNOTE_DB_HOST;
  if (env.SUPERNOTE_DB_PORT) db.port = Number(env.SUPERNOTE_DB_PORT);
  if (env.SUPERNOTE_DB_USER) db.user = env.SUPERNOTE_DB_USER;
  if (env.SUPERNOTE_DB_PASSWORD) db.password = env.SUPERNOTE_DB_PASSWORD;
  if (env.SUPERNOTE_DB_NAME) db.database = env.SUPERNOTE_DB_NAME;
  if (env.SUPERNOTE_USER_ID) db.userId = Number(env.SUPERNOTE_USER_ID);
  if (Object.keys(db).length > 0) sn.db = db;
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
  if (config.backends.supernote?.enabled && !config.backends.supernote.db.password) {
    errors.push(
      "backends.supernote.db.password (SUPERNOTE_DB_PASSWORD) is required when enabled.",
    );
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
