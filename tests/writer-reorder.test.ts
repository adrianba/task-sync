import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reorderTaskLines } from "../src/writer/markdownWriter.js";

describe("reorderTaskLines", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ts-reorder-"));
    file = join(dir, "Tasks.md");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function lines(): Promise<string[]> {
    return (await readFile(file, "utf8")).split("\n");
  }

  it("permutes task lines while leaving other lines in place", async () => {
    await writeFile(
      file,
      ["# Heading", "", "- [ ] A", "- [ ] B", "- [ ] C", ""].join("\n"),
    );
    const res = await reorderTaskLines(file, [
      { line: 4, expectedLine: "- [ ] C" },
      { line: 2, expectedLine: "- [ ] A" },
      { line: 3, expectedLine: "- [ ] B" },
    ]);
    expect(res.changed).toBe(true);
    expect(await lines()).toEqual(["# Heading", "", "- [ ] C", "- [ ] A", "- [ ] B", ""]);
  });

  it("is a no-op when the order already matches", async () => {
    await writeFile(file, ["- [ ] A", "- [ ] B"].join("\n"));
    const res = await reorderTaskLines(file, [
      { line: 0, expectedLine: "- [ ] A" },
      { line: 1, expectedLine: "- [ ] B" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.conflicts).toBe(0);
  });

  it("skips and reports a conflict when an expectedLine no longer matches", async () => {
    await writeFile(file, ["- [ ] A changed", "- [ ] B"].join("\n"));
    const res = await reorderTaskLines(file, [
      { line: 1, expectedLine: "- [ ] B" },
      { line: 0, expectedLine: "- [ ] A" },
    ]);
    expect(res.changed).toBe(false);
    expect(res.conflicts).toBeGreaterThan(0);
    // File untouched.
    expect(await lines()).toEqual(["- [ ] A changed", "- [ ] B"]);
  });

  it("returns no-op for fewer than two items", async () => {
    await writeFile(file, ["- [ ] A"].join("\n"));
    const res = await reorderTaskLines(file, [{ line: 0, expectedLine: "- [ ] A" }]);
    expect(res.changed).toBe(false);
  });
});
