import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyJoinsToLayer,
  DEFAULT_LAYER_STYLE,
  computeGeoArrowBBox,
  createEmptyProject,
  featureCollectionToGeoArrow,
  excludeHiddenFieldsFromProject,
  geoArrowToFeatureCollection,
  isGeoArrowBatch,
  parseProject,
  serializeProject,
  shouldUseTiledRendering,
  useAppStore,
  type GeoArrowBatch,
} from "@geolibre/core";
import type { FeatureCollection, Geometry, Polygon } from "geojson";
import { partializeHistory } from "../packages/core/src/store/undo-history";
import { shallow } from "zustand/shallow";

describe("GeoArrow core data structures and conversions", () => {
  it("validates GeoArrowBatch structures with isGeoArrowBatch", () => {
    assert.equal(isGeoArrowBatch(null), false);
    assert.equal(isGeoArrowBatch({}), false);
    assert.equal(isGeoArrowBatch({ geometryType: "Point" }), false);

    const validPointBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([10, 20, 30, 40]),
      coordDimensions: 2,
      featureCount: 2,
    };
    assert.equal(isGeoArrowBatch(validPointBatch), true);

    const invalidCoords = {
      geometryType: "Point",
      coordinates: [10, 20],
      coordDimensions: 2,
      featureCount: 1,
    };
    assert.equal(isGeoArrowBatch(invalidCoords), false);

    const invalidOffsets = {
      ...validPointBatch,
      geomOffsets: [0, 1], // not Int32Array
    };
    assert.equal(isGeoArrowBatch(invalidOffsets), false);
  });

  it("rejects invalid batch geometry types, counts and offset ranges", () => {
    const point = {
      geometryType: "Point",
      coordinates: new Float64Array([1, 2]),
      coordDimensions: 2,
      featureCount: 1,
    };
    assert.equal(isGeoArrowBatch({ ...point, geometryType: "Unknown" }), false);
    assert.equal(isGeoArrowBatch({ ...point, featureCount: 0.5 }), false);
    assert.equal(isGeoArrowBatch({ ...point, featureCount: 2 }), false);
    assert.equal(
      isGeoArrowBatch({
        ...point,
        geometryType: "LineString",
        geomOffsets: new Int32Array([0, 2]),
      }),
      false,
    );
    assert.equal(isGeoArrowBatch({ ...point, properties: [] }), false);
  });

  it("clears stale batches when excluded fields replace project GeoJSON", () => {
    const project = createEmptyProject();
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { secret: "hidden" },
        },
      ],
    };
    const id = useAppStore.getState().addGeoJsonLayer("excluded", geojson);
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id)!;
    project.layers = [
      {
        ...layer,
        geoarrow: featureCollectionToGeoArrow(geojson)!,
        fieldVisibility: { secret: "excluded" },
      },
    ];
    const result = excludeHiddenFieldsFromProject(project);
    assert.equal(result.layers[0].geoarrow, undefined);
    assert.deepEqual(result.layers[0].geojson?.features[0].properties, {});
    useAppStore.getState().removeLayer(id);
  });

  it("detects Z after the first line vertex and does not invent missing XY ordinates", () => {
    const batch = featureCollectionToGeoArrow({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [[1, 2], [3, 4, 5], []] },
        },
      ],
    });
    assert.ok(batch);
    assert.equal(batch.coordDimensions, 3);
    assert.equal(batch.coordinates[5], 5);
    assert.ok(Number.isNaN(batch.coordinates[6]));
    assert.ok(Number.isNaN(batch.coordinates[7]));
  });

  it("falls back immediately for unsupported multi geometries", () => {
    for (const geometry of [
      {
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [0, 0],
            ],
          ],
        ],
      },
    ]) {
      assert.equal(
        featureCollectionToGeoArrow({
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: geometry as Geometry }],
        }),
        null,
      );
    }
  });

  it("computes accurate 2D bounding boxes in a single pass", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([-122.4, 37.7, -122.2, 37.8, -122.5, 37.6]),
      coordDimensions: 2,
      featureCount: 3,
    };
    const bbox = computeGeoArrowBBox(batch);
    assert.deepEqual(bbox, [-122.5, 37.6, -122.2, 37.8]);

    // Handles empty coordinates
    assert.equal(
      computeGeoArrowBBox({
        geometryType: "Point",
        coordinates: new Float64Array(0),
        coordDimensions: 2,
        featureCount: 0,
      }),
      null,
    );

    // All-invalid coordinates return null
    assert.equal(
      computeGeoArrowBBox({
        geometryType: "Point",
        coordinates: new Float64Array([NaN, NaN, Infinity, -Infinity]),
        coordDimensions: 2,
        featureCount: 2,
      }),
      null,
    );

    // Ignores NaNs and Infinities when finite coordinates are present
    const withNans: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([NaN, Infinity, 10, 20, -Infinity, NaN]),
      coordDimensions: 2,
      featureCount: 3,
    };
    assert.deepEqual(computeGeoArrowBBox(withNans), [10, 20, 10, 20]);
  });

  it("converts GeoArrow Point batch to FeatureCollection losslessly", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1.5, 2.5, 3.5, 4.5]),
      coordDimensions: 2,
      featureCount: 2,
      featureIds: ["feat-1", 42],
      properties: [
        { name: "Alpha", val: 100 },
        { name: "Beta", val: null },
      ],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.type, "FeatureCollection");
    assert.equal(fc.features.length, 2);

    assert.equal(fc.features[0].id, "feat-1");
    assert.deepEqual(fc.features[0].properties, { name: "Alpha", val: 100 });
    assert.deepEqual(fc.features[0].geometry, { type: "Point", coordinates: [1.5, 2.5] });

    assert.equal(fc.features[1].id, 42);
    assert.deepEqual(fc.features[1].properties, { name: "Beta", val: null });
    assert.deepEqual(fc.features[1].geometry, { type: "Point", coordinates: [3.5, 4.5] });
  });

  it("converts GeoArrow 3D Point batch (XYZ) preserving elevation", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1.5, 2.5, 100.25, 3.5, 4.5, -50.5]),
      coordDimensions: 3,
      featureCount: 2,
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.deepEqual(fc.features[0].geometry, { type: "Point", coordinates: [1.5, 2.5, 100.25] });
    assert.deepEqual(fc.features[1].geometry, { type: "Point", coordinates: [3.5, 4.5, -50.5] });
  });

  it("converts GeoArrow LineString batch to FeatureCollection", () => {
    // 2 features:
    // feat 0: vertices 0..2 (3 points: (0,0), (1,1), (2,2))
    // feat 1: vertices 3..4 (2 points: (10,10), (20,20))
    const coordinates = new Float64Array([0, 0, 1, 1, 2, 2, 10, 10, 20, 20]);
    const geomOffsets = new Int32Array([0, 3, 5]);

    const batch: GeoArrowBatch = {
      geometryType: "LineString",
      coordinates,
      coordDimensions: 2,
      geomOffsets,
      featureCount: 2,
      properties: [{ road: "A1" }, { road: "B2" }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features.length, 2);
    assert.deepEqual(fc.features[0].geometry, {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    });
    assert.deepEqual(fc.features[1].geometry, {
      type: "LineString",
      coordinates: [
        [10, 10],
        [20, 20],
      ],
    });
  });

  it("converts GeoArrow Polygon batch with outer and inner rings (holes)", () => {
    // 1 polygon feature with 2 rings (outer 5 vertices, hole 5 vertices):
    // outer: (0,0), (10,0), (10,10), (0,10), (0,0)
    // hole:  (2,2), (4,2), (4,4), (2,4), (2,2)
    const coordinates = new Float64Array([
      0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 2, 2, 4, 2, 4, 4, 2, 4, 2, 2,
    ]);
    const ringOffsets = new Int32Array([0, 5, 10]); // 2 rings
    const geomOffsets = new Int32Array([0, 2]); // 1 polygon having 2 rings

    const batch: GeoArrowBatch = {
      geometryType: "Polygon",
      coordinates,
      coordDimensions: 2,
      geomOffsets,
      ringOffsets,
      featureCount: 1,
      properties: [{ name: "ParkWithLake" }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features.length, 1);
    const geom = fc.features[0].geometry as Polygon;
    assert.equal(geom.type, "Polygon");
    assert.equal(geom.coordinates.length, 2); // 2 rings
    assert.deepEqual(geom.coordinates[0], [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    assert.deepEqual(geom.coordinates[1], [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2],
    ]);
  });

  it("round-trips FeatureCollection to GeoArrow and back without loss", () => {
    const original: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "pt-1",
          properties: { speed: 55, active: true, tag: "fast" },
          geometry: { type: "Point", coordinates: [-73.985, 40.748] },
        },
        {
          type: "Feature",
          id: "pt-2",
          properties: { speed: 30, active: false, tag: null },
          geometry: { type: "Point", coordinates: [-73.986, 40.749] },
        },
      ],
    };

    const batch = featureCollectionToGeoArrow(original);
    assert.ok(batch);
    assert.equal(batch.geometryType, "Point");
    assert.equal(batch.featureCount, 2);

    const roundTripped = geoArrowToFeatureCollection(batch);
    assert.equal(roundTripped.features.length, 2);
    assert.equal(roundTripped.features[0].id, "pt-1");
    assert.deepEqual(roundTripped.features[0].properties, original.features[0].properties);
    assert.deepEqual(roundTripped.features[0].geometry, original.features[0].geometry);

    assert.equal(roundTripped.features[1].id, "pt-2");
    assert.deepEqual(roundTripped.features[1].properties, original.features[1].properties);
    assert.deepEqual(roundTripped.features[1].geometry, original.features[1].geometry);
  });

  it("shouldUseTiledRendering seamlessly supports GeoArrowBatch", () => {
    const smallBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(2000),
      coordDimensions: 2,
      featureCount: 1000,
    };
    assert.equal(shouldUseTiledRendering(smallBatch), false);

    const largeBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(100_002 * 2),
      coordDimensions: 2,
      featureCount: 100_002,
    };
    assert.equal(shouldUseTiledRendering(largeBatch), true);

    // Existing GeoJSON support remains 100% intact
    const smallFc: FeatureCollection = { type: "FeatureCollection", features: new Array(50) };
    assert.equal(shouldUseTiledRendering(smallFc), false);
    const largeFc: FeatureCollection = { type: "FeatureCollection", features: new Array(60_000) };
    assert.equal(shouldUseTiledRendering(largeFc), true);
  });

  it("converts promoted Point and MultiPoint geometries with consistent vertex offsets", () => {
    // Collection with a Point promoted to MultiPoint and an actual MultiPoint
    const fc: FeatureCollection<Geometry | null> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "p1",
          geometry: { type: "Point", coordinates: [10, 20] },
          properties: { name: "Single" },
        },
        {
          type: "Feature",
          id: "mp1",
          geometry: {
            type: "MultiPoint",
            coordinates: [
              [30, 40],
              [50, 60],
            ],
          },
          properties: { name: "Multi" },
        },
        {
          type: "Feature",
          id: "null1",
          geometry: null,
          properties: { name: "Null" },
        },
      ],
    };

    const batch = featureCollectionToGeoArrow(fc);
    assert.ok(batch);
    assert.equal(batch.geometryType, "MultiPoint");
    assert.equal(batch.featureCount, 3);
    assert.ok(batch.geomOffsets);

    // Feature 0 (Point) -> 1 vertex [0, 1]
    // Feature 1 (MultiPoint) -> 2 vertices [1, 3]
    // Feature 2 (null) -> 0 vertices [3, 3]
    assert.deepEqual(Array.from(batch.geomOffsets), [0, 1, 3, 3]);

    // Total emitted coordinates must be 3 vertices * 2 dimensions = 6 numbers
    assert.equal(batch.coordinates.length, 6);
    assert.deepEqual(Array.from(batch.coordinates), [10, 20, 30, 40, 50, 60]);

    // Lossless round trip
    const roundTripped = geoArrowToFeatureCollection(batch);
    assert.equal(roundTripped.features.length, 3);
    assert.deepEqual(roundTripped.features[0].geometry, {
      type: "MultiPoint",
      coordinates: [[10, 20]],
    });
    assert.deepEqual(roundTripped.features[1].geometry, {
      type: "MultiPoint",
      coordinates: [
        [30, 40],
        [50, 60],
      ],
    });
    assert.equal(roundTripped.features[2].geometry, null);
  });

  it("handles updateLayer correctly: clears stale geoarrow on geojson replacement unless explicitly provided", () => {
    const store = useAppStore.getState();
    const initialBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1, 2]),
      coordDimensions: 2,
      featureCount: 1,
    };
    const initialFc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} },
      ],
    };

    const layerId = store.addGeoJsonLayer("test-layer", initialFc, undefined, null, {
      geoarrow: initialBatch,
    });
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === layerId)?.geoarrow,
      initialBatch,
    );

    // Scenario 1: Replacing geojson without providing geoarrow clears existing geoarrow
    const updatedFc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [100, 200] }, properties: {} },
      ],
    };
    store.updateLayer(layerId, { geojson: updatedFc });
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === layerId)?.geoarrow,
      undefined,
      "stale geoarrow should be cleared when geojson is replaced without supplying new geoarrow",
    );

    // Scenario 2: Providing both geojson and geoarrow updates both
    const replacementBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([100, 200]),
      coordDimensions: 2,
      featureCount: 1,
    };
    store.updateLayer(layerId, { geojson: updatedFc, geoarrow: replacementBatch });
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === layerId)?.geoarrow,
      replacementBatch,
    );

    // Scenario 3: Patching unrelated fields (opacity) preserves existing geoarrow
    store.updateLayer(layerId, { opacity: 0.5 });
    const finalLayer = useAppStore.getState().layers.find((l) => l.id === layerId);
    assert.equal(finalLayer?.opacity, 0.5);
    assert.equal(
      finalLayer?.geoarrow,
      replacementBatch,
      "unrelated patch must preserve existing geoarrow",
    );

    // Clean up
    store.removeLayer(layerId);
  });

  it("omits runtime geoarrow during project serialization and safely normalizes during hydration", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([10, 20]),
      coordDimensions: 2,
      featureCount: 1,
    };
    const project = createEmptyProject();
    project.layers.push({
      id: "lyr-test-serialize",
      name: "Vector Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [10, 20] }, properties: {} },
        ],
      },
      geoarrow: batch,
    });

    const json = serializeProject(project);
    const parsedRaw = JSON.parse(json);
    const serializedLayer = parsedRaw.layers.find(
      (l: { id: string }) => l.id === "lyr-test-serialize",
    );

    assert.ok(serializedLayer, "layer must be serialized");
    assert.equal(
      serializedLayer.geoarrow,
      undefined,
      "runtime geoarrow must be omitted from project JSON",
    );
    assert.ok(serializedLayer.geojson, "geojson must be preserved in project JSON");

    // Hydration check via parseProject
    const restored = parseProject(json);
    const restoredLayer = restored.layers.find((l) => l.id === "lyr-test-serialize");
    assert.ok(restoredLayer);
    assert.equal(
      restoredLayer.geoarrow,
      undefined,
      "restored layer without geoarrow is safe GeoJSON-only layer",
    );

    // Corrupted non-GeoArrowBatch value is discarded during normalize
    const corruptedJson = JSON.stringify({
      ...parsedRaw,
      layers: [{ ...serializedLayer, geoarrow: { corrupted: true } }],
    });
    const restoredCorrupted = parseProject(corruptedJson);
    const normalizedCorrupted = restoredCorrupted.layers.find((l) => l.id === "lyr-test-serialize");
    assert.equal(
      normalizedCorrupted?.geoarrow,
      undefined,
      "invalid geoarrow must be discarded during hydration",
    );
  });

  it("addGeoJsonLayer safely falls back to GeoJSON-only layer when featureCollectionToGeoArrow throws (C)", () => {
    const store = useAppStore.getState();
    // Create a feature collection with >50k items so shouldUseTiledRendering is true
    const largeFc: FeatureCollection = {
      type: "FeatureCollection",
      features: new Array(60_000).fill(null).map((_, i) => ({
        type: "Feature",
        id: i,
        // A malformed ring throws during coordinate inspection.
        geometry: { type: "Polygon", coordinates: [null] } as unknown as Polygon,
        properties: {},
      })),
    };
    assert.throws(() => featureCollectionToGeoArrow(largeFc), TypeError);

    // Layer creation succeeds without throwing
    const layerId = store.addGeoJsonLayer("test-large-layer", largeFc);
    const created = useAppStore.getState().layers.find((l) => l.id === layerId);
    assert.ok(created, "layer must be created even with large payload");
    assert.equal(created.geojson, largeFc, "geojson must be intact");
    assert.equal(created.geoarrow, undefined, "failed conversion must not attach a batch");

    // Clean up
    store.removeLayer(layerId);
  });

  it("applyJoinsToLayer strips stale geoarrow when layer geojson is updated (D)", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([10, 20]),
      coordDimensions: 2,
      featureCount: 1,
      properties: [{ baseVal: "initial" }],
    };
    const layer = {
      id: "lyr-join-test",
      name: "Join Test Layer",
      type: "geojson" as const,
      source: { type: "geojson" as const },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson: {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature" as const,
            id: 1,
            geometry: { type: "Point" as const, coordinates: [10, 20] },
            properties: { id: 1, baseVal: "initial" },
          },
        ],
      },
      geoarrow: batch,
    };

    const joinedLayer = applyJoinsToLayer(layer, [layer], []);
    assert.equal(
      joinedLayer.geoarrow,
      undefined,
      "stale geoarrow must be removed when applyJoinsToLayer updates geojson",
    );
    assert.ok(joinedLayer.geojson, "new geojson must be preserved");
  });

  it("partializeHistory preserves layer references and immutable geoarrow across calls (E)", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([10, 20]),
      coordDimensions: 2,
      featureCount: 1,
    };
    const state = useAppStore.getState();
    const layerId = state.addGeoJsonLayer(
      "stable-ref-layer",
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [10, 20] }, properties: {} },
        ],
      },
      undefined,
      null,
      { geoarrow: batch },
    );

    const currentState = useAppStore.getState();
    const snap1 = partializeHistory(currentState);
    const snap2 = partializeHistory(currentState);

    // Layer references must be stable across calls so shallow equality passes
    assert.equal(snap1.layers, snap2.layers);
    assert.ok(shallow(snap1.layers, snap2.layers));

    // GeoArrow is preserved in history snapshot
    const snapLayer = snap1.layers.find((l) => l.id === layerId);
    assert.equal(snapLayer?.geoarrow, batch, "geoarrow must be preserved in history snapshot");

    state.removeLayer(layerId);
  });
});
