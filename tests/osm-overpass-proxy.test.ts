import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildOsmDownloadQuery,
  MAX_ALL_QUERY_AREA_SQUARE_DEGREES,
  MAX_QUERY_AREA_SQUARE_DEGREES,
} from "../packages/plugins/src/plugins/osm-downloader-api";
import {
  isAllowedOverpassQuery,
  OVERPASS_MAX_ALL_QUERY_AREA_SQUARE_DEGREES,
  OVERPASS_MAX_QUERY_AREA_SQUARE_DEGREES,
  tilesWorker,
} from "../workers/tiles/src/index";

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
  it("keeps Worker area limits aligned with the client", () => {
    assert.equal(OVERPASS_MAX_ALL_QUERY_AREA_SQUARE_DEGREES, MAX_ALL_QUERY_AREA_SQUARE_DEGREES);
    assert.equal(OVERPASS_MAX_QUERY_AREA_SQUARE_DEGREES, MAX_QUERY_AREA_SQUARE_DEGREES);
  });

  it("advertises POST only on the Overpass preflight", async () => {
    const overpass = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/overpass", { method: "OPTIONS" }),
      {},
      {} as ExecutionContext,
    );
    const tile = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/opm/example/0/0/0.png", { method: "OPTIONS" }),
      {},
      {} as ExecutionContext,
    );

    assert.equal(overpass.headers.get("access-control-allow-methods"), "POST, OPTIONS");
    assert.equal(tile.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  });

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
    assert.equal(calls[0].input, "https://z.overpass-api.de/api/interpreter");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.body, body);
    await response.text();
  });

  it("accepts a bounded antimeridian split and rejects injected selector text", async () => {
    globalThis.fetch = async () =>
      new Response('{"elements":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const query = buildOsmDownloadQuery([179.9, -0.1, 180.1, 0.1], {
      preset: "buildings",
    });

    const accepted = await tilesWorker.fetch(
      request("data=" + encodeURIComponent(query)),
      {},
      {} as ExecutionContext,
    );
    const rejected = await tilesWorker.fetch(
      request("data=" + encodeURIComponent(query.replace(");nwr", ");node; nwr"))),
      {},
      {} as ExecutionContext,
    );

    assert.equal(accepted.status, 200);
    assert.equal(rejected.status, 400);
    await accepted.text();
  });

  it("rejects two bounded selectors that are not one antimeridian split", () => {
    assert.equal(
      isAllowedOverpassQuery(
        '[out:json][timeout:60];(nwr["building"](0,0,1,1);nwr["building"](2,2,3,3););out geom;',
      ),
      false,
    );
    assert.equal(
      isAllowedOverpassQuery(
        '[out:json][timeout:60];(nwr["building"](0,179,1,180);nwr["highway"](0,-180,1,-179););out geom;',
      ),
      false,
    );
  });

  it("accepts distinct exponent-form client bounds after decimal expansion", () => {
    const positive = buildOsmDownloadQuery([1e-16, 0, 2e-16, 1], {
      preset: "buildings",
    });
    const negative = buildOsmDownloadQuery([-2e-16, 0, -1e-16, 1], {
      preset: "buildings",
    });

    assert.equal(isAllowedOverpassQuery(positive), true);
    assert.equal(isAllowedOverpassQuery(negative), true);
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

  it("stops reading a streamed body once it exceeds the limit", async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response();
    };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data=${"x".repeat(20_001)}`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamedRequest = new Request("https://tiles.geolibre.app/overpass", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        origin: "https://preview.geolibre-preview.pages.dev",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await tilesWorker.fetch(streamedRequest, {}, {} as ExecutionContext);

    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
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
