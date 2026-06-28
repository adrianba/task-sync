import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine, type SyncEngineOptions } from "../src/sync/syncEngine.js";
import { StateStore } from "../src/state/stateStore.js";
import type { BackendEntry } from "../src/sync/backendRegistry.js";
import { FakeAdapter } from "./helpers/fakeAdapter.js";
import { createLogger } from "../src/logger.js";

const silentLogger = createLogger("error");

function entry(adapter: FakeAdapter): BackendEntry {
  return { adapter, conflictPolicy: "vault-wins", tagListMap: {} };
}

/**
 * Regression coverage for Supernote cross-list moves: a move preserves the task
 * id, so it must never be mistaken for a deletion (no recreate, no duplicate);
 * inbound device moves relocate the markdown line, outbound vault tag moves
 * PATCH the backend list, and a both-moved conflict resolves vault-wins.
 */
describe("SyncEngine list-membership (move) reconciliation", () => {
  let vault: string;
  let statePath: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "ts-moves-"));
    statePath = join(vault, ".task-sync", "state.json");
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  async function newEngine(
    backends: BackendEntry[],
  ): Promise<{ engine: SyncEngine; store: StateStore }> {
    const store = new StateStore(statePath);
    await store.load();
    const options: SyncEngineOptions = {
      vaultPath: vault,
      ignore: [".obsidian", ".git"],
      definedTags: ["todo", "inbox", "life", "work"],
      dryRun: false,
      inboundInboxFile: "Sync Inbox.md",
      logger: silentLogger,
    };
    return { engine: new SyncEngine(backends, store, options), store };
  }

  it("relocates the markdown line on an inbound device move without duplicating or recreating", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = new FakeAdapter("supernote", false, true);
    const { engine, store } = await newEngine([entry(a)]);

    await engine.reconcile();
    expect(a.allTasks()).toHaveLength(1);
    const ext = a.allTasks()[0]!;

    // The user moves the task from the Inbox to the "life" list on the device.
    a.simulateDeviceMove(ext.externalId, "life");

    const r2 = await engine.reconcile();

    // No recreate, no duplicate: the same external task id survives.
    expect(a.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.externalId).toBe(ext.externalId);
    expect(r2.createdOutbound).toBe(0);
    expect(r2.inboundCreated).toBe(0);
    expect(r2.movedInbound).toBe(1);

    // The line is relocated out of #inbox into a #life block (a fresh Sync Inbox
    // block, since no #life block existed).
    const inbox = await readFile(join(vault, "Inbox.md"), "utf8");
    expect(inbox).not.toMatch(/Buy milk/);
    const syncInbox = await readFile(join(vault, "Sync Inbox.md"), "utf8");
    expect(syncInbox).toMatch(/#life/);
    expect(syncInbox).toMatch(/Buy milk/);

    // The link now points at the "life" list.
    const link = store.allLinks().find((l) => l.externalId === ext.externalId)!;
    expect(link.externalListId).toBe(a.listIdByName("life"));
  });

  it("relocates an inbound move into an existing block for that tag", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    await writeFile(join(vault, "Life.md"), "#life\n- [ ] Call mum\n");
    const a = new FakeAdapter("supernote", false, true);
    const { engine } = await newEngine([entry(a)]);

    await engine.reconcile();
    const milk = a.allTasks().find((t) => t.title === "Buy milk")!;
    a.simulateDeviceMove(milk.externalId, "life");

    await engine.reconcile();

    const inbox = await readFile(join(vault, "Inbox.md"), "utf8");
    expect(inbox).not.toMatch(/Buy milk/);
    const life = await readFile(join(vault, "Life.md"), "utf8");
    expect(life).toMatch(/Buy milk/); // landed in the existing #life block
  });

  it("moves the backend task on an outbound vault tag change (no duplicate)", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = new FakeAdapter("supernote", false, true);
    const { engine, store } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;
    expect(ext.listId).toBe(a.listIdByName("inbox"));

    // The user retags the task block from #inbox to #work in the vault.
    const content = await readFile(join(vault, "Inbox.md"), "utf8");
    await writeFile(join(vault, "Inbox.md"), content.replace("#inbox", "#work"));

    const r2 = await engine.reconcile();

    expect(a.moveCalls).toHaveLength(1);
    expect(a.moveCalls[0]!.toListId).toBe(a.listIdByName("work"));
    expect(a.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.externalId).toBe(ext.externalId);
    expect(a.allTasks()[0]!.listId).toBe(a.listIdByName("work"));
    expect(r2.movedOutbound).toBe(1);
    expect(r2.createdOutbound).toBe(0);

    const link = store.allLinks().find((l) => l.externalId === ext.externalId)!;
    expect(link.externalListId).toBe(a.listIdByName("work"));
  });

  it("resolves a both-moved conflict vault-wins", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = new FakeAdapter("supernote", false, true);
    const { engine } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;

    // Device moves it to "life"; the vault retags it to #work in the same window.
    a.simulateDeviceMove(ext.externalId, "life");
    const content = await readFile(join(vault, "Inbox.md"), "utf8");
    await writeFile(join(vault, "Inbox.md"), content.replace("#inbox", "#work"));

    const r2 = await engine.reconcile();

    // Vault wins: the backend task ends up in "work", not "life".
    expect(a.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.listId).toBe(a.listIdByName("work"));
    expect(r2.movedOutbound).toBe(1);

    const inbox = await readFile(join(vault, "Inbox.md"), "utf8");
    expect(inbox).toMatch(/#work/);
    expect(inbox).toMatch(/Buy milk/);
  });

  it("is stable: a second reconcile after an inbound move makes no further changes", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = new FakeAdapter("supernote", false, true);
    const { engine } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;
    a.simulateDeviceMove(ext.externalId, "life");
    await engine.reconcile();

    const r3 = await engine.reconcile();
    expect(r3.movedInbound).toBe(0);
    expect(r3.movedOutbound).toBe(0);
    expect(r3.createdOutbound).toBe(0);
    expect(r3.inboundCreated).toBe(0);
  });
});
