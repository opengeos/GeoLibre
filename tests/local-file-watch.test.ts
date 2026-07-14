import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

// local-file-watch statically pulls in tauri-io, which pulls in shpjs, whose
// bundle reads the browser `self` global at module-eval time; shim it before
// the dynamic import below.
(globalThis as { self?: unknown }).self ??= globalThis;

type IsLocalFileLayer = (layer: GeoLibreLayer) => boolean;
type GetLayerWatchConfig = (layer: GeoLibreLayer) => { enabled: boolean };
type SetLayerWatchConfig = (
  layer: GeoLibreLayer,
  enabled: boolean,
) => Partial<GeoLibreLayer>;

let isLocalFileLayer: IsLocalFileLayer;
let getLayerWatchConfig: GetLayerWatchConfig;
let setLayerWatchConfig: SetLayerWatchConfig;

before(async () => {
  const mod = await import(
    "../apps/geolibre-desktop/src/lib/local-file-watch"
  );
  isLocalFileLayer = mod.isLocalFileLayer;
  getLayerWatchConfig = mod.getLayerWatchConfig;
  setLayerWatchConfig = mod.setLayerWatchConfig;
});

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    ...patch,
  };
}

describe("isLocalFileLayer", () => {
  it("accepts a plain local-file geojson layer", () => {
    const layer = makeLayer({ sourcePath: "/home/user/data/cities.geojson" });
    assert.equal(isLocalFileLayer(layer), true);
  });

  it("rejects an http(s) URL layer (those refresh via the URL path)", () => {
    const layer = makeLayer({
      source: { type: "geojson", url: "https://example.com/a.geojson" },
      sourcePath: "https://example.com/a.geojson",
    });
    assert.equal(isLocalFileLayer(layer), false);
  });

  it("rejects a layer without a sourcePath", () => {
    assert.equal(isLocalFileLayer(makeLayer()), false);
  });

  it("rejects a path with a non-vector extension", () => {
    const layer = makeLayer({ sourcePath: "/home/user/notes.txt" });
    assert.equal(isLocalFileLayer(layer), false);
  });

  it("rejects a path with traversal segments", () => {
    const layer = makeLayer({ sourcePath: "/home/user/../etc/x.geojson" });
    assert.equal(isLocalFileLayer(layer), false);
  });

  it("rejects external-native / plugin layers", () => {
    const layer = makeLayer({
      sourcePath: "/home/user/data/cities.geojson",
      metadata: { externalNativeLayer: true },
    });
    assert.equal(isLocalFileLayer(layer), false);
  });

  it("rejects a layer tagged with a sourceKind (e.g. a URL/service import)", () => {
    const layer = makeLayer({
      sourcePath: "/home/user/data/cities.geojson",
      metadata: { sourceKind: "geojson-url" },
    });
    assert.equal(isLocalFileLayer(layer), false);
  });

  it("rejects a non-geojson layer type", () => {
    const layer = makeLayer({
      type: "raster",
      sourcePath: "/home/user/data/dem.tif",
    });
    assert.equal(isLocalFileLayer(layer), false);
  });
});

describe("getLayerWatchConfig / setLayerWatchConfig", () => {
  it("reports disabled by default", () => {
    assert.deepEqual(getLayerWatchConfig(makeLayer()), { enabled: false });
  });

  it("reads the object form", () => {
    const layer = makeLayer({ metadata: { watch: { enabled: true } } });
    assert.deepEqual(getLayerWatchConfig(layer), { enabled: true });
  });

  it("tolerates the bare-true shorthand", () => {
    const layer = makeLayer({ metadata: { watch: true } });
    assert.deepEqual(getLayerWatchConfig(layer), { enabled: true });
  });

  it("enabling writes the watch metadata and preserves other keys", () => {
    const layer = makeLayer({ metadata: { featureCount: 5 } });
    const patch = setLayerWatchConfig(layer, true);
    assert.deepEqual(patch.metadata, {
      featureCount: 5,
      watch: { enabled: true },
    });
  });

  it("disabling omits the watch key rather than storing enabled:false", () => {
    const layer = makeLayer({
      metadata: { featureCount: 5, watch: { enabled: true } },
    });
    const patch = setLayerWatchConfig(layer, false);
    assert.deepEqual(patch.metadata, { featureCount: 5 });
    assert.ok(!(patch.metadata && "watch" in patch.metadata));
  });

  it("round-trips through get after set", () => {
    const layer = makeLayer();
    const enabled = setLayerWatchConfig(layer, true);
    assert.deepEqual(
      getLayerWatchConfig({ ...layer, ...enabled } as GeoLibreLayer),
      { enabled: true },
    );
  });
});
