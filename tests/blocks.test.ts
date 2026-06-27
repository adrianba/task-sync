import { describe, it, expect } from "vitest";
import { parseTree } from "../src/vault/document.js";
import { resolveBlockTags } from "../src/vault/blocks.js";

/** Helper: resolve block tags for `md` and return a line→tag object. */
function tagsFor(md: string, defined: string[]): Record<number, string> {
  const map = resolveBlockTags(parseTree(md), defined);
  return Object.fromEntries(map);
}

describe("resolveBlockTags", () => {
  it("governs a checklist by a paragraph tag on the line above", () => {
    const md = "#todo\n- [ ] a\n- [ ] b\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 1: "todo", 2: "todo" });
  });

  it("governs a checklist by a heading tag", () => {
    const md = "## Work #todo/work\n\n- [ ] a\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 2: "todo/work" });
  });

  it("allows a single blank line between the tag and the list", () => {
    const md = "#todo\n\n- [ ] a\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 2: "todo" });
  });

  it("maps a sub-tag to its own tag-path list", () => {
    const md = "#todo/groceries\n- [ ] milk\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 1: "todo/groceries" });
  });

  it("ignores checklist items with no governing defined tag", () => {
    const md = "- [ ] orphan\n\n# Heading only\n- [ ] also orphan\n";
    expect(tagsFor(md, ["todo"])).toEqual({});
  });

  it("ignores a tag that is not in the defined allow-list", () => {
    const md = "#someday\n- [ ] later\n";
    expect(tagsFor(md, ["todo"])).toEqual({});
  });

  it("uses the first defined tag when several are on the governing line", () => {
    const md = "#todo/work #todo/home\n- [ ] a\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 1: "todo/work" });
  });

  it("does not let a non-adjacent list be governed (paragraph in between)", () => {
    const md = "#todo\n\nsome prose\n\n- [ ] a\n";
    expect(tagsFor(md, ["todo"])).toEqual({});
  });

  it("does not pick up tags inside fenced code blocks", () => {
    const md = "```\n#todo\n- [ ] fake\n```\n";
    expect(tagsFor(md, ["todo"])).toEqual({});
  });

  it("matches the defined tag case-insensitively and lowercases the path", () => {
    const md = "#TODO/Work\n- [ ] a\n";
    expect(tagsFor(md, ["ToDo"])).toEqual({ 1: "todo/work" });
  });

  it("returns nothing when no tags are defined", () => {
    const md = "#todo\n- [ ] a\n";
    expect(tagsFor(md, [])).toEqual({});
  });

  it("handles multiple independent blocks in one file", () => {
    const md = "#todo/a\n- [ ] one\n\n#todo/b\n- [ ] two\n";
    expect(tagsFor(md, ["todo"])).toEqual({ 1: "todo/a", 4: "todo/b" });
  });
});
