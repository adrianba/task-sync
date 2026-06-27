/**
 * Block-tag resolution (obsidian-checklist-plugin model).
 *
 * A *defined* tag (e.g. `#todo`) placed on a **non-task line** governs the
 * checklist block that follows it. We derive this from the **remark mdast**
 * structure rather than hand-rolled line scanning: a `heading`/`paragraph` node
 * whose text contains a defined tag governs the **immediately following sibling
 * `list` node**. Every list item in that list belongs to the tag's list; items
 * not under such a block are out of scope (ignored for syncing).
 *
 * A sub-tag `#todo/groceries` is governed iff its *main* part (`todo`) is a
 * defined tag, and maps to its own list path `todo/groceries` (lowercased).
 * When a governing node contains several defined tags, the **first** one wins.
 */
import { visit } from "unist-util-visit";
import { toString } from "mdast-util-to-string";
import type { Nodes, Parent, Root } from "mdast";

/** A tag token: leading `#`, then Obsidian-style tag characters. */
const TAG_TOKEN = /(?:^|\s)#([^ !@#$%^&*(),.?":{}|<>]+)/gu;

/** Normalize a configured/parsed tag: drop leading '#', trim, lowercase. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Resolve, for a parsed markdown tree, which checklist lines belong to which
 * defined-tag block.
 *
 * @param tree        mdast root (from `remark-parse` + `remark-gfm`)
 * @param definedTags the allow-list of tag *main* names (with or without '#')
 * @returns map of 0-based task-line index → tag path (e.g. `todo/groceries`)
 */
export function resolveBlockTags(tree: Root, definedTags: Iterable<string>): Map<number, string> {
  const defined = new Set([...definedTags].map(normalizeTag).filter((t) => t !== ""));
  const result = new Map<number, string>();
  if (defined.size === 0) return result;
  walk(tree, defined, result);
  return result;
}

/** Walk a container's children in order, governing the next sibling list. */
function walk(parent: Parent, defined: Set<string>, result: Map<number, string>): void {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i] as Nodes;

    if ((node.type === "heading" || node.type === "paragraph") && !isTaskItemBody(parent, node)) {
      const tag = firstDefinedTag(toString(node), defined);
      const next = children[i + 1];
      if (tag !== undefined && next?.type === "list") {
        assignListItems(next, tag, result);
      }
    }

    // Recurse into containers (listItem, blockquote, list) so a tag inside a
    // list item can govern a nested list. Cheap and robust.
    if ("children" in node && Array.isArray(node.children)) {
      walk(node, defined, result);
    }
  }
}

function isTaskItemBody(parent: Parent, node: Nodes): boolean {
  return (
    parent.type === "listItem" &&
    typeof (parent as { checked?: unknown }).checked === "boolean" &&
    parent.children[0] === node
  );
}

/** Map every list item line in `list` (incl. nested) to `tag`. */
function assignListItems(list: Nodes, tag: string, result: Map<number, string>): void {
  visit(list, "listItem", (item) => {
    const start = item.position?.start.line;
    if (start === undefined) return;
    const index = start - 1;
    // First (outermost) governing tag wins; never overwrite.
    if (!result.has(index)) result.set(index, tag);
  });
}

/** Return the first tag in `text` whose main part is a defined tag (lowercased). */
function firstDefinedTag(text: string, defined: Set<string>): string | undefined {
  TAG_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_TOKEN.exec(text)) !== null) {
    const path = m[1];
    if (path === undefined) continue;
    const lower = path.toLowerCase();
    const main = lower.split("/", 1)[0] ?? lower;
    if (defined.has(main)) return lower;
  }
  return undefined;
}
