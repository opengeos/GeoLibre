import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArcType, Cartesian3, PolygonGeometry, PolygonHierarchy } from "@cesium/engine";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { slicePoleWrappingPolygons } from "../packages/map/src/cesium-polar-polygons";

// Polygons that reach or go round a pole on the Cesium globe (#3476). The
// geometry is built with Cesium's own PolygonGeometry, the code its polygon
// worker runs, so a slice it cannot triangulate fails here as it did on the
// globe. (The unsliced outline is not built here: depending on the latitude
// Cesium either throws or never returns.)

/** An Antarctica-like outline: a coast round the pole, closed along it across the antimeridian. */
function antarctica(): Feature<Polygon> {
  const coast: Position[] = [];
  for (let lon = 180; lon >= -180; lon -= 10)
    coast.push([lon, -70 - 5 * Math.cos((lon * Math.PI) / 60)]);
  const ring: Position[] = [...coast, [-180, -90], [180, -90], coast[0]];
  return {
    type: "Feature",
    properties: { NAME: "Antarctica" },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

/** Builds each polygon the way Cesium's ground worker does (rhumb edges, a shadow volume). */
function buildAll(feature: Feature): void {
  const geometry = feature.geometry as Polygon | MultiPolygon;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const cartesians = (ring: Position[]) => ring.map(([x, y]) => Cartesian3.fromDegrees(x, y));
  for (const rings of polygons) {
    PolygonGeometry.createGeometry(
      new PolygonGeometry({
        polygonHierarchy: new PolygonHierarchy(
          cartesians(rings[0]),
          rings.slice(1).map((hole) => new PolygonHierarchy(cartesians(hole))),
        ),
        arcType: ArcType.RHUMB,
        height: -1000,
        extrudedHeight: 9000,
      }),
    );
  }
}

describe("slicePoleWrappingPolygons", () => {
  it("cuts a pole-wrapping polygon into quarter slices Cesium can build", () => {
    const source = antarctica();
    const sliced = slicePoleWrappingPolygons(source);
    assert.notEqual(sliced, source);
    assert.equal(sliced.geometry.type, "MultiPolygon");
    // The generic return keeps the input type; slicing turns it into a MultiPolygon.
    const slices = (sliced.geometry as unknown as MultiPolygon).coordinates;
    assert.equal(slices.length, 4);
    for (const [shell] of slices) {
      const lons = shell.map((p) => p[0]);
      assert.ok(Math.max(...lons) - Math.min(...lons) <= 90 + 1e-9, "at most a quarter wide");
      assert.ok(
        shell.every((p) => Math.abs(p[1]) < 90),
        "no vertex on the pole",
      );
      assert.deepEqual(shell[0], shell[shell.length - 1], "closed ring");
    }
    assert.equal(sliced.properties?.NAME, "Antarctica");
    assert.doesNotThrow(() => buildAll(sliced));
    // The input is not mutated.
    assert.equal((source.geometry as Polygon).coordinates[0].at(-2)?.[1], -90);
  });

  it("slices a ring round a pole that has no pole vertices", () => {
    const ring: Position[] = [];
    for (let lon = -170; lon <= 180; lon += 10) ring.push([lon, 80]);
    ring.push(ring[0]);
    const arctic: Feature<MultiPolygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [ring],
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    };
    const sliced = slicePoleWrappingPolygons(arctic);
    const parts = (sliced.geometry as MultiPolygon).coordinates;
    assert.equal(parts.length, 5, "four slices plus the untouched small polygon");
    assert.deepEqual(parts[4], arctic.geometry.coordinates[1]);
    // Closed along the north pole, just short of it.
    assert.ok(parts.slice(0, 4).every(([shell]) => shell.some((p) => p[1] > 89.99)));
    assert.doesNotThrow(() => buildAll(sliced));
  });

  it("pulls a pole vertex of an ordinary polygon just short of the pole", () => {
    const wedge: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, -80],
            [30, -80],
            [15, -90],
            [0, -80],
          ],
        ],
      },
    };
    const out = slicePoleWrappingPolygons(wedge);
    assert.equal(out.geometry.type, "Polygon");
    const ring = (out.geometry as Polygon).coordinates[0];
    assert.equal(ring[2][0], 15);
    assert.ok(ring[2][1] > -90 && ring[2][1] < -89.99);
    assert.doesNotThrow(() => buildAll(out));
  });

  it("returns every other feature unchanged", () => {
    const square: Feature<Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [170, 10],
            [-170, 10],
            [-170, 20],
            [170, 20],
            [170, 10],
          ],
        ],
      },
    };
    assert.equal(
      slicePoleWrappingPolygons(square),
      square,
      "an antimeridian crossing is not a pole wrap",
    );
    const point: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 90] },
    };
    assert.equal(slicePoleWrappingPolygons(point), point);
    const empty = { type: "Feature", properties: {}, geometry: null } as unknown as Feature;
    assert.equal(slicePoleWrappingPolygons(empty), empty);
  });
});
