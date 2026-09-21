import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("aircraft edge proxies", () => {
  for (const entry of [
    {
      path: "/opensky/states",
      upstream: "https://opensky-network.org/api/states/all",
      body: { time: 1, states: [] },
      ttl: 30,
    },
    {
      path: "/adsb-lol/military",
      upstream: "https://api.adsb.lol/v2/mil",
      body: { now: 1, ac: [] },
      ttl: 15,
    },
  ]) {
    it(`relays the fixed ${entry.path} upstream with CORS and edge caching`, async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify(entry.body), { status: 200 });
      }) as typeof fetch;
      const response = await tilesWorker.fetch(
        new Request(`https://tiles.geolibre.app${entry.path}`, {
          headers: { origin: "http://localhost:5173" },
        }),
        {},
        {} as ExecutionContext,
      );
      assert.equal(response.status, 200);
      assert.equal(calls[0].url, entry.upstream);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("cache-control"), `public, max-age=${entry.ttl}`);
      assert.equal((calls[0].init as RequestInit & { cf?: unknown }).cf, undefined);
    });
  }

  it("rejects untrusted origins before fetching", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/opensky/states", {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
  });

  it("rejects malformed successful aircraft feeds without caching them", async () => {
    globalThis.fetch = (async () =>
      new Response('{"states":"not-an-array"}', { status: 200 })) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/opensky/states", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("cache-control"), null);
  });

  it("rejects oversized aircraft feeds before reading their body", async () => {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-length": String(26 * 1024 * 1024) } },
      )) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/opensky/states", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
  });

  it("normalizes an unknown ADSBDB aircraft into a cacheable empty result", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response('{"response":"unknown aircraft"}', { status: 404 });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/adsbdb/aircraft/AbC123", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(requested, "https://api.adsbdb.com/v0/aircraft/abc123");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
    assert.deepEqual(await response.json(), { response: { aircraft: null } });
  });
});
