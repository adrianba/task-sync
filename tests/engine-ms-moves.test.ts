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
 * Microsoft To Do parity coverage. Unlike Supernote, an MS move mints a NEW
 * external id (delete-in-old + create-in-new), so the engine must re-key the
 * link and correlate inbound app-moves via the sync-id carried in the task body
 * — never creating a duplicate vault line.
 */
describe("SyncEngine MS-style (id-changing) move reconciliation", () => {
  let vault: string;
  let statePath: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "ts-ms-moves-"));
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

  // rekeyOnMove=true models Microsoft To Do's non-identity-preserving move.
  function msAdapter(): FakeAdapter {
    return new FakeAdapter("ms-todo", false, true, true);
  }

  it("re-keys the link to the new id on an outbound vault tag move", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = msAdapter();
    const { engine, store } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;
    expect(ext.listId).toBe(a.listIdByName("inbox"));

    // Retag the block from #inbox to #work in the vault.
    const content = await readFile(join(vault, "Inbox.md"), "utf8");
    await writeFile(join(vault, "Inbox.md"), content.replace("#inbox", "#work"));

    const r2 = await engine.reconcile();

    expect(a.moveCalls).toHaveLength(1);
    expect(a.moveCalls[0]!.toListId).toBe(a.listIdByName("work"));

    // Exactly one external task, with a NEW id, in the target list.
    expect(a.allTasks()).toHaveLength(1);
    const moved = a.allTasks()[0]!;
    expect(moved.externalId).not.toBe(ext.externalId);
    expect(moved.listId).toBe(a.listIdByName("work"));
    expect(r2.movedOutbound).toBe(1);
    expect(r2.createdOutbound).toBe(0);

    // The link now points at the new id + list (re-keyed, not duplicated).
    const links = store.allLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.externalId).toBe(moved.externalId);
    expect(links[0]!.externalListId).toBe(a.listIdByName("work"));
  });

  it("correlates an inbound app-move by sync-id without duplicating, then reasserts vault-wins", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = msAdapter();
    const { engine, store } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;
    expect(ext.externalSyncId).toBeDefined();

    // The user moves the task to a different list in the To Do app: old id gone
    // (reported via delta @removed), new id created carrying the same sync-id.
    a.simulateDeviceMoveRekey(ext.externalId, "life");

    const r2 = await engine.reconcile();

    // No duplicate vault line and no spurious inbound import: the moved task is
    // correlated by sync-id and the link is re-keyed (not recreated).
    const inbox = await readFile(join(vault, "Inbox.md"), "utf8");
    expect(inbox.match(/Buy milk/gu) ?? []).toHaveLength(1);
    expect(r2.inboundCreated).toBe(0);
    expect(r2.createdOutbound).toBe(0);
    expect(a.allTasks()).toHaveLength(1);

    // Exactly one link, re-keyed to the live external id.
    let links = store.allLinks();
    expect(links).toHaveLength(1);
    const live = a.allTasks()[0]!;
    expect(links[0]!.externalId).toBe(live.externalId);

    // Vault-wins reasserts on the next pass: the task is pulled back to #inbox.
    const r3 = await engine.reconcile();
    expect(r3.movedOutbound).toBe(1);
    expect(a.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.listId).toBe(a.listIdByName("inbox"));
    links = store.allLinks();
    expect(links).toHaveLength(1);
    expect(links[0]!.externalId).toBe(a.allTasks()[0]!.externalId);
  });

  it("is stable once converged after an inbound app-move", async () => {
    await writeFile(join(vault, "Inbox.md"), "#inbox\n- [ ] Buy milk\n");
    const a = msAdapter();
    const { engine } = await newEngine([entry(a)]);

    await engine.reconcile();
    const ext = a.allTasks()[0]!;
    a.simulateDeviceMoveRekey(ext.externalId, "life");
    await engine.reconcile(); // correlate (re-key)
    await engine.reconcile(); // vault-wins move-back

    const r4 = await engine.reconcile();
    expect(r4.movedInbound).toBe(0);
    expect(r4.movedOutbound).toBe(0);
    expect(r4.createdOutbound).toBe(0);
    expect(r4.inboundCreated).toBe(0);
  });
});
