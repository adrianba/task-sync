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
import type { ExternalLink, Task } from "../model/task.js";
import type {
  ExternalTask,
  ExternalTaskInput,
} from "../adapters/types.js";
import { ExternalConflictError } from "../adapters/types.js";
import type { Logger } from "../logger.js";
import { parseDocument, parseTree } from "../vault/document.js";
import { normalizeTag, resolveBlockTags } from "../vault/blocks.js";
import { statusToChar } from "../vault/taskMeta.js";
import {
  resolveListKey,
  generateSyncId,
  listNameToTag,
  type MappingOptions,
} from "../mapping/listMapping.js";
import { StateStore, hashTask } from "../state/stateStore.js";
import {
  applyMutations,
  appendLines,
  insertLineAfter,
  reorderTaskLines,
  type ApplyResult,
  type ReorderItem,
  type TaskMutation,
} from "../writer/markdownWriter.js";
import { resolveConflict } from "./conflict.js";
import type { BackendEntry } from "./backendRegistry.js";
import { DeltaTokenExpiredError } from "../adapters/msTodo/msTodoAdapter.js";

export interface SyncEngineOptions {
  vaultPath: string;
  ignore: string[];
  mapping: MappingOptions;
  /** Defined checklist tags whose blocks are synced (without leading '#'). */
  definedTags: string[];
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
  deletedExternal: number;
  conflicts: number;
  /** Tasks whose order was pushed to a backend (sort updates). */
  reorderedOutbound: number;
  /** Tasks whose markdown line was moved to reflect a backend's order. */
  reorderedInbound: number;
}

function emptyResult(): ReconcileResult {
  return {
    idsAssigned: 0,
    createdOutbound: 0,
    updatedOutbound: 0,
    updatedInbound: 0,
    inboundCreated: 0,
    deletedExternal: 0,
    conflicts: 0,
    reorderedOutbound: 0,
    reorderedInbound: 0,
  };
}

interface ReconcileFilesResult {
  result: ReconcileResult;
  seenSyncIds: Set<string>;
  hadReadError: boolean;
  /** True if any scanned file contained a checkbox item (in scope or not). */
  sawCheckboxItem: boolean;
}

interface InboundApplyResult {
  task: Task;
  apply: ApplyResult;
}

interface FetchedExternalTasks {
  changed: ExternalTask[];
  removedIds: string[];
}

/** A linked vault task participating in per-list ordering reconciliation. */
interface OrderMember {
  syncId: string;
  link: ExternalLink;
  absPath: string;
  filePath: string;
  line: number;
  expectedLine: string;
}

/** A parsed file kept in memory for the ordering pass. */
interface ParsedFile {
  absPath: string;
  filePath: string;
  tasks: Task[];
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
    return this.parseTasksFromContent(content, rel);
  }

  private parseTasksFromContent(content: string, rel: string): Task[] {
    return this.parseDocumentFromContent(content, rel).tasks;
  }

  private parseDocumentFromContent(
    content: string,
    rel: string,
  ): { tasks: Task[]; hasCheckboxItems: boolean } {
    const { tasks, hasCheckboxItems } = parseDocument(content, rel, this.options.definedTags);
    for (const t of tasks) {
      const listKey = resolveListKey(t, this.options.mapping);
      if (listKey !== undefined) t.listKey = listKey;
    }
    return { tasks, hasCheckboxItems };
  }

  /**
   * Resolve the external list name for a task **per backend** from its block
   * tag, applying that backend's own `tagListMap`. This keeps one backend's
   * tag→list overrides from leaking into another and lets the same task land in
   * differently-named lists per backend. Returns `undefined` if out of scope.
   */
  private resolveListForBackend(task: Task, entry: BackendEntry): string | undefined {
    return resolveListKey(task, { tagListMap: entry.tagListMap });
  }

  private hasDefinedTags(): boolean {
    return this.options.definedTags.some((tag) => normalizeTag(tag) !== "");
  }

  // --- public entry points ------------------------------------------------

  /** Run a full reconciliation pass over the whole vault. */
  async reconcile(): Promise<ReconcileResult> {
    const files = await this.listMarkdownFiles(this.options.vaultPath);
    const filesResult = await this.reconcileFiles(files, false);
    const result = filesResult.result;
    if (!this.options.dryRun && !filesResult.hadReadError) {
      if (!this.hasDefinedTags()) {
        this.log.error("Skipping deletion sweep because no defined task tags are configured");
      } else if (filesResult.sawCheckboxItem && filesResult.seenSyncIds.size === 0 && this.store.allLinks().length > 0) {
        // The vault still contains checklist items, yet none are in scope and
        // tracked links exist. This is the signature of a tag misconfiguration
        // (e.g. a typo in `tags`, or the governing tag lines were lost) rather
        // than an intentional bulk removal — deleting every backend task would
        // be destructive and hard to recover. Refuse to sweep and tell the
        // operator. (Genuinely emptying the vault leaves no checkbox items, so
        // legitimate deletions are unaffected.)
        this.log.error(
          "Skipping deletion sweep: vault has checklist items but none are under a defined tag while external links exist (likely a misconfigured 'tags' allow-list)",
          { definedTags: this.options.definedTags, trackedLinks: this.store.allLinks().length },
        );
      } else {
        result.deletedExternal += await this.deleteExternalTasksMissingFromVault(
          filesResult.seenSyncIds,
        );
      }
    }
    result.inboundCreated += await this.pullInbound();
    // Ordering is a list-global property, so it runs in the full pass (after
    // field reconcile + inbound creation) when the whole vault is available.
    if (!this.options.dryRun) await this.reconcileOrdering(files, result);
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
    const { result } = await this.reconcileFiles(relevant, true);
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
  ): Promise<ReconcileFilesResult> {
    const result = emptyResult();
    const seenSyncIds = new Set<string>();
    let hadReadError = false;
    let sawCheckboxItem = false;

    for (const abs of absPaths) {
      const rel = relative(this.options.vaultPath, abs).split(sep).join("/");
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch (err) {
        hadReadError = true;
        this.log.warn("Failed to read file; skipping", { file: rel, err });
        continue;
      }

      const fileHash = hashContent(content);
      if (useFileHashSkip && this.store.getFileHash(rel) === fileHash) continue;

      const doc = this.parseDocumentFromContent(content, rel);
      let tasks = doc.tasks;
      if (doc.hasCheckboxItems) sawCheckboxItem = true;

      // Phase 1: assign missing sync IDs by writing them into the markdown.
      const idAssigned = await this.assignMissingIds(abs, tasks, result);
      if (idAssigned && !this.options.dryRun) {
        // Re-read so locations/rawLines reflect the written IDs.
        try {
          tasks = await this.parseFile(abs);
        } catch (err) {
          hadReadError = true;
          this.log.warn("Failed to re-read file after assigning ids; skipping", {
            file: rel,
            err,
          });
          continue;
        }
      }

      // Phase 2: outbound/3-way reconcile per task across all backends.
      for (const task of tasks) {
        if (!task.syncId) continue; // dry-run with unassigned ids
        seenSyncIds.add(task.syncId);
        await this.reconcileTaskAcrossBackends(abs, task, result);
      }

      if (!this.options.dryRun) {
        // Hash the post-write content so the next pass can skip unchanged files.
        const after = await readFile(abs, "utf8").catch(() => content);
        this.store.setFileHash(rel, hashContent(after));
      }
    }

    return { result, seenSyncIds, hadReadError, sawCheckboxItem };
  }

  private async deleteExternalTasksMissingFromVault(seenSyncIds: Set<string>): Promise<number> {
    let deleted = 0;
    const entries = new Map(this.backends.map((entry) => [entry.adapter.backend, entry]));
    for (const link of [...this.store.allLinks()]) {
      if (seenSyncIds.has(link.syncId)) continue;
      const entry = entries.get(link.backend);
      if (!entry) continue;
      if (link.externalListId === undefined) {
        this.log.warn("Cannot delete external task for missing vault task without list id", {
          backend: link.backend,
          syncId: link.syncId,
          externalId: link.externalId,
        });
        continue;
      }
      try {
        await entry.adapter.deleteTask(link.externalListId, link.externalId);
        this.store.deleteLink(link.syncId, link.backend);
        deleted++;
        this.log.info("Deleted external task for removed vault task", {
          backend: link.backend,
          syncId: link.syncId,
          externalId: link.externalId,
        });
      } catch (err) {
        this.log.warn("Failed to delete external task for removed vault task", {
          backend: link.backend,
          syncId: link.syncId,
          externalId: link.externalId,
          err,
        });
      }
    }
    return deleted;
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

    const listName = this.resolveListForBackend(task, entry);
    if (listName === undefined) return task; // out of scope; should not occur post-filter
    const curHash = hashTask(task);
    const link = this.store.getLink(syncId, backend);

    // New task → create in the external system.
    if (!link) {
      result.createdOutbound++;
      if (this.options.dryRun) return task;
      const listId = await entry.adapter.ensureList(listName);
      const ext = await entry.adapter.createTask(listId, toInput(task));
      await this.persistLink({
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
      await this.persistLink({
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
      let updated: ExternalTask;
      try {
        updated = await entry.adapter.updateTask(
          listId,
          link.externalId,
          toInput(task),
          ext.lastModified,
        );
      } catch (err) {
        if (err instanceof ExternalConflictError) {
          // The external task changed between our read and write; skip this
          // pass so the next reconcile resolves it via the conflict policy.
          result.conflicts++;
          this.log.warn("Skipped outbound update due to external write conflict", {
            backend,
            syncId,
          });
          return task;
        }
        throw err;
      }
      await this.persistLink({
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
    const inbound = await this.applyInbound(absPath, task, ext);
    if (inbound.apply.conflicts > 0) {
      result.conflicts += inbound.apply.conflicts;
      this.log.warn("Skipped inbound update due to optimistic concurrency conflict", {
        backend,
        syncId,
        conflicts: inbound.apply.conflicts,
      });
      return task;
    }
    await this.persistLink({
      ...link,
      externalListId: listId,
      lastKnownHash: hashTask(inbound.task),
      ...(ext.lastModified !== undefined
        ? { lastExternalModified: ext.lastModified }
        : {}),
      lastSyncedAt: new Date().toISOString(),
    });
    return inbound.task;
  }

  /** Apply an external change onto the vault line and return the new task. */
  private async applyInbound(
    absPath: string,
    task: Task,
    ext: ExternalTask,
  ): Promise<InboundApplyResult> {
    const mutation: TaskMutation = {
      line: task.location.line,
      expectedLine: task.rawLine,
      statusChar: statusToChar(ext.status, task.statusChar),
      ...(ext.done !== undefined ? { doneDate: ext.done } : {}),
      ...(ext.due !== undefined ? { dueDate: ext.due } : {}),
    };
    const apply = await applyMutations(absPath, [mutation], {
      ...(this.options.suppressNext
        ? { onWillWrite: this.options.suppressNext }
        : {}),
    });

    if (apply.conflicts > 0) return { task, apply };

    // Refresh the in-memory task so subsequent backends see the new state.
    const fresh = await this.parseFile(absPath);
    const match = fresh.find((t) => t.syncId === task.syncId);
    return { task: match ?? mergeInbound(task, ext), apply };
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
          const fetched = await this.fetchExternalTasks(entry, list.id, list.name);
          await this.removeLinksForDeletedExternalTasks(backend, fetched.removedIds);
          for (const ext of fetched.changed) {
            if (this.hasLinkForExternal(backend, ext.externalId)) continue;
            const didCreate = await this.createInboundTask(inboxAbs, list.name, ext, entry);
            if (didCreate) created++;
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
  ): Promise<FetchedExternalTasks> {
    const backend = entry.adapter.backend;
    if (typeof entry.adapter.delta === "function") {
      const prev = this.store.getDeltaToken(backend, listId);
      try {
        const res = await entry.adapter.delta(listId, prev);
        this.store.setDeltaToken(backend, listId, res.token);
        return { changed: res.changed, removedIds: res.removedIds };
      } catch (err) {
        if (err instanceof DeltaTokenExpiredError) {
          this.log.warn("Delta token expired; full resync", { backend, listName });
          this.store.deleteDeltaToken(backend, listId);
          await this.store.flush();
          // fall through to full listing below
        } else {
          throw err;
        }
      }
    }
    return { changed: await entry.adapter.listTasks(listId), removedIds: [] };
  }

  private async removeLinksForDeletedExternalTasks(
    backend: string,
    removedIds: readonly string[],
  ): Promise<void> {
    let removed = 0;
    for (const externalId of removedIds) {
      const links = this.store
        .allLinks()
        .filter((link) => link.backend === backend && link.externalId === externalId);
      for (const link of links) {
        this.store.deleteLink(link.syncId, link.backend);
        removed++;
        this.log.info("Removed link for externally deleted task", {
          backend,
          syncId: link.syncId,
          externalId,
        });
      }
    }
    if (removed > 0) await this.store.flush();
  }

  private hasLinkForExternal(backend: string, externalId: string): boolean {
    return this.store
      .allLinks()
      .some((l) => l.backend === backend && l.externalId === externalId);
  }

  /**
   * Place an externally-created task into the vault under a tagged checklist
   * block so it belongs to the correct list. The target tag is derived from the
   * external list name (inverse of `tagListMap`, else the list name as a
   * tag-path). The task is inserted into an existing block for that tag if one
   * exists anywhere in the vault; otherwise a new `#tag` block is appended to
   * the Sync Inbox note.
   *
   * Lists that don't correspond to a **defined** tag are skipped: writing them
   * would create an out-of-scope line that the next pass would delete.
   *
   * @returns true if a task line was written, false if skipped.
   */
  private async createInboundTask(
    inboxAbs: string,
    listName: string,
    ext: ExternalTask,
    entry: BackendEntry,
  ): Promise<boolean> {
    const backend = entry.adapter.backend;
    const tag = listNameToTag(listName, entry.tagListMap);
    const main = tag.split("/", 1)[0] ?? tag;
    if (!this.options.definedTags.some((defined) => normalizeTag(defined) === main)) {
      this.log.debug("Skipping inbound task from non-defined list", { backend, listName, tag });
      return false;
    }

    const syncId = generateSyncId();
    const statusChar = statusToChar(ext.status);
    const due = ext.due ? ` 📅 ${ext.due}` : "";
    const done = ext.done ? ` ✅ ${ext.done}` : "";
    const line = `- [${statusChar}] ${ext.title}${due}${done} <!-- sync-id: ${syncId} -->`;

    const opts = {
      ...(this.options.suppressNext ? { onWillWrite: this.options.suppressNext } : {}),
    };

    // Prefer inserting into an existing block for this tag.
    const target = await this.findBlockInsertion(tag);
    if (target) {
      const res = await insertLineAfter(target.absPath, target.afterLine, target.expectedLine, line, opts);
      if (!res.changed) {
        this.log.warn("Could not insert inbound task into existing block; retry next pass", {
          backend,
          tag,
          file: relative(this.options.vaultPath, target.absPath).split(sep).join("/"),
        });
        return false;
      }
    } else if (!existsSync(inboxAbs)) {
      await appendLines(inboxAbs, ["# Sync Inbox", "", `#${tag}`, line], opts);
    } else {
      await appendLines(inboxAbs, ["", `#${tag}`, line], opts);
    }

    await this.persistLink({
      syncId,
      backend,
      externalId: ext.externalId,
      externalListId: ext.listId,
      ...(ext.lastModified !== undefined
        ? { lastExternalModified: ext.lastModified }
        : {}),
      lastSyncedAt: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Find an existing checklist block governed by `tag` anywhere in the vault and
   * return the insertion anchor (the last task line of that block, after which
   * the new task is inserted so it stays inside the block).
   */
  private async findBlockInsertion(
    tag: string,
  ): Promise<{ absPath: string; afterLine: number; expectedLine: string } | undefined> {
    const files = await this.listMarkdownFiles(this.options.vaultPath);
    for (const abs of files) {
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const blockTags = resolveBlockTags(parseTree(content), this.options.definedTags);
      const lines = content.split("\n");
      let lastLine = -1;
      for (const [index, blockTag] of blockTags) {
        if (blockTag === tag && index > lastLine) lastLine = index;
      }
      if (lastLine >= 0) {
        const expectedLine = lines[lastLine];
        if (expectedLine !== undefined) return { absPath: abs, afterLine: lastLine, expectedLine };
      }
    }
    return undefined;
  }

  private async persistLink(link: ExternalLink): Promise<void> {
    this.store.setLink(link);
    if (!this.options.dryRun) await this.store.flush();
  }

  // --- ordering reconciliation --------------------------------------------

  /**
   * Reconcile per-list task ordering for backends that expose an explicit order
   * (e.g. Supernote `sort`). Vault document order is the desired order; device
   * reorders are reflected back by physically moving markdown task lines.
   *
   * Runs only in the full pass (the whole vault is needed) and only for
   * `ordered` backends. Ordering is reconciled per **(file, list)** group, so
   * cross-file interleaving on the device (which markdown cannot represent) does
   * not cause an outbound/inbound ping-pong; only a file's internal order is
   * compared and corrected.
   */
  private async reconcileOrdering(absFiles: string[], result: ReconcileResult): Promise<void> {
    const orderedBackends = this.backends.filter((e) => e.adapter.ordered === true);
    if (orderedBackends.length === 0) return;

    const files = [...absFiles].sort();
    const parsed: ParsedFile[] = [];
    for (const abs of files) {
      const filePath = relative(this.options.vaultPath, abs).split(sep).join("/");
      try {
        parsed.push({ absPath: abs, filePath, tasks: await this.parseFile(abs) });
      } catch (err) {
        this.log.warn("Ordering: failed to read file; skipping", { file: filePath, err });
      }
    }

    for (const entry of orderedBackends) {
      try {
        await this.reconcileOrderingForBackend(entry, parsed, result);
      } catch (err) {
        this.log.error("Ordering reconcile failed", { backend: entry.adapter.backend, err });
      }
    }
  }

  private async reconcileOrderingForBackend(
    entry: BackendEntry,
    parsed: ParsedFile[],
    result: ReconcileResult,
  ): Promise<void> {
    const backend = entry.adapter.backend;

    // Per-list membership in (file path, line) order — array index is the
    // collision-free global target sort within the list.
    const byList = new Map<string, OrderMember[]>();
    for (const file of parsed) {
      for (const task of file.tasks) {
        const syncId = task.syncId;
        if (!syncId) continue;
        const link = this.store.getLink(syncId, backend);
        if (!link || link.externalListId === undefined) continue;
        const members = byList.get(link.externalListId) ?? [];
        members.push({
          syncId,
          link,
          absPath: file.absPath,
          filePath: file.filePath,
          line: task.location.line,
          expectedLine: task.rawLine,
        });
        byList.set(link.externalListId, members);
      }
    }

    for (const [listId, members] of byList) {
      const globalIndex = new Map<string, number>();
      members.forEach((m, i) => globalIndex.set(m.syncId, i));

      let deviceOrder: Map<string, number>;
      let deviceModified: Map<string, string>;
      try {
        const ext = await entry.adapter.listTasks(listId);
        deviceOrder = new Map();
        deviceModified = new Map();
        for (const t of ext) {
          if (t.order !== undefined) deviceOrder.set(t.externalId, t.order);
          if (t.lastModified !== undefined) deviceModified.set(t.externalId, t.lastModified);
        }
      } catch (err) {
        this.log.warn("Ordering: failed to read backend list; skipping", { backend, listId, err });
        continue;
      }

      const byFile = new Map<string, OrderMember[]>();
      for (const m of members) {
        const arr = byFile.get(m.absPath) ?? [];
        arr.push(m);
        byFile.set(m.absPath, arr);
      }
      for (const fileMembers of byFile.values()) {
        await this.reconcileFileOrder(
          entry,
          listId,
          fileMembers,
          globalIndex,
          deviceOrder,
          deviceModified,
          result,
        );
      }
    }
  }

  private async reconcileFileOrder(
    entry: BackendEntry,
    listId: string,
    fileMembers: OrderMember[],
    globalIndex: Map<string, number>,
    deviceOrder: Map<string, number>,
    deviceModified: Map<string, string>,
    result: ReconcileResult,
  ): Promise<void> {
    const big = Number.MAX_SAFE_INTEGER;
    const sortKey = (get: (m: OrderMember) => number) => (a: OrderMember, b: OrderMember) =>
      get(a) - get(b) || a.line - b.line;

    const vaultRel = fileMembers.map((m) => m.syncId); // document order
    const baselineRel = [...fileMembers]
      .sort(sortKey((m) => m.link.lastKnownSort ?? big))
      .map((m) => m.syncId);
    const deviceRel = [...fileMembers]
      .sort(sortKey((m) => deviceOrder.get(m.link.externalId) ?? big))
      .map((m) => m.syncId);

    const needsEstablish = fileMembers.some((m) => m.link.lastKnownSort === undefined);
    const vaultChanged = !seqEqual(vaultRel, baselineRel);
    const deviceChanged = !seqEqual(deviceRel, baselineRel);
    const devicePrecedence = entry.conflictPolicy === "external-wins";

    let direction: "outbound" | "inbound" | "none" = "none";
    if (devicePrecedence) {
      if (deviceChanged) direction = "inbound";
      else if (vaultChanged || needsEstablish) direction = "outbound";
    } else {
      if (vaultChanged || needsEstablish) direction = "outbound";
      else if (deviceChanged) direction = "inbound";
    }
    if (direction === "none") return;

    if (vaultChanged && deviceChanged) {
      result.conflicts++;
      this.log.warn("Ordering conflict resolved", {
        backend: entry.adapter.backend,
        listId,
        policy: entry.conflictPolicy,
        direction,
      });
    }

    if (direction === "outbound") {
      await this.pushOrderOutbound(entry, listId, fileMembers, globalIndex, deviceOrder, deviceModified, result);
    } else {
      await this.applyOrderInbound(entry, fileMembers, deviceOrder, result);
    }
  }

  /** Push vault document order to the backend as explicit `order` updates. */
  private async pushOrderOutbound(
    entry: BackendEntry,
    listId: string,
    fileMembers: OrderMember[],
    globalIndex: Map<string, number>,
    deviceOrder: Map<string, number>,
    deviceModified: Map<string, string>,
    result: ReconcileResult,
  ): Promise<void> {
    const backend = entry.adapter.backend;
    for (const m of fileMembers) {
      const target = globalIndex.get(m.syncId);
      if (target === undefined) continue;
      const current = deviceOrder.get(m.link.externalId);

      // Already at the right position: just record the baseline, no write.
      if (current === target) {
        if (m.link.lastKnownSort !== target) {
          await this.persistLink({ ...m.link, lastKnownSort: target });
        }
        continue;
      }

      try {
        const updated = await entry.adapter.updateTask(
          listId,
          m.link.externalId,
          { order: target },
          deviceModified.get(m.link.externalId) ?? m.link.lastExternalModified,
        );
        await this.persistLink({
          ...m.link,
          lastKnownSort: target,
          ...(updated.lastModified !== undefined
            ? { lastExternalModified: updated.lastModified }
            : {}),
          lastSyncedAt: new Date().toISOString(),
        });
        result.reorderedOutbound++;
      } catch (err) {
        if (err instanceof ExternalConflictError) {
          result.conflicts++;
          this.log.warn("Skipped outbound reorder due to external write conflict", {
            backend,
            syncId: m.syncId,
          });
          continue;
        }
        throw err;
      }
    }
  }

  /** Reorder a file's task lines to match the backend's order. */
  private async applyOrderInbound(
    entry: BackendEntry,
    fileMembers: OrderMember[],
    deviceOrder: Map<string, number>,
    result: ReconcileResult,
  ): Promise<void> {
    const big = Number.MAX_SAFE_INTEGER;
    const desired = [...fileMembers].sort(
      (a, b) =>
        (deviceOrder.get(a.link.externalId) ?? big) - (deviceOrder.get(b.link.externalId) ?? big) ||
        a.line - b.line,
    );
    const absPath = fileMembers[0]!.absPath;
    const items: ReorderItem[] = desired.map((m) => ({ line: m.line, expectedLine: m.expectedLine }));

    const res = await reorderTaskLines(absPath, items, {
      ...(this.options.suppressNext ? { onWillWrite: this.options.suppressNext } : {}),
    });
    if (res.conflicts > 0 || res.skippedDueToConcurrentEdit) {
      result.conflicts += res.conflicts;
      this.log.warn("Skipped inbound reorder due to concurrent edit", {
        backend: entry.adapter.backend,
        absPath,
      });
      return;
    }

    // Align the baseline with the device order so the new markdown order is
    // stable on the next pass.
    for (const m of fileMembers) {
      const sort = deviceOrder.get(m.link.externalId);
      if (sort === undefined || m.link.lastKnownSort === sort) continue;
      await this.persistLink({ ...m.link, lastKnownSort: sort, lastSyncedAt: new Date().toISOString() });
    }
    if (res.changed) result.reorderedInbound += desired.length;
  }
}

import { createHash } from "node:crypto";

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** True when two id sequences are element-wise equal. */
function seqEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
