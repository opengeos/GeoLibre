import assert from "node:assert/strict";
import { describe, it } from "node:test";
import distance from "@turf/distance";
import type { Feature, FeatureCollection, Point, Position } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  extractVerticesTool,
  pointsAlongGeometryTool,
} from "../packages/processing/src/vector-tools";
import type { ProcessingContext } from "../packages/processing/src/types";

function run(
  tool: typeof pointsAlongGeometryTool,
  geojson: FeatureCollection,
  parameters: Record<string, unknown>,
) {
  const logs: string[] = [];
  const results: FeatureCollection[] = [];
  const layer = {
    id: "in",
    name: "in",
    type: "geojson",
    geojson,
  } as unknown as GeoLibreLayer;
  const ctx: ProcessingContext = {
    layers: [layer],
    parameters: { layer: "in", ...parameters },
    log: (m) => logs.push(m),
    addResultLayer: (_name, fc) => results.push(fc),
  };
  tool.run(ctx);
  return { logs, points: (results[0]?.features ?? []) as Feature<Point>[] };
}

function line(
  coordinates: Position[],
  properties: Record<string, unknown> = {},
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties,
        geometry: { type: "LineString", coordinates },
      },
    ],
  };
}

describe("pointsAlongGeometryTool", () => {
  it("places interval points geodesically so the distance column matches the coordinate", () => {
    // A 90-degree longitude span at 60N: linear lon/lat interpolation puts the
    // midpoint at [45, 60], which is ~53% of the haversine length, not 50%.
    const start: Position = [0, 60];
    const end: Position = [90, 60];
    const total = distance(start, end, { units: "kilometers" });
    const { points } = run(pointsAlongGeometryTool, line([start, end]), {
      interval: total / 2,
      units: "kilometers",
    });
    assert.equal(points.length, 3);
    const mid = points[1];
    assert.equal(mid.properties?.distance, total / 2);
    const measured = distance(start, mid.geometry.coordinates, {
      units: "kilometers",
    });
    assert.ok(Math.abs(measured / total - 0.5) < 1e-6, `midpoint sits at ${measured / total}`);
    // It does NOT sit on the linear interpolation.
    assert.ok(mid.geometry.coordinates[1] > 60.5, `lat ${mid.geometry.coordinates[1]}`);
    assert.deepEqual(points[2].geometry.coordinates, end);
  });

  it("walks a multi-segment line once and carries distance across vertices", () => {
    // Three 1-degree segments along the equator (~111.19 km each).
    const fc = line([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const { points } = run(pointsAlongGeometryTool, fc, {
      interval: 100,
      units: "kilometers",
    });
    const distances = points.map((p) => p.properties?.distance as number);
    // 0,100,200,300 then the closing end vertex (~333.58).
    assert.deepEqual(distances.slice(0, 4), [0, 100, 200, 300]);
    assert.equal(points.length, 5);
    assert.deepEqual(points[4].geometry.coordinates, [3, 0]);
    for (const p of points) {
      const measured = distance([0, 0], p.geometry.coordinates, {
        units: "kilometers",
      });
      assert.ok(Math.abs(measured - (p.properties?.distance as number)) < 1e-3);
    }
    // Longitudes are strictly increasing: no point was emitted twice at a vertex.
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i].geometry.coordinates[0] > points[i - 1].geometry.coordinates[0]);
    }
  });

  it("refuses an interval that would generate more points than the hard cap", () => {
    const { logs, points } = run(
      pointsAlongGeometryTool,
      line([
        [0, 0],
        [10, 0],
      ]),
      {
        interval: 0.000001,
        units: "meters",
      },
    );
    assert.equal(points.length, 0);
    assert.match(logs[0], /^Error: this interval would generate about/);
  });

  it("never snaps a point from a previous part when a part is degenerate", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [0, 0],
                [0, 0.001],
              ],
              // Every vertex identical: zero-length, ends where part 0 ended.
              [
                [0, 0.001],
                [0, 0.001],
              ],
            ],
          },
        },
      ],
    };
    const { points } = run(pointsAlongGeometryTool, fc, {
      interval: 1,
      units: "kilometers",
    });
    // Part 0: start + end. Part 1: its own end vertex only.
    assert.equal(points.length, 3);
    assert.equal(points[1].properties?.distance, Number(distance([0, 0], [0, 0.001]).toFixed(6)));
    assert.equal(points[2].properties?.distance, 0);
  });

  it("rejects a non-positive interval", () => {
    const { logs } = run(
      pointsAlongGeometryTool,
      line([
        [0, 0],
        [1, 0],
      ]),
      { interval: 0 },
    );
    assert.equal(logs[0], "Error: interval must be greater than 0");
  });
});

describe("extractVerticesTool", () => {
  it("emits one point per vertex with part and vertex indices", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "a" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const { points } = run(extractVerticesTool, fc, {});
    assert.equal(points.length, 4);
    assert.deepEqual(points[2].properties, {
      name: "a",
      vertex_index: 2,
      part_index: 0,
    });
    assert.deepEqual(points[2].geometry.coordinates, [1, 1]);
  });
});
