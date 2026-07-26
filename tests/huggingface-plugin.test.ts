import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  layerFileName,
  rasterFileName,
} from "../packages/plugins/src/plugins/maplibre-huggingface";

describe("layerFileName", () => {
  it("slugs a layer name into a .geojson filename", () => {
    assert.equal(layerFileName("Knox County Parks"), "Knox-County-Parks.geojson");
  });

  it("strips path separators, so a name cannot redirect the commit path", () => {
    assert.equal(layerFileName("a/b/c"), "a-b-c.geojson");
    assert.equal(layerFileName("../../etc/passwd"), "etc-passwd.geojson");
  });

  it("strips leading and trailing dots rather than escaping them", () => {
    assert.equal(layerFileName("..hidden.."), "hidden.geojson");
  });

  it("collapses runs of replacement characters", () => {
    assert.equal(layerFileName("a   ---   b"), "a-b.geojson");
  });

  it("falls back when a name slugs away to nothing", () => {
    assert.equal(layerFileName("///"), "layer.geojson");
    assert.equal(layerFileName("   "), "layer.geojson");
  });

  it("bounds the length, so one long name cannot dominate a path", () => {
    assert.ok(layerFileName("x".repeat(500)).length <= 80 + ".geojson".length);
  });
});

describe("rasterFileName", () => {
  it("keeps the name the file was opened under", () => {
    assert.equal(rasterFileName("dem.tif", "Elevation"), "dem.tif");
  });

  it("takes only the basename of a full path", () => {
    assert.equal(rasterFileName("/home/me/data/dem.tif", "Elevation"), "dem.tif");
    assert.equal(rasterFileName("C:\\data\\dem.tif", "Elevation"), "dem.tif");
  });

  it("slugs an unsafe original name while keeping its extension", () => {
    assert.equal(rasterFileName("my dem (2024).tif", "Elevation"), "my-dem-2024.tif");
  });

  it("falls back to the layer name when the original has no extension", () => {
    // A name that lost its extension would upload a file the Hub cannot type.
    assert.equal(rasterFileName("dem", "Elevation Model"), "Elevation-Model.tif");
  });

  it("falls back when there is no original name at all", () => {
    assert.equal(rasterFileName("", "Elevation"), "Elevation.tif");
    assert.equal(rasterFileName("", ""), "raster.tif");
  });

  it("preserves a non-tif raster extension", () => {
    assert.equal(rasterFileName("scene.tiff", "S"), "scene.tiff");
  });
});
