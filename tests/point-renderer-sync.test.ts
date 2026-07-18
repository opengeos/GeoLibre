import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Stateful fake MapLibre map: tracks sources and layers across sync passes so a
// test can assert which native layers/sources a point renderer produces and
// which were removed when the renderer changes.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getSource: (id: string) => (sources.has(id) ? { setData: record("setData") } : undefined),
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
    setFilter: record("setFilter"),
    setPaintProperty: record("setPaintProperty"),
    setLayoutProperty: record("setLayoutProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    getStyle: () => ({
      layers: [...layers.values()],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, sources, layers, calls };
}

function pointLayer(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "pts",
    name: "Points",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [0, 0] },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [1, 1] },
        },
      ],
    },
  };
}

describe("point renderer sync", () => {
  it("renders a single-symbol point layer as a circle layer", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, pointLayer());

    assert.equal((layers.get("layer-pts-circle") as { type: string }).type, "circle");
    assert.ok(!layers.has("layer-pts-heatmap"));
    assert.ok(!layers.has("layer-pts-cluster"));
    // A single-symbol source is a plain GeoJSON source (no clustering).
    assert.equal(sources.get("source-pts")?.cluster, undefined);
  });

  it("renders a heatmap layer and drops the circle when switched", () => {
    const { map, layers } = makeMap();
    // Start single, then switch to heatmap on the same map.
    syncLayer(map as never, pointLayer());
    assert.ok(layers.has("layer-pts-circle"));

    syncLayer(map as never, pointLayer({ pointRenderer: "heatmap" }));
    assert.equal((layers.get("layer-pts-heatmap") as { type: string }).type, "heatmap");
    assert.ok(!layers.has("layer-pts-circle"));
  });

  it("clusters: a clustered source plus cluster, count, and unclustered layers", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(
      map as never,
      pointLayer({ pointRenderer: "cluster", clusterRadius: 40, clusterMaxZoom: 12 }),
    );

    const src = sources.get("source-pts") as Record<string, unknown>;
    assert.equal(src.cluster, true);
    assert.equal(src.clusterRadius, 40);
    assert.equal(src.clusterMaxZoom, 12);

    assert.equal((layers.get("layer-pts-cluster") as { type: string }).type, "circle");
    assert.equal((layers.get("layer-pts-cluster-count") as { type: string }).type, "symbol");
    // The unclustered points reuse the circle layer, filtered to non-clusters.
    const circle = layers.get("layer-pts-circle") as { filter: unknown };
    assert.deepEqual(circle.filter, ["!", ["has", "point_count"]]);
    assert.ok(!layers.has("layer-pts-heatmap"));
  });

  it("recreates the source when clustering is turned off again", () => {
    const { map, sources, calls } = makeMap();
    syncLayer(map as never, pointLayer({ pointRenderer: "cluster" }));
    assert.equal(sources.get("source-pts")?.cluster, true);

    syncLayer(map as never, pointLayer({ pointRenderer: "single" }));
    // The clustered source was removed and re-added without clustering.
    assert.ok(calls.some((c) => c.method === "removeSource" && c.args[0] === "source-pts"));
    assert.equal(sources.get("source-pts")?.cluster, undefined);
  });

  it("ignores the renderer on layers with non-point geometry", () => {
    const { map, layers } = makeMap();
    const mixed = pointLayer({ pointRenderer: "heatmap" });
    mixed.geojson!.features.push({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    });
    syncLayer(map as never, mixed);

    // hasPoint is still true, so a circle layer renders; heatmap does not.
    assert.ok(layers.has("layer-pts-circle"));
    assert.ok(!layers.has("layer-pts-heatmap"));
  });

  // MapLibre's addLayer silently drops a layer whose paint carries an explicit
  // null (null is only valid as a setPaintProperty reset), so the fill layer's
  // `fill-pattern: null` (the "no pattern" default) must be stripped before the
  // first add — otherwise polygon fills never appear (regression: annotation
  // arrowheads and highlight shapes rendered as outline-only).
  it("never passes a null paint value to addLayer for a polygon fill", () => {
    const { map, layers, calls } = makeMap();
    const polygon: GeoLibreLayer = {
      id: "poly",
      name: "Polygon",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 1],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    };
    syncLayer(map as never, polygon);

    assert.ok(layers.has("layer-poly-fill"), "fill layer is created");
    for (const call of calls) {
      if (call.method !== "addLayer") continue;
      const spec = call.args[0] as {
        id?: string;
        paint?: Record<string, unknown>;
      };
      const nullKeys = Object.entries(spec.paint ?? {})
        .filter(([, value]) => value === null)
        .map(([key]) => key);
      assert.deepEqual(
        nullKeys,
        [],
        `addLayer spec for ${spec.id} carries null paint: ${nullKeys.join(", ")}`,
      );
    }
  });
});
