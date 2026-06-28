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
  SupernoteNotFoundError,
  type ListTasksOptions,
  type ServiceTask,
  type SupernoteServiceClient,
} from "./client.js";
import {
  INBOX_ID,
  inputToCreate,
  listIdFromService,
  moveToUpdate,
  patchToUpdate,
  taskFromService,
} from "./mapping.js";

const INBOX_NAME = "Inbox";

/** Hard cap on pages followed in one task-pagination loop (cursor-cycle guard). */
const MAX_TASK_PAGES = 10_000;

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
  /** Supernote exposes a writable per-list `sort` position. */
  public readonly ordered = true;
  private readonly client: SupernoteServiceClient;
  private readonly baseUrl: string;

  public constructor(
    cfg: SupernoteBackendConfig,
    private readonly log: Logger,
    client?: SupernoteServiceClient,
    signal?: AbortSignal,
  ) {
    this.baseUrl = cfg.service.baseUrl;
    this.client =
      client ??
      new SupernoteHttpClient(
        cfg.service.baseUrl,
        cfg.service.apiKey,
        log.child({ backend: "supernote" }),
        {
          requestTimeoutMs: cfg.service.requestTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
  }

  public async init(): Promise<void> {
    // The version probe hits the unauthenticated GET /v1/version and swallows
    // transport errors. A missing version means the configured base URL is not
    // reachable as a supernote-task-service (wrong host, scheme, or proxy path),
    // which would make every sync call fail — surface it loudly with the URL.
    const version = await this.client.version();
    if (version === undefined) {
      this.log.warn(
        "could not reach supernote-task-service; check SUPERNOTE_SERVICE_URL " +
          "points at the service root (it should answer GET /v1/version)",
        { baseUrl: this.baseUrl },
      );
      return;
    }
    this.log.debug("connected to supernote-task-service", { version });
  }

  public async listLists(): Promise<ExternalList[]> {
    const lists = await this.client.listLists();
    const mapped = lists.map((list) => ({ id: listIdFromService(list.id), name: list.title }));
    // The implicit Inbox (`list_id: null`) is not returned by `/v1/lists` (the
    // client filters null ids), yet inbound enumeration drives off this list —
    // without it, tasks created in the Supernote Inbox would never be imported.
    // Always surface a synthetic Inbox entry so `pullInbound` polls it; de-dupe
    // in case the service ever does return a null-id inbox row.
    if (!mapped.some((list) => list.id === INBOX_ID)) {
      mapped.unshift({ id: INBOX_ID, name: INBOX_NAME });
    }
    return mapped;
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
    // `listId` is only a hint: a cross-list move on the device preserves the
    // task id but changes its `list_id`. Return the live row regardless of which
    // list it currently belongs to (the caller reads `ExternalTask.listId`); a
    // null means the task is genuinely gone, not merely moved. This is what
    // keeps a moved task from being mistaken for a deletion and recreated.
    void listId;
    const task = await this.client.getTask(externalId);
    if (task === null) return null;
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

  public async moveTask(
    externalId: string,
    _fromListId: string,
    toListId: string,
    expectedVersion?: string,
  ): Promise<ExternalTask> {
    // A move is a plain `list_id` re-point on the service: the task id is
    // preserved and only `last_modified` bumps. `fromListId` is unused (the
    // service locates the task by id). Conditional on the last-seen version so a
    // concurrent device edit surfaces as a deferrable conflict.
    try {
      const task = await this.client.updateTask(
        externalId,
        moveToUpdate(toListId),
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
    try {
      await this.client.deleteTask(externalId, expectedVersionMs(expectedVersion));
    } catch (err) {
      // Delete is idempotent: a 404 means the task is already gone on the
      // service (e.g. deleted on the device), which is the outcome we want.
      // Swallow it so the engine can prune the stale link instead of retrying
      // the same DELETE on every reconcile pass.
      if (err instanceof SupernoteNotFoundError) return;
      throw err;
    }
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
    for (let page = 0; ; page++) {
      if (page >= MAX_TASK_PAGES) {
        throw new Error(`Supernote task pagination exceeded ${MAX_TASK_PAGES} pages (cursor not advancing)`);
      }
      const pageResult = await this.client.listTasks({
        ...listFilter(listId),
        ...(since !== undefined ? { since } : {}),
        includeCompleted: true,
      });
      for (const task of pageResult.tasks) byId.set(task.id, task);
      cursor = pageResult.cursor;
      if (!pageResult.has_more) break;
      // The cursor must strictly advance past the current lower bound, else the
      // loop would spin forever on a buggy/looping service response.
      if (since !== undefined && pageResult.cursor <= since) {
        throw new Error("Supernote task pagination cursor did not advance");
      }
      since = pageResult.cursor;
    }
    return { byId, cursor };
  }
}

export function createSupernoteAdapter(
  cfg: SupernoteBackendConfig,
  log: Logger,
  signal?: AbortSignal,
): SupernoteAdapter {
  return new SupernoteAdapter(cfg, log, undefined, signal);
}
