import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebMercatorViewport } from "@deck.gl/core";
import { ColorSchemeProcessor, type PointCloudData } from "maplibre-gl-lidar";
import {
  ASPRS_CLASSES,
  countClasses,
} from "../packages/plugins/src/plugins/point-cloud-annotation/classes";
import { LabelHistory } from "../packages/plugins/src/plugins/point-cloud-annotation/history";
import {
  buildSegmentsLabel,
  extractProjcsFromWkt,
  resolveExportCrs,
  verticalUnitFactor,
  WGS84_WKT,
  writeLas,
} from "../packages/plugins/src/plugins/point-cloud-annotation/las-writer";
import {
  combineSelection,
  createOffsetProjector,
  rasterizeShape,
  selectPointsInShape,
  type ProjectionViewport,
} from "../packages/plugins/src/plugins/point-cloud-annotation/selection";

const ORIGIN: [number, number, number] = [-123.07, 44.05, 0];

function viewport(): ProjectionViewport & { project(xyz: number[]): number[] } {
  return new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: ORIGIN[0],
    latitude: ORIGIN[1],
    zoom: 17,
    pitch: 45,
    bearing: 30,
  }) as unknown as ProjectionViewport & { project(xyz: number[]): number[] };
}

describe("createOffsetProjector", () => {
  it("matches deck.gl's exact projection for points near the origin", () => {
    const vp = viewport();
    const project = createOffsetProjector(vp, ORIGIN);
    const out = new Float64Array(2);
    for (const [dLng, dLat, z] of [
      [0, 0, 0],
      [0.001, -0.0005, 120],
      [-0.0008, 0.0009, 35],
    ]) {
      assert.ok(project(dLng, dLat, z, out));
      const [x, y] = vp.project([ORIGIN[0] + dLng, ORIGIN[1] + dLat, z]);
      assert.ok(Math.abs(out[0] - x) < 0.5, `x ${out[0]} vs ${x}`);
      assert.ok(Math.abs(out[1] - y) < 0.5, `y ${out[1]} vs ${y}`);
    }
  });
});

describe("rasterizeShape", () => {
  it("fills a triangle with even-odd scanlines", () => {
    const mask = rasterizeShape({
      kind: "polygon",
      points: [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
    });
    assert.ok(mask?.bits);
    const at = (x: number, y: number) => mask.bits![(y - mask.y0) * mask.width + (x - mask.x0)];
    assert.equal(at(1, 1), 1);
    assert.equal(at(8, 8), 0);
  });

  it("rejects degenerate shapes", () => {
    assert.equal(rasterizeShape({ kind: "rect", x0: 5, y0: 5, x1: 5.5, y1: 20 }), null);
    assert.equal(
      rasterizeShape({
        kind: "polygon",
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
      null,
    );
  });
});

describe("selectPointsInShape", () => {
  const vp = viewport();
  const project = createOffsetProjector(vp, ORIGIN);
  // Point 0 at the centre, 1 far outside the view, 2 at the centre but high.
  const cloud = {
    positions: new Float32Array([0, 0, 0, 0.05, 0.05, 0, 0, 0, 500]),
    classifications: new Uint8Array([2, 2, 6]),
    pointCount: 3,
    zOffset: 0,
  };
  const [cx, cy] = vp.project([ORIGIN[0], ORIGIN[1], 0]);
  const box = { kind: "rect" as const, x0: cx - 20, y0: cy - 20, x1: cx + 20, y1: cy + 20 };

  it("keeps points inside the drawn rectangle", () => {
    assert.deepEqual([...selectPointsInShape(cloud, project, box)], [0]);
  });

  it("applies the Z range and class filters", () => {
    const [hx, hy] = vp.project([ORIGIN[0], ORIGIN[1], 500]);
    const around = { kind: "rect" as const, x0: hx - 20, y0: hy - 20, x1: hx + 20, y1: hy + 20 };
    assert.deepEqual([...selectPointsInShape(cloud, project, around)], [2]);
    assert.deepEqual([...selectPointsInShape(cloud, project, around, { maxZ: 100 })], []);
    assert.deepEqual(
      [...selectPointsInShape(cloud, project, box, { onlyClasses: new Set([6]) })],
      [],
    );
    assert.deepEqual(
      [...selectPointsInShape(cloud, project, box, { skipClasses: new Set([2]) })],
      [],
    );
  });
});

describe("combineSelection", () => {
  const a = Uint32Array.from([1, 3, 5]);
  const b = Uint32Array.from([3, 4]);
  it("replaces, unions and subtracts", () => {
    assert.deepEqual([...combineSelection(a, b, "replace")], [3, 4]);
    assert.deepEqual([...combineSelection(a, b, "add")], [1, 3, 4, 5]);
    assert.deepEqual([...combineSelection(a, b, "subtract")], [1, 5]);
  });
});

describe("LabelHistory", () => {
  it("assigns, undoes and redoes only the points that changed", () => {
    const classes = new Uint8Array([1, 2, 1, 1]);
    const history = new LabelHistory();
    assert.equal(history.assign("a", classes, Uint32Array.from([0, 1, 3]), 2), 2);
    assert.deepEqual([...classes], [2, 2, 1, 2]);
    assert.equal(
      history.undo(() => classes),
      "a",
    );
    assert.deepEqual([...classes], [1, 2, 1, 1]);
    assert.equal(
      history.redo(() => classes),
      "a",
    );
    assert.deepEqual([...classes], [2, 2, 1, 2]);
    assert.equal(history.assign("a", classes, Uint32Array.from([0]), 2), 0);
    assert.equal(history.canRedo, false);
  });

  it("drops the oldest edit past its limit", () => {
    const classes = new Uint8Array(4);
    const history = new LabelHistory(2);
    history.assign("a", classes, Uint32Array.from([0]), 1);
    history.assign("a", classes, Uint32Array.from([1]), 1);
    history.assign("a", classes, Uint32Array.from([2]), 1);
    history.undo(() => classes);
    history.undo(() => classes);
    assert.equal(
      history.undo(() => classes),
      null,
    );
    assert.deepEqual([...classes], [1, 0, 0, 0]);
  });
});

describe("countClasses", () => {
  it("counts only codes present", () => {
    assert.deepEqual(
      [...countClasses(Uint8Array.from([2, 2, 6]))],
      [
        [2, 2],
        [6, 1],
      ],
    );
  });
});

describe("LAS export", () => {
  const cloud = {
    positions: new Float32Array([0, 0, 10, 0.0001, 0.0002, 12.5]),
    coordinateOrigin: ORIGIN,
    pointCount: 2,
    classifications: Uint8Array.from([2, 6]),
    intensities: Float32Array.from([0.5, 1]),
    colors: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]),
    hasRGB: true,
    extraAttributes: {
      ReturnNumber: Uint8Array.from([1, 2]),
      NumberOfReturns: Uint8Array.from([2, 2]),
    },
  };

  it("writes a LAS 1.4 header, WKT VLR and format 7 records", () => {
    const bytes = writeLas(cloud, { now: new Date(Date.UTC(2026, 8, 29)) });
    const view = new DataView(bytes);
    assert.equal(String.fromCharCode(...new Uint8Array(bytes, 0, 4)), "LASF");
    // WKT CRS (bit 4) plus standard GPS time (bit 0), required for formats 6-10.
    assert.equal(view.getUint16(6, true), 0x11);
    assert.equal(view.getUint8(24), 1);
    assert.equal(view.getUint8(25), 4);
    assert.equal(view.getUint8(104), 7);
    assert.equal(view.getUint16(105, true), 36);
    assert.equal(Number(view.getBigUint64(247, true)), 2);
    const pointOffset = view.getUint32(96, true);
    assert.equal(bytes.byteLength, pointOffset + 2 * 36);
    const xScale = view.getFloat64(131, true);
    const xOffset = view.getFloat64(155, true);
    const x0 = view.getInt32(pointOffset, true) * xScale + xOffset;
    assert.ok(Math.abs(x0 - ORIGIN[0]) < 1e-6);
    assert.equal(view.getUint8(pointOffset + 16), 2);
    assert.equal(view.getUint8(pointOffset + 36 + 16), 6);
    assert.equal(view.getUint8(pointOffset + 36 + 14), 2 | (2 << 4));
    assert.equal(view.getUint16(pointOffset + 12, true), 32768);
    assert.equal(view.getUint16(pointOffset + 30, true), 65535);
    assert.equal(Number(view.getBigUint64(255, true)), 1);
    assert.equal(Number(view.getBigUint64(263, true)), 1);
  });

  it("reprojects to a projected source CRS and restores feet", () => {
    const wkt =
      'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const crs = resolveExportCrs(wkt);
    assert.equal(crs.geographic, false);
    const [x, y] = crs.forward(ORIGIN[0], ORIGIN[1]);
    assert.ok(x > 490000 && x < 500000, `x ${x}`);
    assert.ok(y > 4870000 && y < 4890000, `y ${y}`);
    assert.equal(
      verticalUnitFactor('UNIT["US survey foot",0.3048006096012192]'),
      0.3048006096012192,
    );
    assert.equal(extractProjcsFromWkt(`COMPD_CS["x",${wkt},VERT_CS["v"]]`), wkt);
  });

  it("falls back to WGS 84 for a missing or unparseable WKT", () => {
    assert.equal(resolveExportCrs(undefined).wkt, WGS84_WKT);
    assert.equal(resolveExportCrs("not a crs").wkt, WGS84_WKT);
  });
});

describe("buildSegmentsLabel", () => {
  it("maps each class to one annotation, index-aligned with the points", () => {
    const label = buildSegmentsLabel(Uint8Array.from([2, 6, 2]), 3, (code) => `c${code}`);
    assert.deepEqual(label.point_annotations, [1, 2, 1]);
    assert.deepEqual(label.annotations, [
      { id: 1, category_id: 2 },
      { id: 2, category_id: 6 },
    ]);
    assert.deepEqual(label.categories, [
      { id: 2, name: "c2" },
      { id: 6, name: "c6" },
    ]);
  });
});

describe("ASPRS_CLASSES colour mirror", () => {
  it("matches the colours maplibre-gl-lidar renders for each class", () => {
    // The package does not export CLASSIFICATION_COLORS from its root, so read
    // them back through its public colour processor.
    const count = ASPRS_CLASSES.length;
    const data = {
      positions: new Float32Array(count * 3),
      coordinateOrigin: [0, 0, 0],
      classifications: Uint8Array.from(ASPRS_CLASSES.map((entry) => entry.code)),
      pointCount: count,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      hasRGB: false,
      hasIntensity: false,
      hasClassification: true,
    } as unknown as PointCloudData;
    const colors = new ColorSchemeProcessor().getColors(data, "classification");
    ASPRS_CLASSES.forEach((entry, i) => {
      assert.deepEqual([...colors.subarray(i * 4, i * 4 + 3)], entry.color, `class ${entry.code}`);
    });
  });
});
