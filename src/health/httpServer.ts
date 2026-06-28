/**
 * Lightweight HTTP health/readiness server for container orchestrators and the
 * Docker HEALTHCHECK. Exposes:
 *  - `GET /healthz`  — liveness: the process is up and the event loop responds.
 *  - `GET /readyz`   — readiness: startup completed and the last sync was OK.
 *
 * It intentionally has no dependencies beyond `node:http` and never exposes any
 * task content or secrets — only boolean status and coarse counters.
 */
import { createServer, type Server } from "node:http";
import type { Logger } from "../logger.js";

export interface HealthServerOptions {
  host: string;
  port: number;
  /** Returns true once startup wiring is complete and backends are usable. */
  isReady: () => boolean;
  /** Returns true while the service is healthy (e.g. not in a fatal state). */
  isHealthy: () => boolean;
  /** Optional hook for logging detailed status without exposing it over HTTP. */
  details?: () => Record<string, unknown>;
  logger: Logger;
}

export class HealthServer {
  private server: Server | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: HealthServerOptions) {}

  start(): Promise<void> {
    // Idempotent: repeated calls return the same in-flight/settled start promise
    // rather than binding a second listener.
    if (this.starting) return this.starting;
    const { host, port, isReady, isHealthy, details, logger } = this.options;
    this.starting = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const path = requestPath(req.url);
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        if (path === "/healthz") {
          const healthy = isHealthy();
          if (!healthy && details) logger.warn("Health check failed", details());
          respond(res, healthy, { status: healthy ? "ok" : "unhealthy" });
          return;
        }
        if (path === "/readyz") {
          const ready = isReady();
          if (!ready && details) logger.warn("Readiness check failed", details());
          respond(res, ready, {
            status: ready ? "ok" : "not_ready",
          });
          return;
        }
        res.writeHead(404).end();
      });

      server.on("error", (err) => {
        logger.error("Health server error", { err });
        reject(err);
      });

      server.listen(port, host, () => {
        logger.info("Health server listening", { host, port });
        resolve();
      });

      this.server = server;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.starting = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }
}

/** Extract the URL path (ignoring query string) for exact-match routing. */
function requestPath(rawUrl: string | undefined): string {
  const url = rawUrl ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function respond(
  res: import("node:http").ServerResponse,
  ok: boolean,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(ok ? 200 : 503, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
