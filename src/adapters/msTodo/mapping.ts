import type { ExternalTask, ExternalTaskInput } from "../types.js";
import type { IsoDate, TaskPriority, TaskStatus } from "../../model/task.js";
import { parseSyncIdComment } from "../../vault/syncId.js";

export type GraphStatus =
  | "notStarted"
  | "inProgress"
  | "completed"
  | "waitingOnOthers"
  | "deferred";
export type GraphImportance = "low" | "normal" | "high";

export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: "UTC";
}

/** Microsoft Graph `itemBody` (the task notes field). */
export interface GraphItemBody {
  content?: string;
  contentType?: "text" | "html";
}

export interface GraphTodoTask {
  id: string;
  title?: string;
  status?: string;
  importance?: string;
  dueDateTime?: GraphDateTimeTimeZone | null;
  startDateTime?: GraphDateTimeTimeZone | null;
  completedDateTime?: GraphDateTimeTimeZone | null;
  lastModifiedDateTime?: string;
  body?: GraphItemBody | null;
  "@odata.etag"?: string;
}

export interface GraphTodoTaskBody {
  title?: string;
  status?: GraphStatus;
  importance?: GraphImportance;
  dueDateTime?: GraphDateTimeTimeZone;
  startDateTime?: GraphDateTimeTimeZone;
  completedDateTime?: GraphDateTimeTimeZone;
  body?: GraphItemBody;
}

export function isoDateToGraphDate(date: IsoDate): GraphDateTimeTimeZone {
  return { dateTime: `${date}T00:00:00`, timeZone: "UTC" };
}

export function graphDateToIsoDate(
  value: GraphDateTimeTimeZone | null | undefined,
): IsoDate | undefined {
  const dateTime = value?.dateTime;
  return dateTime ? dateTime.slice(0, 10) : undefined;
}

export function statusToGraph(status: TaskStatus): GraphStatus {
  switch (status) {
    case "done":
      return "completed";
    case "in-progress":
      return "inProgress";
    case "todo":
    case "cancelled":
    case "other":
      return "notStarted";
  }
}

export function statusFromGraph(status: string | undefined): TaskStatus {
  switch (status) {
    case "completed":
      return "done";
    case "inProgress":
      return "in-progress";
    default:
      return "todo";
  }
}

export function priorityToImportance(
  priority: TaskPriority | undefined,
): GraphImportance {
  switch (priority) {
    case "highest":
    case "high":
      return "high";
    case "low":
    case "lowest":
      return "low";
    case "medium":
    case "none":
    case undefined:
      return "normal";
  }
}

export function importanceToPriority(importance: string | undefined): TaskPriority {
  switch (importance) {
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "none";
  }
}

export function toGraphBody(input: Partial<ExternalTaskInput>): GraphTodoTaskBody {
  const body: GraphTodoTaskBody = {};

  if (input.title !== undefined) body.title = input.title;
  if (input.status !== undefined) {
    body.status = statusToGraph(input.status);
    if (input.status === "done") {
      body.completedDateTime = isoDateToGraphDate(
        input.done ?? new Date().toISOString().slice(0, 10),
      );
    }
  }
  if (input.done !== undefined && input.status === undefined) {
    body.completedDateTime = isoDateToGraphDate(input.done);
  }
  if (input.priority !== undefined) body.importance = priorityToImportance(input.priority);
  if (input.due !== undefined) body.dueDateTime = isoDateToGraphDate(input.due);
  if (input.start !== undefined) body.startDateTime = isoDateToGraphDate(input.start);

  return body;
}

export function fromGraphTask(raw: GraphTodoTask, listId: string): ExternalTask {
  const task: ExternalTask = {
    externalId: raw.id,
    listId,
    title: raw.title ?? "",
    status: statusFromGraph(raw.status),
  };

  const due = graphDateToIsoDate(raw.dueDateTime);
  if (due !== undefined) task.due = due;
  const start = graphDateToIsoDate(raw.startDateTime);
  if (start !== undefined) task.start = start;
  const done = graphDateToIsoDate(raw.completedDateTime);
  if (done !== undefined) task.done = done;
  if (raw.importance !== undefined) task.priority = importanceToPriority(raw.importance);
  if (raw.lastModifiedDateTime !== undefined) {
    task.lastModified = raw.lastModifiedDateTime;
  }
  const externalSyncId = parseSyncIdComment(raw.body?.content);
  if (externalSyncId !== undefined) task.externalSyncId = externalSyncId;

  return task;
}

/**
 * Embed our `sync-id` marker into a Graph task body, preserving any existing
 * user notes. Microsoft To Do keeps the body across an app "Move to list", so
 * the marker rides along even though the move mints a new task id — letting the
 * engine recognise the moved task and re-key its link instead of duplicating.
 */
export function embedSyncIdInBody(syncId: string, existing?: string | null): GraphItemBody {
  const marker = `<!-- sync-id: ${syncId} -->`;
  const current = existing ?? "";
  if (current.trim() === "") {
    return { contentType: "text", content: marker };
  }
  if (/<!--\s*sync-id:\s*[A-Za-z0-9._~-]+\s*-->/u.test(current)) {
    return {
      contentType: "text",
      content: current.replace(/<!--\s*sync-id:\s*[A-Za-z0-9._~-]+\s*-->/u, marker),
    };
  }
  return { contentType: "text", content: `${current.replace(/\s+$/u, "")}\n${marker}` };
}
