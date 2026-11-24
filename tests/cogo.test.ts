import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polygon, Position } from "geojson";
import {
  azimuthBetween,
  constructedFeature,
  destinationPoint,
  distanceMeters,
  formatQuadrantBearing,
  geometryPaths,
  misclosure,
  parseAngle,
  parseBearing,
  snapToGeometries,
  tracePath,
  traverse,
} from "../apps/geolibre-desktop/src/lib/cogo";

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
}

/** Identity-ish projection: 100 px per degree, y down. */
const project = (p: Position) => ({ x: p[0] * 100, y: -p[1] * 100 });

describe("parseAngle / parseBearing", () => {
  it("parses decimal and DMS angles", () => {
    assert.equal(parseAngle("45.5"), 45.5);
    assert.equal(parseAngle("-45"), null);
    assert.equal(parseAngle("+45"), null);
    assert.equal(parseBearing("-45"), null);
    assert.equal(parseAngle("45°30'"), 45.5);
    assert.equal(parseAngle("45 30 36"), 45.51);
    assert.equal(parseAngle("45-30-36"), 45.51);
    close(parseAngle("45d30m36.5s")!, 45 + 30 / 60 + 36.5 / 3600);
    assert.equal(parseAngle("45 60"), null);
    assert.equal(parseAngle("45.5 30"), null);
    assert.equal(parseAngle("abc"), null);
    assert.equal(parseAngle(""), null);
  });

  it("parses azimuths and quadrant bearings", () => {
    assert.equal(parseBearing("135"), 135);
    assert.equal(parseBearing("360"), 0);
    assert.equal(parseBearing("N45E"), 45);
    assert.equal(parseBearing("S45°E"), 135);
    assert.equal(parseBearing("s 45 w"), 225);
    assert.equal(parseBearing("N 12°30' W"), 347.5);
    assert.equal(parseBearing("N95E"), null);
    assert.equal(parseBearing("400"), null);
    assert.equal(parseBearing("E45N"), null);
  });

  it("formats a quadrant bearing that parses back", () => {
    assert.equal(formatQuadrantBearing(135), `S 45°00'00" E`);
    assert.equal(formatQuadrantBearing(347.5), `N 12°30'00" W`);
    close(parseBearing(formatQuadrantBearing(222.25))!, 222.25);
  });
});

describe("COGO traverse", () => {
  it("places a vertex by azimuth and distance", () => {
    const east = destinationPoint([0, 0], 90, 1000);
    close(east[1], 0);
    close(distanceMeters([0, 0], east), 1000, 1e-6);
    const north = destinationPoint([10, 20], 0, 5000);
    close(north[0], 10);
    close(distanceMeters([10, 20], north), 5000, 1e-6);
    close(azimuthBetween([10, 20], north), 0, 1e-9);
  });

  it("closes a square traverse", () => {
    const vertices = traverse(
      [-122.4, 37.8],
      [
        { azimuth: 0, distance: 100 },
        { azimuth: 90, distance: 100 },
        { azimuth: 180, distance: 100 },
        { azimuth: 270, distance: 100 },
      ],
    );
    assert.equal(vertices.length, 5);
    // Great-circle legs on the sphere leave a tiny convergence misclosure
    // (about 2 mm for a 100 m square at this latitude), never more than 1 cm.
    assert.ok(misclosure(vertices) < 1e-2, String(misclosure(vertices)));
    assert.ok(misclosure(vertices) > 0);
  });

  it("builds line and polygon features", () => {
    const pts: Position[] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    assert.equal(constructedFeature(pts, "line")?.geometry.type, "LineString");
    const polygon = constructedFeature(pts, "polygon")!.geometry as Polygon;
    assert.deepEqual(polygon.coordinates[0], [...pts, [0, 0]]);
    assert.equal(constructedFeature([[0, 0]], "line"), null);
    assert.equal(constructedFeature(pts.slice(0, 2), "polygon"), null);
  });
});

const SQUARE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

describe("snapping", () => {
  it("prefers a vertex in range over a closer segment", () => {
    // Click 4 px from the vertex (1, 0) and 0 px from the bottom edge.
    const hit = snapToGeometries({ x: 96, y: 0 }, [SQUARE], project, 10, 10)!;
    assert.equal(hit.kind, "vertex");
    assert.deepEqual(hit.position, [1, 0]);
  });

  it("snaps to a segment when no vertex is in range", () => {
    const hit = snapToGeometries({ x: 50, y: 3 }, [SQUARE], project, 10, 10)!;
    assert.equal(hit.kind, "segment");
    close(hit.position[0], 0.5);
    close(hit.position[1], 0);
    assert.deepEqual(hit.location, { path: 0, segment: 0, t: 0.5 });
  });

  it("honours separate vertex and segment tolerances", () => {
    assert.equal(snapToGeometries({ x: 50, y: 8 }, [SQUARE], project, 10, 5), null);
    assert.equal(snapToGeometries({ x: 108, y: 0 }, [SQUARE], project, 5, 10)?.kind, "segment");
  });

  it("returns null when nothing is in range", () => {
    assert.equal(snapToGeometries({ x: 500, y: 500 }, [SQUARE], project, 10), null);
  });
});

describe("tracePath", () => {
  const ring = geometryPaths(SQUARE)[0];

  it("takes the shorter way round a ring", () => {
    // From the middle of the bottom edge to the middle of the right edge.
    const traced = tracePath(
      ring,
      { path: 0, segment: 0, t: 0.5 },
      { path: 0, segment: 1, t: 0.5 },
    );
    assert.deepEqual(traced, [
      [0.5, 0],
      [1, 0],
      [1, 0.5],
    ]);
  });

  it("takes the longer way round on request", () => {
    const traced = tracePath(
      ring,
      { path: 0, segment: 0, t: 0.5 },
      { path: 0, segment: 1, t: 0.5 },
      true,
    );
    assert.deepEqual(traced, [
      [0.5, 0],
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0.5],
    ]);
  });

  it("wraps across the ring's start vertex", () => {
    // From the left edge (segment 3) to the bottom edge (segment 0).
    const traced = tracePath(
      ring,
      { path: 0, segment: 3, t: 0.5 },
      { path: 0, segment: 0, t: 0.5 },
    );
    assert.deepEqual(traced, [
      [0, 0.5],
      [0, 0],
      [0.5, 0],
    ]);
  });

  it("follows an open line in either direction", () => {
    const line: Position[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    assert.deepEqual(
      tracePath(line, { path: 0, segment: 0, t: 0.5 }, { path: 0, segment: 2, t: 0 }),
      [
        [0.5, 0],
        [1, 0],
        [2, 0],
      ],
    );
    assert.deepEqual(
      tracePath(line, { path: 0, segment: 2, t: 0.5 }, { path: 0, segment: 0, t: 0.5 }),
      [
        [2.5, 0],
        [2, 0],
        [1, 0],
        [0.5, 0],
      ],
    );
  });

  it("traces between two snapped vertices", () => {
    const a = snapToGeometries({ x: 0, y: 0 }, [SQUARE], project, 5)!;
    const b = snapToGeometries({ x: 100, y: -100 }, [SQUARE], project, 5)!;
    const traced = tracePath(ring, a.location, b.location);
    assert.equal(traced.length, 3);
    assert.deepEqual(traced[0], [0, 0]);
    assert.deepEqual(traced[2], [1, 1]);
  });
});

it("traces a complete ring for coincident endpoints in long-way mode", () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  const location = { path: 0, segment: 0, t: 0 };
  assert.deepEqual(tracePath(ring, location, location, false), [[0, 0]]);
  assert.deepEqual(tracePath(ring, location, location, true), ring);
});
