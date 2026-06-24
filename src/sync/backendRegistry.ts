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
  private constructor(private readonly backends: BackendEntry[]) {}

  /** Build the registry from validated config. Does not perform I/O. */
  static fromConfig(config: Config, logger: Logger): BackendRegistry {
    const entries: BackendEntry[] = [];

    const ms = config.backends.msTodo;
    if (ms?.enabled) {
      if (!config.tokenKey) {
        throw new Error("tokenKey is required to enable the msTodo backend.");
      }
      const key = parseKey(config.tokenKey);
      entries.push({
        adapter: createMsTodoAdapter(ms, key, logger.child({ backend: "ms-todo" })),
        conflictPolicy: ms.conflictPolicy,
        tagListMap: ms.tagListMap,
      });
    }

    const sn = config.backends.supernote;
    if (sn?.enabled) {
      entries.push({
        adapter: createSupernoteAdapter(sn, logger.child({ backend: "supernote" })),
        conflictPolicy: sn.conflictPolicy,
        tagListMap: sn.tagListMap,
      });
    }

    if (entries.length === 0) {
      throw new Error("No backends are enabled.");
    }
    return new BackendRegistry(entries);
  }

  entries(): readonly BackendEntry[] {
    return this.backends;
  }

  /** Initialize every adapter (auth, DB connect). */
  async initAll(): Promise<void> {
    for (const e of this.backends) {
      await e.adapter.init?.();
    }
  }

  /** Gracefully close every adapter. Errors are swallowed per-adapter. */
  async closeAll(logger?: Logger): Promise<void> {
    for (const e of this.backends) {
      try {
        await e.adapter.close?.();
      } catch (err) {
        logger?.warn("Adapter close failed", { backend: e.adapter.backend, err });
      }
    }
  }
}
