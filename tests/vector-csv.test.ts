import assert from "node:assert/strict";
import { test } from "node:test";
import { geojsonToCsv } from "../apps/geolibre-desktop/src/lib/vector-csv";

test("point exports carry longitude and latitude, preserving colliding attributes", () => {
  assert.equal(
    geojsonToCsv({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "site-1",
          properties: { feature_id: "original", longitude: "old", longitude_2: 9, site: 'A, "B"' },
          geometry: { type: "Point", coordinates: [-84.5, 35.9, 100] },
        },
      ],
    }),
    'feature_id_2,feature_id,longitude,longitude_2,site,longitude_3,latitude\nsite-1,original,old,9,"A, ""B""",-84.5,35.9',
  );
});

test("mixed geometry and missing geometries leave coordinates empty without dropping rows", () => {
  assert.equal(
    geojsonToCsv({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: null, geometry: { type: "Point", coordinates: [0, 0] } },
        { type: "Feature", properties: {}, geometry: null },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        },
      ],
    }),
    "feature_id,longitude,latitude\n0,0,0\n1,,\n2,,",
  );
});

test("non-point and empty exports keep attribute-only columns", () => {
  assert.equal(geojsonToCsv({ type: "FeatureCollection", features: [] }), "feature_id");
  assert.equal(
    geojsonToCsv({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "line" },
          geometry: {
            type: "LineString",
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
        },
      ],
    }),
    "feature_id,name\n0,line",
  );
});

test("escapes spreadsheet formulas in text and headers while retaining numeric coordinates", () => {
  assert.equal(
    geojsonToCsv({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "=1+1",
          properties: { "@column": "+SUM(1)", note: "-text", amount: -3 },
          geometry: { type: "Point", coordinates: [-84, -35] },
        },
      ],
    }),
    "feature_id,'@column,note,amount,longitude,latitude\n'=1+1,'+SUM(1),'-text,-3,-84,-35",
  );
});
