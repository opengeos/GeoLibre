import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
const { config } = await import("maplibre-gl");
const { nativeMbtilesTileUrl, registerNativeMbtilesProtocol } =
  await import("../apps/geolibre-desktop/src/lib/native-mbtiles-protocol");
registerNativeMbtilesProtocol();
const handler = config.REGISTERED_PROTOCOLS["geolibre-native-mbtiles"];
assert.ok(handler);
const originalFetch = globalThis.fetch;
const previousUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousUserAgent) Object.defineProperty(navigator, "userAgent", previousUserAgent);
  else Reflect.deleteProperty(navigator, "userAgent");
});

it("fetches native vector tiles in the document and preserves the path and abort signal", async () => {
  const path = "/data/org.geolibre.app/offline-packages/pkg-a/archive % # é.mbtiles";
  const controller = new AbortController();
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Linux; Android 15)",
  });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, `http://mbtiles.localhost/tile/8/41/98?path=${encodeURIComponent(path)}`);
    assert.equal(options?.signal, controller.signal);
    return new Response(new Uint8Array([1, 2, 3]));
  };
  const result = await handler(
    { url: nativeMbtilesTileUrl(path).replace("{z}/{x}/{y}", "8/41/98") },
    controller,
  );
  assert.deepEqual(new Uint8Array(result.data as ArrayBuffer), new Uint8Array([1, 2, 3]));
  assert.equal(calls, 1);
});

it("preserves Windows native HTTP templates usable by Mapbox", () => {
  assert.equal(
    nativeMbtilesTileUrl("C:\\data\\map.mbtiles", "windows"),
    "http://mbtiles.localhost/tile/{z}/{x}/{y}?path=C%3A%5Cdata%5Cmap.mbtiles",
  );
});

it("does not turn an authorization failure into a successful empty vector tile", async () => {
  globalThis.fetch = async () => new Response("denied", { status: 403 });
  await assert.rejects(
    handler(
      { url: nativeMbtilesTileUrl("/data/a.mbtiles").replace("{z}/{x}/{y}", "0/0/0") },
      new AbortController(),
    ),
    /403/,
  );
});

it("rejects other schemes before fetching and propagates native fetch cancellation", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.ok(options?.signal?.aborted);
    throw options.signal.reason;
  };
  await assert.rejects(
    handler({ url: "https://example.com/tile/0/0/0" }, new AbortController()),
    /Invalid native/,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort(new Error("tile canceled"));
  await assert.rejects(
    handler(
      { url: nativeMbtilesTileUrl("/data/a.mbtiles").replace("{z}/{x}/{y}", "0/0/0") },
      controller,
    ),
    /tile canceled/,
  );
});
