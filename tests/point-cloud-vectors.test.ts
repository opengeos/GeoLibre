import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebMercatorViewport } from "@deck.gl/core";
import { createOffsetProjector } from "../packages/plugins/src/plugins/point-cloud-annotation/selection";
import {
  encodeVectors,
  loadVectors,
  snapToPoint,
  vectorLength,
  vectorsToGeoJson,
  vectorsToSegments,
  type VectorObject,
} from "../packages/plugins/src/plugins/point-cloud-annotation/vectors-panel";

const ORIGIN: [number, number, number] = [-123.07, 44.05, 0];
const UTM10 =
  'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';

/** A point `east`/`north` metres from the origin, at elevation `z`. */
function at(east: number, north: number, z: number): [number, number, number] {
  const my = 6378137 * (Math.PI / 180);
  const mx = my * Math.cos((ORIGIN[1] * Math.PI) / 180);
  return [ORIGIN[0] + east / mx, ORIGIN[1] + north / my, z];
}

describe("vector persistence", () => {
  it("round-trips vectors and drops malformed ones", () => {
    loadVectors([
      {
        url: "https://x/a.copc.laz",
        items: [
          { id: 4, kind: "polyline", classCode: 64, points: [at(0, 0, 100), at(3, 4, 100)] },
          { id: 4, kind: "keypoint", classCode: 15, points: [at(1, 1, 120)] },
          { id: 9, kind: "polygon", classCode: 6, points: [at(0, 0, 1), at(1, 0, 1)] },
          { id: 10, kind: "curve", classCode: 6, points: [at(0, 0, 1), at(1, 0, 1)] },
          { id: 11, kind: "polyline", classCode: 6, points: [[1, 2], at(1, 0, 1)] },
        ],
      },
      {
        url: "session:local",
        items: [{ id: 1, kind: "keypoint", classCode: 1, points: [at(0, 0, 0)] }],
      },
    ]);
    const saved = encodeVectors();
    // Local-file sources cannot be reopened, so they are not saved.
    assert.equal(saved.length, 1);
    const items = saved[0].items;
    // A too-short polygon, an unknown kind and a 2D vertex are dropped; a
    // duplicate id is renumbered.
    assert.deepEqual(
      items.map((item) => [item.id, item.kind]),
      [
        [4, "polyline"],
        [1, "keypoint"],
      ],
    );
    loadVectors(undefined);
    assert.deepEqual(encodeVectors(), []);
  });
});

describe("vector geometry", () => {
  const line: VectorObject = {
    id: 1,
    kind: "polyline",
    classCode: 64,
    points: [at(0, 0, 100), at(3, 4, 100), at(3, 4, 112)],
  };
  const square: VectorObject = {
    id: 2,
    kind: "polygon",
    classCode: 6,
    points: [at(0, 0, 5), at(10, 0, 5), at(10, 10, 5), at(0, 10, 5)],
  };
  const pole: VectorObject = { id: 3, kind: "keypoint", classCode: 15, points: [at(2, 2, 130)] };

  it("measures 3D length, closing a polygon's ring", () => {
    assert.ok(Math.abs(vectorLength(line) - 17) < 0.01, `${vectorLength(line)}`);
    assert.ok(Math.abs(vectorLength(square) - 40) < 0.01, `${vectorLength(square)}`);
    assert.equal(vectorLength(pole), 0);
  });

  it("writes 3D GeoJSON with one geometry type per kind", () => {
    const fc = vectorsToGeoJson([line, square, pole], (code) => `c${code}`);
    assert.deepEqual(
      fc.features.map((feature) => feature.geometry.type),
      ["LineString", "Polygon", "Point"],
    );
    const ring = (fc.features[1].geometry as GeoJSON.Polygon).coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[4]);
    assert.equal((fc.features[2].geometry as GeoJSON.Point).coordinates[2], 130);
    assert.equal(fc.features[0].properties?.class_name, "c64");
    assert.equal(fc.features[0].properties?.vertices, 3);
  });

  it("writes a Segments.ai pointcloud-vector label in the source CRS", () => {
    const label = vectorsToSegments([line, pole], UTM10);
    assert.deepEqual(
      label.annotations.map((annotation) => annotation.type),
      ["polyline", "point"],
    );
    const [a, b] = label.annotations[0].points;
    // UTM metres: 5 m apart horizontally (3-4-5), within the scale factor.
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 5) < 0.01);
    assert.ok(a[0] > 490000 && a[0] < 500000);
    assert.equal(label.annotations[1].points[0][2], 130);
    assert.equal(label.annotations[1].category_id, 15);
  });
});

describe("snapToPoint", () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: ORIGIN[0],
    latitude: ORIGIN[1],
    zoom: 19,
  });
  const offsets = [at(0, 0, 10), at(5, 0, 20), at(-5, 5, 30)];
  const positions = new Float32Array(
    offsets.flatMap(([lng, lat, z]) => [lng - ORIGIN[0], lat - ORIGIN[1], z]),
  );
  const data = { positions, coordinateOrigin: ORIGIN, pointCount: 3 };
  const project = createOffsetProjector(viewport, ORIGIN);

  it("returns the nearest drawn point with its own elevation", () => {
    const [x, y] = viewport.project([offsets[1][0], offsets[1][1], 20]);
    const snapped = snapToPoint(data, project, x + 3, y - 2, { zOffset: 0 });
    assert.ok(snapped);
    assert.equal(snapped![2], 20);
    assert.ok(Math.abs(snapped![0] - offsets[1][0]) < 1e-9);
  });

  it("skips excluded points and gives up beyond the snapping radius", () => {
    const [x, y] = viewport.project([offsets[1][0], offsets[1][1], 20]);
    assert.equal(snapToPoint(data, project, x, y, { zOffset: 0, skip: (i) => i === 1 }), null);
    assert.equal(snapToPoint(data, project, x + 200, y + 200, { zOffset: 0 }), null);
  });
});
