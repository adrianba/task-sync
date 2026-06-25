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

  constructor(private readonly options: HealthServerOptions) {}

  start(): Promise<void> {
    const { host, port, isReady, isHealthy, details, logger } = this.options;
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = req.url ?? "/";
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        if (url.startsWith("/healthz")) {
          const healthy = isHealthy();
          if (!healthy && details) logger.warn("Health check failed", details());
          respond(res, healthy, { status: healthy ? "ok" : "unhealthy" });
          return;
        }
        if (url.startsWith("/readyz")) {
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
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }
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
