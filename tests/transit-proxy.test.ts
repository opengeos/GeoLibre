import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: originalCaches,
  });
});

describe("transit edge proxy", () => {
  it("relays a fixed provider with CORS and short edge caching", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(new Uint8Array([10, 0]), { status: 200 });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/mbta", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://cdn.mbta.com/realtime/VehiclePositions.pb");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=15");
    assert.equal(response.headers.get("content-type"), "application/x-protobuf");
  });

  it("caches OVapi for its required one-minute polling interval", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([10, 0]), { status: 200 })) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/ovapi-nl", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
  });

  it("rejects unknown providers and untrusted origins before fetching", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(new Uint8Array([1]));
    }) as typeof fetch;
    const unknown = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/not-registered", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(unknown.status, 404);
    const forbidden = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/mbta", {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);
  });

  it("rejects empty and oversized provider responses", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(), { status: 200 })) as typeof fetch;
    const empty = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/mbta", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(empty.status, 502);

    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 200,
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
        },
      )) as typeof fetch;
    const oversized = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/transit/vehicles/mbta", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(oversized.status, 502);
    assert.equal(cancelled, true);
  });
});
