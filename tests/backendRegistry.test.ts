import { describe, it, expect } from "vitest";
import { createServer, request } from "node:http";
import type { Logger } from "../src/logger.js";
import { HealthServer } from "../src/health/httpServer.js";
import { BackendRegistry, type BackendEntry } from "../src/sync/backendRegistry.js";
import { FakeAdapter } from "./helpers/fakeAdapter.js";

function createNoopLogger(): Logger {
  const logger: Logger = {
    level: "error",
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

const logger = createNoopLogger();

function entry(adapter: FakeAdapter): BackendEntry {
  return { adapter, conflictPolicy: "newer", tagListMap: {} };
}

class FailingInitAdapter extends FakeAdapter {
  override init(): Promise<void> {
    this.initCalls++;
    return Promise.reject(new Error("init failed"));
  }
}

describe("BackendRegistry", () => {
  it("keeps healthy adapters when one backend init fails", async () => {
    const healthy = new FakeAdapter("healthy");
    const failing = new FailingInitAdapter("failing");
    const registry = new BackendRegistry([entry(failing), entry(healthy)]);

    await expect(registry.initAll(logger)).resolves.toBeUndefined();

    expect(registry.entries().map((e) => e.adapter.backend)).toEqual(["healthy"]);
    expect(registry.healthyBackends()).toEqual(["healthy"]);
    expect(failing.initCalls).toBe(1);
    expect(healthy.initCalls).toBe(1);
  });

  it("closes only successfully initialized adapters", async () => {
    const healthy = new FakeAdapter("healthy");
    const failing = new FailingInitAdapter("failing");
    const registry = new BackendRegistry([entry(failing), entry(healthy)]);

    await registry.initAll(logger);
    await registry.closeAll(logger);

    expect(healthy.closeCalls).toBe(1);
    expect(failing.closeCalls).toBe(0);
  });
});

describe("HealthServer", () => {
  it("does not expose readiness details or lastError", async () => {
    const port = await getFreePort();
    const health = new HealthServer({
      host: "127.0.0.1",
      port,
      isReady: () => false,
      isHealthy: () => true,
      details: () => ({ lastError: "database password rejected", running: true }),
      logger,
    });

    await health.start();
    try {
      const response = await get("/readyz", port);
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ status: "not_ready" });
      expect(response.body).not.toContain("lastError");
      expect(response.body).not.toContain("database password rejected");
    } finally {
      await health.stop();
    }
  });
});

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a test port");
  }
  return address.port;
}

function get(path: string, port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
