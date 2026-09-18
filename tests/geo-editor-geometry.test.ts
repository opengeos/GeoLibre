import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  GEOMAN_SHAPE_PROPERTIES,
  GEOMETRY_EDIT_FID_PROPERTY,
  type OverlayOrderLayer,
  applySyncedEditorTracking,
  canEditLayerGeometry,
  canonicalGeometryKey,
  captureEditedGeometries,
  captureEditedProperties,
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

describe("reconcileEditedFeatures — attribute preservation", () => {
  // Geoman claims `id`, `height`, `text`, `width`, `angle`, … as its own "shape
  // properties": it strips the plain key and re-emits the value as `__gm_<name>`.
  // A buildings layer with a `height` column came back from a pure geometry edit
  // with its columns renamed to `__gm_height`/`__gm_id` (opengeos/GeoLibre, Las
  // Vegas Buildings demo dataset), which also made every feature look edited to
  // any change tracker.
  const original: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { id: "abc", height: 2.6, name: "keep me" },
      },
    ],
  };

  /** What Geoman hands back: reserved names namespaced, the rest untouched. */
  function asGeomanReturned(collection: FeatureCollection): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: collection.features.map((feature) => {
        const props = { ...(feature.properties ?? {}) };
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props)) {
          if (GEOMAN_SHAPE_PROPERTIES.has(key)) out[`__gm_${key}`] = value;
          else out[key] = value;
        }
        out.__gm_shape = "polygon";
        return { ...feature, properties: out };
      }),
    };
  }

  it("restores columns Geoman renamed, and drops its internal keys", () => {
    const tagged = tagFeatureKeys(original);
    const snapshot = captureEditedProperties(tagged);
    const reconciled = reconcileEditedFeatures(asGeomanReturned(tagged), snapshot);
    assert.deepEqual(reconciled.features[0].properties, {
      id: "abc",
      height: 2.6,
      name: "keep me",
    });
  });

  it("leaves the layer unchanged when nothing was edited", () => {
    const tagged = tagFeatureKeys(original);
    const reconciled = reconcileEditedFeatures(
      asGeomanReturned(tagged),
      captureEditedProperties(tagged),
    );
    assert.deepEqual(reconciled.features[0].properties, original.features[0].properties);
    assert.equal(String(reconciled.features[0].id), String(original.features[0].id));
  });

  it("strips Geoman bookkeeping from a feature drawn during the session", () => {
    const drawn: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: { __gm_shape: "circle_marker", __gm_id: 7, note: "new" },
        },
      ],
    };
    const reconciled = reconcileEditedFeatures(drawn, new Map());
    assert.deepEqual(reconciled.features[0].properties, { note: "new" });
  });

  it("keeps working without a snapshot (older callers)", () => {
    const reconciled = reconcileEditedFeatures(tagFeatureKeys(original));
    assert.equal(reconciled.features[0].properties?.name, "keep me");
  });
});

describe("captureEditedProperties — null properties", () => {
  // Tagging has to put the feature key somewhere, so it turns `properties: null`
  // into an object. Snapshotting the tagged collection would therefore restore
  // `{}` on save and silently rewrite valid GeoJSON; the pre-tag collection is
  // the source of truth.
  const original: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: null,
      },
      {
        type: "Feature",
        id: 2,
        geometry: { type: "Point", coordinates: [1, 1] },
        properties: { height: 4 },
      },
    ],
  };

  it("keeps null properties null through tag → edit → reconcile", () => {
    const tagged = tagFeatureKeys(original);
    const snapshot = captureEditedProperties(tagged, original);
    // What Geoman hands back: the reserved `height` renamed, its own key added.
    const returned: FeatureCollection = {
      type: "FeatureCollection",
      features: tagged.features.map((feature) => ({
        ...feature,
        properties: {
          [GEOMETRY_EDIT_FID_PROPERTY]: feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY],
          __gm_shape: "circle_marker",
          ...(feature.properties?.height === undefined
            ? {}
            : { __gm_height: feature.properties.height }),
        },
      })),
    };
    const reconciled = reconcileEditedFeatures(returned, snapshot);
    assert.equal(reconciled.features[0].properties, null);
    assert.deepEqual(reconciled.features[1].properties, { height: 4 });
  });

  it("falls back to the tagged collection when no source is given", () => {
    const tagged = tagFeatureKeys(original);
    const snapshot = captureEditedProperties(tagged);
    // Without the pre-tag source the best available answer is the tagged one.
    assert.deepEqual(snapshot.get(String(tagged.features[0].id)), {});
  });
});

describe("reconcileEditedFeatures — editor tracking", () => {
  const config = { enabled: true };
  const original: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { name: "untouched" },
      },
      {
        type: "Feature",
        id: 2,
        geometry: { type: "Point", coordinates: [10, 10] },
        properties: { name: "moved" },
      },
    ],
  };

  /** Tag, snapshot, and hand back what the editor would return after `edit`. */
  function session(edit: (tagged: FeatureCollection) => FeatureCollection) {
    const tagged = tagFeatureKeys(original);
    return reconcileEditedFeatures(edit(structuredClone(tagged)), captureEditedProperties(tagged), {
      config,
      userIdentity: "ada",
      timestamp: "2026-08-15T00:00:00.000Z",
      originalGeometries: captureEditedGeometries(tagged),
    });
  }

  it("stamps only the feature whose geometry changed", () => {
    const reconciled = session((tagged) => {
      tagged.features[1].geometry = { type: "Point", coordinates: [11, 11] };
      return tagged;
    });

    // Untouched: no tracking columns at all, so a session that only looked at
    // the layer does not rewrite its edit history.
    assert.deepEqual(reconciled.features[0].properties, { name: "untouched" });
    assert.deepEqual(reconciled.features[1].properties, {
      name: "moved",
      edited_by: "ada",
      edited_at: "2026-08-15T00:00:00.000Z",
    });
  });

  it("treats a feature drawn during the session as a creation", () => {
    const reconciled = session((tagged) => {
      tagged.features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [5, 5] },
        properties: { name: "drawn" },
      });
      return tagged;
    });

    assert.deepEqual(reconciled.features[2].properties, {
      name: "drawn",
      created_by: "ada",
      created_at: "2026-08-15T00:00:00.000Z",
      edited_by: "ada",
      edited_at: "2026-08-15T00:00:00.000Z",
    });
  });

  it("ignores a sub-millimetre coordinate difference from the round-trip", () => {
    const reconciled = session((tagged) => {
      // Geoman re-serializes every feature it loaded; a last-bit float
      // difference is not an edit (see GEOMETRY_COMPARE_PRECISION).
      tagged.features[0].geometry = { type: "Point", coordinates: [1e-12, 0] };
      return tagged;
    });
    assert.deepEqual(reconciled.features[0].properties, { name: "untouched" });
  });

  it("honors renamed tracking columns", () => {
    const tagged = tagFeatureKeys(original);
    const moved = structuredClone(tagged);
    moved.features[0].geometry = { type: "Point", coordinates: [3, 3] };
    const reconciled = reconcileEditedFeatures(moved, captureEditedProperties(tagged), {
      config: { enabled: true, editedByField: "author", editedAtField: "touched" },
      userIdentity: "ada",
      timestamp: "2026-08-15T00:00:00.000Z",
      originalGeometries: captureEditedGeometries(tagged),
    });
    assert.deepEqual(reconciled.features[0].properties, {
      name: "untouched",
      author: "ada",
      touched: "2026-08-15T00:00:00.000Z",
    });
  });

  it("stamps nothing when the layer does not track edits", () => {
    const tagged = tagFeatureKeys(original);
    const moved = structuredClone(tagged);
    moved.features[0].geometry = { type: "Point", coordinates: [3, 3] };
    const reconciled = reconcileEditedFeatures(moved, captureEditedProperties(tagged), {
      config: { enabled: false },
      originalGeometries: captureEditedGeometries(tagged),
    });
    assert.deepEqual(reconciled.features[0].properties, { name: "untouched" });
  });
});

describe("applySyncedEditorTracking", () => {
  const config = { enabled: true };
  const keyOf = (feature: { id?: string | number }, index: number) => String(feature.id ?? index);
  const stamp = { config, userIdentity: "ada", timestamp: "2026-08-15T00:00:00.000Z" };

  function collection(...features: FeatureCollection["features"]): FeatureCollection {
    return { type: "FeatureCollection", features };
  }

  it("stamps a feature the editor has that the store does not", () => {
    const next = collection(point("a", { note: "new" }));
    const result = applySyncedEditorTracking(next, collection(), keyOf, stamp);
    assert.deepEqual(result.features[0].properties, {
      note: "new",
      created_by: "ada",
      created_at: "2026-08-15T00:00:00.000Z",
      edited_by: "ada",
      edited_at: "2026-08-15T00:00:00.000Z",
    });
  });

  it("carries the store's columns back onto the editor's copy", () => {
    // The editor never sees the tracking columns, so an unchanged feature would
    // otherwise lose them on the next sync and be re-created from scratch.
    const previous = collection(
      point("a", {
        note: "kept",
        created_by: "ada",
        created_at: "2026-08-01T00:00:00.000Z",
        edited_by: "ada",
        edited_at: "2026-08-01T00:00:00.000Z",
      }),
    );
    const result = applySyncedEditorTracking(
      collection(point("a", { note: "kept" })),
      previous,
      keyOf,
      stamp,
    );
    assert.deepEqual(result.features[0].properties, previous.features[0].properties);
  });

  it("keeps the creation columns but refreshes the edit ones when the geometry moves", () => {
    const previous = collection(
      point("a", {
        note: "kept",
        created_by: "bob",
        created_at: "2026-08-01T00:00:00.000Z",
        edited_by: "bob",
        edited_at: "2026-08-01T00:00:00.000Z",
      }),
    );
    const moved = collection(point("a", { note: "kept" }));
    moved.features[0].geometry = { type: "Point", coordinates: [4, 4] };
    const result = applySyncedEditorTracking(moved, previous, keyOf, stamp);
    assert.deepEqual(result.features[0].properties, {
      note: "kept",
      created_by: "bob",
      created_at: "2026-08-01T00:00:00.000Z",
      edited_by: "ada",
      edited_at: "2026-08-15T00:00:00.000Z",
    });
  });

  it("returns the collection untouched when tracking is off", () => {
    const next = collection(point("a", { note: "new" }));
    assert.equal(
      applySyncedEditorTracking(next, collection(), keyOf, { config: { enabled: false } }),
      next,
    );
  });
});

describe("canonicalGeometryKey", () => {
  it("matches geometries that differ below the comparison precision", () => {
    assert.equal(
      canonicalGeometryKey({ type: "Point", coordinates: [1.0000000001, 2] }),
      canonicalGeometryKey({ type: "Point", coordinates: [1, 2] }),
    );
  });

  it("separates geometries that actually differ", () => {
    assert.notEqual(
      canonicalGeometryKey({ type: "Point", coordinates: [1.001, 2] }),
      canonicalGeometryKey({ type: "Point", coordinates: [1, 2] }),
    );
  });

  it("distinguishes a null geometry from a real one", () => {
    assert.equal(canonicalGeometryKey(null), "null");
    assert.notEqual(canonicalGeometryKey({ type: "Point", coordinates: [0, 0] }), "null");
  });

  it("walks a geometry collection's members", () => {
    const key = (lng: number) =>
      canonicalGeometryKey({
        type: "GeometryCollection",
        geometries: [{ type: "Point", coordinates: [lng, 0] }],
      });
    assert.equal(key(1), key(1));
    assert.notEqual(key(1), key(2));
  });
});

describe("editor tracking — copied and id-less features", () => {
  const config = { enabled: true };
  const stamp = { config, userIdentity: "ada", timestamp: "2026-08-16T00:00:00.000Z" };

  it("records a duplicated feature as newly created, not as its source", () => {
    // Geoman's `copy` edit mode clones properties, and the session loaded the
    // layer's features with their tracking columns — so the copy arrives
    // carrying the original's creation stamp for a feature that did not exist
    // then. It has no tag, so it is new to the session and gets its own.
    const original: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1,
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            name: "source",
            created_by: "bob",
            created_at: "2020-01-01T00:00:00.000Z",
            edited_by: "bob",
            edited_at: "2020-01-01T00:00:00.000Z",
          },
        },
      ],
    };
    const tagged = tagFeatureKeys(original);
    const withCopy = structuredClone(tagged);
    const copy = structuredClone(tagged.features[0]);
    delete (copy.properties as Record<string, unknown>)[GEOMETRY_EDIT_FID_PROPERTY];
    delete copy.id;
    withCopy.features.push(copy);

    const reconciled = reconcileEditedFeatures(withCopy, captureEditedProperties(tagged), {
      ...stamp,
      originalGeometries: captureEditedGeometries(tagged),
    });

    // The source is untouched: it was loaded and not moved.
    assert.equal(reconciled.features[0].properties?.created_by, "bob");
    assert.equal(reconciled.features[0].properties?.created_at, "2020-01-01T00:00:00.000Z");
    assert.deepEqual(reconciled.features[1].properties, {
      name: "source",
      created_by: "ada",
      created_at: "2026-08-16T00:00:00.000Z",
      edited_by: "ada",
      edited_at: "2026-08-16T00:00:00.000Z",
    });
  });

  it("keeps matching an id-less feature after it has been stamped once", () => {
    // The tracking columns only ever exist on the store side, so a key that read
    // them would give one feature two identities once stamped and every sync
    // would reset its creation stamp. `sketchFeatureKey`, replicated here,
    // hashes the geometry rather than the whole feature for exactly this reason.
    const keyOf = (feature: Feature, index: number) =>
      String(
        feature.id ?? feature.properties?.__gm_id ?? `${JSON.stringify(feature.geometry)}@${index}`,
      );
    const editorCopy: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { note: "sketch" },
        },
      ],
    };
    const stored: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {
            note: "sketch",
            created_by: "ada",
            created_at: "2026-08-01T00:00:00.000Z",
            edited_by: "ada",
            edited_at: "2026-08-01T00:00:00.000Z",
          },
        },
      ],
    };

    const result = applySyncedEditorTracking(editorCopy, stored, keyOf, stamp);
    assert.equal(result.features[0].properties?.created_at, "2026-08-01T00:00:00.000Z");
  });
});
