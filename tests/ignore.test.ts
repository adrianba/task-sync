import { describe, it, expect } from "vitest";
import { isPathIgnored, normalizeIgnorePath } from "../src/util/ignore.js";

const STD = [".obsidian", ".trash", ".git", "node_modules"];

describe("util/ignore isPathIgnored", () => {
  it("skips standard directory names anywhere in the tree", () => {
    expect(isPathIgnored(".obsidian/app.json", STD, [])).toBe(true);
    expect(isPathIgnored("a/node_modules/b.md", STD, [])).toBe(true);
    expect(isPathIgnored(".git/config", STD, [])).toBe(true);
  });

  it("does not skip ordinary notes", () => {
    expect(isPathIgnored("Tasks/Work.md", STD, [])).toBe(false);
  });

  it("matches a vault-relative path prefix on a segment boundary", () => {
    const prefixes = ["tasks/templates"];
    expect(isPathIgnored("Tasks/Templates/Daily.md", STD, prefixes)).toBe(true);
    expect(isPathIgnored("Tasks/Templates", STD, prefixes)).toBe(true);
    // Sibling with a shared prefix is NOT excluded.
    expect(isPathIgnored("Tasks/Templates2/Note.md", STD, prefixes)).toBe(false);
    expect(isPathIgnored("Other/Templates/x.md", STD, prefixes)).toBe(false);
  });

  it("is case-insensitive for path prefixes and accepts backslashes", () => {
    expect(isPathIgnored("Tasks\\Templates\\x.md", STD, ["tasks/templates"])).toBe(true);
  });

  it("treats paths outside the vault and empty paths as ignored", () => {
    expect(isPathIgnored("../escape.md", STD, [])).toBe(true);
    expect(isPathIgnored("", STD, [])).toBe(true);
  });
});

describe("util/ignore normalizeIgnorePath", () => {
  it("strips slashes, lowercases, and converts backslashes", () => {
    expect(normalizeIgnorePath("/Tasks/Templates/")).toBe("tasks/templates");
    expect(normalizeIgnorePath("Tasks\\Templates")).toBe("tasks/templates");
    expect(normalizeIgnorePath("  Inbox  ")).toBe("inbox");
  });
});
