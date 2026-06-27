import { describe, expect, it } from "vitest";
import {
  generateSyncId,
  resolveListKey,
  mapTag,
  listNameToTag,
} from "../src/mapping/listMapping.js";
import type { Task } from "../src/model/task.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    statusChar: " ",
    status: "todo",
    description: "Do the thing",
    tags: [],
    fields: {},
    location: { filePath: "Projects/Alpha.md", line: 0 },
    rawLine: "- [ ] Do the thing",
    ...overrides,
  };
}

describe("resolveListKey", () => {
  it("uses the block tag-path verbatim as the list name", () => {
    expect(resolveListKey(task({ blockTag: "todo/work" }))).toBe("todo/work");
  });

  it("renames a tag-path via tagListMap (case-insensitive)", () => {
    expect(
      resolveListKey(task({ blockTag: "todo/work" }), {
        tagListMap: { "TODO/WORK": "Work Tasks" },
      }),
    ).toBe("Work Tasks");
  });

  it("returns undefined for an out-of-scope task with no block tag", () => {
    expect(resolveListKey(task())).toBeUndefined();
    expect(resolveListKey(task({ blockTag: "" }))).toBeUndefined();
  });
});

describe("mapTag / listNameToTag round-trip", () => {
  it("mapTag falls back to the tag-path when unmapped", () => {
    expect(mapTag("todo/home")).toBe("todo/home");
    expect(mapTag("todo/home", { "todo/home": "Home" })).toBe("Home");
  });

  it("listNameToTag inverts a tagListMap rename", () => {
    expect(listNameToTag("Home", { "todo/home": "Home" })).toBe("todo/home");
  });

  it("listNameToTag normalizes an unmapped list name to a tag-path", () => {
    expect(listNameToTag("#Todo/Work")).toBe("todo/work");
  });
});

describe("generateSyncId", () => {
  it("returns distinct non-empty URL-safe ids", () => {
    const first = generateSyncId();
    const second = generateSyncId();

    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(12);
    expect(first).toMatch(/^[\w-]+$/u);
  });
});
