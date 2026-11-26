import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RASTER_TOOLS, getRasterTool, supportsClientRaster } from "@geolibre/processing";

const EXPECTED_IDS = [
  "hillshade",
  "slope",
  "aspect",
  "reproject",
  "resample",
  "clip-extent",
  "clip-mask",
  "polygonize",
  "contour",
  "interpolate",
  "zonal",
  "raster-calc",
  "spectral-index",
  "reclassify",
  "mosaic",
  "focal",
  "change-difference",
  "ndvi-change",
  "transition-matrix",
  "sar-db",
  "speckle-filter",
  "sar-rgb",
  "flood-map",
  "cut-fill",
  "building-shadows",
];

describe("raster tools registry", () => {
  it("registers every expected tool id", () => {
    assert.deepEqual(
      RASTER_TOOLS.map((tool) => tool.id),
      EXPECTED_IDS,
    );
  });

  it("finds registered tools by id", () => {
    for (const id of EXPECTED_IDS) {
      assert.equal(getRasterTool(id)?.id, id);
    }
  });

  it("returns undefined for an unknown id", () => {
    assert.equal(getRasterTool("does-not-exist"), undefined);
  });

  it("declares input/output filters and a default output name", () => {
    for (const tool of RASTER_TOOLS) {
      assert.ok(tool.inputFilters.length > 0, `${tool.id} has input filters`);
      assert.ok(tool.outputFilters.length > 0, `${tool.id} has output filters`);
      assert.ok(tool.defaultOutputName.length > 0, `${tool.id} has a default output name`);
    }
  });

  it("writes raster output to .tif and vector output to .geojson", () => {
    for (const tool of RASTER_TOOLS) {
      const expectedExt = tool.outputKind === "vector" ? ".geojson" : ".tif";
      assert.ok(
        tool.defaultOutputName.endsWith(expectedExt),
        `${tool.id} default output ends with ${expectedExt}`,
      );
    }
  });

  it("gives every tool a browser engine that the client dispatcher knows", () => {
    for (const tool of RASTER_TOOLS) {
      assert.equal(tool.supportsClient, true, `${tool.id} supports the client engine`);
      assert.equal(supportsClientRaster(tool.id), true, `${tool.id} is in CLIENT_RASTER_TOOL_IDS`);
    }
  });

  it("marks only the change detection, SAR and 3D terrain tools as browser-only", () => {
    for (const tool of RASTER_TOOLS) {
      const browserOnly =
        tool.group === "Change Detection" || tool.group === "SAR" || tool.group === "3D Terrain";
      assert.equal(Boolean(tool.clientOnly), browserOnly, `${tool.id} clientOnly`);
    }
  });
});
