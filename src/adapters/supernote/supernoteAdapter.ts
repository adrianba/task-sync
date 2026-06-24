import type { SupernoteBackendConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import type {
  DeltaResult,
  ExternalList,
  ExternalTask,
  ExternalTaskInput,
  SyncAdapter,
} from "../types.js";
import { SupernoteDb, type SupernoteGroupRow } from "./db.js";
import { decodeEmoji, encodeEmoji } from "./emoji.js";
import { rowToExternalTask, type SupernoteTaskRow } from "./mapping.js";

const INBOX_ID = "";
const INBOX_NAME = "Inbox";

function dbListId(listId: string): string | null {
  return listId === INBOX_ID ? null : listId;
}

function lastModifiedMs(row: Pick<SupernoteTaskRow, "last_modified">): number {
  const value = Number(row.last_modified);
  return Number.isFinite(value) ? value : 0;
}

function groupToExternalList(group: SupernoteGroupRow): ExternalList {
  return { id: group.task_list_id, name: decodeEmoji(group.title) };
}

export class SupernoteAdapter implements SyncAdapter {
  public readonly backend = "supernote";
  private readonly userId: number;
  private readonly db: SupernoteDb;

  public constructor(
    private readonly cfg: SupernoteBackendConfig,
    log: Logger,
    db?: SupernoteDb,
  ) {
    this.userId = cfg.db.userId;
    this.db = db ?? new SupernoteDb(cfg.db, log.child({ backend: "supernote" }));
  }

  public async init(): Promise<void> {
    await this.db.init();
  }

  public async close(): Promise<void> {
    await this.db.end();
  }

  public async listLists(): Promise<ExternalList[]> {
    const groups = await this.db.listGroups(this.userId);
    return [{ id: INBOX_ID, name: INBOX_NAME }, ...groups.map(groupToExternalList)];
  }

  public async ensureList(name: string): Promise<string> {
    if (name.trim().toLowerCase() === INBOX_NAME.toLowerCase()) return INBOX_ID;
    const groups = await this.db.listGroups(this.userId);
    const existing = groups.find((group) => decodeEmoji(group.title) === name);
    if (existing !== undefined) return existing.task_list_id;
    return this.db.createGroup(this.userId, encodeEmoji(name));
  }

  public async listTasks(listId: string): Promise<ExternalTask[]> {
    const rows = await this.db.listTasks(this.userId, dbListId(listId));
    return rows.map(rowToExternalTask);
  }

  public async getTask(listId: string, externalId: string): Promise<ExternalTask | null> {
    const row = await this.db.getTask(this.userId, externalId);
    if (row === null || (row.task_list_id ?? INBOX_ID) !== listId) return null;
    return rowToExternalTask(row);
  }

  public async createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask> {
    const row = await this.db.insertTask(this.userId, dbListId(listId), input);
    return rowToExternalTask(row);
  }

  public async updateTask(
    _listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
  ): Promise<ExternalTask> {
    const row = await this.db.updateTask(this.userId, externalId, patch);
    return rowToExternalTask(row);
  }

  public async deleteTask(_listId: string, externalId: string): Promise<void> {
    await this.db.softDeleteTask(this.userId, externalId);
  }

  public async delta(listId: string, token?: string): Promise<DeltaResult> {
    const sinceMs = token === undefined ? 0 : Number(token);
    const safeSinceMs = Number.isFinite(sinceMs) && sinceMs > 0 ? sinceMs : 0;
    const queryStartMs = Date.now();
    const [changedRows, deletedRows] = await Promise.all([
      this.db.tasksModifiedSince(this.userId, dbListId(listId), safeSinceMs),
      this.db.deletedTasksModifiedSince(this.userId, dbListId(listId), safeSinceMs),
    ]);
    const maxSeenMs = [...changedRows, ...deletedRows].reduce(
      (max, row) => Math.max(max, lastModifiedMs(row)),
      queryStartMs,
    );
    return {
      changed: changedRows.map(rowToExternalTask),
      removedIds: deletedRows.map((row) => row.task_id),
      token: String(maxSeenMs),
    };
  }
}

export function createSupernoteAdapter(
  cfg: SupernoteBackendConfig,
  log: Logger,
): SupernoteAdapter {
  return new SupernoteAdapter(cfg, log);
}
