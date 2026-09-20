import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(group: string, origin = "http://localhost:5173"): Request {
  return new Request(`https://tiles.geolibre.app/celestrak/${group}`, {
    headers: { origin },
  });
}

describe("CelesTrak edge proxy", () => {
  it("identifies GeoLibre, caches the fixed upstream, and adds CORS", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("STARLINK TEST\n1 44713U 19074A\n2 44713  53.0500", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    const response = await tilesWorker.fetch(request("starlink"), {}, {} as ExecutionContext);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=21600");
    assert.equal(calls.length, 1);
    const upstream = new URL(calls[0].url);
    assert.equal(
      upstream.origin + upstream.pathname,
      "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php",
    );
    assert.equal(upstream.searchParams.get("FILE"), "starlink");
    assert.equal(upstream.searchParams.get("FORMAT"), "tle");
    const headers = new Headers(calls[0].init?.headers);
    assert.match(headers.get("user-agent") ?? "", /GeoLibre/);
    await response.text();
  });

  it("rejects untrusted origins and groups outside the fixed allowlist", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;

    const forbidden = await tilesWorker.fetch(
      request("starlink", "https://example.com"),
      {},
      {} as ExecutionContext,
    );
    const unknown = await tilesWorker.fetch(request("not-a-group"), {}, {} as ExecutionContext);

    assert.equal(forbidden.status, 403);
    assert.equal(unknown.status, 404);
    assert.equal(fetched, false);
  });
});
