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
  PointLabelStore,
  decodeNodeEdits,
  encodeNodeEdits,
  rangeForIndex,
} from "../packages/plugins/src/plugins/point-cloud-annotation/label-store";
import { readFileSync } from "node:fs";
import { deflateSync } from "fflate";
import { createRequire } from "node:module";
import {
  initSync,
  compress_points,
  laszip_vlr_data,
} from "../packages/plugins/src/plugins/point-cloud-annotation/laz-encoder/laz_encoder.js";
import {
  buildSegmentsLabel,
  extractProjcsFromWkt,
  resolveExportCrs,
  verticalUnitFactor,
  WGS84_WKT,
  writeLas,
  writeLaz,
  writeNpy,
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
    assert.deepEqual(
      history.undo(() => classes),
      {
        cloudId: "a",
        indices: Uint32Array.from([0, 3]),
      },
    );
    assert.deepEqual([...classes], [1, 2, 1, 1]);
    assert.deepEqual(
      history.redo(() => classes),
      {
        cloudId: "a",
        indices: Uint32Array.from([0, 3]),
      },
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

  it("rejects a VLR payload too long for its uint16 length field", () => {
    assert.throws(
      () => writeLas(cloud, { crs: { ...resolveExportCrs(undefined), wkt: "x".repeat(70000) } }),
      /exceeds 65535/,
    );
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

describe("LAZ export", () => {
  it("round-trips through laz-perf to the same records as the LAS export", async () => {
    initSync({
      module: readFileSync(
        new URL(
          "../packages/plugins/src/plugins/point-cloud-annotation/laz-encoder/laz_encoder_bg.wasm",
          import.meta.url,
        ),
      ),
    });
    const count = 5000;
    const positions = new Float32Array(count * 3);
    const classifications = new Uint8Array(count);
    const colors = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (i % 97) * 1e-6;
      positions[i * 3 + 1] = Math.floor(i / 97) * 1e-6;
      positions[i * 3 + 2] = 100 + (i % 13) * 0.5;
      classifications[i] = i % 7;
      colors.set([i % 256, (i * 3) % 256, (i * 7) % 256, 255], i * 4);
    }
    const cloud = {
      positions,
      coordinateOrigin: ORIGIN,
      pointCount: count,
      classifications,
      colors,
      hasRGB: true,
    };
    const now = new Date(Date.UTC(2026, 8, 29));
    const las = new Uint8Array(writeLas(cloud, { now }));
    const laz = writeLaz(cloud, { compress_points, laszip_vlr_data }, { now });
    assert.ok(laz.length < las.length / 2, `LAZ ${laz.length} vs LAS ${las.length}`);
    assert.equal(laz[104], 7 | 0x80);
    // maplibre-gl-lidar <= 0.18.0 only recognises LAZ by this header field.
    assert.match(new TextDecoder().decode(laz.subarray(58, 90)), /laszip/i);

    const require = createRequire(import.meta.url);
    const { createLazPerf } = require("laz-perf/lib/node");
    const LazPerf = await createLazPerf();
    const file = LazPerf._malloc(laz.length);
    LazPerf.HEAPU8.set(laz, file);
    const reader = new LazPerf.LASZip();
    reader.open(file, laz.length);
    assert.equal(reader.getCount(), count);
    assert.equal(reader.getPointFormat(), 7);
    const recordLength = reader.getPointLength();
    assert.equal(recordLength, 36);
    const point = LazPerf._malloc(recordLength);
    const lasOffset = new DataView(las.buffer).getUint32(96, true);
    for (let i = 0; i < count; i++) {
      reader.getPoint(point);
      const decoded = LazPerf.HEAPU8.subarray(point, point + recordLength);
      const expected = las.subarray(
        lasOffset + i * recordLength,
        lasOffset + (i + 1) * recordLength,
      );
      if (!decoded.every((byte: number, k: number) => byte === expected[k])) {
        assert.fail(`record ${i} differs`);
      }
    }
    reader.delete();
    LazPerf._free(point);
    LazPerf._free(file);
  });
});

describe("writeNpy", () => {
  it("writes a 64-byte-aligned v1.0 header and one record per point", () => {
    const bytes = writeNpy({
      positions: new Float32Array([0, 0, 10, 0, 0, 12]),
      coordinateOrigin: ORIGIN,
      pointCount: 2,
      classifications: Uint8Array.from([2, 6]),
      intensities: Float32Array.from([0, 1]),
    });
    const view = new DataView(bytes.buffer);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
    const headerLength = view.getUint16(8, true);
    assert.equal((10 + headerLength) % 64, 0);
    const header = new TextDecoder().decode(bytes.subarray(10, 10 + headerLength));
    assert.match(header, /'shape': \(2,\)/);
    assert.ok(header.endsWith("\n"));
    assert.ok(!header.includes("'red'"));
    const recordSize = 27;
    assert.equal(bytes.length, 10 + headerLength + 2 * recordSize);
    const second = 10 + headerLength + recordSize;
    assert.equal(view.getFloat64(second + 16, true), 12);
    assert.equal(view.getUint16(second + 24, true), 65535);
    assert.equal(bytes[second + 26], 6);
  });
});

describe("stroke selection", () => {
  it("covers every pixel within the radius of the dragged path", () => {
    const mask = rasterizeShape({
      kind: "stroke",
      points: [
        [0, 0],
        [40, 0],
      ],
      radius: 5,
    });
    assert.ok(mask?.bits);
    const at = (x: number, y: number) => mask.bits![(y - mask.y0) * mask.width + (x - mask.x0)];
    assert.equal(at(20, 4), 1);
    assert.equal(at(20, -4), 1);
    assert.equal(at(45, 0), 1);
    assert.equal(at(20, 5), 1);
    assert.equal(mask.height, 11);
  });
});

describe("PointLabelStore", () => {
  it("round-trips node edits through the varint + deflate encoding", () => {
    const edits = new Map([
      [0, 6],
      [1, 6],
      [300, 2],
      [70000, 5],
    ]);
    assert.deepEqual([...decodeNodeEdits(encodeNodeEdits(edits))], [...edits]);
  });

  it("records edits by node key and re-applies them after the buffers move", () => {
    const store = new PointLabelStore();
    const first = {
      classifications: Uint8Array.from([1, 1, 1, 1, 1]),
      nodeRanges: [
        { key: "0-0-0-0", start: 0, count: 2 },
        { key: "1-0-0-0", start: 2, count: 3 },
      ],
    };
    first.classifications[3] = 6;
    assert.equal(store.record("https://x/a.copc.laz", first, [3]), 1);

    // After a reload the same node lands elsewhere in the buffers.
    const reloaded = {
      classifications: new Uint8Array(6).fill(1),
      nodeRanges: [
        { key: "1-0-0-0", start: 0, count: 3 },
        { key: "0-0-0-0", start: 4, count: 2 },
      ],
    };
    const restored = new PointLabelStore();
    restored.load(JSON.parse(JSON.stringify(store.encode())));
    assert.equal(restored.apply("https://x/a.copc.laz", reloaded), 1);
    assert.deepEqual([...reloaded.classifications], [1, 6, 1, 1, 1, 1]);
    assert.equal(restored.apply("https://x/other.laz", reloaded), 0);
  });

  it("finds a buffer index's node and ignores unloaded gaps", () => {
    const ranges = [
      { key: "a", start: 0, count: 2 },
      { key: "b", start: 5, count: 2 },
    ];
    assert.equal(rangeForIndex(ranges, 1)?.key, "a");
    assert.equal(rangeForIndex(ranges, 3), undefined);
    assert.equal(rangeForIndex(ranges, 6)?.key, "b");
  });

  it("drops a truncated node rather than mislabelling a point", () => {
    // Deflate of a lone continuation byte: a varint that never ends.
    const store = new PointLabelStore();
    const truncated = Buffer.from(deflateSync(Uint8Array.from([0x80]))).toString("base64");
    assert.throws(() => decodeNodeEdits(truncated), RangeError);
    store.load({ version: 1, sources: [{ url: "https://x/a.laz", nodes: { a: truncated } }] });
    assert.equal(store.isEmpty, true);
  });

  it("treats a malformed project state as empty", () => {
    const store = new PointLabelStore();
    store.load({ version: 2 });
    assert.equal(store.isEmpty, true);
    assert.equal(store.encode(), undefined);
  });
});
