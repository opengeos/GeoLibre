import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { stripReservedFidProperty } from "../apps/geolibre-desktop/src/lib/duckdb-geojson-fid";

function point(properties: Record<string, unknown>): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties,
      },
    ],
  };
}

describe("stripReservedFidProperty", () => {
  it("drops the reserved OGC_FID property (issue #944 GeoParquet round-trip)", () => {
    const fc = point({ OGC_FID: 7, deaths: 3 });
    const out = stripReservedFidProperty(fc);
    assert.deepEqual(out.features[0].properties, { deaths: 3 });
  });

  it("leaves other properties untouched", () => {
    const fc = point({ OGC_FID: 1, name: "x", year: 2020 });
    const out = stripReservedFidProperty(fc);
    assert.deepEqual(out.features[0].properties, { name: "x", year: 2020 });
  });

  it("returns the same reference when no feature carries OGC_FID", () => {
    const fc = point({ deaths: 3 });
    assert.equal(stripReservedFidProperty(fc), fc);
  });

  it("does not mutate the input FeatureCollection", () => {
    const fc = point({ OGC_FID: 9, deaths: 3 });
    stripReservedFidProperty(fc);
    assert.deepEqual(fc.features[0].properties, { OGC_FID: 9, deaths: 3 });
  });

  it("handles a null properties bag without throwing", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: null,
        },
      ],
    };
    const out = stripReservedFidProperty(fc);
    assert.equal(out.features[0].properties, null);
  });

  it("strips OGC_FID from only the features that carry it", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { OGC_FID: 1, v: 10 },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 1] },
          properties: { v: 20 },
        },
      ],
    };
    const out = stripReservedFidProperty(fc);
    assert.deepEqual(out.features[0].properties, { v: 10 });
    assert.deepEqual(out.features[1].properties, { v: 20 });
  });
});
