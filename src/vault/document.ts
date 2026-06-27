/**
 * Vault document layer.
 *
 * Uses the **unified / remark** pipeline (remark-parse + remark-gfm) to obtain a
 * robust mdast for each markdown file, then locates genuine task list items via
 * `unist-util-visit`. Relying on remark for block structure means tasks inside
 * fenced/indented code, and other false positives, are never misparsed — a
 * common failure mode of purely line-based scanners.
 *
 * For each task list item we read its source line (from the AST position) and
 * delegate the Obsidian Tasks field grammar to the pure `taskMeta` module.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";
import type { Task } from "../model/task.js";
import { TASK_LINE, parseBody, statusCharToStatus } from "./taskMeta.js";
import { resolveBlockTags } from "./blocks.js";

const processor = unified().use(remarkParse).use(remarkGfm);

/** Parse the mdast tree for a markdown document. */
export function parseTree(content: string): Root {
  return processor.parse(content);
}

/**
 * Parse the syncable Obsidian Tasks-plugin tasks from a file's content.
 *
 * Tasks are scoped using the **block-tag** model: only checklist items that sit
 * under a *defined* tag block (see {@link resolveBlockTags}) are returned, each
 * carrying its `blockTag`. Items not under a defined-tag block are not tasks and
 * are omitted. Passing no/empty `definedTags` yields no tasks.
 *
 * @param content     full file text
 * @param filePath    vault-relative path stored on each task's location
 * @param definedTags the tag allow-list (with or without leading '#')
 */
export function parseTasks(
  content: string,
  filePath: string,
  definedTags: Iterable<string> = [],
): Task[] {
  const tree = parseTree(content);
  const lines = content.split("\n");
  const blockTags = resolveBlockTags(tree, definedTags);

  // Collect the 0-based line index of every list item's first line. A list item
  // node's start line is where its marker (`- `, `* `, `1.`) begins, i.e. the
  // task line. Using a Set de-duplicates nested structures safely.
  const taskLineIndexes = new Set<number>();
  visit(tree, "listItem", (node) => {
    const start = node.position?.start.line;
    if (start === undefined) return;
    taskLineIndexes.add(start - 1);
  });

  const tasks: Task[] = [];
  for (const index of [...taskLineIndexes].sort((a, b) => a - b)) {
    const blockTag = blockTags.get(index);
    if (blockTag === undefined) continue; // out of scope: not under a defined-tag block

    const raw = lines[index];
    if (raw === undefined) continue;

    const m = raw.match(TASK_LINE);
    if (!m) continue; // a list item, but not a checkbox task

    const statusChar = m[3] ?? " ";
    const body = m[4] ?? "";
    const parsed = parseBody(body);

    tasks.push({
      ...(parsed.syncId !== undefined ? { syncId: parsed.syncId } : {}),
      statusChar,
      status: statusCharToStatus(statusChar),
      description: parsed.description,
      tags: parsed.tags,
      fields: parsed.fields,
      blockTag,
      location: { filePath, line: index },
      rawLine: raw,
    });
  }

  return tasks;
}
