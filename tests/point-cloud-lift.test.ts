import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LabelHistory } from "../packages/plugins/src/plugins/point-cloud-annotation/history";
import {
  collectPolygons,
  selectPointsInPolygons,
} from "../packages/plugins/src/plugins/point-cloud-annotation/selection";

const ORIGIN: [number, number, number] = [-123, 44, 0];

/** A 10 x 10 grid of points at 0.1 degree spacing from the origin, z = row. */
function grid() {
  const positions: number[] = [];
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 10; col++) positions.push(col * 0.1, row * 0.1, row);
  }
  return {
    positions: Float32Array.from(positions),
    pointCount: 100,
    classifications: new Uint8Array(100).fill(1),
  };
}

/** A square polygon over grid cells [c0, c1) x [r0, r1), as lng/lat rings. */
function square(c0: number, r0: number, c1: number, r1: number): number[][] {
  const x0 = ORIGIN[0] + c0 * 0.1 - 0.05;
  const y0 = ORIGIN[1] + r0 * 0.1 - 0.05;
  const x1 = ORIGIN[0] + c1 * 0.1 - 0.05;
  const y1 = ORIGIN[1] + r1 * 0.1 - 0.05;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

describe("collectPolygons", () => {
  it("gathers Polygon, MultiPolygon and nested polygons, skipping other geometry", () => {
    const polygons = collectPolygons({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [square(0, 0, 2, 2)] },
        },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiPolygon",
            coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]],
          },
        },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [{ type: "Polygon", coordinates: [square(1, 1, 2, 2)] }],
          },
        },
        { type: "Feature", properties: {}, geometry: null as unknown as GeoJSON.Geometry },
      ],
    });
    assert.equal(polygons.length, 4);
    assert.equal(collectPolygons(undefined).length, 0);
  });
});

describe("selectPointsInPolygons", () => {
  it("lifts each polygon's footprint through the cloud, honoring holes and filters", () => {
    const cloud = grid();
    const outer = square(0, 0, 4, 4); // 16 points
    const hole = square(1, 1, 2, 2); // 1 point
    const [withHole, second] = selectPointsInPolygons(cloud, ORIGIN, [
      [outer, hole],
      [square(6, 6, 8, 8)],
    ]);
    assert.equal(withHole.length, 15);
    assert.ok(!withHole.includes(11), "the hole's point is excluded");
    assert.deepEqual([...second], [66, 67, 76, 77]);

    // A point covered by two polygons belongs to the first.
    const [first, overlapping] = selectPointsInPolygons(cloud, ORIGIN, [
      [square(0, 0, 2, 2)],
      [square(1, 1, 3, 3)],
    ]);
    assert.equal(first.length, 4);
    assert.equal(overlapping.length, 3);

    // Z and class filters apply as for a screen selection.
    cloud.classifications[0] = 7;
    const [filtered] = selectPointsInPolygons(cloud, ORIGIN, [[square(0, 0, 4, 4)]], {
      maxZ: 1,
      skipClasses: new Set([7]),
    });
    assert.deepEqual([...filtered], [1, 2, 3, 10, 11, 12, 13]);
  });
});

describe("LabelHistory.assignGroups", () => {
  it("gives each group a new instance and the class, as one undoable edit", () => {
    const classes = new Uint8Array(6).fill(1);
    const ids = new Uint32Array(6);
    const history = new LabelHistory();
    const result = history.assignGroups(
      "a",
      classes,
      ids,
      [Uint32Array.from([0, 1]), new Uint32Array(0), Uint32Array.from([1, 4, 5])],
      6,
      10,
    );
    // The empty group takes no id, and point 1 stays with its first group.
    assert.deepEqual(result, { points: 4, objects: 2 });
    assert.deepEqual([...ids], [10, 10, 0, 0, 11, 11]);
    assert.deepEqual([...classes], [6, 6, 1, 1, 6, 6]);
    history.undo(
      () => classes,
      () => ids,
    );
    assert.deepEqual([...ids], [0, 0, 0, 0, 0, 0]);
    assert.deepEqual([...classes], [1, 1, 1, 1, 1, 1]);
    history.redo(
      () => classes,
      () => ids,
    );
    assert.deepEqual([...ids], [10, 10, 0, 0, 11, 11]);
  });
});
