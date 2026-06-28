import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/adapters/msTodo/graphClient.js";
import { MsTodoAdapter } from "../src/adapters/msTodo/msTodoAdapter.js";
import type { MsTodoBackendConfig } from "../src/config.js";

interface FakeList {
  id: string;
  displayName: string;
  wellknownListName?: string;
}

/**
 * Fake `fetch` serving `/me/todo/lists` so we can drive the adapter's default-
 * list ("Inbox") resolution without a network. Records POSTs so tests can assert
 * the inbox is never created.
 */
function makeAdapter(lists: FakeList[]): {
  adapter: MsTodoAdapter;
  calls: { method: string; path: string }[];
  created: FakeList[];
} {
  const calls: { method: string; path: string }[] = [];
  const created: FakeList[] = [];
  let seq = 1;

  const fakeFetch = vi.fn<typeof fetch>((input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    calls.push({ method, path });

    if (path === "/me/todo/lists" && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ value: lists }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (path === "/me/todo/lists" && method === "POST") {
      const body = JSON.parse(((init?.body as string | undefined) ?? "{}")) as {
        displayName: string;
      };
      const list: FakeList = { id: `new-${seq++}`, displayName: body.displayName };
      lists.push(list);
      created.push(list);
      return Promise.resolve(
        new Response(JSON.stringify(list), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
  });

  const client = new GraphClient(() => Promise.resolve("token"), undefined, {
    fetch: fakeFetch,
    maxRetries: 0,
  });
  const adapter = new MsTodoAdapter(
    {} as MsTodoBackendConfig,
    Buffer.alloc(32),
    undefined,
    undefined,
    client,
  );
  return { adapter, calls, created };
}

describe("MsTodoAdapter default list as Inbox", () => {
  it("exposes the default list under the stable name 'Inbox', preserving its id", async () => {
    const { adapter } = makeAdapter([
      { id: "def-1", displayName: "Aufgaben", wellknownListName: "defaultList" },
      { id: "work-1", displayName: "Work" },
    ]);

    const lists = await adapter.listLists();

    const inbox = lists.find((l) => l.id === "def-1");
    expect(inbox?.name).toBe("Inbox"); // localized "Aufgaben" hidden behind a stable name
    // Other lists keep their real display names.
    expect(lists.find((l) => l.id === "work-1")?.name).toBe("Work");
  });

  it("resolves ensureList('inbox') to the default list id without creating a list", async () => {
    const { adapter, created } = makeAdapter([
      { id: "def-1", displayName: "Tasks", wellknownListName: "defaultList" },
      { id: "work-1", displayName: "Work" },
    ]);

    expect(await adapter.ensureList("inbox")).toBe("def-1");
    expect(await adapter.ensureList("Inbox")).toBe("def-1");
    expect(await adapter.ensureList("  INBOX  ")).toBe("def-1");
    expect(created).toHaveLength(0);
  });

  it("still matches existing non-default lists and creates genuinely new ones", async () => {
    const { adapter, created } = makeAdapter([
      { id: "def-1", displayName: "Tasks", wellknownListName: "defaultList" },
      { id: "work-1", displayName: "Work" },
    ]);

    expect(await adapter.ensureList("Work")).toBe("work-1");
    expect(created).toHaveLength(0);

    const newId = await adapter.ensureList("Groceries");
    expect(newId).toMatch(/^new-/u);
    expect(created.map((l) => l.displayName)).toEqual(["Groceries"]);
  });

  it("caches default-list discovery (lists fetched once across ensureList calls)", async () => {
    const { adapter, calls } = makeAdapter([
      { id: "def-1", displayName: "Tasks", wellknownListName: "defaultList" },
    ]);

    await adapter.ensureList("inbox");
    await adapter.ensureList("inbox");
    await adapter.ensureList("inbox");

    const listGets = calls.filter((c) => c.path === "/me/todo/lists" && c.method === "GET");
    expect(listGets).toHaveLength(1);
  });

  it("throws a clear error when Graph returns no default list", async () => {
    const { adapter } = makeAdapter([{ id: "work-1", displayName: "Work" }]);
    await expect(adapter.ensureList("inbox")).rejects.toThrow(/no default list/u);
  });
});
