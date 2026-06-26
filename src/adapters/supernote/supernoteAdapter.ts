import type { SupernoteBackendConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import type {
  DeltaResult,
  ExternalList,
  ExternalTask,
  ExternalTaskInput,
  SyncAdapter,
} from "../types.js";
import { ExternalConflictError } from "../types.js";
import {
  SupernoteConflictError,
  SupernoteCursorExpiredError,
  SupernoteHttpClient,
  type ListTasksOptions,
  type ServiceTask,
  type SupernoteServiceClient,
} from "./client.js";
import {
  INBOX_ID,
  inputToCreate,
  listIdFromService,
  patchToUpdate,
  taskFromService,
} from "./mapping.js";

const INBOX_NAME = "Inbox";

/** Parse an ISO `lastModified` string into a millisecond version, if valid. */
function expectedVersionMs(expectedVersion: string | undefined): number | undefined {
  if (expectedVersion === undefined) return undefined;
  const ms = Date.parse(expectedVersion);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Build the per-list filter for task reads. */
function listFilter(listId: string): Pick<ListTasksOptions, "listId" | "inbox"> {
  return listId === INBOX_ID ? { inbox: true } : { listId };
}

export class SupernoteAdapter implements SyncAdapter {
  public readonly backend = "supernote";
  private readonly client: SupernoteServiceClient;

  public constructor(
    cfg: SupernoteBackendConfig,
    private readonly log: Logger,
    client?: SupernoteServiceClient,
  ) {
    this.client =
      client ??
      new SupernoteHttpClient(
        cfg.service.baseUrl,
        cfg.service.apiKey,
        log.child({ backend: "supernote" }),
        { requestTimeoutMs: cfg.service.requestTimeoutMs },
      );
  }

  public async init(): Promise<void> {
    const version = await this.client.version();
    if (version !== undefined) {
      this.log.debug("connected to supernote-task-service", { version });
    }
  }

  public async listLists(): Promise<ExternalList[]> {
    const lists = await this.client.listLists();
    return lists.map((list) => ({ id: listIdFromService(list.id), name: list.title }));
  }

  public async ensureList(name: string): Promise<string> {
    if (name.trim().toLowerCase() === INBOX_NAME.toLowerCase()) return INBOX_ID;
    const list = await this.client.ensureList(name);
    return listIdFromService(list.id);
  }

  public async listTasks(listId: string): Promise<ExternalTask[]> {
    // Full active snapshot: start in active mode (no `since`, excludes deleted)
    // and page with the returned cursor. Filter any soft-deleted rows that a
    // continuation (delta-mode) page may include.
    const { byId } = await this.pageFrom(listId, undefined);
    return [...byId.values()].filter((task) => !task.is_deleted).map(taskFromService);
  }

  public async getTask(listId: string, externalId: string): Promise<ExternalTask | null> {
    const task = await this.client.getTask(externalId);
    if (task === null || listIdFromService(task.list_id) !== listId) return null;
    return taskFromService(task);
  }

  public async createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask> {
    const task = await this.client.createTask(inputToCreate(listId, input));
    return taskFromService(task);
  }

  public async updateTask(
    _listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
    expectedVersion?: string,
  ): Promise<ExternalTask> {
    try {
      const task = await this.client.updateTask(
        externalId,
        patchToUpdate(patch),
        expectedVersionMs(expectedVersion),
      );
      return taskFromService(task);
    } catch (err) {
      if (err instanceof SupernoteConflictError) {
        throw new ExternalConflictError(
          `Supernote task ${externalId} changed since last sync`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  public async deleteTask(
    _listId: string,
    externalId: string,
    expectedVersion?: string,
  ): Promise<void> {
    await this.client.deleteTask(externalId, expectedVersionMs(expectedVersion));
  }

  public async delta(listId: string, token?: string): Promise<DeltaResult> {
    const sinceMs = token === undefined ? undefined : Number(token);
    const safeSinceMs = sinceMs !== undefined && Number.isFinite(sinceMs) && sinceMs > 0
      ? sinceMs
      : undefined;

    try {
      return await this.collectDelta(listId, safeSinceMs);
    } catch (err) {
      if (err instanceof SupernoteCursorExpiredError && safeSinceMs !== undefined) {
        // The stored cursor aged out of the service's retention window; discard
        // it and perform a full resync (no `since`), mirroring the Microsoft
        // Graph `410 Gone` delta path.
        this.log.warn("Supernote delta cursor expired; performing full resync", {
          listId,
          cursor: token,
        });
        return await this.collectDelta(listId, undefined);
      }
      throw err;
    }
  }

  /**
   * Page the task list from `sinceMs` (undefined = active mode / full resync),
   * collapsing rows by id, and split changed vs. soft-deleted.
   */
  private async collectDelta(listId: string, sinceMs: number | undefined): Promise<DeltaResult> {
    const { byId, cursor } = await this.pageFrom(listId, sinceMs);

    const changed: ExternalTask[] = [];
    const removedIds: string[] = [];
    for (const task of byId.values()) {
      if (task.is_deleted) removedIds.push(task.id);
      else changed.push(taskFromService(task));
    }

    return { changed, removedIds, token: String(cursor) };
  }

  /**
   * Drive the service's `since`/`has_more` pagination. The first page uses
   * `sinceMs` as given — `undefined` keeps it in active mode (excludes deleted)
   * which is also the only valid "full resync" when the service enforces
   * `CURSOR_MAX_AGE_MS` (a numeric `since` of 0 would be rejected). Continuation
   * pages always pass the numeric cursor (delta mode). Rows are accumulated by
   * id so the inclusive-boundary re-delivery collapses to the latest row.
   */
  private async pageFrom(
    listId: string,
    sinceMs: number | undefined,
  ): Promise<{ byId: Map<string, ServiceTask>; cursor: number }> {
    const byId = new Map<string, ServiceTask>();
    let since = sinceMs;
    let cursor = sinceMs ?? 0;
    for (;;) {
      const page = await this.client.listTasks({
        ...listFilter(listId),
        ...(since !== undefined ? { since } : {}),
        includeCompleted: true,
      });
      for (const task of page.tasks) byId.set(task.id, task);
      cursor = page.cursor;
      if (!page.has_more) break;
      since = page.cursor;
    }
    return { byId, cursor };
  }
}

export function createSupernoteAdapter(
  cfg: SupernoteBackendConfig,
  log: Logger,
): SupernoteAdapter {
  return new SupernoteAdapter(cfg, log);
}
