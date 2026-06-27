/**
 * HTTP client for the supernote-task-service REST API.
 *
 * The service owns all Supernote MariaDB concerns (emoji `[U+XXXX]` encoding,
 * `links` preservation, soft deletes, millisecond timestamps, `user_id`
 * scoping), so this client is a thin, well-typed transport: Bearer auth, a
 * per-request timeout, retry-with-backoff on 429/503 (honoring `Retry-After`),
 * and typed errors the adapter can branch on (404 not-found, 409 conflict).
 *
 * The `SupernoteServiceClient` interface is injected into the adapter so it can
 * be unit-tested with an in-memory fake — no network.
 */
import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";

/** Task status as represented by the service API. */
export type ServiceTaskStatus = "needsAction" | "completed";

/** A task list (category) as returned by the service. */
export interface ServiceTaskList {
  id: string | null;
  title: string;
  last_modified: number;
  is_deleted: boolean;
}

/** A task as returned by the service. */
export interface ServiceTask {
  id: string;
  list_id: string | null;
  category: string;
  title: string;
  detail: string;
  status: ServiceTaskStatus;
  due: string | null;
  completed: string | null;
  importance: number | string | null;
  /** 0-based position within the list (device order). */
  sort: number | null;
  last_modified: number;
  is_deleted: boolean;
}

/** Body accepted when creating a task. */
export interface ServiceTaskCreate {
  title: string;
  list_id: string | null;
  status: ServiceTaskStatus;
  due?: string | null;
  importance?: number | null;
  /** 0-based position; omit to append at the end of the list. */
  sort?: number;
}

/** Body accepted when patching a task (omitted fields are left unchanged). */
export interface ServiceTaskUpdate {
  title?: string;
  list_id?: string | null;
  status?: ServiceTaskStatus;
  due?: string | null;
  importance?: number | null;
  /** 0-based position to move the task to (null is ignored by the service). */
  sort?: number;
}

/** A page of delta results plus the next cursor. */
export interface ServiceTaskPage {
  tasks: ServiceTask[];
  cursor: number;
  has_more: boolean;
}

/** Options accepted by `listTasks`. */
export interface ListTasksOptions {
  listId?: string | null;
  inbox?: boolean;
  since?: number;
  includeCompleted?: boolean;
  limit?: number;
}

/** Context describing the request that produced a service error. */
export interface SupernoteErrorContext {
  method: string;
  url: string;
  code: string | undefined;
  body: string;
}

/** Generic, non-2xx error from the service. Carries the machine-readable code. */
export class SupernoteServiceError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: string;
  readonly method: string;
  readonly url: string;

  constructor(summary: string, status: number, ctx: SupernoteErrorContext) {
    const codePart = ctx.code ? ` code=${ctx.code}` : "";
    const bodyPart = ctx.body ? ` body=${ctx.body}` : "";
    super(`${summary} (${ctx.method} ${ctx.url} → HTTP ${status}${codePart})${bodyPart}`);
    this.name = "SupernoteServiceError";
    this.status = status;
    this.code = ctx.code;
    this.body = ctx.body;
    this.method = ctx.method;
    this.url = ctx.url;
  }
}

/**
 * Thrown on HTTP 404. The adapter treats this as "resource missing" only for a
 * point lookup (`getTask`); for list/create calls a 404 means the endpoint
 * itself was not found (e.g. a misconfigured `SUPERNOTE_SERVICE_URL` or a
 * reverse-proxy path mismatch), so the enriched message carries the full URL.
 */
export class SupernoteNotFoundError extends SupernoteServiceError {
  constructor(ctx: SupernoteErrorContext) {
    super("Supernote endpoint or resource not found", 404, ctx);
    this.name = "SupernoteNotFoundError";
  }
}

/**
 * Thrown on HTTP 409 when a conditional write (`If-Unmodified-Since`) fails
 * because the stored row changed since the client last saw it. The sync engine
 * catches this and defers to its conflict policy on the next reconcile.
 */
export class SupernoteConflictError extends SupernoteServiceError {
  constructor(ctx: SupernoteErrorContext) {
    super("Supernote task changed since last sync (conditional write rejected)", 409, ctx);
    this.name = "SupernoteConflictError";
  }
}

/**
 * Thrown on HTTP 410 with code `cursor_expired` when the service is configured
 * with `CURSOR_MAX_AGE_MS` and the supplied `since` cursor is older than the
 * retention window. The adapter discards the stored delta token and performs a
 * full resync (mirrors Microsoft Graph's `410 Gone` delta handling).
 */
export class SupernoteCursorExpiredError extends SupernoteServiceError {
  constructor(ctx: SupernoteErrorContext) {
    super("Supernote delta cursor expired; full resync required", 410, ctx);
    this.name = "SupernoteCursorExpiredError";
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class SupernoteRequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Supernote service request timed out after ${timeoutMs}ms`, options);
    this.name = "SupernoteRequestTimeoutError";
  }
}

/** The transport surface the adapter depends on (fake-able in tests). */
export interface SupernoteServiceClient {
  listLists(): Promise<ServiceTaskList[]>;
  ensureList(title: string): Promise<ServiceTaskList>;
  listTasks(options: ListTasksOptions): Promise<ServiceTaskPage>;
  getTask(taskId: string): Promise<ServiceTask | null>;
  createTask(body: ServiceTaskCreate): Promise<ServiceTask>;
  updateTask(
    taskId: string,
    body: ServiceTaskUpdate,
    expectedVersionMs?: number,
  ): Promise<ServiceTask>;
  deleteTask(taskId: string, expectedVersionMs?: number): Promise<void>;
  version(): Promise<string | undefined>;
}

export interface SupernoteHttpClientOptions {
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

/** `fetch`-based implementation of {@link SupernoteServiceClient}. */
export class SupernoteHttpClient implements SupernoteServiceClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly log: Logger = defaultLogger,
    options: SupernoteHttpClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.fetchFn = options.fetch ?? fetch;
  }

  async listLists(): Promise<ServiceTaskList[]> {
    // Page via the `since` cursor from 0 so a large category set is fully
    // enumerated; the cursor mode includes soft-deleted rows, so filter them
    // out to return only active lists. Accumulate by id to collapse the
    // inclusive-boundary re-delivery.
    const byId = new Map<string, ServiceTaskList>();
    let since = 0;
    for (;;) {
      const params = new URLSearchParams({ since: String(since) });
      const page = await this.request<{ lists: ServiceTaskList[]; cursor: number; has_more: boolean }>(
        "GET",
        `/v1/lists?${params.toString()}`,
      );
      for (const list of page.lists) {
        if (list.id !== null) byId.set(list.id, list);
      }
      if (!page.has_more) break;
      since = page.cursor;
    }
    return [...byId.values()].filter((list) => !list.is_deleted);
  }

  async ensureList(title: string): Promise<ServiceTaskList> {
    // The service's POST /v1/lists is idempotent: it returns the existing
    // non-deleted list with the same title, or creates a new one. This removes
    // the read-modify-write race of a client-side "find or create".
    return this.request<ServiceTaskList>("POST", "/v1/lists", { title });
  }

  async listTasks(options: ListTasksOptions): Promise<ServiceTaskPage> {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set("since", String(options.since));
    if (options.inbox === true) {
      params.set("inbox", "true");
    } else if (options.listId !== undefined && options.listId !== null) {
      params.set("list_id", options.listId);
    }
    if (options.includeCompleted !== undefined) {
      params.set("include_completed", String(options.includeCompleted));
    }
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<ServiceTaskPage>("GET", `/v1/tasks${query ? `?${query}` : ""}`);
  }

  async getTask(taskId: string): Promise<ServiceTask | null> {
    try {
      return await this.request<ServiceTask>("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
    } catch (err) {
      if (err instanceof SupernoteNotFoundError) return null;
      throw err;
    }
  }

  async createTask(body: ServiceTaskCreate): Promise<ServiceTask> {
    return this.request<ServiceTask>("POST", "/v1/tasks", body);
  }

  async updateTask(
    taskId: string,
    body: ServiceTaskUpdate,
    expectedVersionMs?: number,
  ): Promise<ServiceTask> {
    return this.request<ServiceTask>(
      "PATCH",
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      body,
      expectedVersionMs,
    );
  }

  async deleteTask(taskId: string, expectedVersionMs?: number): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      expectedVersionMs,
    );
  }

  async version(): Promise<string | undefined> {
    try {
      const body = await this.request<{ version?: string }>("GET", "/v1/version");
      return body.version;
    } catch (err) {
      this.log.debug("Supernote service version probe failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    expectedVersionMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (expectedVersionMs !== undefined) {
        headers["If-Unmodified-Since"] = String(expectedVersionMs);
      }
      const requestInit: RequestInit = {
        method,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers,
      };
      if (body !== undefined) requestInit.body = JSON.stringify(body);

      try {
        const response = await this.fetchFn(url, requestInit);

        if (shouldRetry(response.status) && attempt < this.maxRetries) {
          const waitMs = retryDelayMs(response, attempt);
          this.log.warn("Retrying Supernote service request", {
            status: response.status,
            waitMs,
            attempt: attempt + 1,
          });
          await sleep(waitMs);
          continue;
        }

        if (response.status === 204) return undefined as T;

        const text = await response.text();
        if (!response.ok) throw toServiceError(method, url, response.status, text);
        return text ? (JSON.parse(text) as T) : (undefined as T);
      } catch (err) {
        if (err instanceof SupernoteServiceError) throw err;
        if (!isAbortError(err)) throw err;
        const timeoutError = new SupernoteRequestTimeoutError(this.requestTimeoutMs, {
          cause: err,
        });
        if (attempt >= this.maxRetries) throw timeoutError;
        const waitMs = retryDelayMs(undefined, attempt);
        this.log.warn("Retrying timed-out Supernote service request", {
          waitMs,
          attempt: attempt + 1,
          timeoutMs: this.requestTimeoutMs,
        });
        await sleep(waitMs);
      }
    }
  }
}

function toServiceError(
  method: string,
  url: string,
  status: number,
  text: string,
): SupernoteServiceError {
  const snippet = text.slice(0, 1_000);
  const code = parseErrorCode(text);
  const ctx: SupernoteErrorContext = { method, url, code, body: snippet };
  if (status === 404) return new SupernoteNotFoundError(ctx);
  if (status === 409) return new SupernoteConflictError(ctx);
  if (status === 410 && code === "cursor_expired") {
    return new SupernoteCursorExpiredError(ctx);
  }
  return new SupernoteServiceError("Supernote service request failed", status, ctx);
}

function parseErrorCode(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "code" in parsed) {
      const code = (parsed as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  } catch {
    // non-JSON body; no code available
  }
  return undefined;
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1_000;
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(retryAt - Date.now(), 0);
  }
  return Math.min(2 ** attempt * 500, 30_000);
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
