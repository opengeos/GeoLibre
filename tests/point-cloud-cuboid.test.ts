import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cuboidCorners,
  fitCuboid,
  fromBoxFrame,
  growCluster,
  localFrame,
  pointsInCuboid,
  toBoxFrame,
  type Cuboid,
  type OffsetPoints,
} from "../packages/plugins/src/plugins/point-cloud-annotation/cuboid";

const ORIGIN: [number, number, number] = [-123.07, 44.05, 0];
const frame = localFrame(ORIGIN[1]);

/** Builds a cloud from points given in local metres (east, north, up). */
function cloud(metres: [number, number, number][]): OffsetPoints {
  const positions = new Float32Array(metres.length * 3);
  metres.forEach(([e, n, z], i) => {
    positions[i * 3] = e / frame.mx;
    positions[i * 3 + 1] = n / frame.my;
    positions[i * 3 + 2] = z;
  });
  return { positions, coordinateOrigin: ORIGIN, pointCount: metres.length };
}

/** A filled rotated rectangle of points, 4 x 2 m, heading 30 degrees. */
function rotatedBlock(): [number, number, number][] {
  const out: [number, number, number][] = [];
  const yaw = (30 * Math.PI) / 180;
  for (let u = -2; u <= 2; u += 0.25)
    for (let v = -1; v <= 1; v += 0.25)
      for (const z of [100, 101.5])
        out.push([
          10 + u * Math.cos(yaw) - v * Math.sin(yaw),
          5 + u * Math.sin(yaw) + v * Math.cos(yaw),
          z,
        ]);
  return out;
}

describe("box frame", () => {
  it("round-trips through the box frame", () => {
    const box: Cuboid = { center: [ORIGIN[0], ORIGIN[1], 50], size: [4, 2, 2], yaw: 0.7 };
    const [lng, lat, z] = fromBoxFrame(box, 1.5, -0.5, 0.25);
    const back = toBoxFrame(box, lng, lat, z);
    back.forEach((value, i) => assert.ok(Math.abs(value - [1.5, -0.5, 0.25][i]) < 1e-6));
  });

  it("puts the eight corners at half-extents", () => {
    const box: Cuboid = { center: [ORIGIN[0], ORIGIN[1], 50], size: [4, 2, 6], yaw: 0 };
    const corners = cuboidCorners(box);
    assert.equal(corners.length, 8);
    const [x, y, z] = toBoxFrame(box, ...corners[6]);
    assert.ok(Math.abs(x - 2) < 1e-6 && Math.abs(y - 1) < 1e-6 && Math.abs(z - 3) < 1e-9);
  });
});

describe("fitCuboid", () => {
  it("recovers a rotated block's size, heading and centre", () => {
    const points = cloud(rotatedBlock());
    const indices = Uint32Array.from({ length: points.pointCount }, (_, i) => i);
    const box = fitCuboid(points, indices)!;
    assert.ok(Math.abs(box.size[0] - 4) < 1e-3, `length ${box.size[0]}`);
    assert.ok(Math.abs(box.size[1] - 2) < 1e-3, `width ${box.size[1]}`);
    assert.ok(Math.abs(box.size[2] - 1.5) < 1e-6);
    const heading = ((box.yaw * 180) / Math.PI + 360) % 180;
    assert.ok(Math.abs(heading - 30) < 0.01, `heading ${heading}`);
    const [x, y] = toBoxFrame(box, ORIGIN[0] + 10 / frame.mx, ORIGIN[1] + 5 / frame.my, 100.75);
    assert.ok(Math.hypot(x, y) < 1e-3);
  });

  it("returns null for no points", () => {
    assert.equal(fitCuboid(cloud([[0, 0, 0]]), []), null);
  });
});

describe("pointsInCuboid", () => {
  it("keeps the points inside a rotated box and honours the margin", () => {
    const points = cloud([...rotatedBlock(), [10, 5, 110], [30, 30, 100]]);
    const all = Uint32Array.from({ length: points.pointCount - 2 }, (_, i) => i);
    const box = fitCuboid(points, all)!;
    const inside = pointsInCuboid(points, box);
    assert.equal(inside.length, points.pointCount - 2);
    // The point 9 m above is only caught by a 10 m margin.
    assert.equal(pointsInCuboid(points, box, 10).length, points.pointCount - 1);
  });
});

describe("growCluster", () => {
  it("grows through connected points and stops at a gap or the floor", () => {
    const line: [number, number, number][] = [];
    for (let i = 0; i < 20; i++) line.push([i * 0.3, 0, 10]);
    line.push([20, 0, 10]); // far away
    line.push([0.3, 0.2, 0]); // ground, below the floor
    const points = cloud(line);
    const cluster = growCluster(points, 0, { radius: 0.5, minZ: 5 });
    assert.equal(cluster.length, 20);
    assert.ok(!cluster.includes(20) && !cluster.includes(21));
  });
});

describe("object view editing", async () => {
  const { dragBox, hitHandle } =
    await import("../packages/plugins/src/plugins/point-cloud-annotation/object-views");
  const box: Cuboid = { center: [ORIGIN[0], ORIGIN[1], 100], size: [4, 2, 3], yaw: 0 };

  it("maps the pointer to the handle under it", () => {
    assert.equal(hitHandle("top", box, 0, 0, 0.1), "move");
    assert.equal(hitHandle("top", box, 2, 0.5, 0.1), "max-a");
    assert.equal(hitHandle("side", box, 0, -1.5, 0.1), "min-b");
    assert.equal(hitHandle("front", box, 5, 0, 0.1), null);
    assert.equal(hitHandle("top", box, 2.3, 0, 0.1), "rotate");
    // A box thinner than the reach: the nearer face wins.
    const thin: Cuboid = { ...box, size: [4, 2, 0.2] };
    assert.equal(hitHandle("side", thin, 0, 0.12, 0.5), "max-b");
    assert.equal(hitHandle("side", thin, 0, -0.12, 0.5), "min-b");
  });

  it("resizes against the opposite face", () => {
    const grown = dragBox("top", box, "max-a", 2, 0, 3, 0);
    assert.ok(Math.abs(grown.size[0] - 5) < 1e-9);
    const [x] = toBoxFrame(box, ...grown.center);
    assert.ok(Math.abs(x - 0.5) < 1e-6);
    const raised = dragBox("side", box, "max-b", 0, 1.5, 0, 2.5);
    assert.ok(Math.abs(raised.size[2] - 4) < 1e-9);
    assert.ok(Math.abs(raised.center[2] - 100.5) < 1e-9);
  });

  it("moves and rotates", () => {
    const moved = dragBox("front", box, "move", 0, 0, 1, 2);
    const [, y, z] = toBoxFrame(box, ...moved.center);
    assert.ok(Math.abs(y - 1) < 1e-6 && Math.abs(z - 2) < 1e-9);
    const turned = dragBox("top", box, "rotate", 2.3, 0, 0, 2.3);
    assert.ok(Math.abs(turned.yaw - Math.PI / 2) < 1e-9);
  });
});

describe("cuboid persistence and export", async () => {
  const { cuboidsToGeoJson, cuboidsToSegments, encodeCuboids, loadCuboids } =
    await import("../packages/plugins/src/plugins/point-cloud-annotation/cuboid-panel");
  const box: Cuboid = { center: [ORIGIN[0], ORIGIN[1], 100], size: [4, 2, 3], yaw: Math.PI / 6 };

  it("round-trips boxes through the project state and skips local-file sources", () => {
    loadCuboids([
      {
        url: "https://x/a.copc.laz",
        boxes: [{ id: 3, classCode: 6, center: box.center, size: box.size, yaw: box.yaw }],
      },
      {
        url: "https://x/b.laz",
        boxes: [{ id: 1, classCode: 6, center: [1, 2], size: [1, 1, 1], yaw: 0 }],
      },
    ]);
    const saved = encodeCuboids();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].url, "https://x/a.copc.laz");
    assert.deepEqual(saved[0].boxes[0], {
      id: 3,
      classCode: 6,
      center: box.center,
      size: box.size,
      yaw: box.yaw,
    });
    loadCuboids(undefined);
    assert.deepEqual(encodeCuboids(), []);
  });

  it("writes a closed footprint polygon with the box's extent", () => {
    const fc = cuboidsToGeoJson([{ id: 1, classCode: 6, box }], (code) => `c${code}`);
    const ring = (fc.features[0].geometry as GeoJSON.Polygon).coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[4]);
    const props = fc.features[0].properties!;
    assert.equal(props.class_name, "c6");
    assert.equal(props.z_min, 98.5);
    assert.equal(props.height_m, 3);
    assert.ok(Math.abs(props.yaw_deg - 30) < 1e-9);
  });

  it("writes Segments.ai cuboids in the source CRS (grid yaw, CRS units)", () => {
    // UTM 10N in metres: dimensions stay ~metres (scale factor ~0.9996).
    const wkt =
      'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const label = cuboidsToSegments([{ id: 7, classCode: 5, box }], wkt);
    const cuboid = label.annotations[0];
    assert.equal(cuboid.category_id, 5);
    assert.ok(cuboid.position.x > 490000 && cuboid.position.x < 500000);
    assert.ok(Math.abs(cuboid.dimensions.x - 4) < 0.01, `length ${cuboid.dimensions.x}`);
    assert.equal(cuboid.dimensions.z, 3);
    // Near the central meridian grid north is within a degree of true north.
    assert.ok(Math.abs(cuboid.yaw - Math.PI / 6) < 0.02, `yaw ${cuboid.yaw}`);
  });
});
