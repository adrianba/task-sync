/**
 * Core domain model shared across the vault layer, mapping, state store, sync
 * engine and external backend adapters. Kept free of I/O so it is trivially
 * unit-testable and stable across backends.
 */

/** Normalized task status, decoupled from Obsidian checkbox characters. */
export type TaskStatus =
  | "todo"
  | "in-progress"
  | "done"
  | "cancelled"
  | "other";

/** Priority normalized from Obsidian Tasks priority signifiers. */
export type TaskPriority =
  | "highest"
  | "high"
  | "medium"
  | "none"
  | "low"
  | "lowest";

/** A date stored as an ISO `YYYY-MM-DD` string (Obsidian Tasks convention). */
export type IsoDate = string;

/** Location of a parsed task within a vault file, for safe in-place edits. */
export interface TaskLocation {
  /** Vault-relative path of the markdown file (POSIX separators). */
  filePath: string;
  /** Zero-based line index of the task line. */
  line: number;
}

/** Obsidian Tasks metadata fields we understand and can round-trip. */
export interface TaskFields {
  due?: IsoDate;
  scheduled?: IsoDate;
  start?: IsoDate;
  created?: IsoDate;
  done?: IsoDate;
  cancelled?: IsoDate;
  priority?: TaskPriority;
  /** Recurrence rule text, e.g. "every week" (lossy across backends). */
  recurrence?: string;
  /** Obsidian Tasks native id (🆔) — never reused as our correlation id. */
  tasksId?: string;
  /** Obsidian Tasks dependsOn (⛔) ids. */
  dependsOn?: string[];
}

/** A task discovered in the vault, normalized for syncing. */
export interface Task {
  /**
   * Stable correlation ID owned by this service, persisted into the markdown
   * as an HTML comment. Undefined until first assigned.
   */
  syncId?: string;
  /** Raw checkbox character, e.g. " ", "x", "/", "-". */
  statusChar: string;
  /** Normalized status. */
  status: TaskStatus;
  /** Task text with metadata/tags stripped out. */
  description: string;
  /** Tags present on the task line, without the leading '#'. */
  tags: string[];
  /** Parsed metadata fields. */
  fields: TaskFields;
  /**
   * Logical list this task belongs to (resolved from {@link blockTag} by the
   * mapping layer, optionally renamed per backend via `tagListMap`).
   */
  listKey?: string;
  /**
   * The defined tag-path of the checklist block governing this task, e.g.
   * `todo` or `todo/groceries`. Set by the vault layer from the tag on the
   * non-task line above the block. Tasks not under a defined-tag block are out
   * of scope and are not surfaced for syncing.
   */
  blockTag?: string;
  /** Source location for editing. */
  location: TaskLocation;
  /** The exact original line text, for diffing and idempotent writes. */
  rawLine: string;
}

/**
 * External identity correlating a vault task to an item in one external
 * backend. With multi-target fan-out, a single `syncId` may have several
 * `ExternalLink`s — one per backend.
 */
export interface ExternalLink {
  syncId: string;
  /** Backend identity, e.g. "ms-todo" or "supernote". */
  backend: string;
  externalId: string;
  externalListId?: string;
  /** Last vault hash we reconciled, for 3-way reconciliation. */
  lastKnownHash?: string;
  /** Last external `lastModified` we observed, for change detection. */
  lastExternalModified?: string;
  /**
   * Last ordering index we synced for this task in its list (the backend's
   * `sort`/position). Used to detect vault-vs-device reordering. Only set for
   * backends that expose an explicit order.
   */
  lastKnownSort?: number;
  lastSyncedAt?: string;
}
