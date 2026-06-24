/**
 * Generic external sync-adapter interface.
 *
 * The sync engine depends only on this abstraction, so additional backends can
 * be added without touching the engine. With multi-target fan-out the engine
 * iterates over a set of adapters and keeps one ExternalLink per backend.
 *
 * All fields use the normalized domain types from `model/task`.
 */
import type { IsoDate, TaskPriority, TaskStatus } from "../model/task.js";

/** A list in the external system. */
export interface ExternalList {
  id: string;
  name: string;
}

/** A normalized task as represented in the external system. */
export interface ExternalTask {
  externalId: string;
  listId: string;
  title: string;
  status: TaskStatus;
  due?: IsoDate;
  start?: IsoDate;
  done?: IsoDate;
  priority?: TaskPriority;
  /** ISO-8601 timestamp of last modification, used for change detection. */
  lastModified?: string;
}

/** Fields that can be written when creating/updating an external task. */
export interface ExternalTaskInput {
  title: string;
  status: TaskStatus;
  due?: IsoDate;
  start?: IsoDate;
  done?: IsoDate;
  priority?: TaskPriority;
}

/** Result of an incremental change pull. */
export interface DeltaResult {
  changed: ExternalTask[];
  removedIds: string[];
  /** Opaque token to persist for the next incremental pull. */
  token: string;
}

/**
 * A backend integration. Implementations must:
 *  - be safe to call concurrently per-list,
 *  - never throw on transient errors without retry/backoff internally,
 *  - keep field mapping pure and unit-tested in a sibling `mapping.ts`.
 */
export interface SyncAdapter {
  /** Stable backend identity, e.g. "ms-todo" or "supernote". */
  readonly backend: string;

  /** Optional one-time setup (auth, DB connect). Safe to call repeatedly. */
  init?(): Promise<void>;
  /** Optional graceful teardown (close DB pool, flush). */
  close?(): Promise<void>;

  listLists(): Promise<ExternalList[]>;
  /** Find or create a list by display name; returns its id. */
  ensureList(name: string): Promise<string>;

  listTasks(listId: string): Promise<ExternalTask[]>;
  getTask(listId: string, externalId: string): Promise<ExternalTask | null>;
  createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask>;
  updateTask(
    listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
  ): Promise<ExternalTask>;
  deleteTask(listId: string, externalId: string): Promise<void>;

  /** Incremental change pull for a list, given a previous token (if any). */
  delta?(listId: string, token?: string): Promise<DeltaResult>;
}
