import { describe, expect, it } from "vitest";
import {
  SupernoteAdapter,
} from "../src/adapters/supernote/supernoteAdapter.js";
import {
  SupernoteConflictError,
  SupernoteCursorExpiredError,
  type ListTasksOptions,
  type ServiceTask,
  type ServiceTaskCreate,
  type ServiceTaskList,
  type ServiceTaskPage,
  type ServiceTaskUpdate,
  type SupernoteServiceClient,
} from "../src/adapters/supernote/client.js";
import {
  inputToCreate,
  isoDateOnly,
  patchToUpdate,
  priorityFromImportance,
  priorityToImportance,
  statusFromService,
  statusToService,
  taskFromService,
} from "../src/adapters/supernote/mapping.js";
import { ExternalConflictError, type SyncAdapter } from "../src/adapters/types.js";
import { logger } from "../src/logger.js";
import type { SupernoteBackendConfig } from "../src/config.js";

function svcTask(overrides: Partial<ServiceTask> = {}): ServiceTask {
  return {
    id: "a".repeat(32),
    list_id: null,
    category: "Inbox",
    title: "Task",
    detail: "",
    status: "needsAction",
    due: null,
    completed: null,
    importance: null,
    last_modified: 0,
    is_deleted: false,
    ...overrides,
  };
}

const cfg: SupernoteBackendConfig = {
  enabled: true,
  conflictPolicy: "vault-wins",
  service: { baseUrl: "https://x", apiKey: "k", requestTimeoutMs: 1000 },
  tagListMap: {},
};

describe("Supernote mapping", () => {
  it("maps status lossily", () => {
    expect(statusToService("done")).toBe("completed");
    expect(statusToService("in-progress")).toBe("needsAction");
    expect(statusFromService("completed")).toBe("done");
    expect(statusFromService("needsAction")).toBe("todo");
  });

  it("maps priorities to/from nullable importance", () => {
    expect(priorityToImportance("high")).toBe(4);
    expect(priorityToImportance("low")).toBe(2);
    expect(priorityToImportance("none")).toBeNull();
    expect(priorityToImportance(undefined)).toBeNull();
    expect(priorityFromImportance(4)).toBe("high");
    expect(priorityFromImportance("1")).toBe("lowest");
    expect(priorityFromImportance(null)).toBeUndefined();
    expect(priorityFromImportance("")).toBeUndefined();
  });

  it("reduces ISO datetimes to date-only", () => {
    expect(isoDateOnly("2026-06-25T00:00:00Z")).toBe("2026-06-25");
    expect(isoDateOnly(null)).toBeUndefined();
    expect(isoDateOnly("")).toBeUndefined();
    expect(isoDateOnly("nonsense")).toBeUndefined();
  });

  it("maps a service task to an external inbox task", () => {
    const ext = taskFromService(
      svcTask({
        id: "abc",
        list_id: null,
        title: "Buy milk",
        status: "completed",
        due: "2026-06-25T00:00:00Z",
        completed: "2026-06-26T00:00:00Z",
        importance: 4,
        last_modified: Date.UTC(2026, 5, 27, 1, 2, 3),
      }),
    );
    expect(ext).toEqual({
      externalId: "abc",
      listId: "",
      title: "Buy milk",
      status: "done",
      due: "2026-06-25",
      done: "2026-06-26",
      priority: "high",
      lastModified: "2026-06-27T01:02:03.000Z",
    });
  });

  it("builds a create body with list, status, due and importance", () => {
    expect(
      inputToCreate("list1", {
        title: "T",
        status: "done",
        due: "2026-06-25",
        priority: "high",
      }),
    ).toEqual({
      title: "T",
      list_id: "list1",
      status: "completed",
      due: "2026-06-25",
      importance: 4,
    });
    expect(inputToCreate("", { title: "T", status: "todo" })).toEqual({
      title: "T",
      list_id: null,
      status: "needsAction",
      due: null,
      importance: null,
    });
  });

  it("builds a partial patch body (omitted fields absent)", () => {
    expect(patchToUpdate({ title: "New" })).toEqual({ title: "New" });
    expect(patchToUpdate({ status: "done" })).toEqual({ status: "completed" });
    expect(patchToUpdate({ due: "2026-06-25" })).toEqual({ due: "2026-06-25" });
    expect(patchToUpdate({ priority: "none" })).toEqual({ importance: null });
    expect(patchToUpdate({})).toEqual({});
  });
});

/** Minimal in-memory fake of the service client for adapter tests. */
class FakeClient implements SupernoteServiceClient {
  public lists: ServiceTaskList[] = [];
  public tasks: ServiceTask[] = [];
  public lastUpdate?: { id: string; body: ServiceTaskUpdate; expected?: number };
  public conflictOnUpdate = false;
  /** When set, a delta `since` strictly below this is rejected as expired. */
  public cursorMinSince?: number;
  /** Records the `since` value of every listTasks call (undefined = active). */
  public sinceCalls: (number | undefined)[] = [];

  listLists(): Promise<ServiceTaskList[]> {
    return Promise.resolve(this.lists);
  }
  ensureList(title: string): Promise<ServiceTaskList> {
    const existing = this.lists.find((l) => l.title === title && !l.is_deleted);
    if (existing) return Promise.resolve(existing);
    const created: ServiceTaskList = {
      id: "l".repeat(32),
      title,
      last_modified: 1,
      is_deleted: false,
    };
    this.lists.push(created);
    return Promise.resolve(created);
  }
  listTasks(options: ListTasksOptions): Promise<ServiceTaskPage> {
    this.sinceCalls.push(options.since);
    if (
      options.since !== undefined &&
      this.cursorMinSince !== undefined &&
      options.since < this.cursorMinSince
    ) {
      return Promise.reject(new SupernoteCursorExpiredError("cursor_expired", "{}"));
    }
    const deltaMode = options.since !== undefined;
    const since = options.since ?? 0;
    const inInbox = options.inbox === true;
    const tasks = this.tasks.filter((t) => {
      if (deltaMode ? t.last_modified < since : t.is_deleted) return false;
      if (inInbox) return t.list_id === null;
      if (options.listId !== undefined) return t.list_id === options.listId;
      return true;
    });
    return Promise.resolve({ tasks, cursor: since + 1, has_more: false });
  }
  getTask(taskId: string): Promise<ServiceTask | null> {
    return Promise.resolve(this.tasks.find((t) => t.id === taskId && !t.is_deleted) ?? null);
  }
  createTask(body: ServiceTaskCreate): Promise<ServiceTask> {
    const created = svcTask({
      id: "n".repeat(32),
      list_id: body.list_id,
      title: body.title,
      status: body.status,
      due: body.due ?? null,
      importance: body.importance ?? null,
      last_modified: 100,
    });
    this.tasks.push(created);
    return Promise.resolve(created);
  }
  updateTask(
    taskId: string,
    body: ServiceTaskUpdate,
    expectedVersionMs?: number,
  ): Promise<ServiceTask> {
    this.lastUpdate = {
      id: taskId,
      body,
      ...(expectedVersionMs !== undefined ? { expected: expectedVersionMs } : {}),
    };
    if (this.conflictOnUpdate) {
      return Promise.reject(new SupernoteConflictError("conflict", "{}"));
    }
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return Promise.reject(new Error("not found"));
    if (body.title !== undefined) task.title = body.title;
    if (body.status !== undefined) task.status = body.status;
    task.last_modified = 200;
    return Promise.resolve(task);
  }
  deleteTask(taskId: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (task) task.is_deleted = true;
    return Promise.resolve();
  }
  version(): Promise<string | undefined> {
    return Promise.resolve("1.2.3");
  }
}

function makeAdapter(client: SupernoteServiceClient): SyncAdapter {
  return new SupernoteAdapter(cfg, logger, client);
}

describe("SupernoteAdapter", () => {
  it("lists lists mapping null id to the inbox empty id", async () => {
    const client = new FakeClient();
    client.lists = [
      { id: null, title: "Inbox", last_modified: 0, is_deleted: false },
      { id: "g".repeat(32), title: "Work", last_modified: 1, is_deleted: false },
    ];
    const adapter = makeAdapter(client);
    expect(await adapter.listLists()).toEqual([
      { id: "", name: "Inbox" },
      { id: "g".repeat(32), name: "Work" },
    ]);
  });

  it("ensureList short-circuits the inbox and creates others idempotently", async () => {
    const client = new FakeClient();
    const adapter = makeAdapter(client);
    expect(await adapter.ensureList("Inbox")).toBe("");
    const id1 = await adapter.ensureList("Work");
    const id2 = await adapter.ensureList("Work");
    expect(id1).toBe(id2);
    expect(client.lists.length).toBe(1);
  });

  it("creates and reads back a task", async () => {
    const client = new FakeClient();
    const adapter = makeAdapter(client);
    const ext = await adapter.createTask("", {
      title: "Hi",
      status: "todo",
      priority: "medium",
    });
    expect(ext.title).toBe("Hi");
    expect(ext.priority).toBe("medium");
    expect(ext.lastModified).toBe(new Date(100).toISOString());
  });

  it("passes the observed version as an optimistic-concurrency guard", async () => {
    const client = new FakeClient();
    client.tasks = [svcTask({ id: "t".repeat(32), last_modified: 50 })];
    const adapter = makeAdapter(client);
    await adapter.updateTask("", "t".repeat(32), { title: "X" }, new Date(50).toISOString());
    expect(client.lastUpdate?.expected).toBe(50);
  });

  it("translates a service 409 into an ExternalConflictError", async () => {
    const client = new FakeClient();
    client.tasks = [svcTask({ id: "t".repeat(32) })];
    client.conflictOnUpdate = true;
    const adapter = makeAdapter(client);
    await expect(
      adapter.updateTask("", "t".repeat(32), { title: "X" }, new Date(1).toISOString()),
    ).rejects.toBeInstanceOf(ExternalConflictError);
  });

  it("splits delta results into changed and removed when given a cursor", async () => {
    const client = new FakeClient();
    client.tasks = [
      svcTask({ id: "1".repeat(32), title: "Keep", last_modified: 10 }),
      svcTask({ id: "2".repeat(32), title: "Gone", last_modified: 20, is_deleted: true }),
    ];
    const adapter = makeAdapter(client);
    const res = await adapter.delta!("", "5");
    expect(res.changed.map((t) => t.externalId)).toEqual(["1".repeat(32)]);
    expect(res.removedIds).toEqual(["2".repeat(32)]);
    expect(res.token).toBe("6");
    // An incremental delta must use the numeric cursor (delta mode).
    expect(client.sinceCalls).toEqual([5]);
  });

  it("does a full active resync (no since, excludes deleted) on first delta", async () => {
    const client = new FakeClient();
    client.tasks = [
      svcTask({ id: "1".repeat(32), title: "Keep", last_modified: 10 }),
      svcTask({ id: "2".repeat(32), title: "Gone", last_modified: 20, is_deleted: true }),
    ];
    const adapter = makeAdapter(client);
    const res = await adapter.delta!("", undefined);
    expect(res.changed.map((t) => t.externalId)).toEqual(["1".repeat(32)]);
    expect(res.removedIds).toEqual([]);
    // The first page must omit `since` so it is valid even under CURSOR_MAX_AGE_MS.
    expect(client.sinceCalls).toEqual([undefined]);
  });

  it("recovers from an expired cursor with a full resync", async () => {
    const client = new FakeClient();
    client.cursorMinSince = 1000;
    client.tasks = [svcTask({ id: "1".repeat(32), title: "Keep", last_modified: 10 })];
    const adapter = makeAdapter(client);
    const res = await adapter.delta!("", "5");
    expect(res.changed.map((t) => t.externalId)).toEqual(["1".repeat(32)]);
    // First the stale cursor (5) is rejected, then a full resync with no since.
    expect(client.sinceCalls).toEqual([5, undefined]);
  });
});
