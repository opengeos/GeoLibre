import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  featureCollectionToGeoArrow,
  geoArrowToFeatureCollection,
  type GeoArrowBatch,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildTileIndex,
  buildTileIndexFromBinary,
  encodeTile,
} from "../packages/map/src/geojson-vt-index";

const EPSILON = 1e-7;

function coordsWithinTolerance(c1: number[], c2: number[], eps = EPSILON): boolean {
  if (c1.length !== c2.length) return false;
  for (let i = 0; i < c1.length; i++) {
    if (Math.abs(c1[i] - c2[i]) > eps) return false;
  }
  return true;
}

describe("GeoArrow Regression Suite — Golden Baseline Parity", () => {
  it("preserves exact feature counts, attributes, and coordinate precision", () => {
    const baselineFc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "node-101",
          properties: {
            stringVal: "Downtown Transit Hub",
            numVal: 12345.6789,
            bigIntVal: 9007199254740991, // Number.MAX_SAFE_INTEGER
            boolVal: true,
            nullVal: null,
            nested: { level: 2 },
          },
          geometry: {
            type: "Point",
            coordinates: [-122.4194155, 37.7749295],
          },
        },
        {
          type: "Feature",
          id: "node-102",
          properties: {
            stringVal: "Uptown Plaza",
            numVal: -99.5,
            bigIntVal: 42,
            boolVal: false,
            nullVal: null,
          },
          geometry: {
            type: "Point",
            coordinates: [-122.4089123, 37.7858341],
          },
        },
      ],
    };

    // Convert to GeoArrow
    const batch = featureCollectionToGeoArrow(baselineFc);
    assert.ok(batch);
    assert.equal(batch.featureCount, baselineFc.features.length);

    // Convert back to GeoJSON
    const convertedFc = geoArrowToFeatureCollection(batch);
    assert.equal(convertedFc.features.length, baselineFc.features.length);

    for (let i = 0; i < baselineFc.features.length; i++) {
      const orig = baselineFc.features[i];
      const conv = convertedFc.features[i];

      assert.equal(conv.id, orig.id);
      assert.equal(conv.properties?.stringVal, orig.properties?.stringVal);
      assert.equal(conv.properties?.numVal, orig.properties?.numVal);
      assert.equal(conv.properties?.bigIntVal, orig.properties?.bigIntVal);
      assert.equal(conv.properties?.boolVal, orig.properties?.boolVal);
      assert.equal(conv.properties?.nullVal, null);

      assert.equal(conv.geometry?.type, orig.geometry.type);
      const origCoord = (orig.geometry as GeoJSON.Point).coordinates;
      const convCoord = (conv.geometry as GeoJSON.Point).coordinates;
      assert.ok(
        coordsWithinTolerance(origCoord, convCoord),
        `Coordinates diverged: expected ${origCoord}, got ${convCoord}`,
      );
    }
  });

  it("produces identical vector tile payload sizes between GeoJSON and GeoArrow", () => {
    const pointCount = 200;
    const features: GeoJSON.Feature[] = new Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      features[i] = {
        type: "Feature",
        id: i,
        properties: { cat: i % 5, rank: i },
        geometry: {
          type: "Point",
          coordinates: [(i % 20) * 0.05, Math.floor(i / 20) * 0.05],
        },
      };
    }
    const fc: FeatureCollection = { type: "FeatureCollection", features };
    const batch = featureCollectionToGeoArrow(fc);
    assert.ok(batch);

    const options = { cluster: false, clusterRadius: 40, clusterMaxZoom: 14 };
    const legacyIndex = buildTileIndex(fc, options);
    const geoArrowIndex = buildTileIndexFromBinary(batch, options);

    for (const [z, x, y] of [
      [0, 0, 0],
      [1, 1, 0],
      [2, 2, 1],
    ]) {
      const legacyTile = encodeTile(legacyIndex, z, x, y);
      const geoArrowTile = encodeTile(geoArrowIndex, z, x, y);
      assert.equal(
        geoArrowTile.byteLength,
        legacyTile.byteLength,
        `Tile ${z}/${x}/${y} byte length mismatch`,
      );
    }
  });
});
