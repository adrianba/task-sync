import type { MsTodoBackendConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";
import {
  ExternalConflictError,
  type DeltaResult,
  type ExternalList,
  type ExternalTask,
  type ExternalTaskInput,
  type SyncAdapter,
} from "../types.js";
import { MsAuth } from "./auth.js";
import { GraphClient, GraphDeltaGoneError, GraphPreconditionFailedError } from "./graphClient.js";
import {
  embedSyncIdInBody,
  fromGraphTask,
  toGraphBody,
  type GraphTodoTask,
  type GraphTodoTaskBody,
} from "./mapping.js";

interface RemovedGraphTask extends GraphTodoTask {
  "@removed"?: unknown;
}

export class DeltaTokenExpiredError extends Error {
  constructor(message = "Microsoft To Do delta token expired") {
    super(message);
    this.name = "DeltaTokenExpiredError";
  }
}

export class MsTodoAdapter implements SyncAdapter {
  readonly backend = "ms-todo";
  private auth: MsAuth | undefined;
  private graph: GraphClient | undefined;

  constructor(
    private readonly config: MsTodoBackendConfig,
    private readonly tokenKey: Buffer,
    private readonly log: Logger = defaultLogger,
    private readonly signal?: AbortSignal,
    /** Test seam: inject a pre-built (e.g. fake-fetch-backed) Graph client. */
    graph?: GraphClient,
  ) {
    this.graph = graph;
  }

  async init(): Promise<void> {
    const graph = this.client();
    await graph.listLists();
  }

  async listLists(): Promise<ExternalList[]> {
    const lists = await this.client().listLists();
    return lists.map((list) => ({ id: list.id, name: list.displayName }));
  }

  async ensureList(name: string): Promise<string> {
    const lists = await this.listLists();
    const existing = lists.find((list) => list.name === name);
    if (existing) return existing.id;

    const created = await this.client().createList(name);
    if (!created.id) throw new Error(`Microsoft To Do list creation returned no id for ${name}`);
    return created.id;
  }

  async listTasks(listId: string): Promise<ExternalTask[]> {
    const tasks = await this.client().listTasks<GraphTodoTask>(listId);
    return tasks.map((task) => fromGraphTask(task, listId));
  }

  async getTask(listId: string, externalId: string): Promise<ExternalTask | null> {
    try {
      const task = await this.client().getTask<GraphTodoTask>(listId, externalId);
      return fromGraphTask(task, listId);
    } catch (err) {
      if (isGraphNotFound(err)) return null;
      throw err;
    }
  }

  async createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask> {
    const body = toGraphBody(input);
    if (input.syncId !== undefined) body.body = embedSyncIdInBody(input.syncId);
    const task = await this.client().createTask<GraphTodoTask>(listId, body);
    return fromGraphTask(task, listId);
  }

  async updateTask(
    listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
    expectedVersion?: string,
  ): Promise<ExternalTask> {
    // Read fresh to enforce optimistic concurrency (Graph has no timestamp-based
    // conditional header, only ETag) and to obtain the body for a non-clobbering
    // sync-id marker merge. A version mismatch means the task changed since the
    // caller observed it → defer to the engine's conflict policy.
    const current = await this.client().getTask<GraphTodoTask>(listId, externalId);
    if (
      expectedVersion !== undefined &&
      current.lastModifiedDateTime !== undefined &&
      current.lastModifiedDateTime !== expectedVersion
    ) {
      throw new ExternalConflictError(
        `Microsoft To Do task ${externalId} changed since last read`,
      );
    }

    const body = toGraphBody(patch);
    // Ensure the sync-id marker survives in the notes (back-filling tasks created
    // before this feature), preserving any existing user notes.
    if (patch.syncId !== undefined) {
      body.body = embedSyncIdInBody(patch.syncId, current.body?.content);
    }

    try {
      const task = await this.client().patchTask<GraphTodoTask>(
        listId,
        externalId,
        body,
        current["@odata.etag"],
      );
      return fromGraphTask(task, listId);
    } catch (err) {
      if (err instanceof GraphPreconditionFailedError) {
        throw new ExternalConflictError(
          `Microsoft To Do task ${externalId} changed during update`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  async deleteTask(
    listId: string,
    externalId: string,
    expectedVersion?: string,
  ): Promise<void> {
    let ifMatch: string | undefined;
    if (expectedVersion !== undefined) {
      // Read fresh for the ETag and to honor optimistic concurrency. A 404 here
      // means the task is already gone — the desired outcome for an idempotent
      // delete.
      let current: GraphTodoTask;
      try {
        current = await this.client().getTask<GraphTodoTask>(listId, externalId);
      } catch (err) {
        if (isGraphNotFound(err)) return;
        throw err;
      }
      if (
        current.lastModifiedDateTime !== undefined &&
        current.lastModifiedDateTime !== expectedVersion
      ) {
        throw new ExternalConflictError(
          `Microsoft To Do task ${externalId} changed since last read`,
        );
      }
      ifMatch = current["@odata.etag"];
    }

    try {
      await this.client().deleteTask(listId, externalId, ifMatch);
    } catch (err) {
      // Delete is idempotent: a 404 means the task is already gone, which is the
      // outcome we want. Swallow it so the engine prunes the stale link instead
      // of retrying the same DELETE on every reconcile pass.
      if (isGraphNotFound(err)) return;
      if (err instanceof GraphPreconditionFailedError) {
        throw new ExternalConflictError(
          `Microsoft To Do task ${externalId} changed during delete`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Microsoft To Do has no native cross-list move, so emulate one: copy the task
   * (preserving fields + the sync-id marker in its notes) into `toListId`, then
   * delete the original from `fromListId`. The returned task carries a NEW id;
   * the engine re-keys its link. The sync-id marker lets a subsequent inbound
   * pull recognise the new task as already-synced.
   */
  async moveTask(
    externalId: string,
    fromListId: string,
    toListId: string,
    expectedVersion?: string,
  ): Promise<ExternalTask> {
    let old: GraphTodoTask;
    try {
      old = await this.client().getTask<GraphTodoTask>(fromListId, externalId);
    } catch (err) {
      if (isGraphNotFound(err)) {
        throw new ExternalConflictError(
          `Microsoft To Do task ${externalId} vanished before move`,
          { cause: err as Error },
        );
      }
      throw err;
    }

    // Conflict check up-front so a both-sides change leaves no partial state.
    if (
      expectedVersion !== undefined &&
      old.lastModifiedDateTime !== undefined &&
      old.lastModifiedDateTime !== expectedVersion
    ) {
      throw new ExternalConflictError(
        `Microsoft To Do task ${externalId} changed since last read`,
      );
    }

    const ext = fromGraphTask(old, fromListId);
    const createBody: GraphTodoTaskBody = toGraphBody({
      title: ext.title,
      status: ext.status,
      ...(ext.due !== undefined ? { due: ext.due } : {}),
      ...(ext.start !== undefined ? { start: ext.start } : {}),
      ...(ext.done !== undefined ? { done: ext.done } : {}),
      ...(ext.priority !== undefined ? { priority: ext.priority } : {}),
    });
    // Preserve the original notes verbatim (carries the sync-id marker + any user
    // text) so the moved copy stays correlatable.
    if (old.body?.content !== undefined && old.body.content !== "") {
      createBody.body = { contentType: "text", content: old.body.content };
    }

    const created = await this.client().createTask<GraphTodoTask>(toListId, createBody);

    // Delete the original last so a failure never loses the task (a leftover
    // duplicate is recoverable; a lost task is not). Best-effort If-Match.
    try {
      await this.client().deleteTask(fromListId, externalId, old["@odata.etag"]);
    } catch (err) {
      if (err instanceof GraphPreconditionFailedError) {
        // The source changed between our read and delete; retry once without the
        // stale ETag to avoid orphaning the original copy.
        try {
          await this.client().deleteTask(fromListId, externalId);
        } catch (retryErr) {
          if (!isGraphNotFound(retryErr)) {
            this.log.warn("Move left original MS task; will reconcile next pass", {
              backend: this.backend,
              externalId,
              fromListId,
            });
          }
        }
      } else if (!isGraphNotFound(err)) {
        throw err;
      }
    }

    return fromGraphTask(created, toListId);
  }

  async delta(listId: string, token?: string): Promise<DeltaResult> {
    try {
      const response = await this.client().deltaTasks<RemovedGraphTask>(listId, token);
      const changed: ExternalTask[] = [];
      const removedIds: string[] = [];

      for (const item of response.value) {
        if (item["@removed"] !== undefined) {
          removedIds.push(item.id);
        } else {
          changed.push(fromGraphTask(item, listId));
        }
      }

      const deltaToken = response["@odata.deltaLink"];
      if (!deltaToken) throw new Error("Microsoft Graph delta response omitted deltaLink");
      return { changed, removedIds, token: deltaToken };
    } catch (err) {
      if (err instanceof GraphDeltaGoneError) throw new DeltaTokenExpiredError();
      throw err;
    }
  }

  private client(): GraphClient {
    if (!this.graph) {
      this.auth = new MsAuth(this.config, this.tokenKey, this.log);
      this.graph = new GraphClient(
        () => this.auth?.getAccessToken() ?? Promise.reject(new Error("Microsoft auth unavailable")),
        this.log,
        this.signal ? { signal: this.signal } : {},
      );
    }
    return this.graph;
  }
}

export function createMsTodoAdapter(
  cfg: MsTodoBackendConfig,
  tokenKey: Buffer,
  log: Logger = defaultLogger,
  signal?: AbortSignal,
): MsTodoAdapter {
  return new MsTodoAdapter(cfg, tokenKey, log, signal);
}

function isGraphNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
}
