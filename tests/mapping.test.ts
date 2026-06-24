import { describe, expect, it } from "vitest";
import { generateSyncId, resolveListKey } from "../src/mapping/listMapping.js";
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
  it("uses the first usable tag for tag strategy", () => {
    expect(resolveListKey(task({ tags: ["work"] }), { strategy: "tag" })).toBe("work");
  });

  it("maps tags through tagListMap", () => {
    expect(
      resolveListKey(task({ tags: ["work"] }), {
        strategy: "tag",
        tagListMap: { work: "Work Tasks" },
      }),
    ).toBe("Work Tasks");
  });

  it("ignores configured tags when choosing a list", () => {
    expect(
      resolveListKey(task({ tags: ["next", "home"] }), {
        strategy: "tag",
        ignoreTags: ["next"],
      }),
    ).toBe("home");
  });

  it("prefers a mapped tag when multiple tags are usable", () => {
    expect(
      resolveListKey(task({ tags: ["misc", "client"] }), {
        strategy: "tag",
        tagListMap: { client: "Clients" },
      }),
    ).toBe("Clients");
  });

  it("falls back to the folder when tag strategy has no usable tag", () => {
    expect(
      resolveListKey(task({ tags: ["done"], location: { filePath: "Areas/Home/Chores.md", line: 3 } }), {
        strategy: "tag",
        ignoreTags: ["done"],
      }),
    ).toBe("Home");
  });

  it("uses the containing folder for file strategy", () => {
    expect(
      resolveListKey(task({ location: { filePath: "Areas/Home/Chores.md", line: 3 } }), {
        strategy: "file",
      }),
    ).toBe("Home");
  });

  it("uses the base filename for root files", () => {
    expect(
      resolveListKey(task({ location: { filePath: "Inbox Note.md", line: 0 } }), {
        strategy: "file",
      }),
    ).toBe("Inbox Note");
  });

  it("uses tag first for hybrid and folder fallback without a tag", () => {
    expect(resolveListKey(task({ tags: ["errands"] }), { strategy: "hybrid" })).toBe("errands");
    expect(
      resolveListKey(task({ location: { filePath: "Projects/Beta.md", line: 1 } }), {
        strategy: "hybrid",
      }),
    ).toBe("Projects");
  });

  it("returns Inbox as the final fallback", () => {
    expect(
      resolveListKey(task({ tags: ["ignored"], location: { filePath: "", line: 0 } }), {
        strategy: "hybrid",
        ignoreTags: ["ignored"],
      }),
    ).toBe("Inbox");
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
