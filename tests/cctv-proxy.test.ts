import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Calgary CCTV edge proxy", () => {
  it("relays one fixed, bounded public frame with CORS", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://trafficcam.calgary.ca/loc86.jpg");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=30");
  });

  it("accepts the Referer-only request shape sent by popup image elements", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { referer: "https://web.geolibre.app/" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
  });

  it("returns 502 when the upstream frame body stalls", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let startedReading!: () => void;
    const readingStarted = new Promise<void>((resolve) => {
      startedReading = resolve;
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          pull(controller) {
            startedReading();
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg" } },
      );
    }) as typeof fetch;
    const pending = tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    await readingStarted;
    t.mock.timers.tick(30_000);
    assert.equal((await pending).status, 502);
  });

  it("rejects a request with neither an allowed origin nor referrer", async () => {
    const headerlessResponse = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(headerlessResponse.status, 403);
  });

  it("rejects untrusted origins, malformed ids, non-images, and oversized frames", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("not an image", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const forbidden = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);

    const forbiddenReferer = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { referer: "https://example.com/" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbiddenReferer.status, 403);
    assert.equal(fetched, false);

    const malformed = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/not-an-id.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(malformed.status, 404);

    const wrongType = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(wrongType.status, 502);

    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(5 * 1024 * 1024 + 1) },
      })) as typeof fetch;
    const oversized = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/cctv/calgary/86.jpg", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(oversized.status, 502);
  });
});
