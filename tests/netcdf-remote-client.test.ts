import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNetcdfFileUrl } from "../apps/geolibre-desktop/src/lib/netcdf-remote-client";

describe("isNetcdfFileUrl", () => {
  it("recognizes the NetCDF/HDF extensions the reader opens", () => {
    for (const extension of ["nc", "nc4", "h5", "hdf5", "cdf"]) {
      assert.equal(isNetcdfFileUrl(`https://example.com/data/scene.${extension}`), true, extension);
    }
  });

  it("ignores a query string, so a presigned URL still routes", () => {
    assert.equal(
      isNetcdfFileUrl("https://example.com/scene.nc?X-Amz-Signature=abc&X-Amz-Expires=900"),
      true,
    );
    assert.equal(isNetcdfFileUrl("https://example.com/scene.nc#band=1"), true);
  });

  it("is case-insensitive", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/SCENE.NC"), true);
  });

  it("rejects a kerchunk manifest, which goes to the reference loader instead", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/air-temperature.kerchunk.json"), false);
  });

  it("rejects other stores and unrelated URLs", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/store.zarr"), false);
    assert.equal(isNetcdfFileUrl("https://example.com/scene.tif"), false);
    assert.equal(isNetcdfFileUrl("https://example.com/"), false);
  });

  it("tolerates a relative path with no parseable origin", () => {
    assert.equal(isNetcdfFileUrl("/data/scene.nc"), true);
    assert.equal(isNetcdfFileUrl("  /data/scene.nc?v=2  "), true);
  });

  it("does not match an extension that merely appears mid-path", () => {
    assert.equal(isNetcdfFileUrl("https://example.com/nc/readme.txt"), false);
  });
});
