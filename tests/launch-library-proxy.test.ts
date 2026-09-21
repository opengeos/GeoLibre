import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(origin = "http://localhost:5173"): Request {
  return new Request("https://tiles.geolibre.app/launch-library/recent", {
    headers: { origin },
  });
}

describe("Launch Library edge cache", () => {
  it("builds a fixed rolling query and exposes the cached JSON with CORS", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    const response = await tilesWorker.fetch(request(), {}, {} as ExecutionContext);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=900");
    const upstream = new URL(calls[0].url);
    assert.equal(
      upstream.origin + upstream.pathname,
      "https://ll.thespacedevs.com/2.3.0/launches/",
    );
    assert.equal(upstream.searchParams.get("limit"), "100");
    assert.equal(upstream.searchParams.get("mode"), "detailed");
    const lower = Date.parse(upstream.searchParams.get("net__gte") ?? "");
    const upper = Date.parse(upstream.searchParams.get("net__lte") ?? "");
    assert.equal(upper % 900_000, 0);
    assert.equal(upper - lower, 30 * 86_400_000);
    const headers = new Headers(calls[0].init?.headers);
    assert.match(headers.get("user-agent") ?? "", /GeoLibre/);
    const cf = (
      calls[0].init as RequestInit & {
        cf?: { cacheEverything?: boolean; cacheTtlByStatus?: Record<string, number> };
      }
    ).cf;
    assert.deepEqual(cf, {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": 900, "300-599": 0 },
    });
  });

  it("rejects untrusted browser origins", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      request("https://example.com"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
  });
});
