import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";

export type TokenProvider = () => Promise<string>;

export interface GraphList {
  id: string;
  displayName: string;
  wellknownListName?: string;
}

export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface RemovedGraphItem {
  id: string;
  "@removed"?: unknown;
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export class GraphDeltaGoneError extends GraphError {
  constructor(body: string) {
    super("Microsoft Graph delta token expired", 410, body);
    this.name = "GraphDeltaGoneError";
  }
}

export class GraphRequestTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Graph request timed out after ${timeoutMs}ms`, options);
    this.name = "GraphRequestTimeoutError";
  }
}

export interface GraphClientOptions {
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class GraphClient {
  private readonly baseUrl = "https://graph.microsoft.com/v1.0";
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly log: Logger = defaultLogger,
    options: GraphClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 5;
    this.fetchFn = options.fetch ?? fetch;
  }

  async listLists(): Promise<GraphList[]> {
    const response = await this.request<GraphCollection<GraphList>>("GET", "/me/todo/lists");
    return response.value;
  }

  async createList(displayName: string): Promise<GraphList> {
    return this.request<GraphList>("POST", "/me/todo/lists", { displayName });
  }

  async listTasks<T>(listId: string): Promise<T[]> {
    return this.collectPages<T>(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`);
  }

  async getTask<T>(listId: string, taskId: string): Promise<T> {
    return this.request<T>(
      "GET",
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  async createTask<T>(listId: string, body: unknown): Promise<T> {
    return this.request<T>(
      "POST",
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks`,
      body,
    );
  }

  async patchTask<T>(listId: string, taskId: string, body: unknown): Promise<T> {
    return this.request<T>(
      "PATCH",
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
      body,
    );
  }

  async deleteTask(listId: string, taskId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  async deltaTasks<T extends RemovedGraphItem>(
    listId: string,
    token?: string,
  ): Promise<GraphCollection<T>> {
    const changed: T[] = [];
    let url = token ?? `/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;
    let deltaLink: string | undefined;

    for (;;) {
      const response = await this.request<GraphCollection<T>>("GET", url, undefined, true);
      changed.push(...response.value);
      const nextLink = response["@odata.nextLink"];
      if (nextLink) {
        url = nextLink;
        continue;
      }
      deltaLink = response["@odata.deltaLink"];
      break;
    }

    const result: GraphCollection<T> = { value: changed };
    if (deltaLink !== undefined) result["@odata.deltaLink"] = deltaLink;
    return result;
  }

  private async collectPages<T>(initialUrl: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = initialUrl;
    while (url) {
      const response: GraphCollection<T> = await this.request<GraphCollection<T>>(
        "GET",
        url,
      );
      items.push(...response.value);
      url = response["@odata.nextLink"];
    }
    return items;
  }

  private async request<T>(
    method: string,
    urlOrPath: string,
    body?: unknown,
    deltaRequest = false,
  ): Promise<T> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${this.baseUrl}${urlOrPath}`;

    for (let attempt = 0; ; attempt += 1) {
      const token = await this.tokenProvider();
      const requestInit: RequestInit = {
        method,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      };
      try {
        if (body !== undefined) requestInit.body = JSON.stringify(body);
        const response = await this.fetchFn(url, requestInit);

        if (shouldRetry(response.status) && attempt < this.maxRetries) {
          const waitMs = retryDelayMs(response, attempt);
          this.log.warn("Retrying Microsoft Graph request", {
            status: response.status,
            waitMs,
            attempt: attempt + 1,
          });
          await sleep(waitMs);
          continue;
        }

        if (response.status === 204) return undefined as T;

        const text = await response.text();
        if (!response.ok) {
          const snippet = text.slice(0, 1_000);
          if (deltaRequest && response.status === 410) {
            throw new GraphDeltaGoneError(snippet);
          }
          throw new GraphError(
            `Microsoft Graph ${method} failed with HTTP ${response.status}: ${snippet}`,
            response.status,
            snippet,
          );
        }

        return text ? (JSON.parse(text) as T) : (undefined as T);
      } catch (err) {
        if (!isAbortError(err)) throw err;
        const timeoutError = new GraphRequestTimeoutError(this.requestTimeoutMs, {
          cause: err,
        });
        if (attempt >= this.maxRetries) throw timeoutError;
        const waitMs = retryDelayMs(undefined, attempt);
        this.log.warn("Retrying timed-out Microsoft Graph request", {
          waitMs,
          attempt: attempt + 1,
          timeoutMs: this.requestTimeoutMs,
        });
        await sleep(waitMs);
      }
    }
  }
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
