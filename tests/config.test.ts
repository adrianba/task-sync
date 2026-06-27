import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  vaultPath: "/vault",
  tokenKey: "0".repeat(64),
  backends: { msTodo: { enabled: true, clientId: "cid" } },
};

describe("config/loadConfig", () => {
  it("applies defaults and resolves paths to absolute", () => {
    const cfg = loadConfig({ skipEnv: true, overrides: base });
    expect(cfg.listMapping).toBe("hybrid");
    expect(cfg.conflictPolicy).toBe("newer");
    expect(cfg.health.host).toBe("127.0.0.1");
    expect(cfg.health.port).toBe(8080);
    expect(cfg.log.level).toBe("info");
    expect(cfg.vaultPath).toBe("/vault");
    expect(cfg.statePath).toMatch(/^\//);
  });

  it("requires at least one enabled backend", () => {
    expect(() =>
      loadConfig({ skipEnv: true, overrides: { vaultPath: "/vault" } }),
    ).toThrow(/At least one backend/);
  });

  it("requires tokenKey and clientId when msTodo is enabled", () => {
    expect(() =>
      loadConfig({
        skipEnv: true,
        overrides: { vaultPath: "/vault", backends: { msTodo: { enabled: true } } },
      }),
    ).toThrow(/tokenKey|clientId/);
  });

  it("requires service url and api key when supernote is enabled", () => {
    expect(() =>
      loadConfig({
        skipEnv: true,
        overrides: { vaultPath: "/vault", backends: { supernote: { enabled: true } } },
      }),
    ).toThrow(/baseUrl|apiKey/);
  });

  it("accepts a fully-configured supernote backend with vault-wins default", () => {
    const cfg = loadConfig({
      skipEnv: true,
      overrides: {
        vaultPath: "/vault",
        backends: {
          supernote: {
            enabled: true,
            service: { baseUrl: "https://tasks.example.com", apiKey: "key" },
          },
        },
      },
    });
    expect(cfg.backends.supernote?.conflictPolicy).toBe("vault-wins");
    expect(cfg.backends.supernote?.service.baseUrl).toBe("https://tasks.example.com");
    expect(cfg.backends.supernote?.service.requestTimeoutMs).toBe(15_000);
  });

  it("layers overrides over defaults (overrides win)", () => {
    const cfg = loadConfig({
      skipEnv: true,
      overrides: { ...base, listMapping: "tag", log: { level: "debug" } },
    });
    expect(cfg.listMapping).toBe("tag");
    expect(cfg.log.level).toBe("debug");
  });

  it("rejects an invalid enum value with a readable error", () => {
    expect(() =>
      loadConfig({ skipEnv: true, overrides: { ...base, listMapping: "bogus" } }),
    ).toThrow(/Invalid configuration/);
  });

  it("defaults ignoreTags to an empty array", () => {
    const cfg = loadConfig({ skipEnv: true, overrides: base });
    expect(cfg.ignoreTags).toEqual([]);
  });

  it("parses TASK_SYNC_IGNORE_TAGS (comma-separated, strips '#')", () => {
    const prev = process.env.TASK_SYNC_IGNORE_TAGS;
    process.env.TASK_SYNC_IGNORE_TAGS = "#next, someday ,, done";
    try {
      const cfg = loadConfig({ overrides: base });
      expect(cfg.ignoreTags).toEqual(["next", "someday", "done"]);
    } finally {
      if (prev === undefined) delete process.env.TASK_SYNC_IGNORE_TAGS;
      else process.env.TASK_SYNC_IGNORE_TAGS = prev;
    }
  });

  it("parses a per-backend tag map from SUPERNOTE_TAG_LIST_MAP JSON", () => {
    const prev = process.env.SUPERNOTE_TAG_LIST_MAP;
    process.env.SUPERNOTE_TAG_LIST_MAP = JSON.stringify({ "#work": "Work", home: "Home" });
    try {
      const cfg = loadConfig({
        overrides: {
          vaultPath: "/vault",
          backends: {
            supernote: {
              enabled: true,
              service: { baseUrl: "https://tasks.example.com", apiKey: "key" },
            },
          },
        },
      });
      expect(cfg.backends.supernote?.tagListMap).toEqual({ work: "Work", home: "Home" });
    } finally {
      if (prev === undefined) delete process.env.SUPERNOTE_TAG_LIST_MAP;
      else process.env.SUPERNOTE_TAG_LIST_MAP = prev;
    }
  });

  it("rejects malformed tag-map JSON with a clear error", () => {
    const prev = process.env.MS_TAG_LIST_MAP;
    process.env.MS_TAG_LIST_MAP = "not json";
    try {
      expect(() => loadConfig({ overrides: base })).toThrow(/MS_TAG_LIST_MAP must be a JSON object/);
    } finally {
      if (prev === undefined) delete process.env.MS_TAG_LIST_MAP;
      else process.env.MS_TAG_LIST_MAP = prev;
    }
  });
});
