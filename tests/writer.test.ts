import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    dir = await mkdtemp(join(tmpdir(), "ts-writer-"));
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
});

describe("writer/appendLines", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ts-append-"));
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
});
