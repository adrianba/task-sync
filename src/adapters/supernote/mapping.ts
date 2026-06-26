/**
 * Pure field mapping between the supernote-task-service JSON shapes and the
 * normalized domain types. Kept free of I/O so it is directly unit-testable.
 *
 * Notes:
 *  - The service stores/returns full ISO-8601 datetimes for `due`/`completed`,
 *    while the vault uses date-only (`YYYY-MM-DD`); we send date-only (the
 *    service interprets it as midnight UTC) and read back the date portion.
 *  - Priority round-trips losslessly via the service `importance` field
 *    (1..5 / null), which the service persists to the Supernote column.
 *  - Status is intentionally lossy: Supernote only has needsAction/completed.
 */
import type {
  ServiceTask,
  ServiceTaskCreate,
  ServiceTaskStatus,
  ServiceTaskUpdate,
} from "./client.js";
import type { ExternalTask, ExternalTaskInput } from "../types.js";
import type { IsoDate, TaskPriority, TaskStatus } from "../../model/task.js";

/** The implicit Inbox is represented as an empty list id within task-sync. */
export const INBOX_ID = "";

const PRIORITY_TO_IMPORTANCE: Record<TaskPriority, number | null> = {
  highest: 5,
  high: 4,
  medium: 3,
  none: null,
  low: 2,
  lowest: 1,
};

export function statusToService(status: TaskStatus): ServiceTaskStatus {
  return status === "done" ? "completed" : "needsAction";
}

export function statusFromService(status: ServiceTaskStatus): TaskStatus {
  // Supernote has no in-progress/cancelled states, so reads are intentionally lossy.
  return status === "completed" ? "done" : "todo";
}

export function priorityToImportance(priority: TaskPriority | undefined): number | null {
  return priority === undefined ? null : PRIORITY_TO_IMPORTANCE[priority];
}

export function priorityFromImportance(
  importance: number | string | null | undefined,
): TaskPriority | undefined {
  if (importance === null || importance === undefined || importance === "") return undefined;
  const value = Number(importance);
  if (!Number.isFinite(value)) return undefined;
  if (value >= 5) return "highest";
  if (value >= 4) return "high";
  if (value >= 3) return "medium";
  if (value >= 2) return "low";
  if (value >= 1) return "lowest";
  return undefined;
}

/** Convert a service ISO datetime (or null) to a date-only `YYYY-MM-DD`. */
export function isoDateOnly(value: string | null | undefined): IsoDate | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The list id within task-sync (`""` for the Inbox). */
export function listIdFromService(listId: string | null): string {
  return listId ?? INBOX_ID;
}

/** The service `list_id` (`null` for the Inbox). */
export function listIdToService(listId: string): string | null {
  return listId === INBOX_ID ? null : listId;
}

export function taskFromService(task: ServiceTask): ExternalTask {
  const result: ExternalTask = {
    externalId: task.id,
    listId: listIdFromService(task.list_id),
    title: task.title,
    status: statusFromService(task.status),
  };

  const due = isoDateOnly(task.due);
  if (due !== undefined) result.due = due;
  const done = isoDateOnly(task.completed);
  if (done !== undefined) result.done = done;
  const priority = priorityFromImportance(task.importance);
  if (priority !== undefined) result.priority = priority;
  if (Number.isFinite(task.last_modified) && task.last_modified > 0) {
    result.lastModified = new Date(task.last_modified).toISOString();
  }

  return result;
}

/** Build a create body from a full input. */
export function inputToCreate(listId: string, input: ExternalTaskInput): ServiceTaskCreate {
  return {
    title: input.title,
    list_id: listIdToService(listId),
    status: statusToService(input.status),
    due: input.due ?? null,
    importance: priorityToImportance(input.priority),
  };
}

/** Build a PATCH body from a partial input (omitted fields are left unchanged). */
export function patchToUpdate(patch: Partial<ExternalTaskInput>): ServiceTaskUpdate {
  const body: ServiceTaskUpdate = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.status !== undefined) body.status = statusToService(patch.status);
  if ("due" in patch) body.due = patch.due ?? null;
  if ("priority" in patch) body.importance = priorityToImportance(patch.priority);
  return body;
}
