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

function entry(
  adapter: FakeAdapter,
  policy: BackendEntry["conflictPolicy"] = "vault-wins",
): BackendEntry {
  return { adapter, conflictPolicy: policy, tagListMap: {} };
}

/** Titles of a backend's tasks ordered by their `order` field. */
function orderedTitles(a: FakeAdapter): string[] {
  return a
    .allTasks()
    .slice()
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
    .map((t) => t.title);
}

/** Titles of the task lines in a markdown file, in document order. */
async function lineTitles(file: string): Promise<string[]> {
  const content = await readFile(file, "utf8");
  return content
    .split("\n")
    .filter((l) => /^- \[/.test(l))
    .map((l) => l.replace(/^- \[.\]\s*/, "").replace(/\s*<!--.*$/, "").trim());
}

/** Rewrite the file's task lines into the given title order (sync-ids kept). */
async function reorderFile(file: string, titles: string[]): Promise<void> {
  const lines = (await readFile(file, "utf8")).split("\n");
  const taskLines = lines.filter((l) => /^- \[/.test(l));
  const byTitle = new Map(
    taskLines.map((l) => [l.replace(/^- \[.\]\s*/, "").replace(/\s*<!--.*$/, "").trim(), l]),
  );
  const reordered = titles.map((t) => byTitle.get(t)!);
  let i = 0;
  const out = lines.map((l) => (/^- \[/.test(l) ? reordered[i++]! : l));
  await writeFile(file, out.join("\n"));
}

describe("SyncEngine ordering", () => {
  let vault: string;
  let statePath: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "ts-order-"));
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

  it("creates tasks in document order and keeps the backend order matching", async () => {
    await writeFile(join(vault, "Groceries.md"), "- [ ] A\n- [ ] B\n- [ ] C\n");
    const a = new FakeAdapter("supernote", true);
    const { engine } = await newEngine([entry(a)]);

    await engine.reconcile();
    expect(orderedTitles(a)).toEqual(["A", "B", "C"]);
  });

  it("pushes a vault reorder outbound to the backend", async () => {
    const file = join(vault, "Groceries.md");
    await writeFile(file, "- [ ] A\n- [ ] B\n- [ ] C\n");
    const a = new FakeAdapter("supernote", true);
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();

    await reorderFile(file, ["C", "A", "B"]);
    const r = await engine.reconcile();

    expect(orderedTitles(a)).toEqual(["C", "A", "B"]);
    expect(r.reorderedOutbound).toBeGreaterThan(0);
  });

  it("reflects a device reorder back into the markdown (inbound)", async () => {
    const file = join(vault, "Groceries.md");
    await writeFile(file, "- [ ] A\n- [ ] B\n- [ ] C\n");
    const a = new FakeAdapter("supernote", true);
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();

    // Simulate a device reorder: C, A, B.
    const ids = Object.fromEntries(a.allTasks().map((t) => [t.title, t.externalId]));
    a.mutateExternal(ids.C!, { order: 0 });
    a.mutateExternal(ids.A!, { order: 1 });
    a.mutateExternal(ids.B!, { order: 2 });

    const r = await engine.reconcile();
    expect(await lineTitles(file)).toEqual(["C", "A", "B"]);
    expect(r.reorderedInbound).toBeGreaterThan(0);
  });

  it("on an ordering conflict, vault order wins (vault-wins policy)", async () => {
    const file = join(vault, "Groceries.md");
    await writeFile(file, "- [ ] A\n- [ ] B\n- [ ] C\n");
    const a = new FakeAdapter("supernote", true);
    const { engine } = await newEngine([entry(a, "vault-wins")]);
    await engine.reconcile();

    // Both sides reorder differently since the last sync.
    await reorderFile(file, ["B", "C", "A"]);
    const ids = Object.fromEntries(a.allTasks().map((t) => [t.title, t.externalId]));
    a.mutateExternal(ids.C!, { order: 0 });
    a.mutateExternal(ids.A!, { order: 1 });
    a.mutateExternal(ids.B!, { order: 2 });

    await engine.reconcile();
    // Vault wins: backend order matches the markdown order.
    expect(orderedTitles(a)).toEqual(["B", "C", "A"]);
    expect(await lineTitles(file)).toEqual(["B", "C", "A"]);
  });

  it("is idempotent: a second pass issues no further reorders", async () => {
    const file = join(vault, "Groceries.md");
    await writeFile(file, "- [ ] A\n- [ ] B\n- [ ] C\n");
    const a = new FakeAdapter("supernote", true);
    const { engine } = await newEngine([entry(a)]);
    await engine.reconcile();
    await reorderFile(file, ["C", "A", "B"]);
    await engine.reconcile();
    const r = await engine.reconcile();
    expect(r.reorderedOutbound).toBe(0);
    expect(r.reorderedInbound).toBe(0);
  });
});
