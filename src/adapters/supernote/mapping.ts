import type { ExternalTask, ExternalTaskInput } from "../types.js";
import type { IsoDate, TaskPriority, TaskStatus } from "../../model/task.js";
import { decodeEmoji, truncateEncoded } from "./emoji.js";

export const SUPERNOTE_TITLE_MAX = 600;

export interface SupernoteTaskRow {
  task_id: string;
  task_list_id: string | null;
  title: string;
  status: string | null;
  due_time: number | string | bigint | null;
  completed_time: number | string | bigint | null;
  importance: string | number | null;
  last_modified: number | string | bigint | null;
  is_deleted?: string | null;
  links?: string | null;
}

export interface SupernoteTaskColumns {
  title?: string;
  status?: "needsAction" | "completed";
  due_time?: number;
  completed_time?: number;
  importance?: string | null;
}

const PRIORITY_TO_IMPORTANCE: Record<TaskPriority, string | null> = {
  highest: "5",
  high: "4",
  medium: "3",
  none: null,
  low: "2",
  lowest: "1",
};

export function statusToDb(status: TaskStatus): "needsAction" | "completed" {
  return status === "done" ? "completed" : "needsAction";
}

export function statusFromDb(row: Pick<SupernoteTaskRow, "status">): TaskStatus {
  // Supernote has no in-progress/cancelled states, so reads are intentionally lossy.
  return row.status === "completed" ? "done" : "todo";
}

export function priorityToImportance(priority: TaskPriority | undefined): string | null {
  return priority === undefined ? null : PRIORITY_TO_IMPORTANCE[priority];
}

export function priorityFromImportance(importance: string | number | null): TaskPriority | undefined {
  if (importance === null || importance === "") return undefined;
  const value = Number(importance);
  if (!Number.isFinite(value)) return undefined;
  if (value >= 5) return "highest";
  if (value >= 4) return "high";
  if (value >= 3) return "medium";
  if (value >= 2) return "low";
  if (value >= 1) return "lowest";
  return undefined;
}

function msValue(ms: number | string | bigint | null | undefined): number | undefined {
  if (ms === null || ms === undefined) return undefined;
  const value = typeof ms === "bigint" ? Number(ms) : Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export function msToIsoDate(ms: number | string | bigint | null | undefined): IsoDate | undefined {
  const value = msValue(ms);
  if (value === undefined) return undefined;
  return new Date(value).toISOString().slice(0, 10);
}

export function isoDateToMs(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function rowToExternalTask(row: SupernoteTaskRow): ExternalTask {
  const task: ExternalTask = {
    externalId: row.task_id,
    listId: row.task_list_id ?? "",
    title: decodeEmoji(row.title),
    status: statusFromDb(row),
  };

  const due = msToIsoDate(row.due_time);
  if (due !== undefined) task.due = due;
  const done = msToIsoDate(row.completed_time);
  if (done !== undefined) task.done = done;
  const priority = priorityFromImportance(row.importance);
  if (priority !== undefined) task.priority = priority;
  const lastModified = msValue(row.last_modified);
  if (lastModified !== undefined) task.lastModified = new Date(lastModified).toISOString();

  return task;
}

export function inputToColumns(
  input: Partial<ExternalTaskInput>,
  options: { partial?: boolean } = {},
): SupernoteTaskColumns {
  const partial = options.partial ?? false;
  const columns: SupernoteTaskColumns = {};
  if (input.title !== undefined) columns.title = truncateEncoded(input.title, SUPERNOTE_TITLE_MAX);
  if (input.status !== undefined) {
    columns.status = statusToDb(input.status);
    if (input.status !== "done" && input.done === undefined) columns.completed_time = 0;
  }
  if (input.due !== undefined) {
    columns.due_time = isoDateToMs(input.due);
  } else if (!partial) {
    columns.due_time = 0;
  }
  if (input.done !== undefined) {
    columns.completed_time = isoDateToMs(input.done);
  } else if (!partial && columns.completed_time === undefined) {
    columns.completed_time = 0;
  }
  if (input.priority !== undefined) {
    columns.importance = priorityToImportance(input.priority);
  } else if (!partial) {
    columns.importance = null;
  }
  return columns;
}
