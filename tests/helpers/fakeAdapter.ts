/**
 * In-memory SyncAdapter used to drive the engine end-to-end without any
 * network or database. Simulates monotonic `lastModified` timestamps so change
 * detection behaves like a real backend.
 */
import { randomUUID } from "node:crypto";
import type {
  DeltaResult,
  ExternalList,
  ExternalTask,
  ExternalTaskInput,
  SyncAdapter,
} from "../../src/adapters/types.js";

export class FakeAdapter implements SyncAdapter {
  readonly backend: string;
  readonly ordered: boolean;
  /** When true, exposes `moveTask` (a native cross-list move). */
  readonly movable: boolean;
  private clock = 1;
  private readonly lists = new Map<string, ExternalList>();
  private readonly tasks = new Map<string, ExternalTask>();
  initCalls = 0;
  closeCalls = 0;
  /** Records every moveTask call, for assertions. */
  moveCalls: { externalId: string; toListId: string }[] = [];

  constructor(backend = "fake", ordered = false, movable = false) {
    this.backend = backend;
    this.ordered = ordered;
    this.movable = movable;
    if (movable) {
      // Only expose the optional capability when requested, so the engine's
      // `typeof adapter.moveTask === "function"` capability gate matches a real
      // backend that does (Supernote) or does not (Microsoft To Do) support it.
      this.moveTask = (
        externalId: string,
        toListId: string,
        _expectedVersion?: string,
      ): Promise<ExternalTask> => {
        const existing = this.tasks.get(externalId);
        if (!existing) throw new Error(`No such task ${externalId}`);
        this.moveCalls.push({ externalId, toListId });
        const updated: ExternalTask = { ...existing, listId: toListId, lastModified: this.now() };
        this.tasks.set(externalId, updated);
        return Promise.resolve(updated);
      };
    }
  }

  moveTask?: SyncAdapter["moveTask"];

  private now(): string {
    return new Date(this.clock++ * 1000).toISOString();
  }

  init(): Promise<void> {
    this.initCalls++;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }

  listLists(): Promise<ExternalList[]> {
    return Promise.resolve([...this.lists.values()]);
  }

  ensureList(name: string): Promise<string> {
    for (const l of this.lists.values()) if (l.name === name) return Promise.resolve(l.id);
    const id = randomUUID();
    this.lists.set(id, { id, name });
    return Promise.resolve(id);
  }

  listTasks(listId: string): Promise<ExternalTask[]> {
    return Promise.resolve(
      [...this.tasks.values()].filter((t) => t.listId === listId),
    );
  }

  getTask(_listId: string, externalId: string): Promise<ExternalTask | null> {
    return Promise.resolve(this.tasks.get(externalId) ?? null);
  }

  createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask> {
    const task: ExternalTask = {
      externalId: randomUUID(),
      listId,
      lastModified: this.now(),
      ...input,
    };
    if (this.ordered && task.order === undefined) {
      // Mimic Supernote: omitted order appends at the end of the list.
      task.order = [...this.tasks.values()].filter((t) => t.listId === listId).length;
    }
    this.tasks.set(task.externalId, task);
    return Promise.resolve(task);
  }

  updateTask(
    listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
  ): Promise<ExternalTask> {
    const existing = this.tasks.get(externalId);
    if (!existing) throw new Error(`No such task ${externalId}`);
    const updated: ExternalTask = {
      ...existing,
      ...patch,
      listId,
      lastModified: this.now(),
    };
    this.tasks.set(externalId, updated);
    return Promise.resolve(updated);
  }

  deleteTask(_listId: string, externalId: string): Promise<void> {
    this.tasks.delete(externalId);
    return Promise.resolve();
  }

  delta(listId: string, _token?: string): Promise<DeltaResult> {
    return Promise.resolve({
      changed: [...this.tasks.values()].filter((t) => t.listId === listId),
      removedIds: [],
      token: String(this.clock),
    });
  }

  // --- test helpers ---
  /** Simulate an external edit (e.g. the user changed status in the app). */
  mutateExternal(externalId: string, patch: Partial<ExternalTask>): void {
    const existing = this.tasks.get(externalId);
    if (!existing) throw new Error(`No such task ${externalId}`);
    this.tasks.set(externalId, { ...existing, ...patch, lastModified: this.now() });
  }

  /** Seed an external-only task (no local link yet). */
  seedTask(listName: string, input: ExternalTaskInput): ExternalTask {
    let listId: string | undefined;
    for (const l of this.lists.values()) if (l.name === listName) listId = l.id;
    if (!listId) {
      listId = randomUUID();
      this.lists.set(listId, { id: listId, name: listName });
    }
    const task: ExternalTask = {
      externalId: randomUUID(),
      listId,
      lastModified: this.now(),
      ...input,
    };
    this.tasks.set(task.externalId, task);
    return task;
  }

  /** The id of a list by display name, creating it if necessary. */
  listIdByName(name: string): string {
    for (const l of this.lists.values()) if (l.name === name) return l.id;
    const id = randomUUID();
    this.lists.set(id, { id, name });
    return id;
  }

  /**
   * Simulate a device-side cross-list move: preserve the task id, re-point its
   * list (creating the target list if needed) and bump `lastModified`.
   */
  simulateDeviceMove(externalId: string, toListName: string): void {
    const existing = this.tasks.get(externalId);
    if (!existing) throw new Error(`No such task ${externalId}`);
    const listId = this.listIdByName(toListName);
    this.tasks.set(externalId, { ...existing, listId, lastModified: this.now() });
  }

  allTasks(): ExternalTask[] {
    return [...this.tasks.values()];
  }
}
