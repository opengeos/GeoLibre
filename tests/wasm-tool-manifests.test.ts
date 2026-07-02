import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeWasmToolManifests,
  type WhiteboxTool,
} from "@geolibre/processing";

// The Whitebox catalog snapshot (from the Python sidecar) names reproject_vector's
// destination-CRS parameter `dst_epsg` and carries sidecar-only extras. The WASM
// binary's own manifest for the same tool validates `epsg` instead, so building
// CLI args from the catalog fails with "parameter 'epsg' is required" (#1047).
const catalogReprojectVector: WhiteboxTool = {
  id: "reproject_vector",
  display_name: "Reproject Vector",
  category: "Projection and Georeferencing",
  params: [
    { name: "input", kind: "vector_in", required: true },
    { name: "dst_epsg", kind: "int", required: true },
    { name: "output", kind: "file_out", required: true },
    { name: "failure_policy", kind: "string", required: false },
    { name: "antimeridian_policy", kind: "string", required: false },
  ],
};

const wasmReprojectVector: WhiteboxTool = {
  id: "reproject_vector",
  display_name: "Reproject Vector",
  category: "Vector",
  params: [
    { name: "input", data_kind: "vector", io_role: "input", required: true },
    { name: "epsg", data_kind: "number", required: true },
    { name: "output", data_kind: "vector", io_role: "output", required: true },
  ],
};

const geolibreOnlyTool: WhiteboxTool = {
  id: "write_geoparquet",
  display_name: "Write GeoParquet",
  source: "geolibre",
  params: [{ name: "input", data_kind: "vector", io_role: "input" }],
};

describe("mergeWasmToolManifests", () => {
  it("replaces a catalog tool's params with the WASM manifest's", () => {
    const merged = mergeWasmToolManifests(
      [catalogReprojectVector],
      [wasmReprojectVector],
    );
    const tool = merged.find((item) => item.id === "reproject_vector");
    assert.ok(tool, "reproject_vector should still be present");
    // The WASM binary's parameter names win, so args are built as `--epsg=...`.
    assert.deepEqual(
      tool.params?.map((param) => param.name),
      ["input", "epsg", "output"],
    );
    // Catalog display metadata is preserved (only params are overridden).
    assert.equal(tool.category, "Projection and Georeferencing");
  });

  it("keeps catalog params when the WASM binary lacks the tool", () => {
    const merged = mergeWasmToolManifests([catalogReprojectVector], []);
    const tool = merged.find((item) => item.id === "reproject_vector");
    assert.deepEqual(
      tool?.params?.map((param) => param.name),
      ["input", "dst_epsg", "output", "failure_policy", "antimeridian_policy"],
    );
  });

  it("appends GeoLibre-authored tools absent from the catalog", () => {
    const merged = mergeWasmToolManifests(
      [catalogReprojectVector],
      [wasmReprojectVector, geolibreOnlyTool],
    );
    assert.ok(
      merged.some((tool) => tool.id === "write_geoparquet"),
      "GeoLibre-only tool should be appended",
    );
    // The WASM whitebox match is consumed, not duplicated as a WASM-only entry.
    assert.equal(
      merged.filter((tool) => tool.id === "reproject_vector").length,
      1,
    );
  });

  it("does not append WASM-only Whitebox tools missing from the catalog", () => {
    const wasmOnlyWhitebox: WhiteboxTool = {
      id: "some_wasm_only_whitebox_tool",
      params: [{ name: "input", data_kind: "raster", io_role: "input" }],
    };
    const merged = mergeWasmToolManifests([], [wasmOnlyWhitebox]);
    assert.equal(merged.length, 0);
  });
});
