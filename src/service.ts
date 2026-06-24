/**
 * Service wiring: composes configuration, logging, state, the backend registry,
 * the sync engine, the vault watcher and the health server into a runnable unit
 * with a clean lifecycle and graceful shutdown.
 */
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { StateStore } from "./state/stateStore.js";
import { BackendRegistry } from "./sync/backendRegistry.js";
import { SyncEngine } from "./sync/syncEngine.js";
import { VaultWatcher, type VaultChange } from "./watcher/vaultWatcher.js";
import { HealthServer } from "./health/httpServer.js";
import type { MappingOptions } from "./mapping/listMapping.js";

export interface ServiceOptions {
  /** Run a single reconcile pass then exit (no watcher/timers). */
  once?: boolean;
  /** Observe-only: never write to the vault or any backend. */
  dryRun?: boolean;
  /** Interval (ms) for periodic inbound pulls in watch mode. */
  inboundIntervalMs?: number;
}

export class Service {
  private readonly log: Logger;
  private readonly store: StateStore;
  private registry?: BackendRegistry;
  private engine?: SyncEngine;
  private watcher?: VaultWatcher;
  private health?: HealthServer;
  private inboundTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private healthy = true;
  private running = false;
  private lastError: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly options: ServiceOptions = {},
  ) {
    this.log = createLogger(config.log.level);
    this.store = new StateStore(config.statePath);
  }

  private mappingOptions(): MappingOptions {
    return {
      strategy: this.config.listMapping,
      tagListMap: {
        ...this.config.backends.msTodo?.tagListMap,
        ...this.config.backends.supernote?.tagListMap,
      },
    };
  }

  /** Start the service. In `once` mode resolves after a single pass. */
  async start(): Promise<void> {
    const dryRun = this.options.dryRun ?? this.config.dryRun;
    this.log.info("Starting task-sync", {
      vaultPath: this.config.vaultPath,
      dryRun,
      once: this.options.once ?? false,
    });

    await mkdir(dirname(this.config.statePath), { recursive: true });
    await this.store.load();

    this.registry = BackendRegistry.fromConfig(this.config, this.log);
    await this.registry.initAll();

    // The watcher is created early (but not started) so the engine can use its
    // suppressNext hook for loop protection on every write.
    if (!this.options.once) {
      this.watcher = new VaultWatcher(
        {
          vaultPath: this.config.vaultPath,
          ignore: this.config.ignore,
          debounceMs: this.config.watchDebounceMs,
          logger: this.log,
        },
        (changes) => this.onVaultChanges(changes),
      );
    }

    this.engine = new SyncEngine(this.registry.entries(), this.store, {
      vaultPath: this.config.vaultPath,
      ignore: this.config.ignore,
      mapping: this.mappingOptions(),
      dryRun,
      inboundInboxFile: this.config.inboundInboxFile,
      ...(this.watcher
        ? { suppressNext: (p: string) => this.watcher?.suppressNext(p) }
        : {}),
      logger: this.log,
    });

    if (this.config.health.enabled && !this.options.once) {
      this.health = new HealthServer({
        host: this.config.health.host,
        port: this.config.health.port,
        isReady: () => this.ready,
        isHealthy: () => this.healthy,
        details: () => ({
          running: this.running,
          ...(this.lastError ? { lastError: this.lastError } : {}),
        }),
        logger: this.log,
      });
      await this.health.start();
    }

    // Initial full reconcile.
    await this.runSafely(async () => {
      const r = await this.engine!.reconcile();
      this.log.info("Initial reconcile complete", { ...r });
    });

    if (this.options.once) {
      await this.stop();
      return;
    }

    await this.watcher!.start();

    // Periodic full reconcile catches inbound changes (status edits to existing
    // tasks and brand-new external tasks) that no vault file-change event fires.
    const intervalMs = this.options.inboundIntervalMs ?? 60_000;
    this.inboundTimer = setInterval(() => {
      void this.runSafely(async () => {
        const r = await this.engine!.reconcile();
        if (r.updatedInbound > 0 || r.inboundCreated > 0) {
          this.log.info("Periodic reconcile applied inbound changes", { ...r });
        }
      });
    }, intervalMs);
    if (typeof this.inboundTimer.unref === "function") this.inboundTimer.unref();

    this.ready = true;
    this.log.info("task-sync ready");
  }

  private async onVaultChanges(changes: VaultChange[]): Promise<void> {
    const paths = changes
      .filter((c) => c.kind !== "unlink")
      .map((c) => c.absPath);
    if (paths.length === 0) return;
    await this.runSafely(async () => {
      const r = await this.engine!.reconcileChangedFiles(paths);
      this.log.info("Incremental reconcile complete", { files: paths.length, ...r });
    });
  }

  /** Run a unit of work, isolating and recording errors without crashing. */
  private async runSafely(fn: () => Promise<void>): Promise<void> {
    if (this.running) {
      // Serialize passes to avoid concurrent writes to the same files.
      this.log.debug("Reconcile already running; skipping overlap");
      return;
    }
    this.running = true;
    try {
      await fn();
      this.lastError = undefined;
    } catch (err) {
      this.healthy = true; // a single failed pass is not fatal
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.error("Reconcile pass failed", { err });
    } finally {
      this.running = false;
    }
  }

  /** Gracefully stop: drain timers, watcher, health server and backends. */
  async stop(): Promise<void> {
    this.ready = false;
    if (this.inboundTimer) clearInterval(this.inboundTimer);
    this.inboundTimer = undefined;
    await this.watcher?.stop();
    await this.health?.stop();
    await this.registry?.closeAll(this.log);
    try {
      await this.store.flush();
    } catch (err) {
      this.log.warn("Failed to flush state on shutdown", { err });
    }
    this.log.info("task-sync stopped");
  }
}
