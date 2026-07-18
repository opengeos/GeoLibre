import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Feature, FeatureCollection } from "geojson";
import {
  VIEW_IMPORT_CHANGE_PROPERTY,
  VIEW_IMPORT_EDITOR_PROPERTY,
  VIEW_IMPORT_ID_PROPERTY,
  VIEW_IMPORT_MODIFIED_PROPERTY,
  buildChangedExport,
  buildFullExport,
  captureViewImportBaseline,
  dedupeViewportFeatures,
  geometryIntersectsBounds,
  listViewVectorLayers,
  queryViewLayerFeatures,
  resolveStoreLayerViewSource,
  tagViewFeaturesForImport,
  type ViewBounds,
  type ViewImportMap,
} from "../packages/plugins/src/plugins/geo-editor-view-import";

const WORLD: ViewBounds = { west: -180, east: 180, south: -90, north: 90 };

function point(lng: number, lat: number, props: Record<string, unknown> = {}): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: props,
  };
}

describe("listViewVectorLayers", () => {
  const style = {
    sources: {
      basemap: { type: "vector" },
      user: { type: "geojson" },
      imagery: { type: "raster" },
    },
    layers: [
      { id: "building", type: "fill", source: "basemap", "source-layer": "building" },
      { id: "roads", type: "line", source: "basemap", "source-layer": "transportation" },
      { id: "labels", type: "symbol", source: "basemap" },
      { id: "user-points", type: "circle", source: "user" },
      { id: "sat", type: "raster", source: "imagery" },
      { id: "gm_main_polygons", type: "fill", source: "gm_main" },
      {
        id: "geo-editor-selection-fill-layer",
        type: "fill",
        source: "geo-editor-selection-source",
      },
      { id: "geolibre-highlight-fill", type: "fill", source: "user" },
      { id: "hillshade", type: "hillshade", source: "basemap" },
      { id: "no-source", type: "fill" },
    ],
  };

  it("includes editable vector/geojson layers, including basemap ones", () => {
    const ids = listViewVectorLayers(style).map((l) => l.id);
    assert.deepEqual(ids, ["building", "roads", "labels", "user-points"]);
  });

  it("carries the source-layer for vector-tile layers", () => {
    const building = listViewVectorLayers(style).find((l) => l.id === "building");
    assert.equal(building?.sourceLayer, "building");
    assert.equal(building?.sourceId, "basemap");
  });

  it("excludes raster/hillshade layers and the editor's own overlay layers", () => {
    const ids = listViewVectorLayers(style).map((l) => l.id);
    assert.ok(!ids.includes("sat"));
    assert.ok(!ids.includes("hillshade"));
    assert.ok(!ids.includes("gm_main_polygons"));
    assert.ok(!ids.includes("geo-editor-selection-fill-layer"));
    assert.ok(!ids.includes("geolibre-highlight-fill"));
    assert.ok(!ids.includes("no-source"));
  });

  it("returns an empty list for an undefined style", () => {
    assert.deepEqual(listViewVectorLayers(undefined), []);
  });
});

describe("resolveStoreLayerViewSource", () => {
  const style = {
    sources: {
      "source-abc": { type: "geojson" },
      "vt-source": { type: "vector" },
      "raster-source": { type: "raster" },
    },
    layers: [
      { id: "layer-abc-fill", type: "fill", source: "source-abc" },
      { id: "layer-abc-line", type: "line", source: "source-abc" },
      { id: "custom-vt", type: "fill", source: "vt-source", "source-layer": "parcels" },
      { id: "img", type: "raster", source: "raster-source" },
    ],
  };

  it("resolves a geojson store layer via the conventional layer id", () => {
    const result = resolveStoreLayerViewSource({ id: "abc" }, style);
    assert.deepEqual(result, {
      id: "abc",
      type: "fill",
      sourceId: "source-abc",
    });
  });

  it("resolves a vector-tile layer via nativeLayerIds, keeping source-layer", () => {
    const result = resolveStoreLayerViewSource(
      { id: "vt", metadata: { nativeLayerIds: ["custom-vt"] } },
      style,
    );
    assert.deepEqual(result, {
      id: "vt",
      type: "fill",
      sourceId: "vt-source",
      sourceLayer: "parcels",
    });
  });

  it("resolves via a matching source id in metadata", () => {
    const result = resolveStoreLayerViewSource(
      { id: "whatever", metadata: { sourceIds: ["vt-source"] } },
      style,
    );
    assert.equal(result?.sourceId, "vt-source");
    assert.equal(result?.sourceLayer, "parcels");
  });

  it("resolves a PMTiles-style layer via the singular sourceId", () => {
    const result = resolveStoreLayerViewSource(
      { id: "pm", metadata: { sourceId: "vt-source" } },
      style,
    );
    assert.equal(result?.sourceId, "vt-source");
    assert.equal(result?.sourceLayer, "parcels");
  });

  it("returns null for a raster-backed layer", () => {
    const rasterStyle = {
      sources: { "raster-source": { type: "raster" } },
      layers: [{ id: "layer-r-fill", type: "raster", source: "raster-source" }],
    };
    assert.equal(resolveStoreLayerViewSource({ id: "r" }, rasterStyle), null);
  });

  it("returns null when the layer is not on the map", () => {
    assert.equal(resolveStoreLayerViewSource({ id: "missing" }, style), null);
  });
});

describe("geometryIntersectsBounds", () => {
  const bounds: ViewBounds = { west: 0, east: 10, south: 0, north: 10 };
  it("returns true when any vertex is inside the bounds", () => {
    assert.equal(geometryIntersectsBounds({ type: "Point", coordinates: [5, 5] }, bounds), true);
    assert.equal(
      geometryIntersectsBounds(
        {
          type: "LineString",
          coordinates: [
            [-5, -5],
            [5, 5],
          ],
        },
        bounds,
      ),
      true,
    );
  });
  it("returns false when the geometry's bbox does not overlap the bounds", () => {
    assert.equal(geometryIntersectsBounds({ type: "Point", coordinates: [20, 20] }, bounds), false);
  });
  it("returns true for a polygon that fully contains the viewport (no vertex inside)", () => {
    assert.equal(
      geometryIntersectsBounds(
        {
          type: "Polygon",
          coordinates: [
            [
              [-90, -90],
              [-90, 90],
              [90, 90],
              [90, -90],
              [-90, -90],
            ],
          ],
        },
        bounds,
      ),
      true,
    );
  });
  it("returns true for a line crossing the viewport with both endpoints outside", () => {
    assert.equal(
      geometryIntersectsBounds(
        {
          type: "LineString",
          coordinates: [
            [-20, 5],
            [30, 5],
          ],
        },
        bounds,
      ),
      true,
    );
  });
  it("handles GeometryCollection", () => {
    assert.equal(
      geometryIntersectsBounds(
        {
          type: "GeometryCollection",
          geometries: [{ type: "Point", coordinates: [5, 5] }],
        },
        bounds,
      ),
      true,
    );
  });
});

/** Bounding box [minX, minY, maxX, maxY] of a polygon/multipolygon geometry. */
function geomBbox(geometry: unknown): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      minX = Math.min(minX, value[0]);
      minY = Math.min(minY, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    for (const item of value) walk(item);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
  return [minX, minY, maxX, maxY];
}

describe("dedupeViewportFeatures", () => {
  it("drops out-of-view features and reassembles tile-clipped pieces of one id", () => {
    // Two clipped pieces of the same feature that together span [0,0]-[2,2];
    // neither piece alone reaches x=2, so keeping one would cut the feature off.
    const westHalf: Feature = {
      type: "Feature",
      id: 1,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 2],
            [1, 2],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      properties: { name: "split" },
    };
    const eastHalf: Feature = {
      type: "Feature",
      id: 1,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 0],
            [1, 2],
            [2, 2],
            [2, 0],
            [1, 0],
          ],
        ],
      },
      properties: { name: "split" },
    };
    const outside = point(200, 5, {});
    const result = dedupeViewportFeatures([westHalf, eastHalf, outside], WORLD);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 1);
    assert.equal(result[0].properties?.name, "split");
    // The merged geometry spans the full [0,0]-[2,2] extent, not a single half.
    const [minX, minY, maxX, maxY] = geomBbox(result[0].geometry);
    assert.deepEqual([minX, minY, maxX, maxY], [0, 0, 2, 2]);
  });

  it("assigns synthetic keys to id-less features so they are not merged", () => {
    const a = point(1, 1);
    const b = point(2, 2);
    const result = dedupeViewportFeatures([a, b], WORLD);
    assert.equal(result.length, 2);
  });

  it("reassembles line fragments of one id into a MultiLineString (no fragment dropped)", () => {
    const west: Feature = {
      type: "Feature",
      id: 7,
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 0],
        ],
      },
      properties: { name: "road" },
    };
    const east: Feature = {
      type: "Feature",
      id: 7,
      geometry: {
        type: "LineString",
        coordinates: [
          [1, 0],
          [2, 0],
        ],
      },
      properties: { name: "road" },
    };
    const result = dedupeViewportFeatures([west, east], WORLD);
    assert.equal(result.length, 1);
    assert.equal(result[0].geometry?.type, "MultiLineString");
    assert.equal((result[0].geometry as { coordinates: number[][][] }).coordinates.length, 2);
  });
});

describe("queryViewLayerFeatures", () => {
  it("queries the source layer and filters to the viewport", () => {
    const calls: Array<{ sourceId: string; options?: { sourceLayer?: string } }> = [];
    const map: ViewImportMap = {
      getStyle: () => ({}),
      querySourceFeatures: (sourceId, options) => {
        calls.push({ sourceId, options });
        return [
          { id: 1, geometry: { type: "Point", coordinates: [1, 1] }, properties: {} },
          { id: 2, geometry: { type: "Point", coordinates: [999, 999] }, properties: {} },
        ];
      },
      getBounds: () => ({
        getWest: () => 0,
        getEast: () => 10,
        getSouth: () => 0,
        getNorth: () => 10,
      }),
    };
    const features = queryViewLayerFeatures(map, {
      id: "building",
      type: "fill",
      sourceId: "basemap",
      sourceLayer: "building",
    });
    assert.equal(calls[0].sourceId, "basemap");
    assert.deepEqual(calls[0].options, { sourceLayer: "building" });
    assert.equal(features.length, 1);
    assert.equal(features[0].id, 1);
  });
});

describe("tagViewFeaturesForImport", () => {
  it("tags each feature with a unique id and marks points as circle markers", () => {
    const { collection, prepared, dropped } = tagViewFeaturesForImport([
      point(1, 1, { name: "a" }),
    ]);
    assert.equal(prepared, 1);
    assert.equal(dropped, 0);
    const feature = collection.features[0];
    assert.equal(feature.id, "view-0");
    assert.equal(feature.properties?.[VIEW_IMPORT_ID_PROPERTY], "view-0");
    assert.equal(feature.properties?.__gm_shape, "circle_marker");
    assert.equal(feature.properties?.name, "a");
  });

  it("drops features whose geometry cannot be represented", () => {
    const bad: Feature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }, // < 3 points
      properties: {},
    };
    const { prepared, dropped } = tagViewFeaturesForImport([bad, point(1, 1)]);
    assert.equal(prepared, 1);
    assert.equal(dropped, 1);
  });

  it("closes open polygon rings", () => {
    const openRing: Feature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
          ],
        ],
      },
      properties: {},
    };
    const { collection } = tagViewFeaturesForImport([openRing]);
    const ring = (collection.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  });

  it("uses the id prefix so appended loads do not collide", () => {
    const { collection } = tagViewFeaturesForImport([point(1, 1)], "view3");
    assert.equal(collection.features[0].id, "view3-0");
  });
});

/** Simulate loading a tagged collection into the editor (identity round-trip). */
function loadedCollection(features: Feature[]): FeatureCollection {
  return tagViewFeaturesForImport(features).collection;
}

describe("buildChangedExport", () => {
  it("classifies added, modified, deleted, and skips unchanged features", () => {
    const original = loadedCollection([
      point(0, 0, { name: "keep" }), // view-0 unchanged
      point(1, 1, { name: "edit-me" }), // view-1 will move
      point(2, 2, { name: "delete-me" }), // view-2 will be removed
    ]);
    const baseline = captureViewImportBaseline(original);

    // Current editor state: view-0 unchanged, view-1 moved, view-2 gone, plus a
    // freshly drawn feature with no view-import id.
    const current: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        original.features[0],
        {
          ...original.features[1],
          geometry: { type: "Point", coordinates: [1.5, 1.5] },
        },
        point(9, 9, { name: "brand-new" }),
      ],
    };

    const { collection, counts } = buildChangedExport(current, baseline, {
      editorName: "Alice",
      now: "2026-07-02T00:00:00.000Z",
    });
    assert.deepEqual(counts, { added: 1, modified: 1, deleted: 1 });

    const byChange = (kind: string) =>
      collection.features.filter((f) => f.properties?.[VIEW_IMPORT_CHANGE_PROPERTY] === kind);
    assert.equal(byChange("modified").length, 1);
    assert.equal(byChange("added").length, 1);
    assert.equal(byChange("deleted").length, 1);

    // The deleted feature keeps its original geometry and attributes.
    const deleted = byChange("deleted")[0];
    assert.deepEqual((deleted.geometry as { coordinates: number[] }).coordinates, [2, 2]);
    assert.equal(deleted.properties?.name, "delete-me");

    // Editor metadata is stamped (namespaced, so it can't clobber user
    // attributes) and internal tags are stripped from the export.
    const modified = byChange("modified")[0];
    assert.equal(modified.properties?.[VIEW_IMPORT_EDITOR_PROPERTY], "Alice");
    assert.equal(modified.properties?.[VIEW_IMPORT_MODIFIED_PROPERTY], "2026-07-02T00:00:00.000Z");
    assert.ok(!(VIEW_IMPORT_ID_PROPERTY in (modified.properties ?? {})));
    assert.ok(!("__gm_shape" in (modified.properties ?? {})));
  });

  it("detects attribute-only changes as modified", () => {
    const original = loadedCollection([point(0, 0, { name: "before" })]);
    const baseline = captureViewImportBaseline(original);
    const current: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          ...original.features[0],
          properties: {
            ...original.features[0].properties,
            name: "after",
          },
        },
      ],
    };
    const { counts } = buildChangedExport(current, baseline, {
      now: "2026-07-02T00:00:00.000Z",
    });
    assert.deepEqual(counts, { added: 0, modified: 1, deleted: 0 });
  });
});

describe("buildFullExport", () => {
  it("returns every feature, stripping internal tags and unsafe ids", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 9007199254740993, // > MAX_SAFE_INTEGER, dropped
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: {
            name: "kept",
            [VIEW_IMPORT_ID_PROPERTY]: "view-0",
            __gm_shape: "circle_marker",
          },
        },
      ],
    };
    const { collection: out, counts } = buildFullExport(collection);
    assert.equal(counts.added, 1);
    const feature = out.features[0];
    assert.equal(feature.id, undefined);
    assert.equal(feature.properties?.name, "kept");
    assert.ok(!(VIEW_IMPORT_ID_PROPERTY in (feature.properties ?? {})));
    assert.ok(!("__gm_shape" in (feature.properties ?? {})));
  });
});
