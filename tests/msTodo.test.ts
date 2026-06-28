import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenCacheContext } from "@azure/msal-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedTokenCachePlugin } from "../src/adapters/msTodo/tokenCache.js";
import {
  fromGraphTask,
  graphDateToIsoDate,
  importanceToPriority,
  isoDateToGraphDate,
  priorityToImportance,
  statusFromGraph,
  statusToGraph,
  toGraphBody,
  type GraphTodoTask,
} from "../src/adapters/msTodo/mapping.js";
import type { LogFields, Logger } from "../src/logger.js";
import { decryptString } from "../src/util/crypto.js";

const cachePath = "tests/.msal-cache-test.enc";
const key = Buffer.alloc(32, 7);

const errorLog = vi.fn<(msg: string, fields?: LogFields) => void>();

const testLogger: Logger = {
  level: "debug",
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: errorLog,
  child: () => testLogger,
};

afterEach(async () => {
  await rm(cachePath, { force: true });
  vi.clearAllMocks();
});

describe("Microsoft To Do mapping", () => {
  it("maps normalized statuses to Graph statuses", () => {
    expect(statusToGraph("todo")).toBe("notStarted");
    expect(statusToGraph("in-progress")).toBe("inProgress");
    expect(statusToGraph("done")).toBe("completed");
    expect(statusToGraph("cancelled")).toBe("notStarted");
    expect(statusToGraph("other")).toBe("notStarted");
  });

  it("maps Graph statuses to normalized statuses", () => {
    expect(statusFromGraph("notStarted")).toBe("todo");
    expect(statusFromGraph("inProgress")).toBe("in-progress");
    expect(statusFromGraph("completed")).toBe("done");
    expect(statusFromGraph("waitingOnOthers")).toBe("todo");
    expect(statusFromGraph("deferred")).toBe("todo");
    expect(statusFromGraph(undefined)).toBe("todo");
  });

  it("maps priority and importance both directions", () => {
    expect(priorityToImportance("highest")).toBe("high");
    expect(priorityToImportance("high")).toBe("high");
    expect(priorityToImportance("medium")).toBe("normal");
    expect(priorityToImportance("none")).toBe("normal");
    expect(priorityToImportance("low")).toBe("low");
    expect(priorityToImportance("lowest")).toBe("low");
    expect(priorityToImportance(undefined)).toBe("normal");

    expect(importanceToPriority("high")).toBe("high");
    expect(importanceToPriority("low")).toBe("low");
    expect(importanceToPriority("normal")).toBe("none");
    expect(importanceToPriority(undefined)).toBe("none");
  });

  it("uses date-only UTC Graph date shapes", () => {
    expect(isoDateToGraphDate("2026-06-24")).toEqual({
      dateTime: "2026-06-24T00:00:00",
      timeZone: "UTC",
    });
    expect(
      graphDateToIsoDate({ dateTime: "2026-06-24T17:45:00", timeZone: "UTC" }),
    ).toBe("2026-06-24");
    expect(graphDateToIsoDate(null)).toBeUndefined();
  });

  it("maps Graph todoTask objects to ExternalTask without undefined optionals", () => {
    const raw: GraphTodoTask = {
      id: "task-1",
      title: "Write tests",
      status: "completed",
      importance: "high",
      dueDateTime: { dateTime: "2026-07-01T09:00:00", timeZone: "UTC" },
      startDateTime: { dateTime: "2026-06-25T00:00:00", timeZone: "UTC" },
      completedDateTime: { dateTime: "2026-07-02T10:30:00", timeZone: "UTC" },
      lastModifiedDateTime: "2026-07-02T10:31:00Z",
    };

    expect(fromGraphTask(raw, "list-1")).toEqual({
      externalId: "task-1",
      listId: "list-1",
      title: "Write tests",
      status: "done",
      due: "2026-07-01",
      start: "2026-06-25",
      done: "2026-07-02",
      priority: "high",
      lastModified: "2026-07-02T10:31:00Z",
    });

    const minimal = fromGraphTask({ id: "task-2" }, "list-1");
    expect(minimal).toEqual({
      externalId: "task-2",
      listId: "list-1",
      title: "",
      status: "todo",
    });
    expect(Object.hasOwn(minimal, "due")).toBe(false);
    expect(Object.hasOwn(minimal, "priority")).toBe(false);
  });

  it("maps ExternalTaskInput to Graph request bodies", () => {
    expect(
      toGraphBody({
        title: "Ship backend",
        status: "in-progress",
        due: "2026-07-10",
        start: "2026-07-01",
        priority: "lowest",
      }),
    ).toEqual({
      title: "Ship backend",
      status: "inProgress",
      dueDateTime: { dateTime: "2026-07-10T00:00:00", timeZone: "UTC" },
      startDateTime: { dateTime: "2026-07-01T00:00:00", timeZone: "UTC" },
      importance: "low",
    });
  });

  it("sets completedDateTime when completing a task", () => {
    expect(
      toGraphBody({ title: "Done", status: "done", done: "2026-07-12" }),
    ).toEqual({
      title: "Done",
      status: "completed",
      completedDateTime: { dateTime: "2026-07-12T00:00:00", timeZone: "UTC" },
    });
  });

  it("round-trips writable normalized fields through Graph shapes", () => {
    const body = toGraphBody({
      title: "Round trip",
      status: "done",
      due: "2026-08-01",
      start: "2026-07-31",
      done: "2026-08-02",
      priority: "highest",
    });
    const raw: GraphTodoTask = {
      id: "round-trip-id",
      title: body.title,
      status: body.status,
      importance: body.importance,
      dueDateTime: body.dueDateTime,
      startDateTime: body.startDateTime,
      completedDateTime: body.completedDateTime,
    };

    expect(fromGraphTask(raw, "list-id")).toMatchObject({
      externalId: "round-trip-id",
      listId: "list-id",
      title: "Round trip",
      status: "done",
      due: "2026-08-01",
      start: "2026-07-31",
      done: "2026-08-02",
      priority: "high",
    });
  });
});

describe("EncryptedTokenCachePlugin", () => {
  it("persists encrypted MSAL cache data and reloads it", async () => {
    await mkdir(dirname(cachePath), { recursive: true });
    const plugin = new EncryptedTokenCachePlugin(cachePath, key, testLogger);
    const writeContext = fakeCacheContext("{\"secret\":true}", true);

    await plugin.afterCacheAccess(writeContext);

    const encrypted = await readFile(cachePath, "utf8");
    expect(encrypted).not.toContain("secret");
    expect(decryptString(encrypted, key)).toBe("{\"secret\":true}");
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);

    const readContext = fakeCacheContext("", false);
    await plugin.beforeCacheAccess(readContext);

    expect(readContext.tokenCache.deserialize).toHaveBeenCalledWith("{\"secret\":true}");
  });

  it("starts fresh on missing or undecryptable cache files", async () => {
    const plugin = new EncryptedTokenCachePlugin(cachePath, key, testLogger);
    const missingContext = fakeCacheContext("", false);
    await plugin.beforeCacheAccess(missingContext);
    expect(missingContext.tokenCache.deserialize).not.toHaveBeenCalled();

    await mkdir(dirname(cachePath), { recursive: true });
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(cachePath, "not encrypted", { mode: 0o600 }),
    );
    await plugin.beforeCacheAccess(missingContext);
    expect(errorLog).toHaveBeenCalled();
    const [message, fields] = errorLog.mock.calls[0] ?? [];
    expect(message).toBe("Failed to decrypt MSAL token cache; starting fresh");
    // The raw error is deliberately not logged (it can carry paths/crypto
    // internals); only a generic message is emitted.
    expect(fields).toBeUndefined();
  });
});

function fakeCacheContext(serialized: string, changed: boolean): TokenCacheContext {
  return {
    cacheHasChanged: changed,
    tokenCache: {
      serialize: vi.fn(() => serialized),
      deserialize: vi.fn(),
    },
  } as unknown as TokenCacheContext;
}
