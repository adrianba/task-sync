import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExternalLink, Task } from "../src/model/task.js";
import { hashTask, StateStore, deltaTokenKey } from "../src/state/stateStore.js";

const testRoot = join(process.cwd(), ".test-tmp");
let testDir: string;

beforeEach(async () => {
  testDir = join(testRoot, randomUUID());
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function statePath(): string {
  return join(testDir, "state.json");
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    syncId: "sync-1",
    statusChar: " ",
    status: "todo",
    description: "Do the thing",
    tags: ["work"],
    fields: { due: "2026-06-25", priority: "high" },
    location: { filePath: "Projects/Alpha.md", line: 2 },
    rawLine: "- [ ] Do the thing #work 📅 2026-06-25 <!-- sync-id: sync-1 -->",
    ...overrides,
  };
}

function link(overrides: Partial<ExternalLink> = {}): ExternalLink {
  return {
    syncId: "sync-1",
    backend: "ms-todo",
    externalId: "external-1",
    externalListId: "list-1",
    lastKnownHash: "hash-1",
    lastExternalModified: "2026-06-24T00:00:00.000Z",
    lastSyncedAt: "2026-06-24T00:01:00.000Z",
    ...overrides,
  };
}

describe("StateStore", () => {
  it("starts empty when loading a missing file", async () => {
    const store = new StateStore(statePath());

    await store.load();

    expect(store.allLinks()).toHaveLength(0);
    expect(store.getDeltaToken("ms-todo", "list-1")).toBeUndefined();
    expect(store.getFileHash("Projects/Alpha.md")).toBeUndefined();
  });

  it("prunes file hashes not in the keep set and reports the count", async () => {
    const store = new StateStore(statePath());
    await store.load();
    store.setFileHash("Keep.md", "h1");
    store.setFileHash("Templates/Drop.md", "h2");
    store.setFileHash("Gone.md", "h3");

    const pruned = store.pruneFileHashes(new Set(["Keep.md"]));

    expect(pruned).toBe(2);
    expect(store.getFileHash("Keep.md")).toBe("h1");
    expect(store.getFileHash("Templates/Drop.md")).toBeUndefined();
    expect(store.getFileHash("Gone.md")).toBeUndefined();
  });

  it("prunes orphan delta tokens only for backends that enumerated lists", async () => {
    const store = new StateStore(statePath());
    await store.load();
    store.setDeltaToken("ms-todo", "list-1", "t1");
    store.setDeltaToken("ms-todo", "gone", "t2");
    store.setDeltaToken("supernote", "list-2", "t3");

    const keep = new Set([deltaTokenKey("ms-todo", "list-1")]);
    const pruned = store.pruneDeltaTokens(keep, new Set(["ms-todo"]));

    expect(pruned).toBe(1);
    expect(store.getDeltaToken("ms-todo", "list-1")).toBe("t1");
    expect(store.getDeltaToken("ms-todo", "gone")).toBeUndefined();
    expect(store.getDeltaToken("supernote", "list-2")).toBe("t3");
  });

  it("upserts links by sync id and backend while preserving fan-out", async () => {
    const store = new StateStore(statePath());
    await store.load();

    store.setLink(link());
    store.setLink(link({ backend: "supernote", externalId: "external-2" }));
    store.setLink(link({ externalId: "external-1b", externalListId: "list-2" }));

    expect(store.allLinks()).toHaveLength(2);
    expect(store.getLink("sync-1", "ms-todo")?.externalId).toBe("external-1b");
    expect(store.getLink("sync-1", "ms-todo")?.externalListId).toBe("list-2");
    expect(store.getLink("sync-1", "supernote")?.externalId).toBe("external-2");
    expect(store.getLinksForSyncId("sync-1").map((entry) => entry.backend).sort()).toEqual([
      "ms-todo",
      "supernote",
    ]);
  });

  it("deletes a link by sync id and backend", async () => {
    const store = new StateStore(statePath());
    await store.load();
    store.setLink(link());
    store.setLink(link({ backend: "supernote", externalId: "external-2" }));

    store.deleteLink("sync-1", "ms-todo");

    expect(store.getLink("sync-1", "ms-todo")).toBeUndefined();
    expect(store.getLink("sync-1", "supernote")?.externalId).toBe("external-2");
    expect(store.allLinks()).toHaveLength(1);
  });

  it("stores delta tokens and file hashes", async () => {
    const store = new StateStore(statePath());
    await store.load();

    store.setDeltaToken("ms-todo", "list-1", "delta-1");
    store.setFileHash("Projects/Alpha.md", "hash-1");

    expect(store.getDeltaToken("ms-todo", "list-1")).toBe("delta-1");
    expect(store.getFileHash("Projects/Alpha.md")).toBe("hash-1");
  });

  it("flushes atomically with private mode and reloads data", async () => {
    const path = statePath();
    const store = new StateStore(path);
    await store.load();
    store.setLink(link());
    store.setDeltaToken("ms-todo", "list-1", "delta-1");
    store.setFileHash("Projects/Alpha.md", "hash-1");

    await store.flush();

    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const reloaded = new StateStore(path);
    await reloaded.load();

    expect(reloaded.getLink("sync-1", "ms-todo")?.externalId).toBe("external-1");
    expect(reloaded.getDeltaToken("ms-todo", "list-1")).toBe("delta-1");
    expect(reloaded.getFileHash("Projects/Alpha.md")).toBe("hash-1");
  });

  it("throws a clear error for corrupt JSON", async () => {
    const path = join(testDir, "bad.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{not-json", { mode: 0o600 }));
    const store = new StateStore(path);

    await expect(store.load()).rejects.toThrow(/corrupt JSON/u);
  });
});

describe("hashTask", () => {
  it("is stable across formatting changes", () => {
    const first = hashTask(task());
    const second = hashTask(
      task({
        statusChar: "-",
        rawLine: "  - [-] Do the thing   #later 📅 2026-06-25",
      }),
    );

    expect(second).toBe(first);
  });

  it("changes when status changes", () => {
    expect(hashTask(task({ status: "done" }))).not.toBe(hashTask(task()));
  });

  it("changes when due date changes", () => {
    expect(hashTask(task({ fields: { due: "2026-06-26", priority: "high" } }))).not.toBe(
      hashTask(task()),
    );
  });

  it("ignores tags, location, rawLine, and syncId", () => {
    const first = hashTask(task());
    const second = hashTask(
      task({
        syncId: "sync-2",
        tags: ["home", "next"],
        location: { filePath: "Other/Note.md", line: 99 },
        rawLine: "- [ ] Rewritten line #home <!-- sync-id: sync-2 -->",
      }),
    );

    expect(second).toBe(first);
  });
});
