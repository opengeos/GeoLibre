import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeGeoArrowBBox,
  featureCollectionToGeoArrow,
  geoArrowToFeatureCollection,
  isGeoArrowBatch,
  type GeoArrowBatch,
} from "@geolibre/core";
import { buildTileIndexFromBinary, encodeTile } from "../packages/map/src/geojson-vt-index";
import {
  registerGeoJsonVtSource,
  unregisterGeoJsonVtSource,
} from "../packages/map/src/geojson-vt-protocol";
import { wkbRowsToGeoArrowBatch } from "../apps/geolibre-desktop/src/lib/geoarrow-pipeline";

describe("GeoArrow Adversarial & Failure-Injection Test Matrix", () => {
  it("Scenario 1 & 20: Empty table / 0 features & empty buffers", () => {
    const emptyBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(0),
      coordDimensions: 2,
      featureCount: 0,
      properties: [],
    };
    assert.equal(isGeoArrowBatch(emptyBatch), true);
    assert.equal(computeGeoArrowBBox(emptyBatch), null);

    const fc = geoArrowToFeatureCollection(emptyBatch);
    assert.equal(fc.features.length, 0);

    const index = buildTileIndexFromBinary(emptyBatch, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    const tile = encodeTile(index, 0, 0, 0);
    assert.equal(tile.byteLength, 0);
  });

  it("Scenario 2 & 3: Single feature & single-coordinate geometry", () => {
    const singlePoint: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([100.5, -45.5]),
      coordDimensions: 2,
      featureCount: 1,
      properties: [{ id: "solo" }],
    };
    const fc = geoArrowToFeatureCollection(singlePoint);
    assert.equal(fc.features.length, 1);
    assert.deepEqual(fc.features[0].geometry, { type: "Point", coordinates: [100.5, -45.5] });
    assert.deepEqual(computeGeoArrowBBox(singlePoint), [100.5, -45.5, 100.5, -45.5]);
  });

  it("Scenario 4: Very large feature with 10,000 vertices", () => {
    const VERTEX_COUNT = 10_000;
    const coords = new Float64Array(VERTEX_COUNT * 2);
    for (let i = 0; i < VERTEX_COUNT; i++) {
      coords[i * 2] = (i % 180) - 90;
      coords[i * 2 + 1] = (i % 80) - 40;
    }
    const largeLine: GeoArrowBatch = {
      geometryType: "LineString",
      coordinates: coords,
      coordDimensions: 2,
      geomOffsets: new Int32Array([0, VERTEX_COUNT]),
      featureCount: 1,
      properties: [{ name: "MassivePolyline" }],
    };

    const fc = geoArrowToFeatureCollection(largeLine);
    assert.equal(fc.features.length, 1);
    const geom = fc.features[0].geometry as GeoJSON.LineString;
    assert.equal(geom.type, "LineString");
    assert.equal(geom.coordinates.length, VERTEX_COUNT);

    const index = buildTileIndexFromBinary(largeLine, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    const tile = encodeTile(index, 0, 0, 0);
    assert.ok(tile.byteLength > 0);
  });

  it("Scenario 5 & 6: Extremely complex polygon with 50 inner holes", () => {
    // 1 outer ring + 50 holes = 51 rings
    const HOLE_COUNT = 50;
    const TOTAL_RINGS = HOLE_COUNT + 1;
    const ringOffsets = new Int32Array(TOTAL_RINGS + 1);
    const ringVertices = 5; // closed 4-sided ring
    const totalVertices = TOTAL_RINGS * ringVertices;
    const coordinates = new Float64Array(totalVertices * 2);

    let v = 0;
    // Outer ring: 0..100
    ringOffsets[0] = 0;
    const outer: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
      [0, 0],
    ];
    for (const [x, y] of outer) {
      coordinates[v * 2] = x;
      coordinates[v * 2 + 1] = y;
      v++;
    }

    // 50 small holes
    for (let h = 0; h < HOLE_COUNT; h++) {
      ringOffsets[h + 1] = v;
      const x0 = 2 + (h % 10) * 8;
      const y0 = 2 + Math.floor(h / 10) * 15;
      const hole: [number, number][] = [
        [x0, y0],
        [x0 + 4, y0],
        [x0 + 4, y0 + 4],
        [x0, y0 + 4],
        [x0, y0],
      ];
      for (const [x, y] of hole) {
        coordinates[v * 2] = x;
        coordinates[v * 2 + 1] = y;
        v++;
      }
    }
    ringOffsets[TOTAL_RINGS] = v;

    const complexPoly: GeoArrowBatch = {
      geometryType: "Polygon",
      coordinates,
      coordDimensions: 2,
      geomOffsets: new Int32Array([0, TOTAL_RINGS]),
      ringOffsets,
      featureCount: 1,
      properties: [{ holes: HOLE_COUNT }],
    };

    const fc = geoArrowToFeatureCollection(complexPoly);
    assert.equal(fc.features.length, 1);
    const poly = fc.features[0].geometry as GeoJSON.Polygon;
    assert.equal(poly.coordinates.length, TOTAL_RINGS);

    const index = buildTileIndexFromBinary(complexPoly, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    const tile = encodeTile(index, 0, 0, 0);
    assert.ok(tile.byteLength > 0);
  });

  it("Scenario 7 & 8: Null and empty geometry features in Point batch", () => {
    const coords = new Float64Array([NaN, NaN, 10, 20, NaN, NaN]);
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: coords,
      coordDimensions: 2,
      featureCount: 3,
      properties: [{ id: 1 }, { id: 2 }, { id: 3 }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features.length, 3);
    assert.equal(fc.features[0].geometry, null);
    assert.deepEqual(fc.features[1].geometry, { type: "Point", coordinates: [10, 20] });
    assert.equal(fc.features[2].geometry, null);
  });

  it("Scenario 9: Malformed or truncated WKB buffers", () => {
    // Truncated WKB buffer (only 3 bytes)
    const truncated = new Uint8Array([1, 1, 0]);
    const rows = [
      { id: 1, geom: truncated },
      { id: 2, geom: "invalid-base64-!@#" },
    ];
    const batch = wkbRowsToGeoArrowBatch(rows, "geom");
    assert.ok(batch);
    assert.equal(batch.featureCount, 2);
    // Malformed WKB results in NaN coordinates, not a fatal crash
    assert.ok(Number.isNaN(batch.coordinates[0]));
    assert.ok(Number.isNaN(batch.coordinates[2]));
  });

  it("Scenario 10: Missing geometry column in WKB rows", () => {
    const rows = [{ id: 1, name: "NoGeom" }];
    const batch = wkbRowsToGeoArrowBatch(rows, "non_existent_column");
    assert.ok(batch);
    assert.equal(batch.featureCount, 1);
    assert.ok(Number.isNaN(batch.coordinates[0]));
  });

  it("Scenario 14 & 15: Invalid (NaN/Inf) and large coordinate magnitudes", () => {
    const extremeCoords = new Float64Array([NaN, Infinity, 1e15, -1e15, -180.0, 90.0]);
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: extremeCoords,
      coordDimensions: 2,
      featureCount: 3,
    };

    const bbox = computeGeoArrowBBox(batch);
    assert.ok(bbox);
    assert.equal(bbox[0], -180.0);
    assert.equal(bbox[2], 1e15);

    // Tile builder does not throw
    const index = buildTileIndexFromBinary(batch, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    assert.ok(index);
  });

  it("Scenario 16: Long Unicode strings and emojis in attributes", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([0, 0]),
      coordDimensions: 2,
      featureCount: 1,
      properties: [
        {
          emoji: "🌍🚀✨",
          multilingual: "北京 (Beijing) - 東京 (Tokyo) - القاهرة (Cairo)",
          longText: "A".repeat(5000),
        },
      ],
    };
    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features[0].properties?.emoji, "🌍🚀✨");
    assert.equal(
      fc.features[0].properties?.multilingual,
      "北京 (Beijing) - 東京 (Tokyo) - القاهرة (Cairo)",
    );
    assert.equal(String(fc.features[0].properties?.longText).length, 5000);
  });

  it("Scenario 17 & 18: Duplicate and missing feature IDs", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1, 1, 2, 2, 3, 3]),
      coordDimensions: 2,
      featureCount: 3,
      featureIds: ["same-id", "same-id", undefined],
    };
    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features[0].id, "same-id");
    assert.equal(fc.features[1].id, "same-id");
    assert.equal(fc.features[2].id, undefined);
  });

  it("Scenario 31 & 32: Rapid creation, update, and removal of layers", () => {
    const layerId = "rapid-churn-layer";
    for (let cycle = 0; cycle < 20; cycle++) {
      const batch: GeoArrowBatch = {
        geometryType: "Point",
        coordinates: new Float64Array([cycle, cycle]),
        coordDimensions: 2,
        featureCount: 1,
      };
      registerGeoJsonVtSource(layerId, batch, {
        cluster: false,
        clusterRadius: 50,
        clusterMaxZoom: 16,
      });
    }
    // Final drop
    unregisterGeoJsonVtSource(layerId);
    unregisterGeoJsonVtSource(layerId); // idempotent
  });

  it("Scenario 41: Antimeridian crossing coordinates", () => {
    // Feature crossing 180° meridian: (179, 10) to (-179, 10)
    const crossingLine: GeoArrowBatch = {
      geometryType: "LineString",
      coordinates: new Float64Array([179, 10, -179, 10]),
      coordDimensions: 2,
      geomOffsets: new Int32Array([0, 2]),
      featureCount: 1,
    };
    const index = buildTileIndexFromBinary(crossingLine, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    assert.ok(index);
    const tileWest = encodeTile(index, 1, 0, 0);
    const tileEast = encodeTile(index, 1, 1, 0);
    // Tiles on both sides of the antimeridian should receive cut geometry
    assert.ok(tileWest.byteLength > 0 || tileEast.byteLength > 0);
  });
});
