/**
 * Minimal-diff, idempotent markdown writer.
 *
 * Applies status / metadata mutations to individual task lines while preserving
 * the rest of the file byte-for-byte. Safety properties:
 *  - **Optimistic concurrency:** each edit carries the `expectedLine` we last
 *    read; if the on-disk line no longer matches, the edit is skipped (a
 *    concurrent user / Obsidian-Sync change is assumed and left for the next
 *    reconcile).
 *  - **Idempotent:** re-applying the same mutation produces no further change.
 *  - **Atomic replacement** via temp file + fsync + rename (`atomicWriteFile`).
 *
 * Pure line transforms live in `vault/taskMeta.ts`; this module owns the file
 * I/O, batching and loop-protection hook.
 */
import { readFile } from "node:fs/promises";
import {
  ensureDoneDate,
  removeDoneDate,
  setDueDate,
  setStatusChar,
} from "../vault/taskMeta.js";
import { ensureSyncIdComment } from "../vault/syncId.js";
import { atomicWriteFile } from "../util/atomicFile.js";

export interface TaskMutation {
  /** Zero-based line index of the task within the file. */
  line: number;
  /** The exact line text we last parsed; used for optimistic concurrency. */
  expectedLine: string;
  /** New checkbox status character, e.g. " ", "x", "/", "-". */
  statusChar?: string;
  /** Correlation ID to ensure is present on the line. */
  syncId?: string;
  /** ISO done date to ensure present when completing (idempotent). */
  doneDate?: string;
  /** ISO due date to set/replace. */
  dueDate?: string;
}

/** Compute the new line text for a mutation. Pure + idempotent. */
export function applyMutationToLine(line: string, m: TaskMutation): string {
  let out = line;
  if (m.statusChar !== undefined) out = setStatusChar(out, m.statusChar);
  if (m.syncId !== undefined) out = ensureSyncIdComment(out, m.syncId);
  if (m.dueDate !== undefined) out = setDueDate(out, m.dueDate);

  // Done-date is coupled to completion status.
  if (m.statusChar === "x" || m.statusChar === "X") {
    if (m.doneDate !== undefined) out = ensureDoneDate(out, m.doneDate);
  } else if (m.statusChar !== undefined) {
    // Moving out of done: strip an auto-added done date.
    out = removeDoneDate(out);
  }
  return out;
}

export interface ApplyResult {
  changed: boolean;
  /** Edits skipped because the on-disk line no longer matched. */
  conflicts: number;
  /** Write aborted because the file kept changing during compare-and-swap. */
  skippedDueToConcurrentEdit?: boolean;
}

export interface ApplyMutationsOptions {
  /** Called immediately before writing (e.g. watcher.suppressNext). */
  onWillWrite?: (absPath: string) => void;
  /** When true, compute changes but never write (observe-only). */
  dryRun?: boolean;
}

/**
 * Apply a batch of mutations to a single file with optimistic concurrency.
 *
 * @param absPath   absolute file path
 * @param mutations edits keyed by line index
 */
export async function applyMutations(
  absPath: string,
  mutations: TaskMutation[],
  options: ApplyMutationsOptions = {},
): Promise<ApplyResult> {
  let lastConflicts = 0;

  for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
    const original = await readFile(absPath, "utf8");
    const lines = original.split("\n");
    let changed = false;
    let conflicts = 0;

    for (const m of mutations) {
      const current = lines[m.line];
      if (current === undefined || current !== m.expectedLine) {
        conflicts++;
        continue;
      }
      const next = applyMutationToLine(current, m);
      if (next !== current) {
        lines[m.line] = next;
        changed = true;
      }
    }

    lastConflicts = conflicts;

    if (!changed) return { changed: false, conflicts };
    if (options.dryRun) return { changed: true, conflicts };

    const updated = lines.join("\n");
    const beforeHook = await readFile(absPath, "utf8");
    if (beforeHook !== original) {
      continue;
    }
    options.onWillWrite?.(absPath);
    const currentOnDisk = await readFile(absPath, "utf8");
    if (currentOnDisk !== original) {
      continue;
    }
    await atomicWriteFile(absPath, updated);
    return { changed: true, conflicts };
  }

  return {
    changed: false,
    conflicts: lastConflicts,
    skippedDueToConcurrentEdit: true,
  };
}

export interface AppendOptions {
  onWillWrite?: (absPath: string) => void;
  dryRun?: boolean;
}

/** One task line participating in a reorder. */
export interface ReorderItem {
  /** Current zero-based line index of the task. */
  line: number;
  /** Exact current line text, for optimistic concurrency. */
  expectedLine: string;
}

/**
 * Reorder a set of task lines **among their own positions**, leaving every
 * other line (headings, blanks, tasks from other lists) byte-for-byte in place.
 *
 * `desired` lists the participating task lines in their target relative order.
 * The lines' current positions are treated as fixed "slots" (sorted ascending);
 * the desired line texts are placed into those slots in order. This permutes
 * only the given task lines and is safe for flat (non-nested) task lists.
 *
 * Optimistic concurrency: every item's `expectedLine` must still match the
 * on-disk line at its index, or the whole reorder is skipped (reported as a
 * conflict) and left for the next reconcile. Atomic via temp + fsync + rename.
 */
export async function reorderTaskLines(
  absPath: string,
  desired: ReorderItem[],
  options: ApplyMutationsOptions = {},
): Promise<ApplyResult> {
  if (desired.length < 2) return { changed: false, conflicts: 0 };

  const slots = desired.map((d) => d.line).sort((a, b) => a - b);

  for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
    const original = await readFile(absPath, "utf8");
    const lines = original.split("\n");

    // Verify every participating line still matches (optimistic concurrency).
    let mismatch = false;
    for (const item of desired) {
      if (lines[item.line] !== item.expectedLine) {
        mismatch = true;
        break;
      }
    }
    if (mismatch) return { changed: false, conflicts: desired.length };

    // Place desired texts into the fixed slots in target order.
    let changed = false;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const text = desired[i]!.expectedLine;
      if (lines[slot] !== text) {
        lines[slot] = text;
        changed = true;
      }
    }

    if (!changed) return { changed: false, conflicts: 0 };
    if (options.dryRun) return { changed: true, conflicts: 0 };

    const updated = lines.join("\n");
    const beforeHook = await readFile(absPath, "utf8");
    if (beforeHook !== original) continue;
    options.onWillWrite?.(absPath);
    const currentOnDisk = await readFile(absPath, "utf8");
    if (currentOnDisk !== original) continue;
    await atomicWriteFile(absPath, updated);
    return { changed: true, conflicts: 0 };
  }

  return { changed: false, conflicts: 0, skippedDueToConcurrentEdit: true };
}



/**
 * Append a block of lines to a file (creating it if needed), ensuring the file
 * ends with a newline first. Used for inbound externally-created tasks routed
 * to the shared Sync Inbox note. Atomic.
 */
export async function appendLines(
  absPath: string,
  newLines: string[],
  options: AppendOptions = {},
): Promise<void> {
  if (newLines.length === 0) return;
  for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
    const existing = await readFileIfExists(absPath);
    const needsNl = existing.length > 0 && !existing.endsWith("\n");
    const block = (needsNl ? "\n" : "") + newLines.join("\n") + "\n";
    const updated = existing + block;

    if (options.dryRun) return;
    const beforeHook = await readFileIfExists(absPath);
    if (beforeHook !== existing) {
      continue;
    }
    options.onWillWrite?.(absPath);
    const currentOnDisk = await readFileIfExists(absPath);
    if (currentOnDisk !== existing) {
      continue;
    }
    await atomicWriteFile(absPath, updated);
    return;
  }

  throw new Error(`Failed to append to ${absPath}: concurrent edits did not settle`);
}

const maxCasAttempts = 3;

/**
 * Insert a single new line immediately **after** the line at 0-based
 * `afterLine`, whose current text must still equal `expectedLine` (optimistic
 * concurrency). Used to drop an inbound task into an existing checklist block.
 * Atomic; returns `{ changed:false }` if the anchor line no longer matches.
 */
export async function insertLineAfter(
  absPath: string,
  afterLine: number,
  expectedLine: string,
  text: string,
  options: ApplyMutationsOptions = {},
): Promise<ApplyResult> {
  for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
    const original = await readFile(absPath, "utf8");
    const lines = original.split("\n");
    if (lines[afterLine] !== expectedLine) {
      return { changed: false, conflicts: 1 };
    }
    lines.splice(afterLine + 1, 0, text);
    const updated = lines.join("\n");
    if (options.dryRun) return { changed: true, conflicts: 0 };

    const beforeHook = await readFile(absPath, "utf8");
    if (beforeHook !== original) continue;
    options.onWillWrite?.(absPath);
    const currentOnDisk = await readFile(absPath, "utf8");
    if (currentOnDisk !== original) continue;
    await atomicWriteFile(absPath, updated);
    return { changed: true, conflicts: 0 };
  }
  return { changed: false, conflicts: 0, skippedDueToConcurrentEdit: true };
}



async function readFileIfExists(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}
