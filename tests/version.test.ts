import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("matches the version declared in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a non-empty semver-like string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
