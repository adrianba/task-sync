import { describe, it, expect } from "vitest";
import { resolveConflict } from "../src/sync/conflict.js";

describe("sync/conflict resolveConflict", () => {
  it("vault-wins always resolves outbound", () => {
    expect(resolveConflict("vault-wins", { vaultMtimeMs: 1 })).toBe("outbound");
    expect(
      resolveConflict("vault-wins", {
        vaultMtimeMs: 1,
        externalModified: new Date(9e12).toISOString(),
      }),
    ).toBe("outbound");
  });

  it("external-wins resolves inbound when external state exists", () => {
    expect(
      resolveConflict("external-wins", {
        vaultMtimeMs: 1,
        externalModified: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("inbound");
  });

  it("external-wins falls back to outbound without external state", () => {
    expect(resolveConflict("external-wins", { vaultMtimeMs: 1 })).toBe("outbound");
  });

  it("newer picks the side with the later timestamp", () => {
    const ext = "2026-01-02T00:00:00.000Z";
    const extMs = new Date(ext).getTime();
    expect(resolveConflict("newer", { vaultMtimeMs: extMs - 1000, externalModified: ext })).toBe(
      "inbound",
    );
    expect(resolveConflict("newer", { vaultMtimeMs: extMs + 1000, externalModified: ext })).toBe(
      "outbound",
    );
  });

  it("newer breaks ties toward the vault (outbound)", () => {
    const ext = "2026-01-02T00:00:00.000Z";
    expect(
      resolveConflict("newer", { vaultMtimeMs: new Date(ext).getTime(), externalModified: ext }),
    ).toBe("outbound");
  });

  it("newer treats missing/invalid external timestamps as outbound", () => {
    expect(resolveConflict("newer", { vaultMtimeMs: 1 })).toBe("outbound");
    expect(resolveConflict("newer", { vaultMtimeMs: 1, externalModified: "not-a-date" })).toBe(
      "outbound",
    );
  });
});
