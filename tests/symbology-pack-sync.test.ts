import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { removeLayerFromMap, syncLayer } from "../packages/map/src/layer-sync";
import {
  createPMTilesStoreLayer,
  pmtilesLayerDrawsLineDecorations,
} from "../packages/map/src/pmtiles-layer";

// Stateful fake MapLibre map, mirroring tests/point-renderer-sync.test.ts: it
// tracks sources and layers across sync passes so a test can assert which
// companion layers/sources the symbology pack produces and removes.
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
    getLayersOrder: () => [...layers.keys()],
    getStyle: () => ({
      layers: [...layers.values()],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, sources, layers, calls };
}

function polygonLayer(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "poly",
    name: "Polygons",
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
          properties: { name: "a" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          },
        },
      ],
    },
  };
}

function lineLayer(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "lines",
    name: "Lines",
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
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [10, 10],
            ],
          },
        },
      ],
    },
  };
}

describe("inverted fill sync", () => {
  it("swaps the fill layer for a mask fill on its own source", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer());
    assert.ok(layers.has("layer-poly-fill"));

    syncLayer(map as never, polygonLayer({ invertedFillEnabled: true }));
    assert.ok(!layers.has("layer-poly-fill"));
    const inverted = layers.get("layer-poly-inverted-fill") as {
      type: string;
      source: string;
      metadata: Record<string, unknown>;
    };
    assert.equal(inverted.type, "fill");
    assert.equal(inverted.source, "source-poly-inverted");
    // Internal chrome: hidden from the layer control.
    assert.equal(inverted.metadata["geolibre:internal"], true);
    const maskData = sources.get("source-poly-inverted")?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    assert.equal(maskData?.features.length, 1);
  });

  it("falls back to the normal filtered fill while a time filter is active", () => {
    const { map, layers } = makeMap();
    const layer = polygonLayer({ invertedFillEnabled: true });
    (layer as { timeFilter?: unknown[] }).timeFilter = [">=", ["get", "t"], 0];
    syncLayer(map as never, layer);
    // The mask derives from raw features and cannot honor the filter, so the
    // normal (filtered) fill renders instead.
    assert.ok(layers.has("layer-poly-fill"));
    assert.ok(!layers.has("layer-poly-inverted-fill"));
  });

  it("restores the normal fill and drops the mask when disabled", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ invertedFillEnabled: true }));
    assert.ok(layers.has("layer-poly-inverted-fill"));

    syncLayer(map as never, polygonLayer());
    assert.ok(layers.has("layer-poly-fill"));
    assert.ok(!layers.has("layer-poly-inverted-fill"));
    assert.ok(!sources.has("source-poly-inverted"));
  });
});

describe("line decoration sync", () => {
  it("adds a line-placed symbol layer with the decoration icon", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, lineLayer({ lineDecoration: "arrow", lineDecorationSpacing: 120 }));
    const decoration = layers.get("layer-lines-line-decoration") as {
      type: string;
      layout: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    assert.equal(decoration.type, "symbol");
    assert.equal(decoration.layout["symbol-placement"], "line");
    assert.equal(decoration.layout["symbol-spacing"], 120);
    assert.match(String(decoration.layout["icon-image"]), /^geolibre-line-decoration-arrow-/);
    assert.equal(decoration.metadata["geolibre:internal"], true);
  });

  it("removes the decoration layer when switched off", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, lineLayer({ lineDecoration: "circle" }));
    assert.ok(layers.has("layer-lines-line-decoration"));

    syncLayer(map as never, lineLayer());
    assert.ok(!layers.has("layer-lines-line-decoration"));
  });
});

// A vector PMTiles archive with two source layers, built the way Add Data →
// PMTiles builds it.
function pmtilesLayer(
  style: Partial<LayerStyle> = {},
  overrides: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  const layer = createPMTilesStoreLayer({
    id: "flow",
    name: "Flow paths",
    url: "https://example.org/flow.pmtiles",
    tileType: "vector",
    sourceLayers: ["streams", "basin boundary"],
  });
  return { ...layer, ...overrides, style: { ...layer.style, ...style } };
}

const STREAMS_DECORATION = "layer-flow-line-decoration-streams";
const BOUNDARY_DECORATION = "layer-flow-line-decoration-basin%20boundary";

describe("PMTiles line decoration sync", () => {
  it("adds a line-placed arrow layer per source layer on the archive's source", () => {
    const { map, layers, calls } = makeMap();
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow", lineDecorationSpacing: 90 }));

    for (const [id, sourceLayer] of [
      [STREAMS_DECORATION, "streams"],
      [BOUNDARY_DECORATION, "basin boundary"],
    ]) {
      const decoration = layers.get(id) as {
        type: string;
        source: string;
        "source-layer": string;
        layout: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      assert.ok(decoration, `missing ${id}`);
      assert.equal(decoration.type, "symbol");
      assert.equal(decoration.source, "flow");
      assert.equal(decoration["source-layer"], sourceLayer);
      assert.equal(decoration.layout["symbol-placement"], "line");
      assert.equal(decoration.layout["symbol-spacing"], 90);
      assert.match(String(decoration.layout["icon-image"]), /^geolibre-line-decoration-arrow-/);
      assert.equal(decoration.metadata["geolibre:internal"], true);
    }

    // Added after the archive's own line layers, so the arrows draw on top.
    const added = calls
      .filter((call) => call.method === "addLayer")
      .map((call) => (call.args[0] as { id: string }).id);
    assert.ok(added.indexOf(STREAMS_DECORATION) > added.indexOf("flow-streams-line"));
  });

  it("removes decorations for source-layer names omitted by a same-id update", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow" }));
    assert.ok(layers.has(BOUNDARY_DECORATION));
    const narrowed = createPMTilesStoreLayer({
      id: "flow",
      name: "Flow paths",
      url: "https://example.org/flow.pmtiles",
      tileType: "vector",
      sourceLayers: ["streams"],
    });
    const styled = { ...narrowed, style: { ...narrowed.style, lineDecoration: "arrow" as const } };
    syncLayer(map as never, styled);
    assert.ok(layers.has(STREAMS_DECORATION));
    assert.ok(!layers.has(BOUNDARY_DECORATION));
    syncLayer(map as never, narrowed);
    assert.ok(!layers.has(STREAMS_DECORATION));
  });

  it("deleting with narrowed metadata also removes previously rendered decorations", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow" }));
    const narrowed = createPMTilesStoreLayer({
      id: "flow",
      name: "Flow paths",
      url: "https://example.org/flow.pmtiles",
      tileType: "vector",
      sourceLayers: ["streams"],
    });
    removeLayerFromMap(map as never, narrowed.id, narrowed);
    assert.ok(!layers.has(STREAMS_DECORATION));
    assert.ok(!layers.has(BOUNDARY_DECORATION));
  });

  it("removes recorded decorations when the caller no longer has a layer snapshot", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow" }));
    removeLayerFromMap(map as never, "flow");
    assert.ok(!layers.has(STREAMS_DECORATION));
    assert.ok(!layers.has(BOUNDARY_DECORATION));
  });

  it("hides the decorations with the layer and follows its opacity", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      pmtilesLayer({ lineDecoration: "arrow" }, { visible: false, opacity: 0.4 }),
    );
    const decoration = layers.get(STREAMS_DECORATION) as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.equal(decoration.layout.visibility, "none");
    assert.equal(decoration.paint["icon-opacity"], 0.4);
  });

  it("removes the decorations when switched off or extruded", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow" }));
    assert.ok(layers.has(STREAMS_DECORATION));

    syncLayer(map as never, pmtilesLayer());
    assert.ok(!layers.has(STREAMS_DECORATION));
    assert.ok(!layers.has(BOUNDARY_DECORATION));

    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow" }));
    syncLayer(map as never, pmtilesLayer({ lineDecoration: "arrow", extrusionEnabled: true }));
    assert.ok(!layers.has(STREAMS_DECORATION));
  });

  it("draws nothing for a raster archive", () => {
    const { map, layers } = makeMap();
    const raster = createPMTilesStoreLayer({
      id: "flow",
      name: "Hillshade",
      url: "https://example.org/hillshade.pmtiles",
      tileType: "raster",
      sourceLayers: [],
    });
    syncLayer(map as never, { ...raster, style: { ...raster.style, lineDecoration: "arrow" } });
    assert.ok(![...layers.keys()].some((id) => id.includes("line-decoration")));
  });

  it("keeps two source layers whose encoded names would collide apart", () => {
    const { map, layers } = makeMap();
    const layer = createPMTilesStoreLayer({
      id: "flow",
      name: "Flow paths",
      url: "https://example.org/flow.pmtiles",
      tileType: "vector",
      sourceLayers: ["a b", "a_20b"],
    });
    syncLayer(map as never, { ...layer, style: { ...layer.style, lineDecoration: "arrow" } });
    const sourceLayers = [...layers.values()]
      .filter((spec) => String(spec.id).includes("line-decoration"))
      .map((spec) => spec["source-layer"]);
    assert.deepEqual(sourceLayers.sort(), ["a b", "a_20b"]);
  });

  it("limits the shared decoration predicate to styled vector archives", () => {
    const raster = createPMTilesStoreLayer({
      id: "hillshade",
      name: "Hillshade",
      url: "https://example.org/hillshade.pmtiles",
      tileType: "raster",
      sourceLayers: [],
    });
    const notFromControl = pmtilesLayer({}, { metadata: { ...pmtilesLayer().metadata } });
    delete notFromControl.metadata.externalNativeLayer;
    // The panel hides the section for extruded layers on its own, so the shared predicate is
    // compared against a flat render of each PMTiles layer. (GeoJSON layers have their own gate.)
    for (const layer of [pmtilesLayer(), raster, notFromControl]) {
      const { map, layers } = makeMap();
      syncLayer(map as never, {
        ...layer,
        style: { ...layer.style, lineDecoration: "arrow", extrusionEnabled: false },
      });
      const drawn = [...layers.keys()].some((id) =>
        id.startsWith(`layer-${layer.id}-line-decoration`),
      );
      const offered = pmtilesLayerDrawsLineDecorations(layer);
      assert.equal(offered, drawn, `panel and sync disagree for ${layer.name}`);
    }
  });

  it("removes the decorations with the layer", () => {
    const { map, layers } = makeMap();
    const layer = pmtilesLayer({ lineDecoration: "arrow" });
    syncLayer(map as never, layer);
    removeLayerFromMap(map as never, layer.id, layer);
    assert.ok(![...layers.keys()].some((id) => id.includes("line-decoration")));
  });
});

describe("geometry generator sync", () => {
  it("renders centroids through a companion source and circle layer", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));

    const derived = sources.get("source-poly-generator")?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    assert.equal(derived?.features.length, 1);
    assert.equal(derived?.features[0].geometry.type, "Point");
    const circle = layers.get("layer-poly-generator-circle") as {
      type: string;
      metadata: Record<string, unknown>;
    };
    assert.equal(circle.type, "circle");
    assert.equal(circle.metadata["geolibre:internal"], true);
    assert.ok(!layers.has("layer-poly-generator-fill"));
  });

  it("renders buffers as fill + line companion layers", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      polygonLayer({
        geometryGenerator: "buffer",
        geometryGeneratorBufferDistance: 5000,
      }),
    );
    assert.equal((layers.get("layer-poly-generator-fill") as { type: string }).type, "fill");
    assert.equal((layers.get("layer-poly-generator-line") as { type: string }).type, "line");
    assert.ok(!layers.has("layer-poly-generator-circle"));
  });

  it("sizes generated centroids by the chosen attribute", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      polygonLayer({
        geometryGenerator: "centroid",
        geometryGeneratorCircleRadius: 5,
        geometryGeneratorSizeProperty: "count",
        geometryGeneratorSizeMinValue: 0,
        geometryGeneratorSizeMaxValue: 50,
        geometryGeneratorSizeMinRadius: 3,
        geometryGeneratorSizeMaxRadius: 30,
      }),
    );
    const circle = layers.get("layer-poly-generator-circle") as {
      paint: Record<string, unknown>;
    };
    assert.deepEqual(circle.paint["circle-radius"], [
      "interpolate",
      ["linear"],
      ["to-number", ["get", "count"], 0],
      0,
      3,
      50,
      30,
    ]);
  });

  it("threads the buffer distance field through to the derived geometry", () => {
    const { map, sources } = makeMap();
    // Two squares side by side, buffered by their own `radius` values, so the
    // derived extents prove the field reached buildGeneratedGeometry rather
    // than every feature taking the flat distance.
    const layer = polygonLayer({
      geometryGenerator: "buffer",
      geometryGeneratorBufferDistance: 1000,
      geometryGeneratorBufferProperty: "radius",
    });
    const square = layer.geojson!.features[0];
    layer.geojson = {
      type: "FeatureCollection",
      features: [
        { ...square, properties: { radius: 1000 } },
        { ...square, properties: { radius: 50_000 } },
      ],
    };
    syncLayer(map as never, layer);

    const derived = sources.get("source-poly-generator")?.data as GeoJSON.FeatureCollection;
    assert.equal(derived.features.length, 2);
    const widths = derived.features.map((feature) => {
      const xs = (feature.geometry as GeoJSON.Polygon).coordinates[0].map(([x]) => x);
      return Math.max(...xs) - Math.min(...xs);
    });
    assert.ok(widths[1] > widths[0]);
  });

  it("suppresses generator layers while a time filter is active", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    const filtered = polygonLayer({ geometryGenerator: "centroid" });
    (filtered as { timeFilter?: unknown[] }).timeFilter = [">=", ["get", "t"], 0];
    syncLayer(map as never, filtered);
    // Derived features cannot honor the filter, so they are suppressed
    // rather than rendering hidden features.
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!sources.has("source-poly-generator"));
  });

  it("suppresses generator layers while the layer renders as an extrusion", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    // Turning on extrusion must tear the flat companion symbology down even
    // though geometryGenerator is still set (the Style Panel hides the
    // controls without resetting the value).
    syncLayer(
      map as never,
      polygonLayer({ geometryGenerator: "centroid", extrusionEnabled: true }),
    );
    assert.ok(layers.has("layer-poly-extrusion"));
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!sources.has("source-poly-generator"));
  });

  it("tears companion layers and source down when set back to none", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    syncLayer(map as never, polygonLayer());
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!layers.has("layer-poly-generator-fill"));
    assert.ok(!layers.has("layer-poly-generator-line"));
    assert.ok(!sources.has("source-poly-generator"));
  });
});
