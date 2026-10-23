import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeArrayBuffer } from "geotiff";
import {
  decodeLabelGrid,
  felzenszwalbLabels,
  felzenszwalbSegmentLabels,
  splitImageBands,
} from "@geolibre/processing";

/**
 * A width × height band whose value is `left` west of `split` and `right`
 * east, plus a periodic noise of amplitude `noise`.
 */
function band(
  width: number,
  height: number,
  split: number,
  left: number,
  right: number,
  noise = 0,
) {
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[y * width + x] = (x < split ? left : right) + ((x * 3 + y * 7) % 5) * noise;
    }
  }
  return values;
}

const distinct = (labels: Int32Array) => new Set(Array.from(labels).filter((l) => l > 0)).size;

describe("Felzenszwalb segmentation", () => {
  it("separates regions and merges within them", () => {
    const [w, h] = [30, 20];
    const labels = felzenszwalbLabels(
      [band(w, h, 15, 10, 100), band(w, h, 15, 50, 20)],
      w,
      h,
      null,
      // No smoothing: it would blur the boundary into columns of its own.
      { scale: 100, sigma: 0, minSize: 5 },
    );
    assert.equal(distinct(labels), 2);
    // Labels follow raster order, and each side is one object.
    assert.equal(labels[0], 1);
    assert.equal(labels[w - 1], 2);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) assert.equal(labels[y * w + x], x < 15 ? 1 : 2);
    }
  });

  it("matches scikit-image on a striped image", () => {
    // scikit-image's felzenszwalb (scale 100, sigma 0.5, min_size 5) on these
    // standardized bands finds 19 objects at noise 0.2 and 4 at noise 0.02.
    const [w, h] = [30, 20];
    const count = (noise: number) =>
      distinct(
        felzenszwalbLabels(
          [band(w, h, 15, 10, 100, noise), band(w, h, 15, 50, 20, noise)],
          w,
          h,
          null,
          { scale: 100, sigma: 0.5, minSize: 5 },
        ),
      );
    assert.equal(count(0.2), 19);
    assert.equal(count(0.02), 4);
  });

  it("gives more objects for a smaller scale, and merges ones below the minimum size", () => {
    const [w, h] = [40, 40];
    const noisy = new Float32Array(w * h).map((_, i) => ((i * 2654435761) >>> 0) % 97);
    const run = (scale: number, minSize: number) =>
      distinct(felzenszwalbLabels([noisy], w, h, null, { scale, sigma: 0, minSize }));
    assert.ok(run(10, 1) > run(1000, 1));
    const sizes = new Map<number, number>();
    for (const l of felzenszwalbLabels([noisy], w, h, null, { scale: 10, sigma: 0, minSize: 20 })) {
      sizes.set(l, (sizes.get(l) ?? 0) + 1);
    }
    assert.ok([...sizes.values()].every((size) => size >= 20));
  });

  it("leaves invalid pixels unlabeled and is deterministic", () => {
    const [w, h] = [12, 10];
    const bands = [band(w, h, 6, 0, 50)];
    const valid = new Uint8Array(w * h).fill(1);
    valid.fill(0, 0, w); // the first row has no data
    const params = { scale: 50, sigma: 0.5, minSize: 3 };
    const a = felzenszwalbLabels(bands, w, h, valid, params);
    assert.ok(Array.from(a.subarray(0, w)).every((l) => l === 0));
    assert.ok(Array.from(a.subarray(w)).every((l) => l > 0));
    assert.deepEqual(a, felzenszwalbLabels(bands, w, h, valid, params));
  });

  it("segments a GeoTIFF into a label raster on the same grid", async () => {
    const [w, h] = [20, 16];
    const left = band(w, h, 10, 20, 200);
    const right = band(w, h, 10, 60, 30);
    const values = new Float32Array(w * h * 2);
    for (let i = 0; i < w * h; i += 1) {
      values[i * 2] = left[i];
      values[i * 2 + 1] = right[i];
    }
    const tiff = writeArrayBuffer(values, {
      width: w,
      height: h,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
      ProjectedCSTypeGeoKey: 32617,
      GTModelTypeGeoKey: 1,
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const image = await splitImageBands(tiff);
    const params = { scale: 100, sigma: 0, minSize: 5 };
    const first = await felzenszwalbSegmentLabels(image, params);
    const grid = await decodeLabelGrid(first.labels);
    assert.equal(grid.width, w);
    assert.equal(grid.height, h);
    assert.equal(grid.raster.originX, 500000);
    assert.equal(distinct(grid.ids), 2);
    assert.equal(first.tool, "obia/felzenszwalb");
    assert.deepEqual(JSON.parse(first.args[0]), params);
    // The same image and parameters give the same labels, byte for byte.
    const again = await felzenszwalbSegmentLabels(image, params);
    assert.deepEqual(again.labels, first.labels);
  });

  it("refuses bands on different grids, and images over the limit", async () => {
    const tiff = (w: number, h: number) =>
      writeArrayBuffer(new Float32Array(w * h), {
        width: w,
        height: h,
        ModelPixelScale: [10, 10, 0],
        ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
        ProjectedCSTypeGeoKey: 32617,
        GTModelTypeGeoKey: 1,
      } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const a = await splitImageBands(tiff(8, 6));
    const b = await splitImageBands(tiff(6, 6));
    const image = { ...a, bandCount: 2, bands: [a.bands[0], { ...b.bands[0], index: 2 }] };
    await assert.rejects(
      felzenszwalbSegmentLabels(image, { scale: 100, sigma: 0, minSize: 1 }),
      /not on the same grid/,
    );
    // Same size, shifted origin: also refused.
    const shifted = writeArrayBuffer(new Float32Array(48), {
      width: 8,
      height: 6,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 500010, 4000000, 0],
      ProjectedCSTypeGeoKey: 32617,
      GTModelTypeGeoKey: 1,
    } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
    const c = await splitImageBands(shifted);
    await assert.rejects(
      felzenszwalbSegmentLabels(
        { ...a, bandCount: 2, bands: [a.bands[0], { ...c.bands[0], index: 2 }] },
        { scale: 100, sigma: 0, minSize: 1 },
      ),
      /not on the same grid/,
    );
    // An image over the limit is refused before its bands are decoded.
    await assert.rejects(
      felzenszwalbSegmentLabels(
        { ...a, width: 4096, height: 1025 },
        { scale: 100, sigma: 0, minSize: 1 },
      ),
      (err: unknown) => (err as { code?: string }).code === "image-too-large",
    );
  });
});
