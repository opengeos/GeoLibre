import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  GEOMETRY_EDIT_FID_PROPERTY,
  canEditLayerGeometry,
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

function point(
  id: string | number | undefined,
  properties: Record<string, unknown> = {},
) {
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
    assert.equal(
      canEditLayerGeometry(makeLayer({ type: "raster", geojson: undefined })),
      false,
    );
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
      canEditLayerGeometry(
        makeLayer({ metadata: { sourceKind: "geoeditor-sketches" } }),
      ),
      false,
    );
  });

  it("rejects Add-Vector-Layer control layers", () => {
    // sourceKind alone is enough to reject.
    assert.equal(
      canEditLayerGeometry(
        makeLayer({ metadata: { sourceKind: "maplibre-gl-vector" } }),
      ),
      false,
    );
    // externalNativeLayer alone is also enough.
    assert.equal(
      canEditLayerGeometry(makeLayer({ metadata: { externalNativeLayer: true } })),
      false,
    );
    // Both together (the original combined case).
    assert.equal(
      canEditLayerGeometry(
        makeLayer({
          metadata: {
            sourceKind: "maplibre-gl-vector",
            externalNativeLayer: true,
          },
        }),
      ),
      false,
    );
  });
});

describe("tagFeatureKeys", () => {
  it("tags each feature with its stable id, falling back to the index", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [point("a"), point(undefined)],
    };
    const tagged = tagFeatureKeys(collection);
    assert.equal(
      tagged.features[0].properties?.[GEOMETRY_EDIT_FID_PROPERTY],
      "a",
    );
    assert.equal(
      tagged.features[1].properties?.[GEOMETRY_EDIT_FID_PROPERTY],
      "1",
    );
    // Original collection is not mutated.
    assert.equal(
      collection.features[0].properties?.[GEOMETRY_EDIT_FID_PROPERTY],
      undefined,
    );
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
      ["5", "12", "2"],
    );
  });
});
