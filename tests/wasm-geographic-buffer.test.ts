import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection, GeometryCollection, Point } from "geojson";
import { prepareGeographicBufferInput } from "@geolibre/processing";

const warsaw: FeatureCollection<Point> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Warsaw" },
      geometry: { type: "Point", coordinates: [21.0122, 52.2297] },
    },
  ],
};

describe("prepareGeographicBufferInput", () => {
  it("projects WGS84 coordinates and degree distances into Web Mercator", () => {
    const prepared = prepareGeographicBufferInput(warsaw, "0.1");
    assert.ok(prepared);
    assert.deepEqual((prepared.geojson as FeatureCollection & { crs?: unknown }).crs, {
      type: "name",
      properties: { name: "EPSG:3857" },
    });

    const point = prepared.geojson.features[0].geometry as Point;
    assert.ok(Math.abs(point.coordinates[0] - 2_339_067.4) < 1);
    assert.ok(Math.abs(point.coordinates[1] - 6_841_765.2) < 1);
    assert.ok(Math.abs(prepared.distance - 11_131.949) < 0.01);
  });

  it("does not mutate the map layer supplied by the caller", () => {
    const before = structuredClone(warsaw);
    prepareGeographicBufferInput(warsaw, 0.1);
    assert.deepEqual(warsaw, before);
  });

  it("projects coordinate geometries nested inside geometry collections", () => {
    const nested: FeatureCollection<GeometryCollection> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [
              {
                type: "GeometryCollection",
                geometries: [{ type: "Point", coordinates: [21.0122, 52.2297] }],
              },
            ],
          },
        },
      ],
    };

    const prepared = prepareGeographicBufferInput(nested, 0.1);
    assert.ok(prepared);
    const outer = prepared.geojson.features[0].geometry as GeometryCollection;
    const inner = outer.geometries[0] as GeometryCollection;
    const point = inner.geometries[0] as Point;
    assert.ok(Math.abs(point.coordinates[0] - 2_339_067.4) < 1);
    assert.ok(Math.abs(point.coordinates[1] - 6_841_765.2) < 1);
  });

  it("rejects missing, non-numeric, and non-positive distances", () => {
    for (const distance of [undefined, "", "not a number", 0, -1]) {
      assert.equal(prepareGeographicBufferInput(warsaw, distance), null);
    }
  });
});
