import type { MsTodoBackendConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";
import type {
  DeltaResult,
  ExternalList,
  ExternalTask,
  ExternalTaskInput,
  SyncAdapter,
} from "../types.js";
import { MsAuth } from "./auth.js";
import { GraphClient, GraphDeltaGoneError } from "./graphClient.js";
import { fromGraphTask, toGraphBody, type GraphTodoTask } from "./mapping.js";

interface RemovedGraphTask extends GraphTodoTask {
  "@removed"?: unknown;
}

export class DeltaTokenExpiredError extends Error {
  constructor(message = "Microsoft To Do delta token expired") {
    super(message);
    this.name = "DeltaTokenExpiredError";
  }
}

export class MsTodoAdapter implements SyncAdapter {
  readonly backend = "ms-todo";
  private auth: MsAuth | undefined;
  private graph: GraphClient | undefined;

  constructor(
    private readonly config: MsTodoBackendConfig,
    private readonly tokenKey: Buffer,
    private readonly log: Logger = defaultLogger,
  ) {}

  async init(): Promise<void> {
    const graph = this.client();
    await graph.listLists();
  }

  async listLists(): Promise<ExternalList[]> {
    const lists = await this.client().listLists();
    return lists.map((list) => ({ id: list.id, name: list.displayName }));
  }

  async ensureList(name: string): Promise<string> {
    const lists = await this.listLists();
    const existing = lists.find((list) => list.name === name);
    if (existing) return existing.id;

    const created = await this.client().createList(name);
    if (!created.id) throw new Error(`Microsoft To Do list creation returned no id for ${name}`);
    return created.id;
  }

  async listTasks(listId: string): Promise<ExternalTask[]> {
    const tasks = await this.client().listTasks<GraphTodoTask>(listId);
    return tasks.map((task) => fromGraphTask(task, listId));
  }

  async getTask(listId: string, externalId: string): Promise<ExternalTask | null> {
    try {
      const task = await this.client().getTask<GraphTodoTask>(listId, externalId);
      return fromGraphTask(task, listId);
    } catch (err) {
      if (isGraphNotFound(err)) return null;
      throw err;
    }
  }

  async createTask(listId: string, input: ExternalTaskInput): Promise<ExternalTask> {
    const task = await this.client().createTask<GraphTodoTask>(listId, toGraphBody(input));
    return fromGraphTask(task, listId);
  }

  async updateTask(
    listId: string,
    externalId: string,
    patch: Partial<ExternalTaskInput>,
  ): Promise<ExternalTask> {
    const task = await this.client().patchTask<GraphTodoTask>(
      listId,
      externalId,
      toGraphBody(patch),
    );
    return fromGraphTask(task, listId);
  }

  async deleteTask(listId: string, externalId: string): Promise<void> {
    await this.client().deleteTask(listId, externalId);
  }

  async delta(listId: string, token?: string): Promise<DeltaResult> {
    try {
      const response = await this.client().deltaTasks<RemovedGraphTask>(listId, token);
      const changed: ExternalTask[] = [];
      const removedIds: string[] = [];

      for (const item of response.value) {
        if (item["@removed"] !== undefined) {
          removedIds.push(item.id);
        } else {
          changed.push(fromGraphTask(item, listId));
        }
      }

      const deltaToken = response["@odata.deltaLink"];
      if (!deltaToken) throw new Error("Microsoft Graph delta response omitted deltaLink");
      return { changed, removedIds, token: deltaToken };
    } catch (err) {
      if (err instanceof GraphDeltaGoneError) throw new DeltaTokenExpiredError();
      throw err;
    }
  }

  private client(): GraphClient {
    if (!this.graph) {
      this.auth = new MsAuth(this.config, this.tokenKey, this.log);
      this.graph = new GraphClient(() => this.auth?.getAccessToken() ?? Promise.reject(new Error("Microsoft auth unavailable")), this.log);
    }
    return this.graph;
  }
}

export function createMsTodoAdapter(
  cfg: MsTodoBackendConfig,
  tokenKey: Buffer,
  log: Logger = defaultLogger,
): MsTodoAdapter {
  return new MsTodoAdapter(cfg, tokenKey, log);
}

function isGraphNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
}
