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

  if (!changed) return { changed: false, conflicts };
  if (options.dryRun) return { changed: true, conflicts };

  const updated = lines.join("\n");
  options.onWillWrite?.(absPath);
  await atomicWriteFile(absPath, updated);
  return { changed: true, conflicts };
}

export interface AppendOptions {
  onWillWrite?: (absPath: string) => void;
  dryRun?: boolean;
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
  let existing = "";
  try {
    existing = await readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const needsNl = existing.length > 0 && !existing.endsWith("\n");
  const block = (needsNl ? "\n" : "") + newLines.join("\n") + "\n";
  const updated = existing + block;

  if (options.dryRun) return;
  options.onWillWrite?.(absPath);
  await atomicWriteFile(absPath, updated);
}
