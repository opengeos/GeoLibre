import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RASTER_TOOLS, getRasterTool } from "@geolibre/processing";

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
});
