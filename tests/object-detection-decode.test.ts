import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeYolo,
  nonMaxSuppression,
  rgbBands,
  type Candidate,
} from "../packages/processing/src/object-detection";
import type { RasterData } from "../packages/processing/src/raster-client";

// A standard 3-level head at inputSize 32 yields 21 anchors
// ((32/8)² + (32/16)² + (32/32)² = 16 + 4 + 1). Tests use that so decodeYolo's
// anchor-count matching resolves the layout the way a real export would.
const INPUT = 32;
const ANCHORS = 21;

/** Build a YOLOv8/v11 output `[1, 4 + nc, anchors]` (channels-major, no
 * objectness) with one "hot" anchor carrying a box + class scores. */
function buildV8(
  nc: number,
  hot: { i: number; box: [number, number, number, number]; cls: number[] },
): { data: Float32Array; dims: number[] } {
  const c = 4 + nc;
  const data = new Float32Array(c * ANCHORS);
  const set = (chan: number, i: number, v: number) => {
    data[chan * ANCHORS + i] = v;
  };
  hot.box.forEach((v, k) => set(k, hot.i, v));
  hot.cls.forEach((v, k) => set(4 + k, hot.i, v));
  return { data, dims: [1, c, ANCHORS] };
}

/** Build a YOLOv5 output `[1, anchors, 5 + nc]` (anchor-major, with objectness). */
function buildV5(
  nc: number,
  hot: { i: number; box: [number, number, number, number]; obj: number; cls: number[] },
): { data: Float32Array; dims: number[] } {
  const c = 5 + nc;
  const data = new Float32Array(ANCHORS * c);
  const set = (i: number, chan: number, v: number) => {
    data[i * c + chan] = v;
  };
  hot.box.forEach((v, k) => set(hot.i, k, v));
  set(hot.i, 4, hot.obj);
  hot.cls.forEach((v, k) => set(hot.i, 5 + k, v));
  return { data, dims: [1, ANCHORS, c] };
}

describe("decodeYolo", () => {
  it("decodes the v8/v11 layout (channels-major, no objectness)", () => {
    // cx,cy,w,h = 16,16,8,8 -> box [12,12,20,20]; class 0 = 0.9, class 1 = 0.1.
    const { data, dims } = buildV8(2, {
      i: 5,
      box: [16, 16, 8, 8],
      cls: [0.9, 0.1],
    });
    const out = decodeYolo(data, dims, 0.5, INPUT);
    assert.equal(out.length, 1);
    assert.equal(out[0].classIndex, 0);
    assert.ok(Math.abs(out[0].score - 0.9) < 1e-6);
    assert.deepEqual(out[0].box, [12, 12, 20, 20]);
  });

  it("decodes the v5 layout (anchor-major, objectness × class)", () => {
    const { data, dims } = buildV5(2, {
      i: 7,
      box: [16, 16, 8, 8],
      obj: 0.9,
      cls: [0.8, 0.1],
    });
    const out = decodeYolo(data, dims, 0.5, INPUT);
    assert.equal(out.length, 1);
    assert.equal(out[0].classIndex, 0);
    // score = bestClassProb (0.8) × objectness (0.9) = 0.72.
    assert.ok(Math.abs(out[0].score - 0.72) < 1e-6);
  });

  it("resolves a v8 head with more classes than anchors (small input)", () => {
    // 80 classes -> 84 channels > 21 anchors. A bare `anchors > channels` rule
    // would misread this as v5 (treating channel 4 as objectness); the
    // anchor-count match must still pick the v8 layout.
    const cls = new Array(80).fill(0);
    cls[42] = 0.7;
    const { data, dims } = buildV8(80, { i: 3, box: [10, 10, 4, 4], cls });
    assert.deepEqual(dims, [1, 84, 21]);
    const out = decodeYolo(data, dims, 0.5, INPUT);
    assert.equal(out.length, 1);
    assert.equal(out[0].classIndex, 42);
    // v8 has no objectness, so the score is the raw class prob (not ×objectness).
    assert.ok(Math.abs(out[0].score - 0.7) < 1e-6);
  });

  it("throws on a non-3D output shape", () => {
    assert.throws(() => decodeYolo(new Float32Array(4), [1, 4], 0.5, INPUT));
  });
});

describe("nonMaxSuppression", () => {
  const box = (x: number): [number, number, number, number] => [x, 0, x + 10, 10];
  it("drops a lower-scoring box overlapping a kept one of the same class", () => {
    const cands: Candidate[] = [
      { box: box(0), classIndex: 0, score: 0.9 },
      { box: box(1), classIndex: 0, score: 0.5 }, // ~0.8 IoU with the first
    ];
    const kept = nonMaxSuppression(cands, 0.45);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].score, 0.9);
  });

  it("keeps overlapping boxes of different classes", () => {
    const cands: Candidate[] = [
      { box: box(0), classIndex: 0, score: 0.9 },
      { box: box(1), classIndex: 1, score: 0.5 },
    ];
    assert.equal(nonMaxSuppression(cands, 0.45).length, 2);
  });
});

describe("rgbBands divisor heuristic", () => {
  const raster = (values: number[]): RasterData => ({
    bands: [Float32Array.from(values)],
    width: values.length,
    height: 1,
    originX: 0,
    originY: 0,
    resX: 1,
    resY: 1,
    nodata: null,
    geoKeys: {},
  });

  it("scales 8-bit integer imagery by 255", () => {
    assert.equal(rgbBands(raster([0, 100, 200])).divisor, 255);
  });

  it("leaves already-normalised 0-1 data as-is", () => {
    assert.equal(rgbBands(raster([0.1, 0.5, 0.8])).divisor, 1);
  });

  it("auto-scales float reflectance peaking in (1.5, 255) by its own max", () => {
    // A value of 2.5 is non-integer, so it is treated as float, not 8-bit.
    assert.equal(rgbBands(raster([0.2, 1.8, 2.5])).divisor, 2.5);
  });

  it("auto-scales high-bit-depth data by its own max", () => {
    assert.equal(rgbBands(raster([0, 1000, 4000])).divisor, 4000);
  });
});
