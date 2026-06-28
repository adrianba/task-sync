import { describe, expect, it } from "vitest";
import { GraphClient } from "../src/adapters/msTodo/graphClient.js";
import { MsTodoAdapter } from "../src/adapters/msTodo/msTodoAdapter.js";
import { ExternalConflictError } from "../src/adapters/types.js";
import type { MsTodoBackendConfig } from "../src/config.js";
import type { GraphTodoTask } from "../src/adapters/msTodo/mapping.js";

/**
 * Minimal in-memory Microsoft Graph To Do server backing a fake `fetch`, just
 * rich enough to exercise the adapter's move/concurrency logic (id-changing
 * move, ETag `If-Match`, `lastModified` guard) with no network.
 */
class FakeGraph {
  private seq = 1;
  readonly tasks = new Map<string, GraphTodoTask & { __list: string }>();
  readonly calls: { method: string; path: string; ifMatch?: string }[] = [];

  seed(list: string, task: Partial<GraphTodoTask> & { id: string }): void {
    this.tasks.set(task.id, {
      __list: list,
      lastModifiedDateTime: this.stamp(),
      "@odata.etag": this.etag(),
      ...task,
    });
  }

  private stamp(): string {
    return new Date(this.seq++ * 1000).toISOString();
  }
  private etag(): string {
    return `W/"${this.seq}"`;
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    const headers = new Headers(init?.headers);
    const ifMatch = headers.get("If-Match") ?? undefined;
    this.calls.push({ method, path, ...(ifMatch !== undefined ? { ifMatch } : {}) });

    // /me/todo/lists/{list}/tasks(/{id})
    const m = /^\/me\/todo\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/u.exec(path);
    if (!m) return this.json(404, { error: "not found" });
    const listId = decodeURIComponent(m[1]!);
    const taskId = m[2] ? decodeURIComponent(m[2]) : undefined;

    if (method === "POST") {
      const body = JSON.parse(((init?.body as string | undefined) ?? "{}")) as GraphTodoTask;
      const id = `gen-${this.seq}`;
      const created: GraphTodoTask & { __list: string } = {
        __list: listId,
        id,
        lastModifiedDateTime: this.stamp(),
        "@odata.etag": this.etag(),
        ...body,
      };
      this.tasks.set(id, created);
      return this.json(201, created);
    }

    if (taskId === undefined) return this.json(404, { error: "not found" });
    const existing = this.tasks.get(taskId);

    if (method === "GET") {
      if (!existing || existing.__list !== listId) return this.json(404, { error: "gone" });
      return this.json(200, existing);
    }

    if (method === "PATCH") {
      if (!existing) return this.json(404, { error: "gone" });
      if (ifMatch !== undefined && ifMatch !== existing["@odata.etag"]) {
        return this.json(412, { error: "precondition failed" });
      }
      const body = JSON.parse(((init?.body as string | undefined) ?? "{}")) as GraphTodoTask;
      const updated = {
        ...existing,
        ...body,
        lastModifiedDateTime: this.stamp(),
        "@odata.etag": this.etag(),
      };
      this.tasks.set(taskId, updated);
      return this.json(200, updated);
    }

    if (method === "DELETE") {
      if (!existing) return this.json(404, { error: "gone" });
      if (ifMatch !== undefined && ifMatch !== existing["@odata.etag"]) {
        return this.json(412, { error: "precondition failed" });
      }
      this.tasks.delete(taskId);
      return new Response(null, { status: 204 });
    }

    return this.json(405, { error: "method not allowed" });
  };

  private json(status: number, body: unknown): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

function makeAdapter(graph: FakeGraph): MsTodoAdapter {
  const client = new GraphClient(() => Promise.resolve("token"), undefined, {
    fetch: graph.fetch,
    maxRetries: 0,
  });
  return new MsTodoAdapter({} as MsTodoBackendConfig, Buffer.alloc(32), undefined, undefined, client);
}

describe("MsTodoAdapter.moveTask", () => {
  it("emulates a move (create in target + delete source) with a new id, preserving notes", async () => {
    const graph = new FakeGraph();
    graph.seed("listA", {
      id: "old-1",
      title: "Buy milk",
      status: "notStarted",
      body: { contentType: "text", content: "remember the cap <!-- sync-id: sid-1 -->" },
    });
    const adapter = makeAdapter(graph);

    const moved = await adapter.moveTask("old-1", "listA", "listB");

    expect(moved.externalId).not.toBe("old-1");
    expect(moved.listId).toBe("listB");
    expect(moved.externalSyncId).toBe("sid-1");
    // Source gone, a new task exists in the target carrying the marker + notes.
    expect(graph.tasks.has("old-1")).toBe(false);
    const created = graph.tasks.get(moved.externalId);
    expect(created?.body?.content).toContain("<!-- sync-id: sid-1 -->");
    expect(created?.body?.content).toContain("remember the cap");
    // Delete carried an If-Match on the source ETag.
    expect(graph.calls.some((c) => c.method === "DELETE" && c.ifMatch !== undefined)).toBe(true);
  });

  it("throws ExternalConflictError on a stale version, leaving no partial state", async () => {
    const graph = new FakeGraph();
    graph.seed("listA", { id: "old-2", title: "T", status: "notStarted" });
    const adapter = makeAdapter(graph);

    await expect(adapter.moveTask("old-2", "listA", "listB", "1999-01-01T00:00:00.000Z")).rejects.toBeInstanceOf(
      ExternalConflictError,
    );
    // No create/delete happened.
    expect(graph.tasks.has("old-2")).toBe(true);
    expect([...graph.tasks.values()].every((t) => t.__list === "listA")).toBe(true);
  });
});

describe("MsTodoAdapter optimistic concurrency", () => {
  it("updateTask sends If-Match and embeds the sync-id marker preserving notes", async () => {
    const graph = new FakeGraph();
    graph.seed("listA", {
      id: "t-1",
      title: "Old",
      status: "notStarted",
      body: { contentType: "text", content: "user note" },
    });
    const current = graph.tasks.get("t-1")!;
    const adapter = makeAdapter(graph);

    const updated = await adapter.updateTask(
      "listA",
      "t-1",
      { title: "New", status: "todo", syncId: "sid-9" },
      current.lastModifiedDateTime,
    );

    expect(updated.title).toBe("New");
    const patch = graph.calls.find((c) => c.method === "PATCH");
    expect(patch?.ifMatch).toBe(current["@odata.etag"]);
    const stored = graph.tasks.get("t-1");
    expect(stored?.body?.content).toContain("user note");
    expect(stored?.body?.content).toContain("<!-- sync-id: sid-9 -->");
  });

  it("updateTask rejects a stale expectedVersion without patching", async () => {
    const graph = new FakeGraph();
    graph.seed("listA", { id: "t-2", title: "X", status: "notStarted" });
    const adapter = makeAdapter(graph);

    await expect(
      adapter.updateTask("listA", "t-2", { title: "Y", status: "todo" }, "1999-01-01T00:00:00.000Z"),
    ).rejects.toBeInstanceOf(ExternalConflictError);
    expect(graph.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("deleteTask is idempotent on a missing task", async () => {
    const graph = new FakeGraph();
    const adapter = makeAdapter(graph);
    await expect(adapter.deleteTask("listA", "missing")).resolves.toBeUndefined();
  });
});
