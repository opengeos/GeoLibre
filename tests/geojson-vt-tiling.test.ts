import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  LARGE_VECTOR_FEATURE_THRESHOLD,
  shouldUseTiledRendering,
  type GeoLibreLayer,
} from "@geolibre/core";
import { config } from "maplibre-gl";
import { syncLayer } from "../packages/map/src/layer-sync";
import {
  ensureGeoJsonVtProtocol,
  GEOJSONVT_PROTOCOL,
  registerGeoJsonVtSource,
  unregisterGeoJsonVtSource,
} from "../packages/map/src/geojson-vt-protocol";

type ProtocolHandler = (
  params: { url: string },
  abort: AbortController,
) => Promise<{ data: ArrayBuffer }>;

function protocolHandler(): ProtocolHandler {
  ensureGeoJsonVtProtocol();
  const handler = (config as { REGISTERED_PROTOCOLS?: Record<string, ProtocolHandler> })
    .REGISTERED_PROTOCOLS?.[GEOJSONVT_PROTOCOL];
  assert.ok(handler, "geojson-vt protocol should be registered");
  return handler;
}

function pointGrid(count: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < count; i++) {
    // Spread points across a small region near [0, 0] so a low-zoom tile covers
    // them all.
    const lng = (i % 100) * 0.001;
    const lat = Math.floor(i / 100) * 0.001;
    features.push({
      type: "Feature",
      properties: { idx: i },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

// Unique id per layer keeps the module-level tile-index registry from leaking
// state between tests if one throws before its cleanup runs.
let layerIdCounter = 0;

function largeLayer(
  count: number,
  id: string = `big-${layerIdCounter++}`,
  style: Partial<GeoLibreLayer["style"]> = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: pointGrid(count),
  };
}

// Fake MapLibre map that, unlike the shared point-renderer harness, surfaces the
// stored source `type` from getSource so the tiled/inline switch can be tested.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const calls: { method: string; args: unknown[] }[] = [];
  const map = {
    getSource: (id: string) => {
      const spec = sources.get(id);
      return spec ? { type: spec.type, setData: () => {} } : undefined;
    },
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
      calls.push({ method: "addSource", args: [id, spec] });
    },
    removeSource: (id: string) => {
      sources.delete(id);
      calls.push({ method: "removeSource", args: [id] });
    },
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>, beforeId?: string) => {
      layers.set(spec.id as string, spec);
      calls.push({ method: "addLayer", args: [spec, beforeId] });
    },
    removeLayer: (id: string) => {
      layers.delete(id);
      calls.push({ method: "removeLayer", args: [id] });
    },
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: () => {},
    setPaintProperty: () => {},
    setLayoutProperty: () => {},
    setLayerZoomRange: () => {},
    moveLayer: () => {},
    getStyle: () => ({
      layers: [...layers.values()],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, sources, layers, calls };
}

describe("shouldUseTiledRendering", () => {
  it("switches at the threshold", () => {
    assert.equal(LARGE_VECTOR_FEATURE_THRESHOLD, 50_000);
    assert.equal(shouldUseTiledRendering(undefined), false);
    assert.equal(shouldUseTiledRendering(pointGrid(LARGE_VECTOR_FEATURE_THRESHOLD)), false);
    assert.equal(shouldUseTiledRendering(pointGrid(LARGE_VECTOR_FEATURE_THRESHOLD + 1)), true);
  });
});

describe("geojson-vt protocol", () => {
  it("encodes a covering tile and is empty out of range / for unknown layers", async () => {
    const handler = protocolHandler();
    const rebuilt = registerGeoJsonVtSource("L1", pointGrid(10), {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 14,
    });
    assert.equal(rebuilt, true);

    const covering = await handler(
      { url: `${GEOJSONVT_PROTOCOL}://L1/0/0/0` },
      new AbortController(),
    );
    assert.ok(covering.data.byteLength > 0, "z0 tile should contain features");

    // A far-away tile (near lng ~172, far south) holds no features.
    const empty = await handler(
      { url: `${GEOJSONVT_PROTOCOL}://L1/10/1000/1000` },
      new AbortController(),
    );
    assert.equal(empty.data.byteLength, 0);

    // Unknown layer id yields an empty tile rather than throwing.
    const unknown = await handler(
      { url: `${GEOJSONVT_PROTOCOL}://nope/0/0/0` },
      new AbortController(),
    );
    assert.equal(unknown.data.byteLength, 0);

    unregisterGeoJsonVtSource("L1");
    const afterUnregister = await handler(
      { url: `${GEOJSONVT_PROTOCOL}://L1/0/0/0` },
      new AbortController(),
    );
    assert.equal(afterUnregister.data.byteLength, 0);
  });

  it("reuses the index until the data or cluster config changes", () => {
    const fc = pointGrid(5);
    assert.equal(
      registerGeoJsonVtSource("L2", fc, {
        cluster: false,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      }),
      true,
    );
    // Same reference + same options → reused, not rebuilt.
    assert.equal(
      registerGeoJsonVtSource("L2", fc, {
        cluster: false,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      }),
      false,
    );
    // Toggling clustering forces a rebuild.
    assert.equal(
      registerGeoJsonVtSource("L2", fc, {
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      }),
      true,
    );
    // A new collection reference forces a rebuild.
    assert.equal(
      registerGeoJsonVtSource("L2", pointGrid(5), {
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 14,
      }),
      true,
    );
    unregisterGeoJsonVtSource("L2");
  });

  it("encodes a clustered tile", async () => {
    const handler = protocolHandler();
    registerGeoJsonVtSource("LC", pointGrid(200), {
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 14,
    });
    const tile = await handler({ url: `${GEOJSONVT_PROTOCOL}://LC/0/0/0` }, new AbortController());
    assert.ok(tile.data.byteLength > 0);
    unregisterGeoJsonVtSource("LC");
  });
});

describe("syncLayer tiled path", () => {
  it("renders a large layer as a vector source with source-layer'd render layers", () => {
    const { map, sources, layers } = makeMap();
    const id = "big-render";
    try {
      syncLayer(map as never, largeLayer(LARGE_VECTOR_FEATURE_THRESHOLD + 1, id));

      const src = sources.get(`source-${id}`) as Record<string, unknown>;
      assert.equal(src.type, "vector");
      assert.deepEqual(src.tiles, [`${GEOJSONVT_PROTOCOL}://${id}/{z}/{x}/{y}`]);

      const circle = layers.get(`layer-${id}-circle`) as Record<string, unknown>;
      assert.equal(circle.type, "circle");
      assert.equal(circle["source-layer"], "data");
    } finally {
      unregisterGeoJsonVtSource(id);
    }
  });

  it("switches back to an inline geojson source when shrunk below the threshold", () => {
    const { map, sources, calls } = makeMap();
    const id = "big-switch";
    try {
      syncLayer(map as never, largeLayer(LARGE_VECTOR_FEATURE_THRESHOLD + 1, id));
      assert.equal((sources.get(`source-${id}`) as Record<string, unknown>).type, "vector");

      syncLayer(map as never, largeLayer(10, id));
      assert.ok(
        calls.some((c) => c.method === "removeSource" && c.args[0] === `source-${id}`),
        "the vector source should be torn down",
      );
      assert.equal((sources.get(`source-${id}`) as Record<string, unknown>).type, "geojson");
    } finally {
      unregisterGeoJsonVtSource(id);
    }
  });
});
