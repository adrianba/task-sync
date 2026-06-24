import { randomUUID } from "node:crypto";
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import type { SupernoteDbConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { ExternalTaskInput } from "../types.js";
import { inputToColumns, type SupernoteTaskRow } from "./mapping.js";

export interface SupernoteGroupRow {
  task_list_id: string;
  title: string;
  last_modified: number | string | bigint | null;
}

type DbTaskRow = SupernoteTaskRow & RowDataPacket;
type DbGroupRow = SupernoteGroupRow & RowDataPacket;
type LinkRow = Pick<SupernoteTaskRow, "links"> & RowDataPacket;

function newSupernoteId(): string {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

function numberOrZero(value: number | string | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export class SupernoteDb {
  private pool: Pool | undefined;

  public constructor(
    private readonly config: SupernoteDbConfig,
    private readonly log: Logger,
  ) {}

  public async init(): Promise<void> {
    if (this.pool !== undefined) return;
    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: this.config.connectTimeoutMs,
      charset: "utf8mb4",
    });
    const connection = await this.pool.getConnection();
    connection.release();
    this.log.debug("connected to Supernote MariaDB", {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
    });
  }

  public async end(): Promise<void> {
    if (this.pool === undefined) return;
    await this.pool.end();
    this.pool = undefined;
  }

  public async listGroups(userId: number): Promise<SupernoteGroupRow[]> {
    const [rows] = await this.requiredPool().query<DbGroupRow[]>(
      "SELECT task_list_id, title, last_modified FROM t_schedule_task_group WHERE user_id = ? AND is_deleted = 'N' ORDER BY title",
      [userId],
    );
    return rows;
  }

  public async createGroup(userId: number, title: string): Promise<string> {
    const id = newSupernoteId();
    await this.requiredPool().execute<ResultSetHeader>(
      "INSERT INTO t_schedule_task_group (task_list_id, user_id, title, is_deleted, last_modified) VALUES (?, ?, ?, 'N', ?)",
      [id, userId, title, Date.now()],
    );
    return id;
  }

  public async listTasks(userId: number, listId: string | null): Promise<SupernoteTaskRow[]> {
    const [rows] = listId === null
      ? await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'N' AND task_list_id IS NULL ORDER BY last_modified DESC",
          [userId],
        )
      : await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'N' AND task_list_id = ? ORDER BY last_modified DESC",
          [userId, listId],
        );
    return rows;
  }

  public async getTask(userId: number, taskId: string): Promise<SupernoteTaskRow | null> {
    const [rows] = await this.requiredPool().query<DbTaskRow[]>(
      "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND task_id = ? AND is_deleted = 'N' LIMIT 1",
      [userId, taskId],
    );
    return rows[0] ?? null;
  }

  public async insertTask(
    userId: number,
    listId: string | null,
    input: ExternalTaskInput,
  ): Promise<SupernoteTaskRow> {
    const id = newSupernoteId();
    const columns = inputToColumns(input);
    const now = Date.now();
    const status = columns.status ?? "needsAction";
    const completedTime = status === "completed" ? (columns.completed_time ?? now) : 0;
    await this.requiredPool().execute<ResultSetHeader>(
      "INSERT INTO t_schedule_task (task_id, user_id, task_list_id, title, status, due_time, completed_time, importance, is_deleted, last_modified, links) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'N', ?, ?)",
      [
        id,
        userId,
        listId,
        columns.title ?? "",
        status,
        columns.due_time ?? 0,
        completedTime,
        columns.importance ?? null,
        now,
        null,
      ],
    );
    const inserted = await this.getTask(userId, id);
    if (inserted === null) throw new Error("Inserted Supernote task could not be read back");
    return inserted;
  }

  public async updateTask(
    userId: number,
    taskId: string,
    patch: Partial<ExternalTaskInput>,
  ): Promise<SupernoteTaskRow> {
    const existing = await this.getTask(userId, taskId);
    if (existing === null) throw new Error(`Supernote task not found: ${taskId}`);
    const [linkRows] = await this.requiredPool().query<LinkRow[]>(
      "SELECT links FROM t_schedule_task WHERE user_id = ? AND task_id = ? AND is_deleted = 'N' LIMIT 1",
      [userId, taskId],
    );
    const columns = inputToColumns(patch, { partial: true });
    const status = columns.status ?? (existing.status === "completed" ? "completed" : "needsAction");
    const now = Date.now();
    let completedTime = columns.completed_time ?? numberOrZero(existing.completed_time);
    if (columns.status === "completed" && existing.status !== "completed" && columns.completed_time === undefined) {
      completedTime = now;
    } else if (status !== "completed") {
      completedTime = 0;
    }

    await this.requiredPool().execute<ResultSetHeader>(
      "UPDATE t_schedule_task SET title = ?, status = ?, due_time = ?, completed_time = ?, importance = ?, links = ?, last_modified = ? WHERE user_id = ? AND task_id = ? AND is_deleted = 'N'",
      [
        columns.title ?? existing.title,
        status,
        columns.due_time ?? numberOrZero(existing.due_time),
        completedTime,
        columns.importance ?? existing.importance ?? null,
        linkRows[0]?.links ?? null,
        now,
        userId,
        taskId,
      ],
    );
    const updated = await this.getTask(userId, taskId);
    if (updated === null) throw new Error(`Updated Supernote task could not be read back: ${taskId}`);
    return updated;
  }

  public async softDeleteTask(userId: number, taskId: string): Promise<void> {
    await this.requiredPool().execute<ResultSetHeader>(
      "UPDATE t_schedule_task SET is_deleted = 'Y', last_modified = ? WHERE user_id = ? AND task_id = ?",
      [Date.now(), userId, taskId],
    );
  }

  public async tasksModifiedSince(
    userId: number,
    listId: string | null,
    sinceMs: number,
  ): Promise<SupernoteTaskRow[]> {
    const [rows] = listId === null
      ? await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'N' AND task_list_id IS NULL AND last_modified > ? ORDER BY last_modified ASC",
          [userId, sinceMs],
        )
      : await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'N' AND task_list_id = ? AND last_modified > ? ORDER BY last_modified ASC",
          [userId, listId, sinceMs],
        );
    return rows;
  }

  public async deletedTasksModifiedSince(
    userId: number,
    listId: string | null,
    sinceMs: number,
  ): Promise<SupernoteTaskRow[]> {
    const [rows] = listId === null
      ? await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'Y' AND task_list_id IS NULL AND last_modified > ? ORDER BY last_modified ASC",
          [userId, sinceMs],
        )
      : await this.requiredPool().query<DbTaskRow[]>(
          "SELECT task_id, task_list_id, title, status, due_time, completed_time, importance, last_modified, is_deleted, links FROM t_schedule_task WHERE user_id = ? AND is_deleted = 'Y' AND task_list_id = ? AND last_modified > ? ORDER BY last_modified ASC",
          [userId, listId, sinceMs],
        );
    return rows;
  }

  private requiredPool(): Pool {
    if (this.pool === undefined) {
      throw new Error(
        "SupernoteDb is not initialized; call init() first. Docker-network container hostnames and TCP host:port use the same connection path.",
      );
    }
    return this.pool;
  }
}
