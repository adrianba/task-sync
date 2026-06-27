import { randomBytes } from "node:crypto";
import type { Task } from "../model/task.js";

export interface MappingOptions {
  /** tag-path (e.g. `todo/groceries`) -> external list display name */
  tagListMap?: Record<string, string>;
}

/**
 * Resolve the external list display name for an **in-scope** task from its
 * `blockTag` (the defined tag-path of the checklist block it belongs to).
 *
 * The tag-path is used verbatim as the list name unless `tagListMap` renames it
 * (lookup is case-insensitive). Returns `undefined` for a task with no
 * `blockTag` — such tasks are out of scope and must not be synced.
 */
export function resolveListKey(task: Task, opts: MappingOptions = {}): string | undefined {
  const blockTag = task.blockTag;
  if (blockTag === undefined || blockTag.trim() === "") return undefined;
  return mapTag(blockTag, opts.tagListMap);
}

/** Apply a (case-insensitive) tag->list rename, else use the tag-path verbatim. */
export function mapTag(tagPath: string, tagListMap?: Record<string, string>): string {
  const lower = tagPath.toLowerCase();
  if (tagListMap) {
    for (const [key, value] of Object.entries(tagListMap)) {
      if (key.toLowerCase() === lower) {
        const trimmed = value.trim();
        if (trimmed !== "") return trimmed;
      }
    }
  }
  return tagPath;
}

/**
 * Inverse of {@link mapTag}: given an external list display name, recover the
 * tag-path that would map to it (for placing inbound tasks under a tagged
 * block). Falls back to the list name itself, normalized as a tag-path.
 */
export function listNameToTag(listName: string, tagListMap?: Record<string, string>): string {
  if (tagListMap) {
    for (const [key, value] of Object.entries(tagListMap)) {
      if (value.trim().toLowerCase() === listName.trim().toLowerCase()) {
        return key.toLowerCase();
      }
    }
  }
  return listName.trim().replace(/^#/, "").toLowerCase();
}

/** Generate a short, opaque, URL-safe correlation id (e.g. 12+ chars). */
export function generateSyncId(): string {
  return randomBytes(12).toString("base64url");
}
