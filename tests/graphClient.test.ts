import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/adapters/msTodo/graphClient.js";

describe("GraphClient", () => {
  it("wraps timed-out fetches in a typed error", async () => {
    const fakeFetch = vi.fn<typeof fetch>((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("aborted"),
            ),
          { once: true },
        );
      }),
    );
    const client = new GraphClient(
      () => Promise.resolve("token"),
      undefined,
      { fetch: fakeFetch, maxRetries: 0, requestTimeoutMs: 5 },
    );

    await expect(client.listLists()).rejects.toMatchObject({
      message: "Graph request timed out after 5ms",
      name: "GraphRequestTimeoutError",
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts pagination on a non-advancing nextLink", async () => {
    const page = {
      value: [],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/loop",
    };
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new GraphClient(() => Promise.resolve("token"), undefined, {
      fetch: fakeFetch,
    });

    await expect(
      client.listTasks("https://graph.microsoft.com/v1.0/loop"),
    ).rejects.toThrow(/non-advancing nextLink/);
  });

  it("keeps response bodies out of error messages", async () => {
    const secretBody = JSON.stringify({ error: "token=SUPER_SECRET_VALUE" });
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(secretBody, { status: 400 })),
    );
    const client = new GraphClient(() => Promise.resolve("token"), undefined, {
      fetch: fakeFetch,
      maxRetries: 0,
    });

    await expect(client.listLists()).rejects.toMatchObject({
      name: "GraphError",
      status: 400,
      body: secretBody,
    });
    await expect(client.listLists()).rejects.toThrow(
      /^Microsoft Graph GET failed with HTTP 400$/,
    );
  });

  it("stops retrying once the shutdown signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fakeFetch = vi.fn<typeof fetch>((_input, init) => {
      calls += 1;
      if (init?.signal?.aborted) {
        return Promise.reject(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 503 }));
    });
    const client = new GraphClient(() => Promise.resolve("token"), undefined, {
      fetch: fakeFetch,
      maxRetries: 5,
      signal: controller.signal,
    });

    await expect(client.listLists()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });
});
