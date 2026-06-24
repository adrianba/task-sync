import { randomBytes } from "node:crypto";
import { posix as path } from "node:path";
import type { Task } from "../model/task.js";

export interface MappingOptions {
  strategy: "tag" | "file" | "hybrid";
  /** tag (without '#') -> external list display name */
  tagListMap?: Record<string, string>;
  /** tags to ignore when choosing a list, e.g. status tags */
  ignoreTags?: string[];
}

const DEFAULT_LIST = "Inbox";

/** Resolve the logical list display name for a task. Never returns empty. */
export function resolveListKey(task: Task, opts: MappingOptions): string {
  const strategy = opts.strategy ?? "hybrid";

  if (strategy === "tag" || strategy === "hybrid") {
    const tagKey = tagListKey(task, opts);
    if (tagKey !== undefined) return tagKey;
  }

  if (strategy === "file" || strategy === "hybrid" || strategy === "tag") {
    return nonEmpty(fileListKey(task.location.filePath)) ?? DEFAULT_LIST;
  }

  return DEFAULT_LIST;
}

/** Generate a short, opaque, URL-safe correlation id (e.g. 12+ chars). */
export function generateSyncId(): string {
  return randomBytes(12).toString("base64url");
}

function tagListKey(task: Task, opts: MappingOptions): string | undefined {
  const ignoreTags = new Set(opts.ignoreTags ?? []);
  const usableTags = task.tags.filter((tag) => !ignoreTags.has(tag) && tag.trim() !== "");
  if (usableTags.length === 0) return undefined;

  const mappedTag = usableTags.find((tag) => nonEmpty(opts.tagListMap?.[tag]) !== undefined);
  const tag = mappedTag ?? usableTags[0];
  if (tag === undefined) return undefined;

  return nonEmpty(opts.tagListMap?.[tag]) ?? tag;
}

function fileListKey(filePath: string): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  const dir = path.dirname(normalized);
  if (dir !== "." && dir !== "") return nonEmpty(path.basename(dir));

  const baseName = path.basename(normalized);
  const extension = path.extname(baseName);
  const withoutExtension = extension === "" ? baseName : baseName.slice(0, -extension.length);
  return nonEmpty(withoutExtension);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
