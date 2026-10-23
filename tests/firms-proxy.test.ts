import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { tilesWorker } from "../workers/tiles/src/index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(path: string, origin = "http://localhost:5173"): Request {
  return new Request(`https://tiles.geolibre.app${path}`, { headers: { origin } });
}

describe("FIRMS edge proxy", () => {
  it("relays a fixed VIIRS file with CORS and a half-hour cache", async () => {
    let requested = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response("latitude,longitude,frp\n1,2,3\n", { status: 200 });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      request("/firms/viirs/noaa-20"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(
      requested,
      "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "public, max-age=1800");
    assert.match(await response.text(), /^latitude,longitude/);
  });

  it("rejects unknown satellites and untrusted origins before fetching", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("latitude,longitude\n");
    }) as typeof fetch;
    const unknown = await tilesWorker.fetch(
      request("/firms/viirs/terra"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(unknown.status, 404);
    const forbidden = await tilesWorker.fetch(
      request("/firms/viirs/noaa-20", "https://example.com"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    assert.equal(fetched, false);
  });

  it("does not relay an upstream error page as CSV", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>maintenance</html>", { status: 200 })) as typeof fetch;
    const response = await tilesWorker.fetch(
      request("/firms/viirs/suomi-npp"),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 502);
  });
});
