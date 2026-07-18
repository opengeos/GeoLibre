import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildInlineZarrRefs,
  openLocalNetcdf,
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
