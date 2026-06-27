import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SyncEngine, type SyncEngineOptions } from "../src/sync/syncEngine.js";
import { StateStore } from "../src/state/stateStore.js";
import type { DeltaResult, ExternalTask } from "../src/adapters/types.js";
import type { BackendEntry } from "../src/sync/backendRegistry.js";
import { FakeAdapter } from "./helpers/fakeAdapter.js";
import { createLogger } from "../src/logger.js";

const silentLogger = createLogger("error");

class DeletionAwareAdapter extends FakeAdapter {
  readonly deleteCalls: Array<{ listId: string; externalId: string }> = [];
  private readonly removed = new Set<string>();

  override async deleteTask(listId: string, externalId: string): Promise<void> {
    this.deleteCalls.push({ listId, externalId });
    this.removed.add(externalId);
    await super.deleteTask(listId, externalId);
  }

  emitRemoved(externalId: string): void {
    this.removed.add(externalId);
  }

  override delta(listId: string, _token?: string): Promise<DeltaResult> {
    const removedIds = [...this.removed];
    this.removed.clear();
    return Promise.resolve({
      changed: this.allTasks().filter((task) => task.listId === listId),
      removedIds,
      token: randomUUID(),
    });
  }
}

class ConcurrentEditAdapter extends DeletionAwareAdapter {
  private conflictFile: string | undefined;
  private conflictLine: string | undefined;

  setConcurrentEdit(file: string, line: string): void {
    this.conflictFile = file;
    this.conflictLine = line;
  }

  override async getTask(listId: string, externalId: string): Promise<ExternalTask | null> {
    const task = await super.getTask(listId, externalId);
    if (this.conflictFile !== undefined && this.conflictLine !== undefined) {
      const file = this.conflictFile;
      const line = this.conflictLine;
      this.conflictFile = undefined;
      this.conflictLine = undefined;
      await writeFile(file, `${line}\n`);
    }
    return task;
  }
}

function entry(adapter: FakeAdapter, policy: BackendEntry["conflictPolicy"] = "newer"): BackendEntry {
  return { adapter, conflictPolicy: policy, tagListMap: {} };
}

describe("SyncEngine deletion reconciliation", () => {
  let root: string;
  let vault: string;
  let statePath: string;

  beforeEach(async () => {
    root = join(process.cwd(), ".test-vaults", `engine-deletions-${randomUUID()}`);
    vault = join(root, "vault");
    await mkdir(vault, { recursive: true });
    statePath = join(vault, ".task-sync", "state.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function newEngine(
    backends: BackendEntry[],
    opts: Partial<SyncEngineOptions> = {},
  ): Promise<{ engine: SyncEngine; store: StateStore }> {
    const store = new StateStore(statePath);
    await store.load();
    const engine = new SyncEngine(backends, store, {
      vaultPath: vault,
      ignore: [".obsidian", ".git"],
      mapping: {},
      definedTags: ["todo"],
      dryRun: false,
      inboundInboxFile: "Sync Inbox.md",
      logger: silentLogger,
      ...opts,
    });
    return { engine, store };
  }

  it("deletes external tasks and links when a vault task is removed in a full reconcile", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "#todo\n- [ ] Remove me\n");
    const adapter = new DeletionAwareAdapter("alpha");
    const { engine, store } = await newEngine([entry(adapter)]);
    await engine.reconcile();
    const synced = adapter.allTasks()[0]!;

    await writeFile(file, "");
    const result = await engine.reconcile();

    expect(result.deletedExternal).toBe(1);
    expect(adapter.deleteCalls).toEqual([
      { listId: synced.listId, externalId: synced.externalId },
    ]);
    expect(adapter.allTasks()).toHaveLength(0);
    expect(store.allLinks()).toHaveLength(0);
  });

  it("skips the deletion sweep if any vault file cannot be read", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "#todo\n- [ ] Keep me\n");
    const adapter = new DeletionAwareAdapter("alpha");
    const { engine, store } = await newEngine([entry(adapter)]);
    await engine.reconcile();

    await unlink(file);
    await symlink(join(vault, "missing-target.md"), join(vault, "Unreadable.md"));
    const result = await engine.reconcile();

    expect(result.deletedExternal).toBe(0);
    expect(adapter.deleteCalls).toHaveLength(0);
    expect(adapter.allTasks()).toHaveLength(1);
    expect(store.allLinks()).toHaveLength(1);
  });

  it("removes stale links reported by delta removedIds", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "#todo\n- [ ] Deleted externally\n");
    const adapter = new DeletionAwareAdapter("alpha");
    const { engine, store } = await newEngine([entry(adapter)]);
    await engine.reconcile();
    const synced = adapter.allTasks()[0]!;

    await adapter.deleteTask(synced.listId, synced.externalId);
    const created = await engine.pullInbound();

    expect(created).toBe(0);
    expect(store.allLinks()).toHaveLength(0);
  });

  it("does not advance synced markers when inbound write hits an optimistic conflict", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "#todo\n- [ ] Conflict me\n");
    const adapter = new ConcurrentEditAdapter("alpha");
    const { engine, store } = await newEngine([entry(adapter)]);
    await engine.reconcile();
    const synced = adapter.allTasks()[0]!;
    const link = store.allLinks()[0]!;
    const originalExternalModified = link.lastExternalModified;
    const originalHash = link.lastKnownHash;

    adapter.mutateExternal(synced.externalId, { status: "done", done: "2026-06-24" });
    const changed = adapter.allTasks()[0]!;
    adapter.setConcurrentEdit(file, "- [ ] Locally changed #work <!-- sync-id: concurrent -->");

    const result = await engine.reconcile();
    const after = store.allLinks()[0]!;
    const content = await readFile(file, "utf8");

    expect(result.conflicts).toBeGreaterThanOrEqual(1);
    expect(after.lastExternalModified).toBe(originalExternalModified);
    expect(after.lastExternalModified).not.toBe(changed.lastModified);
    expect(after.lastKnownHash).toBe(originalHash);
    expect(content).toMatch(/Locally changed/);
    expect(content).not.toMatch(/\[x\]/);
  });
});
