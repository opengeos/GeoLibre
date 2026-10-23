import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverOpenRouterModels } from "../apps/geolibre-desktop/src/lib/assistant/openrouter";

describe("discoverOpenRouterModels", () => {
  function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
    const { promise, reject } = Promise.withResolvers<Response>();
    const onAbort = () => reject(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return promise;
  }

  it("requests the keyless text/tool catalog and preserves popularity order", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let hasAuthorization = true;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      hasAuthorization = request.headers.has("authorization");
      return Response.json({
        data: [
          { id: " vendor/first ", name: "First model" },
          { id: "vendor/second", name: "  " },
          { id: "vendor/first", name: "Duplicate" },
          { id: "  ", name: "Missing ID" },
          { id: 42, name: "Malformed ID" },
          null,
          "malformed entry",
          {},
        ],
      });
    };

    try {
      assert.deepEqual(await discoverOpenRouterModels(), [
        { id: "vendor/first", name: "First model" },
        { id: "vendor/second", name: "vendor/second" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const url = new URL(requestUrl);
    assert.equal(url.origin, "https://openrouter.ai");
    assert.equal(url.pathname, "/api/v1/models");
    assert.deepEqual(
      [...url.searchParams.entries()],
      [
        ["input_modalities", "text"],
        ["output_modalities", "text"],
        ["supported_parameters", "tools"],
        ["sort", "most-popular"],
      ],
    );
    assert.equal(hasAuthorization, false);
  });

  it("accepts an empty catalog and rejects missing or malformed data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: [] });
    try {
      assert.deepEqual(await discoverOpenRouterModels(), []);

      globalThis.fetch = async () => Response.json({});
      await assert.rejects(discoverOpenRouterModels(), /invalid model catalog/);

      globalThis.fetch = async () => Response.json({ data: null });
      await assert.rejects(discoverOpenRouterModels(), /invalid model catalog/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports non-success HTTP status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    try {
      await assert.rejects(discoverOpenRouterModels(), /HTTP 403/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts an in-flight catalog request when the caller cancels", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverOpenRouterModels(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the ten-second deadline to abort a stalled request", async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        assert.equal(milliseconds, 10_000);
        return deadline.signal;
      },
    });
    globalThis.fetch = async (_input, init) => waitForAbort(init?.signal);

    try {
      const pending = discoverOpenRouterModels();
      deadline.abort(new DOMException("The operation timed out", "TimeoutError"));
      await assert.rejects(pending, { name: "TimeoutError" });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
    }
  });
});
