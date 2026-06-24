import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine, type SyncEngineOptions } from "../src/sync/syncEngine.js";
import { StateStore } from "../src/state/stateStore.js";
import type { BackendEntry } from "../src/sync/backendRegistry.js";
import { FakeAdapter } from "./helpers/fakeAdapter.js";
import { createLogger } from "../src/logger.js";

const silentLogger = createLogger("error");

function entry(adapter: FakeAdapter, policy: BackendEntry["conflictPolicy"] = "newer"): BackendEntry {
  return { adapter, conflictPolicy: policy, tagListMap: {} };
}

describe("SyncEngine", () => {
  let vault: string;
  let statePath: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "ts-engine-"));
    statePath = join(vault, ".task-sync", "state.json");
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
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
      mapping: { strategy: "hybrid" },
      dryRun: false,
      inboundInboxFile: "Sync Inbox.md",
      logger: silentLogger,
      ...opts,
    });
    return { engine, store };
  }

  it("assigns sync IDs and creates tasks outbound across multiple backends", async () => {
    await writeFile(join(vault, "Work.md"), "- [ ] Write report #work\n");
    const a = new FakeAdapter("alpha");
    const b = new FakeAdapter("beta");
    const { engine } = await newEngine([entry(a), entry(b)]);

    const r = await engine.reconcile();
    expect(r.idsAssigned).toBe(1);
    expect(r.createdOutbound).toBe(2); // one per backend

    const content = await readFile(join(vault, "Work.md"), "utf8");
    expect(content).toMatch(/<!-- sync-id: [A-Za-z0-9._~-]+ -->/);
    expect(a.allTasks()).toHaveLength(1);
    expect(b.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.title).toBe("Write report");
  });

  it("is idempotent: a second reconcile makes no further external changes", async () => {
    await writeFile(join(vault, "Work.md"), "- [ ] Task one #work\n");
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();
    const r2 = await engine.reconcile();
    expect(r2.createdOutbound).toBe(0);
    expect(r2.updatedOutbound).toBe(0);
    expect(r2.idsAssigned).toBe(0);
  });

  it("pushes vault edits outbound on the next pass", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "- [ ] Original #work\n");
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();

    const withId = await readFile(file, "utf8");
    await writeFile(file, withId.replace("[ ] Original", "[x] Original ✅ 2026-01-02"));
    const r = await engine.reconcile();
    expect(r.updatedOutbound).toBe(1);
    expect(a.allTasks()[0]!.status).toBe("done");
  });

  it("applies external status changes inbound to the vault", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "- [ ] Finish me #work\n");
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();

    const ext = a.allTasks()[0]!;
    a.mutateExternal(ext.externalId, { status: "done", done: "2026-03-03" });
    const r = await engine.reconcile();
    expect(r.updatedInbound).toBe(1);
    const content = await readFile(file, "utf8");
    expect(content).toMatch(/- \[x\] Finish me/);
  });

  it("creates inbound externally-created tasks into the Sync Inbox", async () => {
    const a = new FakeAdapter("alpha");
    a.seedTask("Personal", { title: "Bought externally", status: "todo" });
    const { engine } = await newEngine([entry(a)]);
    const created = await engine.pullInbound();
    expect(created).toBe(1);
    const inbox = await readFile(join(vault, "Sync Inbox.md"), "utf8");
    expect(inbox).toMatch(/# Sync Inbox/);
    expect(inbox).toMatch(/Bought externally/);
    expect(inbox).toMatch(/<!-- sync-id: /);
  });

  it("resolves conflicts per-backend policy (vault-wins keeps the vault)", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "- [ ] Contended #work\n");
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a, "vault-wins")]);
    await engine.reconcile();

    // Change both sides.
    const ext = a.allTasks()[0]!;
    a.mutateExternal(ext.externalId, { status: "done" });
    const withId = await readFile(file, "utf8");
    await writeFile(file, withId.replace("[ ] Contended", "[/] Contended"));

    const r = await engine.reconcile();
    expect(r.conflicts).toBe(1);
    // vault-wins → outbound; external becomes in-progress, vault unchanged status
    expect(a.allTasks()[0]!.status).toBe("in-progress");
  });

  it("dry-run never writes to the vault or backends", async () => {
    const file = join(vault, "Work.md");
    await writeFile(file, "- [ ] No writes #work\n");
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a)], { dryRun: true });
    const r = await engine.reconcile();
    expect(r.idsAssigned).toBe(1);
    expect(a.allTasks()).toHaveLength(0);
    const content = await readFile(file, "utf8");
    expect(content).not.toMatch(/sync-id/);
  });

  it("does not parse tasks inside fenced code blocks", async () => {
    await mkdir(join(vault, "sub"), { recursive: true });
    await writeFile(
      join(vault, "Note.md"),
      "- [ ] Real task #work\n\n```\n- [ ] Fake task in code\n```\n",
    );
    const a = new FakeAdapter("alpha");
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();
    expect(a.allTasks()).toHaveLength(1);
    expect(a.allTasks()[0]!.title).toBe("Real task");
  });
});
