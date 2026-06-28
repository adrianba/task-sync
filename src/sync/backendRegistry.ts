/**
 * Backend registry: builds and owns the set of enabled `SyncAdapter`s from
 * configuration, pairing each with its conflict policy. The sync engine fans
 * out to every entry, so adding a backend never requires engine changes.
 */
import type { SyncAdapter } from "../adapters/types.js";
import type { Config, ConflictPolicy } from "../config.js";
import type { Logger } from "../logger.js";
import { parseKey } from "../util/crypto.js";
import { createMsTodoAdapter } from "../adapters/msTodo/msTodoAdapter.js";
import { createSupernoteAdapter } from "../adapters/supernote/supernoteAdapter.js";

export interface BackendEntry {
  adapter: SyncAdapter;
  conflictPolicy: ConflictPolicy;
  /** Per-backend explicit tag → list display-name overrides. */
  tagListMap: Record<string, string>;
}

export class BackendRegistry {
  private initializedBackends: BackendEntry[] | undefined;

  constructor(private readonly backends: BackendEntry[]) {
    if (backends.length === 0) {
      throw new Error("No backends are enabled.");
    }
  }

  /**
   * Build the registry from validated config. Does not perform I/O.
   *
   * @param signal optional shutdown signal threaded into each backend's HTTP
   *   client so in-flight requests and retry back-off sleeps abort promptly on
   *   graceful shutdown.
   */
  static fromConfig(config: Config, logger: Logger, signal?: AbortSignal): BackendRegistry {
    const entries: BackendEntry[] = [];

    const ms = config.backends.msTodo;
    if (ms?.enabled) {
      if (!config.tokenKey) {
        throw new Error("tokenKey is required to enable the msTodo backend.");
      }
      const key = parseKey(config.tokenKey);
      entries.push({
        adapter: createMsTodoAdapter(ms, key, logger.child({ backend: "ms-todo" }), signal),
        conflictPolicy: ms.conflictPolicy,
        tagListMap: ms.tagListMap,
      });
    }

    const sn = config.backends.supernote;
    if (sn?.enabled) {
      entries.push({
        adapter: createSupernoteAdapter(sn, logger.child({ backend: "supernote" }), signal),
        conflictPolicy: sn.conflictPolicy,
        tagListMap: sn.tagListMap,
      });
    }

    return new BackendRegistry(entries);
  }

  entries(): readonly BackendEntry[] {
    return this.initializedBackends ?? this.backends;
  }

  healthyBackends(): readonly string[] {
    return this.entries().map((e) => e.adapter.backend);
  }

  /** Initialize every adapter (auth, DB connect), excluding degraded backends. */
  async initAll(logger?: Logger): Promise<void> {
    const initialized: BackendEntry[] = [];
    for (const e of this.backends) {
      try {
        await e.adapter.init?.();
        initialized.push(e);
      } catch (err) {
        logger?.error("Backend initialization failed; excluding backend from this run", {
          backend: e.adapter.backend,
          err,
        });
      }
    }
    this.initializedBackends = initialized;
    if (initialized.length === 0) {
      throw new Error("No backends initialized successfully.");
    }
  }

  /** Gracefully close every adapter. Errors are swallowed per-adapter. */
  async closeAll(logger?: Logger): Promise<void> {
    for (const e of this.initializedBackends ?? []) {
      try {
        await e.adapter.close?.();
      } catch (err) {
        logger?.warn("Adapter close failed", { backend: e.adapter.backend, err });
      }
    }
  }
}
