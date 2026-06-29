/**
 * Vault file-system watcher.
 *
 * Watches a vault root for markdown changes and emits debounced, coalesced
 * change batches. Includes write-origin loop protection: when this service
 * writes a file (via the markdown writer), it calls {@link VaultWatcher.suppressNext}
 * so the resulting change event does not trigger a re-sync feedback loop.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import { isPathIgnored } from "../util/ignore.js";

export type ChangeKind = "add" | "change" | "unlink";

export interface VaultChange {
  /** Absolute path of the changed file. */
  absPath: string;
  /** Vault-relative path (POSIX separators). */
  relPath: string;
  kind: ChangeKind;
}

export type ChangeHandler = (changes: VaultChange[]) => void | Promise<void>;

export interface VaultWatcherOptions {
  vaultPath: string;
  /** Directory names to ignore anywhere in the tree. */
  ignore: string[];
  /** Vault-relative path prefixes to ignore (e.g. `Tasks/Templates`). */
  ignorePaths?: string[];
  /** Debounce window for coalescing events (ms). */
  debounceMs: number;
  logger?: Logger;
}

export class VaultWatcher {
  private watcher: FSWatcher | undefined;
  private readonly pending = new Map<string, ChangeKind>();
  private timer: NodeJS.Timeout | undefined;
  /** Paths recently written by us, to ignore the next change event. */
  private readonly suppressed = new Map<string, NodeJS.Timeout>();
  private readonly log: Logger;

  constructor(
    private readonly options: VaultWatcherOptions,
    private readonly onChanges: ChangeHandler,
  ) {
    this.log = options.logger ?? defaultLogger;
  }

  /**
   * Register a path so its next change event is ignored (loop protection).
   *
   * Suppression is a best-effort time window, not an exact match on our own
   * write event. Two edge cases follow from that, both bounded and self-healing:
   *  - If the FS event for our write arrives *after* the window (slow disk,
   *    large file), it is not suppressed and triggers one extra reconcile — which
   *    is idempotent (content hash unchanged), so it is harmless.
   *  - If a genuine *user* edit lands within the window right after our write, it
   *    is suppressed and not picked up until the next full reconcile pass.
   * The window is kept short to minimize the second case.
   */
  suppressNext(absPath: string, windowMs = 2000): void {
    const existing = this.suppressed.get(absPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => this.suppressed.delete(absPath), windowMs);
    if (typeof t.unref === "function") t.unref();
    this.suppressed.set(absPath, t);
  }

  private isIgnoredPath(absPath: string): boolean {
    const rel = relative(this.options.vaultPath, absPath);
    return isPathIgnored(rel, this.options.ignore, this.options.ignorePaths ?? []);
  }

  private enqueue(kind: ChangeKind, absPath: string): void {
    if (!absPath.endsWith(".md")) return;
    if (this.isIgnoredPath(absPath)) return;
    if (this.suppressed.has(absPath)) {
      this.log.debug("Suppressed self-write event", { absPath });
      return;
    }
    // A later kind for the same path supersedes earlier ones in the batch,
    // except unlink which always wins.
    const prev = this.pending.get(absPath);
    if (prev === "unlink") return;
    this.pending.set(absPath, kind);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.options.debounceMs);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const changes: VaultChange[] = [...this.pending.entries()].map(
      ([absPath, kind]) => ({
        absPath,
        relPath: relative(this.options.vaultPath, absPath).split(sep).join("/"),
        kind,
      }),
    );
    this.pending.clear();
    try {
      await this.onChanges(changes);
    } catch (err) {
      this.log.error("Change handler failed", { err });
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.watcher = chokidar.watch(this.options.vaultPath, {
        ignoreInitial: false,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      this.watcher
        .on("add", (p) => this.enqueue("add", p))
        .on("change", (p) => this.enqueue("change", p))
        .on("unlink", (p) => this.enqueue("unlink", p))
        .on("error", (err) => this.log.error("Watcher error", { err }))
        .on("ready", () => {
          this.log.info("Vault watcher ready", {
            vaultPath: this.options.vaultPath,
          });
          resolve();
        });
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.suppressed.values()) clearTimeout(t);
    this.suppressed.clear();
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
