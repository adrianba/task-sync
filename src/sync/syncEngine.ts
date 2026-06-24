/**
 * Bidirectional sync engine with multi-target fan-out.
 *
 * Performs 3-way reconciliation between the Obsidian vault (markdown), the local
 * state store (last-known baseline per backend), and each enabled external
 * backend. A single vault task fans out to every backend; state is keyed by
 * `(syncId, backend)`.
 *
 * Two entry points:
 *  - {@link reconcile} — full pass (used on startup / recovery).
 *  - {@link reconcileChangedFiles} — incremental outbound for changed files.
 *  - {@link pullInbound} — incremental inbound via backend delta / listing.
 *
 * All file mutations go through the markdown writer (atomic + optimistic
 * concurrency) and notify `suppressNext` to avoid watcher feedback loops.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Task } from "../model/task.js";
import type {
  ExternalTask,
  ExternalTaskInput,
} from "../adapters/types.js";
import type { Logger } from "../logger.js";
import { parseTasks } from "../vault/document.js";
import { statusToChar } from "../vault/taskMeta.js";
import {
  resolveListKey,
  generateSyncId,
  type MappingOptions,
} from "../mapping/listMapping.js";
import { StateStore, hashTask } from "../state/stateStore.js";
import {
  applyMutations,
  appendLines,
  type TaskMutation,
} from "../writer/markdownWriter.js";
import { resolveConflict } from "./conflict.js";
import type { BackendEntry } from "./backendRegistry.js";
import { DeltaTokenExpiredError } from "../adapters/msTodo/msTodoAdapter.js";

export interface SyncEngineOptions {
  vaultPath: string;
  ignore: string[];
  mapping: MappingOptions;
  /** When true, never write to markdown or any external system. */
  dryRun: boolean;
  /** Vault-relative note that receives externally-created tasks. */
  inboundInboxFile: string;
  /** Loop-protection hook (e.g. VaultWatcher.suppressNext). */
  suppressNext?: (absPath: string) => void;
  logger: Logger;
}

export interface ReconcileResult {
  idsAssigned: number;
  createdOutbound: number;
  updatedOutbound: number;
  updatedInbound: number;
  inboundCreated: number;
  conflicts: number;
}

function emptyResult(): ReconcileResult {
  return {
    idsAssigned: 0,
    createdOutbound: 0,
    updatedOutbound: 0,
    updatedInbound: 0,
    inboundCreated: 0,
    conflicts: 0,
  };
}

/** Build an ExternalTaskInput, omitting undefined optional fields. */
function toInput(task: Task): ExternalTaskInput {
  const input: ExternalTaskInput = {
    title: task.description,
    status: task.status,
  };
  if (task.fields.due !== undefined) input.due = task.fields.due;
  if (task.fields.start !== undefined) input.start = task.fields.start;
  if (task.fields.done !== undefined) input.done = task.fields.done;
  if (task.fields.priority !== undefined) input.priority = task.fields.priority;
  return input;
}

export class SyncEngine {
  private readonly log: Logger;

  constructor(
    private readonly backends: readonly BackendEntry[],
    private readonly store: StateStore,
    private readonly options: SyncEngineOptions,
  ) {
    this.log = options.logger;
  }

  // --- vault scanning -----------------------------------------------------

  private isIgnored(rel: string): boolean {
    return rel.split(sep).some((s) => this.options.ignore.includes(s));
  }

  private async listMarkdownFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(this.options.vaultPath, abs);
      if (this.isIgnored(rel)) continue;
      if (e.isDirectory()) out.push(...(await this.listMarkdownFiles(abs)));
      else if (e.name.endsWith(".md")) out.push(abs);
    }
    return out;
  }

  /** Parse one file into tasks with `listKey` resolved. */
  private async parseFile(absPath: string): Promise<Task[]> {
    const rel = relative(this.options.vaultPath, absPath).split(sep).join("/");
    const content = await readFile(absPath, "utf8");
    const tasks = parseTasks(content, rel);
    for (const t of tasks) {
      t.listKey = resolveListKey(t, this.options.mapping);
    }
    return tasks;
  }

  // --- public entry points ------------------------------------------------

  /** Run a full reconciliation pass over the whole vault. */
  async reconcile(): Promise<ReconcileResult> {
    const files = await this.listMarkdownFiles(this.options.vaultPath);
    const result = await this.reconcileFiles(files, false);
    result.inboundCreated += await this.pullInbound();
    if (!this.options.dryRun) await this.store.flush();
    return result;
  }

  /**
   * Incremental outbound reconcile for a set of changed files (absolute paths).
   * Skips files whose content hash is unchanged since the last pass.
   */
  async reconcileChangedFiles(absPaths: string[]): Promise<ReconcileResult> {
    const relevant = absPaths.filter(
      (p) =>
        p.endsWith(".md") &&
        !this.isIgnored(relative(this.options.vaultPath, p)) &&
        existsSync(p),
    );
    const result = await this.reconcileFiles(relevant, true);
    if (!this.options.dryRun) await this.store.flush();
    return result;
  }

  /**
   * @param useFileHashSkip when true, skip files whose content hash is unchanged
   *   since the last pass (a safe optimization for watcher-driven incremental
   *   runs). The full {@link reconcile} pass disables this so inbound changes to
   *   tasks in otherwise-unchanged files are still detected.
   */
  private async reconcileFiles(
    absPaths: string[],
    useFileHashSkip: boolean,
  ): Promise<ReconcileResult> {
    const result = emptyResult();

    for (const abs of absPaths) {
      const rel = relative(this.options.vaultPath, abs).split(sep).join("/");
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch (err) {
        this.log.warn("Failed to read file; skipping", { file: rel, err });
        continue;
      }

      const fileHash = hashContent(content);
      if (useFileHashSkip && this.store.getFileHash(rel) === fileHash) continue;

      let tasks = await this.parseFile(abs);

      // Phase 1: assign missing sync IDs by writing them into the markdown.
      const idAssigned = await this.assignMissingIds(abs, tasks, result);
      if (idAssigned && !this.options.dryRun) {
        // Re-read so locations/rawLines reflect the written IDs.
        tasks = await this.parseFile(abs);
      }

      // Phase 2: outbound/3-way reconcile per task across all backends.
      for (const task of tasks) {
        if (!task.syncId) continue; // dry-run with unassigned ids
        await this.reconcileTaskAcrossBackends(abs, task, result);
      }

      if (!this.options.dryRun) {
        // Hash the post-write content so the next pass can skip unchanged files.
        const after = await readFile(abs, "utf8").catch(() => content);
        this.store.setFileHash(rel, hashContent(after));
      }
    }

    return result;
  }

  private async assignMissingIds(
    absPath: string,
    tasks: Task[],
    result: ReconcileResult,
  ): Promise<boolean> {
    const missing = tasks.filter((t) => !t.syncId);
    if (missing.length === 0) return false;

    const mutations: TaskMutation[] = missing.map((t) => ({
      line: t.location.line,
      expectedLine: t.rawLine,
      syncId: generateSyncId(),
    }));
    result.idsAssigned += missing.length;

    if (this.options.dryRun) return false;
    await applyMutations(absPath, mutations, {
      ...(this.options.suppressNext
        ? { onWillWrite: this.options.suppressNext }
        : {}),
    });
    return true;
  }

  private async reconcileTaskAcrossBackends(
    absPath: string,
    task: Task,
    result: ReconcileResult,
  ): Promise<void> {
    let current = task;
    for (const entry of this.backends) {
      try {
        current = await this.reconcileTaskToBackend(absPath, current, entry, result);
      } catch (err) {
        // Isolate backend failures so one backend cannot break the others.
        this.log.error("Backend reconcile failed for task", {
          backend: entry.adapter.backend,
          syncId: current.syncId,
          err,
        });
      }
    }
  }

  /**
   * Reconcile one task with one backend. Returns the (possibly updated) task so
   * a subsequent backend in the fan-out sees the latest in-memory state after
   * an inbound write.
   */
  private async reconcileTaskToBackend(
    absPath: string,
    task: Task,
    entry: BackendEntry,
    result: ReconcileResult,
  ): Promise<Task> {
    const backend = entry.adapter.backend;
    const syncId = task.syncId;
    if (!syncId) return task;

    const listName = task.listKey ?? "Inbox";
    const curHash = hashTask(task);
    const link = this.store.getLink(syncId, backend);

    // New task → create in the external system.
    if (!link) {
      result.createdOutbound++;
      if (this.options.dryRun) return task;
      const listId = await entry.adapter.ensureList(listName);
      const ext = await entry.adapter.createTask(listId, toInput(task));
      this.store.setLink({
        syncId,
        backend,
        externalId: ext.externalId,
        externalListId: listId,
        lastKnownHash: curHash,
        ...(ext.lastModified !== undefined
          ? { lastExternalModified: ext.lastModified }
          : {}),
        lastSyncedAt: new Date().toISOString(),
      });
      return task;
    }

    const listId = link.externalListId ?? (await entry.adapter.ensureList(listName));
    const ext = await entry.adapter.getTask(listId, link.externalId);

    // External task vanished — recreate it outbound.
    if (!ext) {
      result.createdOutbound++;
      if (this.options.dryRun) return task;
      const recreated = await entry.adapter.createTask(listId, toInput(task));
      this.store.setLink({
        ...link,
        externalId: recreated.externalId,
        externalListId: listId,
        lastKnownHash: curHash,
        ...(recreated.lastModified !== undefined
          ? { lastExternalModified: recreated.lastModified }
          : {}),
        lastSyncedAt: new Date().toISOString(),
      });
      return task;
    }

    const vaultChanged = curHash !== link.lastKnownHash;
    const externalChanged =
      ext.lastModified !== undefined &&
      ext.lastModified !== link.lastExternalModified;

    if (!vaultChanged && !externalChanged) return task;

    let direction: "outbound" | "inbound";
    if (vaultChanged && !externalChanged) direction = "outbound";
    else if (!vaultChanged && externalChanged) direction = "inbound";
    else {
      result.conflicts++;
      const mtimeMs = existsSync(absPath)
        ? (await stat(absPath)).mtime.getTime()
        : 0;
      direction = resolveConflict(entry.conflictPolicy, {
        vaultMtimeMs: mtimeMs,
        externalModified: ext.lastModified,
      });
      this.log.warn("Sync conflict resolved", {
        backend,
        syncId,
        policy: entry.conflictPolicy,
        direction,
      });
    }

    if (direction === "outbound") {
      result.updatedOutbound++;
      if (this.options.dryRun) return task;
      const updated = await entry.adapter.updateTask(
        listId,
        link.externalId,
        toInput(task),
      );
      this.store.setLink({
        ...link,
        externalListId: listId,
        lastKnownHash: curHash,
        ...(updated.lastModified !== undefined
          ? { lastExternalModified: updated.lastModified }
          : {}),
        lastSyncedAt: new Date().toISOString(),
      });
      return task;
    }

    // inbound
    result.updatedInbound++;
    if (this.options.dryRun) return task;
    const updatedTask = await this.applyInbound(absPath, task, ext);
    this.store.setLink({
      ...link,
      externalListId: listId,
      lastKnownHash: hashTask(updatedTask),
      ...(ext.lastModified !== undefined
        ? { lastExternalModified: ext.lastModified }
        : {}),
      lastSyncedAt: new Date().toISOString(),
    });
    return updatedTask;
  }

  /** Apply an external change onto the vault line and return the new task. */
  private async applyInbound(
    absPath: string,
    task: Task,
    ext: ExternalTask,
  ): Promise<Task> {
    const mutation: TaskMutation = {
      line: task.location.line,
      expectedLine: task.rawLine,
      statusChar: statusToChar(ext.status, task.statusChar),
      ...(ext.done !== undefined ? { doneDate: ext.done } : {}),
      ...(ext.due !== undefined ? { dueDate: ext.due } : {}),
    };
    await applyMutations(absPath, [mutation], {
      ...(this.options.suppressNext
        ? { onWillWrite: this.options.suppressNext }
        : {}),
    });

    // Refresh the in-memory task so subsequent backends see the new state.
    const fresh = await this.parseFile(absPath);
    const match = fresh.find((t) => t.syncId === task.syncId);
    return match ?? mergeInbound(task, ext);
  }

  // --- inbound creation (delta / listing) ---------------------------------

  /**
   * Pull tasks that exist in a backend but have no local link, appending them
   * to the shared Sync Inbox note. Uses delta when available, else full listing.
   * Returns the number of new tasks created locally.
   */
  async pullInbound(): Promise<number> {
    if (this.options.dryRun) return 0;
    const inboxAbs = join(this.options.vaultPath, this.options.inboundInboxFile);
    let created = 0;

    for (const entry of this.backends) {
      const backend = entry.adapter.backend;
      try {
        const lists = await entry.adapter.listLists();
        for (const list of lists) {
          const externals = await this.fetchExternalTasks(entry, list.id, list.name);
          for (const ext of externals) {
            if (this.hasLinkForExternal(backend, ext.externalId)) continue;
            await this.createInboundTask(inboxAbs, list.name, ext, backend);
            created++;
          }
        }
      } catch (err) {
        this.log.error("Inbound pull failed", { backend, err });
      }
    }

    return created;
  }

  private async fetchExternalTasks(
    entry: BackendEntry,
    listId: string,
    listName: string,
  ): Promise<ExternalTask[]> {
    const backend = entry.adapter.backend;
    if (typeof entry.adapter.delta === "function") {
      const prev = this.store.getDeltaToken(backend, listId);
      try {
        const res = await entry.adapter.delta(listId, prev);
        this.store.setDeltaToken(backend, listId, res.token);
        return res.changed;
      } catch (err) {
        if (err instanceof DeltaTokenExpiredError) {
          this.log.warn("Delta token expired; full resync", { backend, listName });
          // fall through to full listing below
        } else {
          throw err;
        }
      }
    }
    return entry.adapter.listTasks(listId);
  }

  private hasLinkForExternal(backend: string, externalId: string): boolean {
    return this.store
      .allLinks()
      .some((l) => l.backend === backend && l.externalId === externalId);
  }

  private async createInboundTask(
    inboxAbs: string,
    listName: string,
    ext: ExternalTask,
    backend: string,
  ): Promise<void> {
    const syncId = generateSyncId();
    const statusChar = statusToChar(ext.status);
    const due = ext.due ? ` 📅 ${ext.due}` : "";
    const done = ext.done ? ` ✅ ${ext.done}` : "";
    const tag = listName && listName !== "Inbox" ? ` #${slugTag(listName)}` : "";
    const line = `- [${statusChar}] ${ext.title}${tag}${due}${done} <!-- sync-id: ${syncId} -->`;

    const opts = {
      ...(this.options.suppressNext
        ? { onWillWrite: this.options.suppressNext }
        : {}),
    };
    if (!existsSync(inboxAbs)) {
      await appendLines(inboxAbs, ["# Sync Inbox", "", line], opts);
    } else {
      await appendLines(inboxAbs, [line], opts);
    }

    this.store.setLink({
      syncId,
      backend,
      externalId: ext.externalId,
      externalListId: ext.listId,
      ...(ext.lastModified !== undefined
        ? { lastExternalModified: ext.lastModified }
        : {}),
      lastSyncedAt: new Date().toISOString(),
    });
  }
}

import { createHash } from "node:crypto";

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Best-effort in-memory merge when re-parsing cannot find the task. */
function mergeInbound(task: Task, ext: ExternalTask): Task {
  const fields = { ...task.fields };
  if (ext.due !== undefined) fields.due = ext.due;
  if (ext.done !== undefined) fields.done = ext.done;
  return {
    ...task,
    status: ext.status,
    statusChar: statusToChar(ext.status, task.statusChar),
    fields,
  };
}

/** Turn a list display name into a safe single tag token. */
function slugTag(name: string): string {
  return name.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
}
