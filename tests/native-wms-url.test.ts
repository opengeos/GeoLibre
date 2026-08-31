import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { routeWmsLayerThroughNativeProtocol } from "../apps/geolibre-desktop/src/lib/xyz-url";
import { isHttpWmsUrl, nativeWmsTileUrl } from "../apps/geolibre-desktop/src/lib/native-wms-url";

test("nativeWmsTileUrl preserves the MapLibre bbox placeholder", () => {
  const tile =
    "https://example.com/wms?SERVICE=WMS&LAYERS=roads&BBOX={bbox-epsg-3857}&FORMAT=image%2Fpng";
  const routed = nativeWmsTileUrl(tile);

  assert.match(routed, /^geolibre-wms:\/\/tile\?url=/);
  assert.match(routed, /\{bbox-epsg-3857\}/);
  assert.equal(new URL(routed).searchParams.get("url"), tile);
});

test("nativeWmsTileUrl does not wrap an already routed URL", () => {
  const routed = "geolibre-wms://tile?url=https%3A%2F%2Fexample.com%2Fwms";
  assert.equal(nativeWmsTileUrl(routed), routed);
});

test("nativeWmsTileUrl rejects non-HTTP tile URLs", () => {
  assert.throws(() => nativeWmsTileUrl("file:///tmp/tile.png"), /Invalid WMS tile URL/);
  assert.throws(() => nativeWmsTileUrl("https://"), /Invalid WMS tile URL/);
});

test("isHttpWmsUrl accepts only syntactically valid HTTP(S) URLs", () => {
  assert.equal(isHttpWmsUrl("https://example.com/wms"), true);
  assert.equal(isHttpWmsUrl("http://example.com/wms"), true);
  assert.equal(isHttpWmsUrl("example.com/wms"), false);
  assert.equal(isHttpWmsUrl("https://"), false);
  assert.equal(isHttpWmsUrl("file:///tmp/tile.png"), false);
});

test("routeWmsLayerThroughNativeProtocol only changes desktop WMS tiles", () => {
  const globals = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globals.window;
  const tile = "https://example.com/wms?BBOX={bbox-epsg-3857}";
  const layer = {
    id: "wms",
    name: "WMS",
    type: "wms",
    source: { type: "raster", tiles: [tile] },
    metadata: {},
  } as GeoLibreLayer;

  try {
    globals.window = {};
    assert.equal(routeWmsLayerThroughNativeProtocol(layer), layer);

    globals.window = { __TAURI_INTERNALS__: {} };
    const routed = routeWmsLayerThroughNativeProtocol(layer);
    assert.notEqual(routed, layer);
    assert.match(String(routed.source.tiles?.[0]), /^geolibre-wms:/);
    assert.equal(layer.source.tiles?.[0], tile);
  } finally {
    if (previousWindow === undefined) delete globals.window;
    else globals.window = previousWindow;
  }
});
