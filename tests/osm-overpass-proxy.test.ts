import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildOsmDownloadQuery } from "../packages/plugins/src/plugins/osm-downloader-api";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(body: string, origin = "https://preview.geolibre-preview.pages.dev"): Request {
  return new Request("https://tiles.geolibre.app/overpass", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin,
    },
    body,
  });
}

describe("Overpass edge proxy", () => {
  it("relays a bounded query to the fixed upstream and adds CORS", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response('{"elements":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const body =
      "data=" + encodeURIComponent(buildOsmDownloadQuery([0, 0, 1, 1], { preset: "amenities" }));
    const response = await tilesWorker.fetch(request(body), {}, {} as ExecutionContext);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, "https://overpass-api.de/api/interpreter");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, body);
  });

  it("rejects untrusted origins and oversized bodies before fetching upstream", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response();
    };

    const forbidden = await tilesWorker.fetch(
      request("data=query", "https://example.com"),
      {},
      {} as ExecutionContext,
    );
    const oversized = await tilesWorker.fetch(
      request(`data=${"x".repeat(20_001)}`),
      {},
      {} as ExecutionContext,
    );

    assert.equal(forbidden.status, 403);
    assert.equal(oversized.status, 413);
    assert.equal(fetched, false);
  });

  it("rejects forged unbounded queries before fetching upstream", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response();
    };

    const unbounded = await tilesWorker.fetch(
      request("data=" + encodeURIComponent('[out:json][timeout:60];way["building"];out geom;')),
      {},
      {} as ExecutionContext,
    );
    const oversized = await tilesWorker.fetch(
      request(
        "data=" +
          encodeURIComponent('[out:json][timeout:60];nwr["building"](-80,-170,80,170);out geom;'),
      ),
      {},
      {} as ExecutionContext,
    );

    assert.equal(unbounded.status, 400);
    assert.equal(oversized.status, 400);
    assert.equal(fetched, false);
  });
});
