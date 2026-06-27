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
    expect(cfg.tags).toEqual(["todo"]);
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
      overrides: { ...base, tags: ["Work", "#Home"], log: { level: "debug" } },
    });
    expect(cfg.tags).toEqual(["work", "home"]);
    expect(cfg.log.level).toBe("debug");
  });

  it("rejects an invalid enum value with a readable error", () => {
    expect(() =>
      loadConfig({ skipEnv: true, overrides: { ...base, conflictPolicy: "bogus" } }),
    ).toThrow(/Invalid configuration/);
  });

  it("defaults tags to [todo]", () => {
    const cfg = loadConfig({ skipEnv: true, overrides: base });
    expect(cfg.tags).toEqual(["todo"]);
  });

  it("parses TASK_SYNC_TODO_TAGS (comma-separated, strips '#', lowercases)", () => {
    const prev = process.env.TASK_SYNC_TODO_TAGS;
    process.env.TASK_SYNC_TODO_TAGS = "#Todo, Work ,, Home";
    try {
      const cfg = loadConfig({ overrides: base });
      expect(cfg.tags).toEqual(["todo", "work", "home"]);
    } finally {
      if (prev === undefined) delete process.env.TASK_SYNC_TODO_TAGS;
      else process.env.TASK_SYNC_TODO_TAGS = prev;
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
