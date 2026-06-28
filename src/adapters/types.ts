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
  /**
   * 0-based position within its list, for backends that expose an explicit
   * ordering (e.g. Supernote `sort`). Undefined for backends without ordering.
   */
  order?: number;
  /** ISO-8601 timestamp of last modification, used for change detection. */
  lastModified?: string;
  /**
   * The service's own correlation id (our `sync-id`) if the backend can carry
   * one out-of-band (e.g. Microsoft To Do stores it in the task notes/body so it
   * survives an app-initiated cross-list move, which mints a new `externalId`).
   * Lets the engine recognise a moved/recreated task as an already-synced one
   * and re-key its link instead of importing a duplicate. Undefined when the
   * backend cannot carry it (e.g. Supernote, which preserves `externalId`).
   */
  externalSyncId?: string;
}

/** Fields that can be written when creating/updating an external task. */
export interface ExternalTaskInput {
  title: string;
  status: TaskStatus;
  due?: IsoDate;
  start?: IsoDate;
  done?: IsoDate;
  priority?: TaskPriority;
  /**
   * Desired 0-based position within its list. Backends without an ordering
   * concept ignore it. On create, omit to append at the end.
   */
  order?: number;
  /**
   * Our `sync-id` correlation id for this task, when the backend can persist it
   * out-of-band (Microsoft To Do embeds it in the task notes/body). Backends
   * that cannot carry it ignore the field.
   */
  syncId?: string;
}

/** Result of an incremental change pull. */
export interface DeltaResult {
  changed: ExternalTask[];
  removedIds: string[];
  /** Opaque token to persist for the next incremental pull. */
  token: string;
}

/**
 * Thrown by an adapter when a conditional write is rejected because the stored
 * resource changed since the caller's observed `expectedVersion`. The sync
 * engine treats this as a conflict and defers to its conflict policy on the
 * next reconcile rather than clobbering the newer external state.
 */
export class ExternalConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalConflictError";
  }
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

  /**
   * True when the backend exposes an explicit, writable per-list ordering
   * (`ExternalTask.order` / `ExternalTaskInput.order`). The engine only runs its
   * ordering reconciliation for such backends; others ignore `order`.
   */
  readonly ordered?: boolean;

  /** Optional one-time setup (auth, DB connect). Safe to call repeatedly. */
  init?(): Promise<void>;
  /** Optional graceful teardown (close DB pool, flush). */
  close?(): Promise<void>;

  listLists(): Promise<ExternalList[]>;
  /** Find or create a list by display name; returns its id. */
  ensureList(name: string): Promise<string>;

  listTasks(listId: string): Promise<ExternalTask[]>;
  /**
   * Look up a task by id. `listId` is the caller's last-known list. Backends
   * that store a task independently of its list (e.g. Supernote) treat it as a
   * hint and return the live row regardless of which list it now belongs to;
   * the caller MUST inspect `ExternalTask.listId` for the current list. Backends
   * whose task ids are scoped to a list (e.g. Microsoft To Do, where a move
   * mints a new id) look up within `listId` only. Returns `null` when the task
   * is not found under `listId` (for list-scoped backends this includes "moved
   * away"; such backends instead carry `externalSyncId` so the engine can
   * recognise the moved/recreated task and re-key its link).
   */
  getTask(listId: string, externalId: string): Promise<ExternalTask | null>;
  createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask>;
  /**
   * Apply a partial update. `expectedVersion`, when provided, is the
   * `lastModified` the caller last observed; backends that support optimistic
   * concurrency should reject the write (surfacing a backend-specific conflict
   * error) if the stored resource changed since then. Backends without such
   * support may ignore it.
   */
  updateTask(
    listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
    expectedVersion?: string,
  ): Promise<ExternalTask>;
  /**
   * Delete a task; `expectedVersion` has the same semantics as `updateTask`.
   * Must be idempotent: if the target task is already gone (HTTP 404), treat it
   * as success and return normally rather than throwing.
   */
  deleteTask(listId: string, externalId: string, expectedVersion?: string): Promise<void>;

  /**
   * Move a task from `fromListId` to `toListId`. Optional: only backends that
   * support a cross-list move implement it; the engine capability-gates
   * list-membership reconciliation on its presence (backends without it leave a
   * vault tag change a no-op).
   *
   * Identity is NOT guaranteed to be preserved: backends with a native move
   * (Supernote re-points `list_id`) return the same `externalId`; backends
   * without one (Microsoft To Do) emulate the move as delete-in-`fromListId` +
   * create-in-`toListId` and return a task with a **new `externalId`**. Callers
   * MUST re-key any stored link to the returned task's `externalId`/`listId`.
   * `fromListId` is required by emulating backends to read+delete the source;
   * native-move backends may ignore it.
   *
   * `expectedVersion` has the same optimistic-concurrency semantics as
   * `updateTask`. Returns the moved task (with its new `listId`, possibly new id).
   */
  moveTask?(
    externalId: string,
    fromListId: string,
    toListId: string,
    expectedVersion?: string,
  ): Promise<ExternalTask>;

  /** Incremental change pull for a list, given a previous token (if any). */
  delta?(listId: string, token?: string): Promise<DeltaResult>;
}
