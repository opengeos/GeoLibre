import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  assertByteServing,
  buildInlineZarrRefs,
  buildInlineZarrStore,
  composeColormappedImage,
  composeRgbImage,
  gridBounds,
  gridPixelAt,
  openLocalNetcdf,
  percentileClim,
  type InlineZarrGrid,
} from "../packages/plugins/src/plugins/local-netcdf";
import { KerchunkReferenceStore } from "../packages/plugins/src/plugins/kerchunk-reference-store";

/** Read a test fixture file as an ArrayBuffer. */
function fixture(name: string): ArrayBuffer {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Decode a JSON metadata value from the store. */
async function readJson(
  store: KerchunkReferenceStore,
  key: string,
): Promise<Record<string, unknown>> {
  const bytes = await store.get(key);
  assert.ok(bytes, `missing key ${key}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Decode a store chunk as a little-endian float32 array. */
async function readFloat32(store: KerchunkReferenceStore, key: string): Promise<number[]> {
  const chunk = await store.get(key);
  assert.ok(chunk, `missing key ${key}`);
  return Array.from(new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4));
}

/** A small 2x3 float32 grid with 2 lat rows and 3 lon columns. */
function sampleGrid(): InlineZarrGrid {
  return {
    variable: "air",
    ny: 2,
    nx: 3,
    // Row-major: row 0 = [1,2,3], row 1 = [4,5,6].
    data: new Float32Array([1, 2, 3, 4, 5, 6]),
    dtype: "<f4",
    lat: new Float64Array([10, 20]),
    latDtype: "<f8",
    lon: new Float64Array([0, 1, 2]),
    lonDtype: "<f8",
    fillValue: -9999,
    scaleFactor: 0.1,
    addOffset: 5,
  };
}

describe("buildInlineZarrRefs", () => {
  it("emits a valid Zarr v2 group with data + coordinate arrays", async () => {
    const refs = buildInlineZarrRefs(sampleGrid());
    const store = new KerchunkReferenceStore(refs);

    const group = await readJson(store, ".zgroup");
    assert.equal(group.zarr_format, 2);

    const zarray = await readJson(store, "air/.zarray");
    assert.deepEqual(zarray.shape, [2, 3]);
    assert.deepEqual(zarray.chunks, [2, 3]);
    assert.equal(zarray.dtype, "<f4");
    assert.equal(zarray.compressor, null);
    assert.equal(zarray.fill_value, -9999);

    const zattrs = await readJson(store, "air/.zattrs");
    assert.deepEqual(zattrs._ARRAY_DIMENSIONS, ["lat", "lon"]);
    assert.equal(zattrs.scale_factor, 0.1);
    assert.equal(zattrs.add_offset, 5);
  });

  it("round-trips the data chunk bytes", async () => {
    const refs = buildInlineZarrRefs(sampleGrid());
    const store = new KerchunkReferenceStore(refs);

    // Single chunk for a 2-D array is keyed "0.0".
    const chunk = await store.get("air/0.0");
    assert.ok(chunk);
    const values = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
    assert.deepEqual(Array.from(values), [1, 2, 3, 4, 5, 6]);
  });

  it("round-trips the lat/lon coordinate arrays", async () => {
    const refs = buildInlineZarrRefs(sampleGrid());
    const store = new KerchunkReferenceStore(refs);

    const latAttrs = await readJson(store, "lat/.zattrs");
    assert.deepEqual(latAttrs._ARRAY_DIMENSIONS, ["lat"]);
    const latChunk = await store.get("lat/0");
    assert.ok(latChunk);
    const lat = new Float64Array(latChunk.buffer, latChunk.byteOffset, latChunk.byteLength / 8);
    assert.deepEqual(Array.from(lat), [10, 20]);

    const lonChunk = await store.get("lon/0");
    assert.ok(lonChunk);
    const lon = new Float64Array(lonChunk.buffer, lonChunk.byteOffset, lonChunk.byteLength / 8);
    assert.deepEqual(Array.from(lon), [0, 1, 2]);
  });

  it("omits scale_factor/add_offset when not provided and defaults fill_value", async () => {
    const grid = sampleGrid();
    delete grid.scaleFactor;
    delete grid.addOffset;
    delete grid.fillValue;
    const refs = buildInlineZarrRefs(grid);
    const store = new KerchunkReferenceStore(refs);

    const zattrs = await readJson(store, "air/.zattrs");
    assert.equal("scale_factor" in zattrs, false);
    assert.equal("add_offset" in zattrs, false);
    const zarray = await readJson(store, "air/.zarray");
    assert.equal(zarray.fill_value, null);
  });

  it("rolls a 0-360 longitude grid to -180..180, reordering data columns", async () => {
    // 1 row, 4 columns at lon 0, 90, 180, 270. Values tag their column.
    const grid: InlineZarrGrid = {
      variable: "air",
      ny: 1,
      nx: 4,
      data: new Float32Array([10, 20, 30, 40]),
      dtype: "<f4",
      lat: new Float64Array([0]),
      latDtype: "<f8",
      lon: new Float64Array([0, 90, 180, 270]),
      lonDtype: "<f8",
    };
    const store = new KerchunkReferenceStore(buildInlineZarrRefs(grid));

    // Split at lon >= 180: columns [180,270] move to the front as [-180,-90].
    const lonChunk = await store.get("lon/0");
    assert.ok(lonChunk);
    const lon = new Float64Array(lonChunk.buffer, lonChunk.byteOffset, lonChunk.byteLength / 8);
    assert.deepEqual(Array.from(lon), [-180, -90, 0, 90]);

    // Data columns follow the same permutation: [30,40,10,20].
    const dataChunk = await store.get("air/0.0");
    assert.ok(dataChunk);
    const values = new Float32Array(
      dataChunk.buffer,
      dataChunk.byteOffset,
      dataChunk.byteLength / 4,
    );
    assert.deepEqual(Array.from(values), [30, 40, 10, 20]);
  });

  it("leaves a -180..180 longitude grid unchanged", async () => {
    const grid: InlineZarrGrid = {
      variable: "air",
      ny: 1,
      nx: 4,
      data: new Float32Array([10, 20, 30, 40]),
      dtype: "<f4",
      lat: new Float64Array([0]),
      latDtype: "<f8",
      lon: new Float64Array([-135, -45, 45, 135]),
      lonDtype: "<f8",
    };
    const store = new KerchunkReferenceStore(buildInlineZarrRefs(grid));
    const lonChunk = await store.get("lon/0");
    assert.ok(lonChunk);
    const lon = new Float64Array(lonChunk.buffer, lonChunk.byteOffset, lonChunk.byteLength / 8);
    assert.deepEqual(Array.from(lon), [-135, -45, 45, 135]);
    const dataChunk = await store.get("air/0.0");
    assert.ok(dataChunk);
    const values = new Float32Array(
      dataChunk.buffer,
      dataChunk.byteOffset,
      dataChunk.byteLength / 4,
    );
    assert.deepEqual(Array.from(values), [10, 20, 30, 40]);
  });

  it("does not roll when the longitude axis contains a non-finite value", async () => {
    const grid: InlineZarrGrid = {
      variable: "air",
      ny: 1,
      nx: 4,
      data: new Float32Array([10, 20, 30, 40]),
      dtype: "<f4",
      lat: new Float64Array([0]),
      latDtype: "<f8",
      // Looks like a 0-360 axis but has a NaN: must be left untouched, not
      // mis-split by the roll.
      lon: new Float64Array([0, 90, NaN, 270]),
      lonDtype: "<f8",
    };
    const store = new KerchunkReferenceStore(buildInlineZarrRefs(grid));
    const dataChunk = await store.get("air/0.0");
    assert.ok(dataChunk);
    const values = new Float32Array(
      dataChunk.buffer,
      dataChunk.byteOffset,
      dataChunk.byteLength / 4,
    );
    assert.deepEqual(Array.from(values), [10, 20, 30, 40]);

    // The longitude coordinate must also be left untouched (no roll).
    const lonChunk = await store.get("lon/0");
    assert.ok(lonChunk);
    const lon = new Float64Array(lonChunk.buffer, lonChunk.byteOffset, lonChunk.byteLength / 8);
    assert.deepEqual(Array.from(lon), [0, 90, NaN, 270]);
  });

  it("emits an integer dtype for integer grids", async () => {
    const grid: InlineZarrGrid = {
      ...sampleGrid(),
      data: new Int16Array([1, 2, 3, 4, 5, 6]),
      dtype: "<i2",
    };
    const refs = buildInlineZarrRefs(grid);
    const store = new KerchunkReferenceStore(refs);
    const chunk = await store.get("air/0.0");
    assert.ok(chunk);
    const values = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    assert.deepEqual(Array.from(values), [1, 2, 3, 4, 5, 6]);
  });
});

describe("openLocalNetcdf (NetCDF-3)", () => {
  it("lists renderable variables from a classic NetCDF-3 file", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      const vars = file.listVariables();
      assert.equal(vars.length, 1);
      assert.equal(vars[0].name, "temp");
      assert.deepEqual(vars[0].dims, ["time", "lat", "lon"]);
      assert.deepEqual(vars[0].shape, [2, 2, 3]);
    } finally {
      file.close();
    }
  });

  it("builds a Zarr store for a selected time slice", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      // time index 1 -> the +10 plane.
      const { refs } = file.buildLayerRefs("temp", { time: 1 });
      const store = new KerchunkReferenceStore(refs);

      const zarray = await readJson(store, "temp/.zarray");
      assert.deepEqual(zarray.shape, [2, 3]);
      assert.equal(zarray.dtype, "<f4");
      assert.equal(zarray.fill_value, -9999);

      assert.deepEqual(await readFloat32(store, "temp/0.0"), [11, 12, 13, 14, 15, 16]);
      assert.deepEqual(await readFloat32(store, "lat/0"), [10, 20]);
    } finally {
      file.close();
    }
  });

  it("defaults the time slice to index 0", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      const { refs } = file.buildLayerRefs("temp");
      const store = new KerchunkReferenceStore(refs);
      assert.deepEqual(await readFloat32(store, "temp/0.0"), [1, 2, 3, 4, 5, 6]);
    } finally {
      file.close();
    }
  });

  it("rejects generic x/y axes without geographic units", async () => {
    // data(y, x) with x/y pixel-index coords and no CF units: must not be
    // mis-read as WGS84 degrees.
    const file = await openLocalNetcdf(fixture("sample-nc3-xy.nc"));
    try {
      assert.throws(() => file.buildLayerRefs("data"), /latitude\/longitude coordinate/i);
    } finally {
      file.close();
    }
  });
});

describe("gridBounds", () => {
  it("expands cell centres by half a cell on every side", () => {
    // 3 columns spaced 1 degree apart -> half a cell is 0.5 degrees.
    assert.deepEqual(gridBounds([10, 20], [0, 1, 2]), [-0.5, 5, 2.5, 25]);
  });

  it("reads a descending axis the same as an ascending one", () => {
    assert.deepEqual(gridBounds([20, 10], [2, 1, 0]), [-0.5, 5, 2.5, 25]);
  });

  it("leaves a single-cell axis as a point rather than inventing a width", () => {
    assert.deepEqual(gridBounds([10], [0]), [0, 10, 0, 10]);
  });

  it("clamps to the valid WGS84 ranges", () => {
    const [west, south, east, north] = gridBounds([-89.5, 89.5], [-179.5, 179.5]);
    assert.equal(west, -180);
    assert.equal(south, -90);
    assert.equal(east, 180);
    assert.equal(north, 90);
  });
});

describe("buildInlineZarrStore", () => {
  it("reports the grid's extent alongside the references", () => {
    const { bounds } = buildInlineZarrStore(sampleGrid());
    assert.deepEqual(bounds, [-0.5, 5, 2.5, 25]);
  });

  it("reports the *rolled* extent for a 0-360 longitude grid", () => {
    // Rolling moves the data into -180..180, so the pre-roll 45..315 extent
    // would fly the camera to the wrong place.
    const { bounds } = buildInlineZarrStore({
      ...sampleGrid(),
      nx: 4,
      data: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]),
      lon: new Float64Array([45, 135, 225, 315]),
    });
    assert.deepEqual(bounds, [-180, 5, 180, 25]);
  });
});

describe("percentileClim", () => {
  it("trims outliers off both ends", () => {
    // 0..100 with a single wild outlier: the 2/98 percentiles stay near the bulk.
    const values = new Float32Array([...Array.from({ length: 101 }, (_, i) => i), 1e6]);
    const clim = percentileClim(values);
    assert.ok(clim);
    assert.ok(clim[1] < 1000, `expected the outlier to be trimmed, got ${clim[1]}`);
  });

  it("skips the fill value and applies scale_factor/add_offset", () => {
    const clim = percentileClim(new Float32Array([-9999, 0, 10, -9999]), {
      fillValue: -9999,
      scale: 2,
      offset: 1,
    });
    // Only 0 and 10 survive the fill filter; scaled they span 1..21, and the
    // 2/98 trim pulls each end 2% of the way in.
    assert.deepEqual(clim, [1.4, 20.6]);
  });

  it("returns null for a grid with no spread", () => {
    assert.equal(percentileClim(new Float32Array([7, 7, 7, 7])), null);
    assert.equal(percentileClim(new Float32Array([-9999, -9999]), { fillValue: -9999 }), null);
  });
});

describe("composeRgbImage", () => {
  /** A 2x2 grid whose three channels each run 0..3, on an ascending lat axis. */
  function composition() {
    return {
      ny: 2,
      nx: 2,
      channels: [
        new Float32Array([0, 1, 2, 3]),
        new Float32Array([0, 1, 2, 3]),
        new Float32Array([0, 1, 2, 3]),
      ],
      lat: new Float64Array([10, 20]),
      lon: new Float64Array([0, 1]),
      stretchPercent: 0,
    };
  }

  it("flips an ascending latitude axis so the image is north-up", () => {
    const image = composeRgbImage(composition());
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    // Source row 1 (lat 20, the northern one) must be output row 0, so the
    // top-left pixel is the value 2 -> full scale over a 0..3 range is 170.
    assert.equal(image.pixels[0], Math.round((2 / 3) * 255));
    // Output row 1 is source row 0 (lat 10), starting at value 0.
    assert.equal(image.pixels[2 * 4], 0);
  });

  it("leaves a descending latitude axis in place", () => {
    const image = composeRgbImage({
      ...composition(),
      lat: new Float64Array([20, 10]),
    });
    assert.equal(image.pixels[0], 0);
  });

  it("emits image-source corners in NW, NE, SE, SW order", () => {
    const image = composeRgbImage(composition());
    assert.deepEqual(image.bounds, [-0.5, 5, 1.5, 25]);
    assert.deepEqual(image.coordinates, [
      [-0.5, 25],
      [1.5, 25],
      [1.5, 5],
      [-0.5, 5],
    ]);
  });

  it("makes fill and non-finite cells fully transparent", () => {
    const image = composeRgbImage({
      ...composition(),
      channels: [
        new Float32Array([-9999, 1, 2, Number.NaN]),
        new Float32Array([0, 1, 2, 3]),
        new Float32Array([0, 1, 2, 3]),
      ],
      fillValue: -9999,
      // Descending so output rows match source rows and the assertions read
      // straight off the input.
      lat: new Float64Array([20, 10]),
    });
    const alpha = [0, 1, 2, 3].map((i) => image.pixels[i * 4 + 3]);
    assert.deepEqual(alpha, [0, 255, 255, 0]);
  });

  it("stretches each channel over its own range", () => {
    const image = composeRgbImage({
      ...composition(),
      channels: [
        new Float32Array([0, 0, 0, 10]), // red spans 0..10
        new Float32Array([0, 0, 0, 1]), // green spans 0..1
        new Float32Array([5, 5, 5, 5]), // blue is constant
      ],
      lat: new Float64Array([20, 10]),
    });
    assert.deepEqual(image.channelRanges[0], [0, 10]);
    assert.deepEqual(image.channelRanges[1], [0, 1]);
    // The last pixel is each channel's own maximum, so both stretched channels
    // saturate despite their very different native ranges.
    assert.equal(image.pixels[3 * 4], 255);
    assert.equal(image.pixels[3 * 4 + 1], 255);
  });

  it("decimates a grid past maxSize", () => {
    const big = new Float32Array(8 * 8).map((_, i) => i);
    const image = composeRgbImage({
      ny: 8,
      nx: 8,
      channels: [big, big, big],
      lat: new Float64Array(Array.from({ length: 8 }, (_, i) => 20 - i)),
      lon: new Float64Array(Array.from({ length: 8 }, (_, i) => i)),
      maxSize: 4,
    });
    assert.equal(image.width, 4);
    assert.equal(image.height, 4);
  });

  it("rejects anything other than three channels", () => {
    assert.throws(
      () =>
        composeRgbImage({
          ...composition(),
          channels: [new Float32Array([0, 1, 2, 3])],
        }),
      /exactly three channels/i,
    );
  });
});

describe("openLocalNetcdf axes, bounds, and RGB (NetCDF-3)", () => {
  it("reports the leading axes of a cube", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      // The fixture has no `time` coordinate variable, so the axis is reported
      // without values and the picker falls back to a plain index box.
      assert.deepEqual(file.listAxes("temp"), [{ name: "time", size: 2 }]);
      // lat/lon are the spatial pair, never a leading axis.
      assert.deepEqual(
        file.listAxes("temp").map((axis) => axis.name),
        ["time"],
      );
    } finally {
      file.close();
    }
  });

  it("returns the slice's extent and robust color limits", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      const { bounds, clim } = file.buildLayerRefs("temp", { time: 1 });
      assert.deepEqual(bounds, [-0.5, 5, 2.5, 25]);
      // The +10 plane runs 11..16; a 2% trim off 6 samples stays inside it.
      assert.ok(clim);
      assert.ok(clim[0] >= 11 && clim[1] <= 16, `unexpected clim ${clim}`);
    } finally {
      file.close();
    }
  });

  it("composes an RGB image from three indices of a leading axis", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      const image = file.buildRgbImage("temp", {
        axis: "time",
        indices: [1, 0, 0],
        stretchPercent: 0,
      });
      assert.equal(image.width, 3);
      assert.equal(image.height, 2);
      assert.deepEqual(image.bounds, [-0.5, 5, 2.5, 25]);
      // Red reads the +10 plane (11..16), green and blue the base plane (1..6).
      assert.deepEqual(image.channelRanges[0], [11, 16]);
      assert.deepEqual(image.channelRanges[1], [1, 6]);
      // Every cell is valid data, so nothing is masked out.
      assert.ok(
        Array.from({ length: 6 }, (_, i) => image.pixels[i * 4 + 3]).every((a) => a === 255),
      );
    } finally {
      file.close();
    }
  });

  it("rejects an axis that is not one of the variable's leading dimensions", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      assert.throws(
        () => file.buildRgbImage("temp", { axis: "lat", indices: [0, 1, 0] }),
        /not one of this variable's non-spatial dimensions/i,
      );
    } finally {
      file.close();
    }
  });
});

describe("composeColormappedImage", () => {
  /** A 2x2 grid running 0..3 on a descending (north-first) latitude axis. */
  function composition() {
    return {
      ny: 2,
      nx: 2,
      values: new Float32Array([0, 1, 2, 3]),
      lat: new Float64Array([20, 10]),
      lon: new Float64Array([0, 1]),
      colors: ["#000000", "#ff0000"],
      clim: [0, 3] as [number, number],
    };
  }

  it("maps values across the ramp", () => {
    const image = composeColormappedImage(composition());
    // Two stops with no interpolation: the bottom half picks black, the top red.
    assert.deepEqual([image.pixels[0], image.pixels[1], image.pixels[2]], [0, 0, 0]);
    assert.deepEqual(
      [image.pixels[3 * 4], image.pixels[3 * 4 + 1], image.pixels[3 * 4 + 2]],
      [255, 0, 0],
    );
    assert.deepEqual(image.clim, [0, 3]);
  });

  it("makes fill and non-finite cells transparent, others opaque", () => {
    const image = composeColormappedImage({
      ...composition(),
      values: new Float32Array([-9999, 1, 2, Number.NaN]),
      fillValue: -9999,
    });
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => image.pixels[i * 4 + 3]),
      [0, 255, 255, 0],
    );
  });

  it("derives color limits from the data when none are given", () => {
    const image = composeColormappedImage({
      ...composition(),
      clim: undefined,
      stretchPercent: 0,
      values: new Float32Array([-9999, 4, 8, -9999]),
      fillValue: -9999,
    });
    assert.deepEqual(image.clim, [4, 8]);
  });

  it("applies scale_factor/add_offset before mapping", () => {
    const image = composeColormappedImage({
      ...composition(),
      values: new Float32Array([0, 0, 0, 10]),
      scaleFactor: 2,
      addOffset: 1,
      clim: [1, 21],
    });
    // 0 -> 1 (ramp bottom), 10 -> 21 (ramp top).
    assert.equal(image.pixels[0], 0);
    assert.equal(image.pixels[3 * 4], 255);
  });

  it("flips an ascending latitude axis so the image is north-up", () => {
    const image = composeColormappedImage({
      ...composition(),
      lat: new Float64Array([10, 20]),
    });
    // Source row 1 (lat 20) becomes output row 0, so the top-left value is 2.
    assert.equal(image.pixels[0], 255);
    assert.equal(image.pixels[2 * 4], 0);
  });

  it("reads axis orientation from the finite endpoints, not the raw first and last", () => {
    // A swath-edge artifact leaves NaN in the first latitude centre. Every
    // comparison against NaN is false, so a naive `lat[0] > lat[ny-1]` reads this
    // descending axis as ascending and mirrors the rows — over a `gridBounds`
    // extent computed from the same array, which still comes out right, so the
    // result looks plausible and is upside down.
    const image = composeColormappedImage({
      ...composition(),
      ny: 3,
      values: new Float32Array([0, 1, 2, 3, 4, 5]),
      lat: new Float64Array([Number.NaN, 20, 10]),
      clim: [0, 5],
    });
    // Still north-first: output row 0 must be the source's own first row (0, 1),
    // which sits at the ramp bottom, not the last row (4, 5) at the top.
    assert.equal(image.pixels[0], 0);
    assert.equal(image.pixels[2 * 2 * 4], 255);
  });

  it("emits the same extent and corners as the RGB composer", () => {
    const image = composeColormappedImage(composition());
    assert.deepEqual(image.bounds, [-0.5, 5, 1.5, 25]);
    assert.deepEqual(image.coordinates, [
      [-0.5, 25],
      [1.5, 25],
      [1.5, 5],
      [-0.5, 5],
    ]);
  });

  it("rejects an empty ramp", () => {
    assert.throws(
      () => composeColormappedImage({ ...composition(), colors: [] }),
      /at least one color/i,
    );
  });
});

describe("readGrid (NetCDF-3)", () => {
  it("returns a slice ready to hand straight to composeColormappedImage", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      const grid = file.readGrid("temp", { time: 1 });
      assert.equal(grid.ny, 2);
      assert.equal(grid.nx, 3);
      assert.deepEqual(Array.from(grid.values), [11, 12, 13, 14, 15, 16]);
      assert.deepEqual(Array.from(grid.lat), [10, 20]);
      assert.deepEqual(Array.from(grid.lon), [0, 1, 2]);
      assert.equal(grid.fillValue, -9999);
      // The +10 plane runs 11..16, so a 2% trim stays inside it.
      assert.ok(grid.dataClim[0] >= 11 && grid.dataClim[1] <= 16);

      const image = composeColormappedImage({ ...grid, colors: ["#000000", "#ffffff"] });
      assert.equal(image.width, 3);
      assert.equal(image.height, 2);
      assert.deepEqual(image.bounds, [-0.5, 5, 2.5, 25]);
      // Every cell is valid data, so nothing is masked out.
      assert.ok(
        Array.from({ length: 6 }, (_, i) => image.pixels[i * 4 + 3]).every((a) => a === 255),
      );
    } finally {
      file.close();
    }
  });

  it("defaults the leading dimension to index 0", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      assert.deepEqual(Array.from(file.readGrid("temp").values), [1, 2, 3, 4, 5, 6]);
    } finally {
      file.close();
    }
  });
});

describe("gridPixelAt", () => {
  /** A 2x3 grid on a descending latitude axis, values tagging their cell. */
  function grid() {
    return {
      ny: 2,
      nx: 3,
      values: new Float32Array([1, 2, 3, 4, 5, 6]),
      lat: new Float64Array([20, 10]),
      lon: new Float64Array([0, 1, 2]),
      fillValue: -9999 as number | string | null,
      dataClim: [1, 6] as [number, number],
    };
  }

  it("finds the cell under a click and reports its value", () => {
    const pixel = gridPixelAt(grid(), 1.1, 19.6);
    assert.deepEqual(pixel, { row: 0, column: 1, lng: 1, lat: 20, value: 2 });
  });

  it("reads the southern row of a descending latitude axis", () => {
    assert.equal(gridPixelAt(grid(), 2, 10)?.value, 6);
  });

  it("applies scale_factor and add_offset to the readout", () => {
    const pixel = gridPixelAt({ ...grid(), scaleFactor: 2, addOffset: 1 }, 0, 20);
    assert.equal(pixel?.value, 3);
  });

  it("reports a fill cell as no data rather than as its sentinel", () => {
    const values = new Float32Array([-9999, 2, 3, 4, 5, 6]);
    assert.equal(gridPixelAt({ ...grid(), values }, 0, 20)?.value, null);
  });

  it("returns null for a click outside the grid", () => {
    assert.equal(gridPixelAt(grid(), 40, 20), null);
    assert.equal(gridPixelAt(grid(), 1, -40), null);
  });

  it("still reads the outermost cell half a cell past the edge", () => {
    // The extent runs half a cell past the last centre, so the very edge of the
    // drawn image must still resolve rather than reporting a miss.
    assert.equal(gridPixelAt(grid(), 2.4, 20)?.column, 2);
  });
});

describe("readProfile (NetCDF-3)", () => {
  it("walks a leading axis at one pixel", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      // temp is (time=2, lat=2, lon=3); row 1 / column 2 is 6 then 16.
      const profile = file.readProfile("temp", { axis: "time", row: 1, column: 2 });
      assert.equal(profile.axis.name, "time");
      assert.equal(profile.axis.size, 2);
      assert.deepEqual(profile.values, [6, 16]);
    } finally {
      file.close();
    }
  });

  it("clamps a pixel outside the grid onto the nearest edge cell", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      assert.deepEqual(
        file.readProfile("temp", { axis: "time", row: 99, column: 99 }).values,
        [6, 16],
      );
    } finally {
      file.close();
    }
  });

  it("rejects an axis that is not one of the variable's leading dimensions", async () => {
    const file = await openLocalNetcdf(fixture("sample-nc3.nc"));
    try {
      assert.throws(
        () => file.readProfile("temp", { axis: "lat", row: 0, column: 0 }),
        /not one of this variable's non-spatial dimensions/i,
      );
    } finally {
      file.close();
    }
  });
});

describe("assertByteServing", () => {
  /**
   * Swap in a stub `fetch` for one call.
   *
   * @param response - What the stubbed fetch resolves to, or a thrower.
   * @param body - Receives the `RequestInit` the client sent.
   */
  async function withFetch(
    response: Response | (() => never),
    body: (sent: () => RequestInit | undefined) => Promise<void>,
  ): Promise<void> {
    const previous = globalThis.fetch;
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, options?: RequestInit) => {
      init = options;
      if (typeof response === "function") response();
      return response;
    }) as typeof fetch;
    try {
      await body(() => init);
    } finally {
      globalThis.fetch = previous;
    }
  }

  /** A response carrying the given status and headers, with a drainable body. */
  function reply(status: number, headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : "x", { status, headers });
  }

  it("asks for a single byte", async () => {
    await withFetch(reply(206, { "content-range": "bytes 0-0/1048576" }), async (sent) => {
      await assertByteServing("https://example.com/scene.h5");
      assert.deepEqual(sent()?.headers, { Range: "bytes=0-0" });
    });
  });

  it("rejects a server that ignored the range and answered whole", async () => {
    // The failure this guards: emscripten accepts the full entity, so the mount
    // silently becomes a blocking download of the entire file.
    await withFetch(reply(200), async () => {
      await assertByteServing("https://example.com/scene.h5").then(
        () => assert.fail("expected a rejection"),
        (error: Error) => assert.match(error.message, /ignored a byte-range request/i),
      );
    });
  });

  it("accepts a 206 whose Content-Range CORS did not expose", async () => {
    // A cross-origin response only exposes Content-Range when the server lists it
    // in Access-Control-Expose-Headers; the status alone must be enough to pass.
    await withFetch(reply(206), async () => {
      await assertByteServing("https://example.com/scene.h5");
    });
  });

  it("rejects a 206 that answered a different range than asked for", async () => {
    await withFetch(reply(206, { "content-range": "bytes 500-999/1048576" }), async () => {
      await assertByteServing("https://example.com/scene.h5").then(
        () => assert.fail("expected a rejection"),
        (error: Error) => assert.match(error.message, /unexpected range/i),
      );
    });
  });

  it("reports an error status rather than the range verdict", async () => {
    await withFetch(reply(404), async () => {
      await assertByteServing("https://example.com/missing.h5").then(
        () => assert.fail("expected a rejection"),
        (error: Error) => assert.match(error.message, /answered 404/),
      );
    });
  });

  it("reports an unreachable URL as a CORS/network failure", async () => {
    await withFetch(
      () => {
        throw new TypeError("Failed to fetch");
      },
      async () => {
        await assertByteServing("https://example.com/scene.h5").then(
          () => assert.fail("expected a rejection"),
          (error: Error) => assert.match(error.message, /cross-origin requests/i),
        );
      },
    );
  });
});
