import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  GEOMETRY_EDIT_FID_PROPERTY,
  type OverlayOrderLayer,
  canEditLayerGeometry,
  planGeoEditorOverlayOrder,
  reconcileEditedFeatures,
  tagFeatureKeys,
} from "../packages/plugins/src/plugins/geo-editor-geometry";

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Layer 1",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...overrides,
  } as unknown as GeoLibreLayer;
}

function point(id: string | number | undefined, properties: Record<string, unknown> = {}) {
  return {
    type: "Feature" as const,
    id,
    geometry: { type: "Point" as const, coordinates: [0, 0] },
    properties,
  };
}

describe("canEditLayerGeometry", () => {
  it("allows an in-memory geojson vector layer", () => {
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          geojson: { type: "FeatureCollection", features: [point(0)] },
        }),
      ),
      true,
    );
  });

  it("allows an empty-but-present feature collection", () => {
    assert.equal(canEditLayerGeometry(makeLayer({})), true);
  });

  it("rejects an undefined layer", () => {
    assert.equal(canEditLayerGeometry(undefined), false);
  });

  it("rejects non-vector layer types", () => {
    assert.equal(canEditLayerGeometry(makeLayer({ type: "raster", geojson: undefined })), false);
  });

  it("rejects a layer without an in-memory feature collection", () => {
    assert.equal(canEditLayerGeometry(makeLayer({ geojson: undefined })), false);
  });

  it("rejects DuckDB query layers", () => {
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          type: "duckdb-query",
          metadata: {
            sourceKind: "duckdb-query",
            externalDeckLayer: true,
          },
        }),
      ),
      false,
    );
  });

  it("rejects the GeoEditor Sketches layer", () => {
    assert.equal(
      canEditLayerGeometry(makeLayer({ metadata: { sourceKind: "geoeditor-sketches" } })),
      false,
    );
  });

  it("rejects live SQL query layers", () => {
    // A query result is derived: refresh re-runs the stored SQL and would
    // overwrite in-place edits, so editing is disabled.
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          metadata: {
            sourceKind: "sql-query",
            sqlQuery: { engine: "duckdb", sql: "SELECT 1 AS geom" },
          },
        }),
      ),
      false,
    );
  });

  it("rejects generic external native layers", () => {
    // externalNativeLayer that is not an Add-Vector-Layer source is not editable.
    assert.equal(
      canEditLayerGeometry(makeLayer({ metadata: { externalNativeLayer: true } })),
      false,
    );
    // maplibre-gl-vector but missing sourceIds: no readable source to edit.
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          geojson: undefined,
          metadata: {
            sourceKind: "maplibre-gl-vector",
            externalNativeLayer: true,
          },
        }),
      ),
      false,
    );
    // maplibre-gl-vector with an empty sourceIds array: still no usable source.
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          geojson: undefined,
          metadata: {
            sourceKind: "maplibre-gl-vector",
            externalNativeLayer: true,
            sourceIds: [],
          },
        }),
      ),
      false,
    );
  });

  it("allows Add-Vector-Layer geojson-mode layers (features in a source)", () => {
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          geojson: undefined,
          metadata: {
            sourceKind: "maplibre-gl-vector",
            externalNativeLayer: true,
            sourceIds: ["src-1"],
          },
        }),
      ),
      true,
    );
  });
});

describe("tagFeatureKeys", () => {
  it("tags each feature with a unique id mirrored into feature.id", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [point("a"), point(undefined)],
    };
    const tagged = tagFeatureKeys(collection);
    assert.equal(tagged.features[0].properties?.[GEOMETRY_EDIT_FID_PROPERTY], "a");
    assert.equal(tagged.features[0].id, "a");
    // The untagged feature gets a freshly allocated, non-colliding id.
    const secondId = String(tagged.features[1].id);
    assert.equal(tagged.features[1].properties?.[GEOMETRY_EDIT_FID_PROPERTY], secondId);
    assert.notEqual(secondId, "a");
    // Original collection is not mutated.
    assert.equal(collection.features[0].properties?.[GEOMETRY_EDIT_FID_PROPERTY], undefined);
  });

  it("assigns unique ids when the input has duplicate ids", () => {
    const tagged = tagFeatureKeys({
      type: "FeatureCollection",
      features: [point("dup"), point("dup"), point("dup")],
    });
    const ids = tagged.features.map((f) => String(f.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], "dup");
  });
});

describe("reconcileEditedFeatures", () => {
  it("restores tagged ids and strips the tag", () => {
    const tagged = tagFeatureKeys({
      type: "FeatureCollection",
      features: [point("a", { name: "A" }), point("b", { name: "B" })],
    });
    const reconciled = reconcileEditedFeatures(tagged);
    assert.deepEqual(
      reconciled.features.map((f) => f.id),
      ["a", "b"],
    );
    for (const feature of reconciled.features) {
      assert.equal(feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY], undefined);
    }
    assert.equal(reconciled.features[0].properties?.name, "A");
  });

  it("assigns fresh non-colliding ids to new (untagged) features", () => {
    // Tagged feature keeps id "0"; the untagged new feature must not reuse "0".
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { ...point(undefined), properties: { [GEOMETRY_EDIT_FID_PROPERTY]: "0" } },
        point(undefined, { drawn: true }),
      ],
    };
    const reconciled = reconcileEditedFeatures(collection);
    const ids = reconciled.features.map((f) => String(f.id));
    assert.equal(ids[0], "0");
    assert.notEqual(ids[1], "0");
    assert.equal(new Set(ids).size, ids.length);
  });

  it("round-trips original ids through tag then reconcile", () => {
    const original: FeatureCollection = {
      type: "FeatureCollection",
      features: [point(5), point(12), point(undefined)],
    };
    const reconciled = reconcileEditedFeatures(tagFeatureKeys(original));
    assert.deepEqual(
      reconciled.features.map((f) => String(f.id)),
      ["5", "12", "0"],
    );
  });

  it("avoids id collision when an index-based fallback could match an explicit id", () => {
    // Feature at index 2 has id undefined; another feature carries explicit id 2.
    // The unique-id allocator must not assign "2" to both.
    const original: FeatureCollection = {
      type: "FeatureCollection",
      features: [point(2), point(5), point(undefined)],
    };
    const reconciled = reconcileEditedFeatures(tagFeatureKeys(original));
    const ids = reconciled.features.map((f) => String(f.id));
    assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids}`);
    assert.equal(ids[0], "2"); // the explicit id 2 must survive
  });

  it("de-duplicates ids when a tag was cloned (e.g. a copied feature)", () => {
    // Two features share the same tag, as a Geoman copy that cloned properties
    // would produce. Reconcile must give them distinct ids so Geoman does not
    // overwrite one with the other on the next load.
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { ...point(undefined), properties: { [GEOMETRY_EDIT_FID_PROPERTY]: "7" } },
        { ...point(undefined), properties: { [GEOMETRY_EDIT_FID_PROPERTY]: "7" } },
      ],
    };
    const reconciled = reconcileEditedFeatures(collection);
    const ids = reconciled.features.map((f) => String(f.id));
    assert.equal(ids[0], "7");
    assert.notEqual(ids[1], "7");
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("planGeoEditorOverlayOrder", () => {
  function row(id: string, flags: Partial<OverlayOrderLayer> = {}): OverlayOrderLayer {
    return { id, isOverlay: false, isAnchor: false, ...flags };
  }

  it("raises overlay above a layer stacked over the edited layer (issue #1015)", () => {
    // Bottom-to-top: the overlay has sunk below the raster, which is stacked
    // above the (hidden) edited layer; it must move back up to the edited slot.
    const plan = planGeoEditorOverlayOrder([
      row("basemap"),
      row("gm_main-fill", { isOverlay: true }),
      row("geo-editor-selection-fill", { isOverlay: true }),
      row("xyz-raster"),
      row("edited-fill", { isAnchor: true }),
      row("edited-line", { isAnchor: true }),
    ]);
    assert.deepEqual(plan, {
      overlayIds: ["gm_main-fill", "geo-editor-selection-fill"],
      // The edited layer is the topmost data layer here, so nothing real sits
      // above it: the overlay goes to the very top.
      beforeId: undefined,
    });
  });

  it("anchors the overlay just below the first layer above the edited layer", () => {
    // The overlay has sunk to the bottom; the edited layer is genuinely below a
    // raster, so the overlay must return to the edited layer's slot (below the
    // raster), not jump to the very top.
    const plan = planGeoEditorOverlayOrder([
      row("basemap"),
      row("gm_main-fill", { isOverlay: true }),
      row("edited-fill", { isAnchor: true }),
      row("raster-on-top"),
    ]);
    assert.deepEqual(plan, {
      overlayIds: ["gm_main-fill"],
      beforeId: "raster-on-top",
    });
  });

  it("returns null when the overlay already sits directly above the anchor", () => {
    const plan = planGeoEditorOverlayOrder([
      row("basemap"),
      row("edited-fill", { isAnchor: true }),
      row("edited-line", { isAnchor: true }),
      row("gm_main-fill", { isOverlay: true }),
      row("geo-editor-selection-fill", { isOverlay: true }),
      row("raster-on-top"),
    ]);
    assert.equal(plan, null);
  });

  it("returns null when the edited layer is not on the map (no anchor)", () => {
    const plan = planGeoEditorOverlayOrder([
      row("basemap"),
      row("gm_main-fill", { isOverlay: true }),
    ]);
    assert.equal(plan, null);
  });

  it("returns null when there are no overlay layers", () => {
    const plan = planGeoEditorOverlayOrder([
      row("basemap"),
      row("edited-fill", { isAnchor: true }),
    ]);
    assert.equal(plan, null);
  });
});
