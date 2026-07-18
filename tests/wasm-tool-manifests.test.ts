import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fileOutputTargetExtension,
  mergeWasmToolManifests,
  normalizeVectorOutputFormat,
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
    const merged = mergeWasmToolManifests([catalogReprojectVector], [wasmReprojectVector]);
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
    assert.equal(merged.filter((tool) => tool.id === "reproject_vector").length, 1);
  });

  it("consumes a matched GeoLibre tool once and preserves its source", () => {
    // A GeoLibre-authored tool that also has a catalog stub must be merged once
    // (never appended a second time via the GeoLibre-only leftovers), take the
    // WASM manifest's params, and keep its "geolibre" source so the source
    // filter still recognises it.
    const catalogStub: WhiteboxTool = {
      id: "write_geoparquet",
      display_name: "Write GeoParquet",
      params: [{ name: "input", kind: "vector_in", required: true }],
    };
    const wasmTool: WhiteboxTool = {
      id: "write_geoparquet",
      source: "geolibre",
      params: [
        { name: "input", data_kind: "vector", io_role: "input" },
        { name: "compression", data_kind: "string" },
      ],
    };
    const merged = mergeWasmToolManifests([catalogStub], [wasmTool]);
    assert.equal(merged.filter((tool) => tool.id === "write_geoparquet").length, 1);
    assert.deepEqual(
      merged[0].params?.map((param) => param.name),
      ["input", "compression"],
    );
    assert.equal(merged[0].source, "geolibre");
    // Catalog display metadata is retained.
    assert.equal(merged[0].display_name, "Write GeoParquet");
  });

  it("corrects a WASM param the manifest mislabels as a dataset/bool (#1073)", () => {
    // The WASM binary types extract_by_attribute's `statement` expression as a
    // bool (a checkbox) and field_calculator's `expression` as a vector input (a
    // second layer picker), so neither exposes a text field. The catalog types
    // both as plain strings; that scalar kind must win for matched param names.
    const catalog: WhiteboxTool = {
      id: "field_calculator",
      display_name: "Field Calculator",
      params: [
        { name: "input", kind: "vector_in", required: true },
        { name: "field", kind: "string", required: true },
        { name: "field_type", kind: "int", required: false },
        { name: "expression", kind: "string", required: true },
        { name: "output", kind: "vector_out", required: false },
      ],
    };
    const wasm: WhiteboxTool = {
      id: "field_calculator",
      params: [
        { name: "input", data_kind: "vector", io_role: "input", required: true },
        { name: "field", data_kind: "string", required: true },
        // A real enum/dropdown: its kind must be left alone, not coerced to int.
        {
          name: "field_type",
          schema: { kind: "enum", options: [{ value: "float" }] },
          options: ["float", "integer", "text"],
        },
        // Mislabeled as a vector input; the catalog's `string` must win.
        {
          name: "expression",
          data_kind: "vector",
          io_role: "input",
          required: true,
        },
        { name: "output", data_kind: "vector", io_role: "output" },
      ],
    };
    const [tool] = mergeWasmToolManifests([catalog], [wasm]);
    const byName = new Map(tool.params?.map((p) => [p.name, p]));
    // Param names/set still come from the WASM manifest.
    assert.deepEqual(
      tool.params?.map((p) => p.name),
      ["input", "field", "field_type", "expression", "output"],
    );
    // The mislabeled expression is corrected to a string (a text field).
    assert.equal(byName.get("expression")?.kind, "string");
    // A genuine enum keeps its dropdown; the catalog's `int` does not clobber it.
    assert.equal(byName.get("field_type")?.kind, undefined);
    // Matching dataset kinds are untouched (no spurious override).
    assert.equal(byName.get("input")?.kind, undefined);
  });

  it("corrects a bool-typed expression param to a string (#1073)", () => {
    const catalog: WhiteboxTool = {
      id: "extract_by_attribute",
      params: [
        { name: "input", kind: "vector_in", required: true },
        { name: "statement", kind: "string", required: true },
        { name: "output", kind: "vector_out", required: true },
      ],
    };
    const wasm: WhiteboxTool = {
      id: "extract_by_attribute",
      params: [
        { name: "input", data_kind: "vector", io_role: "input", required: true },
        { name: "statement", data_kind: "bool", required: true },
        { name: "output", data_kind: "vector", io_role: "output", required: true },
      ],
    };
    const [tool] = mergeWasmToolManifests([catalog], [wasm]);
    const statement = tool.params?.find((p) => p.name === "statement");
    assert.equal(statement?.kind, "string");
  });

  it("does not downgrade a genuine dataset input the catalog mistyped scalar", () => {
    // Only expression/statement-named inputs are corrected; a real raster/vector
    // input whose name is not an expression must keep its WASM dataset kind even
    // if the catalog snapshot mistypes it as a string.
    const catalog: WhiteboxTool = {
      id: "some_tool",
      params: [{ name: "input", kind: "string", required: true }],
    };
    const wasm: WhiteboxTool = {
      id: "some_tool",
      params: [{ name: "input", data_kind: "raster", io_role: "input", required: true }],
    };
    const [tool] = mergeWasmToolManifests([catalog], [wasm]);
    assert.equal(tool.params?.[0]?.kind, undefined);
  });

  it("never overrides a WASM output param, even if the catalog types it scalar", () => {
    // A scalar-typed catalog output must not divert a genuine WASM dataset
    // output into the plain-arg path (which would break its run). Only inputs
    // and bools are corrected.
    const catalog: WhiteboxTool = {
      id: "some_tool",
      params: [{ name: "output", kind: "string", required: true }],
    };
    const wasm: WhiteboxTool = {
      id: "some_tool",
      params: [{ name: "output", data_kind: "vector", io_role: "output", required: true }],
    };
    const [tool] = mergeWasmToolManifests([catalog], [wasm]);
    // Kind stays unset so parameterKind resolves the WASM vector_out.
    assert.equal(tool.params?.[0]?.kind, undefined);
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

describe("normalizeVectorOutputFormat", () => {
  it("passes through the known formats", () => {
    for (const format of ["geojson", "geoparquet", "flatgeobuf", "shapefile"]) {
      assert.equal(normalizeVectorOutputFormat(format), format);
    }
  });

  it("falls back to geojson for a stale output path or bad value", () => {
    // A leftover sidecar-mode path (or any non-format string/undefined) must not
    // be treated as a format, else the WASM runner writes `..._output.undefined`.
    assert.equal(normalizeVectorOutputFormat("/Users/me/output.shp"), "geojson");
    assert.equal(normalizeVectorOutputFormat(""), "geojson");
    assert.equal(normalizeVectorOutputFormat(undefined), "geojson");
    assert.equal(normalizeVectorOutputFormat(42), "geojson");
  });
});

describe("fileOutputTargetExtension", () => {
  // vector_summary_statistics' output param, as the WASM manifest reports it.
  const tableOutput = {
    name: "output",
    description: "Output CSV path.",
    data_kind: "table",
    io_role: "output",
    schema: { dataset: { kind: "table" }, kind: "output", mode: "new" },
  };

  it("honors the extension of the user-chosen output path", () => {
    // The bug in #1074: a hardcoded ".dat" made vector_summary_statistics reject
    // its own output path. The user's ".csv" choice must reach the tool.
    assert.equal(fileOutputTargetExtension(tableOutput, "test.csv"), "csv");
    assert.equal(fileOutputTargetExtension(tableOutput, "/Users/me/report.JSON"), "json");
  });

  it("defaults a table output to csv when no path is given", () => {
    assert.equal(fileOutputTargetExtension(tableOutput, undefined), "csv");
    assert.equal(fileOutputTargetExtension(tableOutput, ""), "csv");
  });

  it("sniffs the format from the description when no path/table is given", () => {
    // A JSON/HTML report param whose format lives only in its prose must not
    // fall through to .dat when the output field is blank (would reproduce #1074
    // for that tool).
    const jsonReport = {
      name: "output",
      description: "Optional output report path (.json or .csv).",
      data_kind: "file",
      io_role: "output",
    };
    // csv wins over json in the hint order (both are valid for this tool).
    assert.equal(fileOutputTargetExtension(jsonReport, undefined), "csv");
    const jsonOnly = {
      name: "match_report",
      description: "Optional JSON output path for summary diagnostics.",
      data_kind: "file",
      io_role: "output",
    };
    assert.equal(fileOutputTargetExtension(jsonOnly, undefined), "json");
  });

  it("falls back to an opaque .dat for a non-table, non-text output", () => {
    const opaque = { name: "output", data_kind: "file", io_role: "output" };
    assert.equal(fileOutputTargetExtension(opaque, undefined), "dat");
  });
});
