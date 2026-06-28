/**
 * Structured JSON logger.
 *
 * Emits one JSON object per line to stdout (stderr for warn/error), suitable
 * for container log collectors. Includes a configurable level threshold and
 * best-effort redaction of secret-bearing keys so tokens/passwords never leak
 * into logs.
 *
 * Use this logger — never `console` — everywhere in `src/`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys whose values are redacted anywhere in a log payload. */
const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|clientsecret|client_secret|authorization|apikey|api_key|refresh_token|access_token|key)/i;

const REDACTED = "[redacted]";

export type LogFields = Record<string, unknown>;

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    // NOTE: `message` and `stack` are emitted verbatim and are NOT value-scrubbed
    // (key-name redaction below only inspects field names). Callers must never
    // interpolate secrets or raw upstream response bodies into error messages —
    // the HTTP clients deliberately keep response bodies off the message and only
    // on a typed `.body` field, which we do not log here.
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
    };
  }
  return err;
}

export interface Logger {
  level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

interface LoggerState {
  level: LogLevel;
  bindings: LogFields;
}

function emit(state: LoggerState, level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;

  const merged: LogFields = { ...state.bindings, ...fields };
  if (merged.err !== undefined) merged.err = serializeError(merged.err);
  if (merged.error !== undefined) merged.error = serializeError(merged.error);

  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(redact(merged, new WeakSet()) as LogFields),
  };

  const line = JSON.stringify(record);
  if (level === "warn" || level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function build(state: LoggerState): Logger {
  return {
    get level() {
      return state.level;
    },
    set level(l: LogLevel) {
      state.level = l;
    },
    debug: (msg, fields) => emit(state, "debug", msg, fields),
    info: (msg, fields) => emit(state, "info", msg, fields),
    warn: (msg, fields) => emit(state, "warn", msg, fields),
    error: (msg, fields) => emit(state, "error", msg, fields),
    child: (bindings) =>
      build({ level: state.level, bindings: { ...state.bindings, ...bindings } }),
  };
}

/** Create a logger with the given minimum level. */
export function createLogger(level: LogLevel = "info"): Logger {
  return build({ level, bindings: {} });
}

/** Shared default logger; level is reconfigured at startup from config. */
export const logger: Logger = createLogger(
  (process.env.TASK_SYNC_LOG_LEVEL as LogLevel | undefined) ?? "info",
);
