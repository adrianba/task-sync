import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMutationToLine,
  applyMutations,
  appendLines,
} from "../src/writer/markdownWriter.js";

describe("writer/applyMutationToLine (pure)", () => {
  it("sets status, sync-id and is idempotent", () => {
    const line = "- [ ] Task #work";
    const once = applyMutationToLine(line, {
      line: 0,
      expectedLine: line,
      statusChar: "x",
      syncId: "abc123",
      doneDate: "2026-06-12",
    });
    expect(once).toContain("- [x]");
    expect(once).toContain("sync-id: abc123");
    expect(once).toContain("✅ 2026-06-12");
    // Re-applying the same mutation yields the same line.
    const twice = applyMutationToLine(once, {
      line: 0,
      expectedLine: once,
      statusChar: "x",
      syncId: "abc123",
      doneDate: "2026-06-12",
    });
    expect(twice).toBe(once);
  });

  it("strips the done date when moving out of done", () => {
    const done = "- [x] Task ✅ 2026-06-12";
    const reopened = applyMutationToLine(done, {
      line: 0,
      expectedLine: done,
      statusChar: " ",
    });
    expect(reopened).toContain("- [ ]");
    expect(reopened).not.toContain("✅");
  });
});

describe("writer/applyMutations (atomic, optimistic concurrency)", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".ts-writer-"));
    file = join(dir, "Note.md");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies a matching mutation and writes atomically", async () => {
    await writeFile(file, "- [ ] Task\n", "utf8");
    const res = await applyMutations(file, [
      { line: 0, expectedLine: "- [ ] Task", statusChar: "x", doneDate: "2026-06-12" },
    ]);
    expect(res.changed).toBe(true);
    expect(res.conflicts).toBe(0);
    expect(await readFile(file, "utf8")).toContain("- [x] Task ✅ 2026-06-12");
  });

  it("skips a mutation whose expected line no longer matches (conflict)", async () => {
    await writeFile(file, "- [x] Task changed underneath\n", "utf8");
    const res = await applyMutations(file, [
      { line: 0, expectedLine: "- [ ] Task", statusChar: "x" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.conflicts).toBe(1);
    expect(await readFile(file, "utf8")).toBe("- [x] Task changed underneath\n");
  });

  it("does not write when dryRun is set", async () => {
    await writeFile(file, "- [ ] Task\n", "utf8");
    const res = await applyMutations(
      file,
      [{ line: 0, expectedLine: "- [ ] Task", statusChar: "x" }],
      { dryRun: true },
    );
    expect(res.changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe("- [ ] Task\n");
  });

  it("invokes onWillWrite before writing", async () => {
    await writeFile(file, "- [ ] Task\n", "utf8");
    let notified: string | undefined;
    await applyMutations(
      file,
      [{ line: 0, expectedLine: "- [ ] Task", statusChar: "x" }],
      { onWillWrite: (p) => (notified = p) },
    );
    expect(notified).toBe(file);
  });

  it("retries instead of clobbering an unrelated concurrent edit", async () => {
    await writeFile(file, "- [ ] Task\n- [ ] Other\n", "utf8");
    let hookCalls = 0;

    const res = await applyMutations(
      file,
      [{ line: 0, expectedLine: "- [ ] Task", statusChar: "x" }],
      {
        onWillWrite: (p) => {
          hookCalls++;
          if (hookCalls === 1) {
            writeFileSync(p, "- [ ] Task\n- [ ] Other edited externally\n", "utf8");
          }
        },
      },
    );

    expect(res.changed).toBe(true);
    expect(res.conflicts).toBe(0);
    expect(res.skippedDueToConcurrentEdit ?? false).toBe(false);
    expect(await readFile(file, "utf8")).toBe("- [x] Task\n- [ ] Other edited externally\n");
  });
});

describe("writer/appendLines", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".ts-append-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a missing file and appends", async () => {
    const file = join(dir, "Inbox.md");
    await appendLines(file, ["- [ ] new task"]);
    const content = await readFile(file, "utf8");
    expect(content).toContain("- [ ] new task");
  });

  it("ensures a trailing newline before appending to existing content", async () => {
    const file = join(dir, "Inbox.md");
    await writeFile(file, "# Inbox", "utf8");
    await appendLines(file, ["- [ ] a", "- [ ] b"]);
    const content = await readFile(file, "utf8");
    expect(content).toMatch(/# Inbox\n/);
    expect(content).toContain("- [ ] a");
    expect(content).toContain("- [ ] b");
  });

  it("is a no-op for an empty append", async () => {
    const file = join(dir, "Inbox.md");
    await writeFile(file, "x", "utf8");
    await appendLines(file, []);
    expect(await readFile(file, "utf8")).toBe("x");
  });

  it("recomputes an append after an unrelated concurrent edit", async () => {
    const file = join(dir, "Inbox.md");
    await writeFile(file, "# Inbox\n", "utf8");
    let hookCalls = 0;

    await appendLines(file, ["- [ ] appended"], {
      onWillWrite: (p) => {
        hookCalls++;
        if (hookCalls === 1) {
          writeFileSync(p, "# Inbox\n- [ ] external\n", "utf8");
        }
      },
    });

    expect(await readFile(file, "utf8")).toBe("# Inbox\n- [ ] external\n- [ ] appended\n");
  });
});
