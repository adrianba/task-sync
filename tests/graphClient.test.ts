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
});
