import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExternalLink, Task } from "../model/task.js";
import { atomicWriteFile } from "../util/atomicFile.js";

export interface StateStoreData {
  version: number;
  links: ExternalLink[];
  deltaTokens: Record<string, string>;
  fileHashes: Record<string, string>;
}

const CURRENT_VERSION = 1;

export class StateStore {
  private data: StateStoreData = emptyState();
  private readonly linkIndex = new Map<string, ExternalLink>();

  constructor(private readonly path: string) {}

  /** Load from disk; tolerate a missing file (start empty). Throw on corrupt JSON. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (isNodeError(err) && err.code === "ENOENT") {
        this.data = emptyState();
        this.rebuildIndex();
        return;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`State store at ${this.path} contains corrupt JSON`, { cause: err });
    }

    this.data = parseStateStoreData(parsed, this.path);
    this.rebuildIndex();
  }

  getLink(syncId: string, backend: string): ExternalLink | undefined {
    return this.linkIndex.get(linkKey(syncId, backend));
  }

  getLinksForSyncId(syncId: string): ExternalLink[] {
    return this.data.links.filter((link) => link.syncId === syncId);
  }

  setLink(link: ExternalLink): void {
    const key = linkKey(link.syncId, link.backend);
    const existingIndex = this.data.links.findIndex(
      (candidate) => linkKey(candidate.syncId, candidate.backend) === key,
    );
    if (existingIndex === -1) {
      this.data.links.push(link);
    } else {
      this.data.links[existingIndex] = link;
    }
    this.linkIndex.set(key, link);
  }

  deleteLink(syncId: string, backend: string): void {
    const key = linkKey(syncId, backend);
    this.data.links = this.data.links.filter((link) => linkKey(link.syncId, link.backend) !== key);
    this.linkIndex.delete(key);
  }

  allLinks(): readonly ExternalLink[] {
    return this.data.links;
  }

  getDeltaToken(backend: string, listId: string): string | undefined {
    return this.data.deltaTokens[deltaKey(backend, listId)];
  }

  setDeltaToken(backend: string, listId: string, token: string): void {
    this.data.deltaTokens[deltaKey(backend, listId)] = token;
  }

  getFileHash(filePath: string): string | undefined {
    return this.data.fileHashes[filePath];
  }

  setFileHash(filePath: string, hash: string): void {
    this.data.fileHashes[filePath] = hash;
  }

  /** Atomically persist to disk via atomicWriteFile (mode 0o600). */
  async flush(): Promise<void> {
    await atomicWriteFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
  }

  private rebuildIndex(): void {
    this.linkIndex.clear();
    for (const link of this.data.links) {
      this.linkIndex.set(linkKey(link.syncId, link.backend), link);
    }
  }
}

/** Stable hash of the sync-relevant fields of a task (NOT formatting). */
export function hashTask(task: Task): string {
  const relevant = {
    description: task.description,
    fields: pickSyncFields(task),
    status: task.status,
  };
  return createHash("sha256").update(canonicalJson(relevant)).digest("hex");
}

function pickSyncFields(task: Task): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of ["due", "start", "done", "scheduled", "priority", "recurrence"] as const) {
    const value = task.fields[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

function emptyState(): StateStoreData {
  return {
    version: CURRENT_VERSION,
    links: [],
    deltaTokens: {},
    fileHashes: {},
  };
}

function linkKey(syncId: string, backend: string): string {
  return `${syncId}\u0000${backend}`;
}

function deltaKey(backend: string, listId: string): string {
  return `${backend}::${listId}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortValue(child);
  }
  return out;
}

function parseStateStoreData(value: unknown, statePath: string): StateStoreData {
  if (!isRecord(value)) throw invalidState(statePath);
  if (typeof value.version !== "number") throw invalidState(statePath);
  if (!Array.isArray(value.links)) throw invalidState(statePath);
  if (!isStringRecord(value.deltaTokens)) throw invalidState(statePath);
  if (!isStringRecord(value.fileHashes)) throw invalidState(statePath);

  return {
    version: value.version,
    links: value.links.map((link) => parseExternalLink(link, statePath)),
    deltaTokens: { ...value.deltaTokens },
    fileHashes: { ...value.fileHashes },
  };
}

function parseExternalLink(value: unknown, statePath: string): ExternalLink {
  if (!isRecord(value)) throw invalidState(statePath);
  if (typeof value.syncId !== "string") throw invalidState(statePath);
  if (typeof value.backend !== "string") throw invalidState(statePath);
  if (typeof value.externalId !== "string") throw invalidState(statePath);

  const link: ExternalLink = {
    syncId: value.syncId,
    backend: value.backend,
    externalId: value.externalId,
  };
  addOptionalString(link, "externalListId", value.externalListId, statePath);
  addOptionalString(link, "lastKnownHash", value.lastKnownHash, statePath);
  addOptionalString(link, "lastExternalModified", value.lastExternalModified, statePath);
  addOptionalString(link, "lastSyncedAt", value.lastSyncedAt, statePath);
  return link;
}

function addOptionalString<K extends keyof ExternalLink>(
  link: ExternalLink,
  key: K,
  value: unknown,
  statePath: string,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw invalidState(statePath);
  Object.assign(link, { [key]: value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function invalidState(statePath: string): Error {
  return new Error(`State store at ${statePath} has an invalid shape`);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
