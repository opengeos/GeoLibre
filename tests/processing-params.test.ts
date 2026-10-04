import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import type { WhiteboxJob, WhiteboxTool, WhiteboxToolParameter } from "@geolibre/processing";
import {
  LAYER_TOKEN_PREFIX,
  acceptForParameter,
  createDefaultValues,
  defaultOutputName,
  defaultParameterValue,
  fileOutputExtension,
  humanize,
  isCrsParameter,
  isDataInputParameter,
  isDistanceParameter,
  isFeatureCollection,
  isFieldParameter,
  isJsonOutputPath,
  isOutputParameter,
  isPathParameter,
  isSubsetUrlParameter,
  jobStatusTone,
  mergeCatalogParameterFallbacks,
  outputEntries,
  outputExtensionForParameter,
  outputPath,
  pathFiltersForParameter,
  toolLabel,
  wgs84ToolLayerIds,
} from "../apps/geolibre-desktop/src/lib/processing-params";

function fakeT(catalog: Record<string, string> = {}): TFunction {
  const translate = ((key: string, options?: { defaultValue?: string }) =>
    catalog[key] ?? options?.defaultValue ?? key) as TFunction;
  return translate;
}

function param(name: string, extra: Partial<WhiteboxToolParameter> = {}): WhiteboxToolParameter {
  return { name, ...extra };
}

function tool(id: string, params?: WhiteboxToolParameter[], extra: Partial<WhiteboxTool> = {}) {
  return { id, params, ...extra } as WhiteboxTool;
}

function job(status: string): WhiteboxJob {
  return {
    id: "j1",
    status,
    tool_id: "slope",
    created_at: "",
    updated_at: "",
    messages: [],
    outputs: {},
  };
}

describe("LAYER_TOKEN_PREFIX", () => {
  it("is the token the dialog stores for a map-layer input", () => {
    assert.equal(LAYER_TOKEN_PREFIX, "layer:");
  });
});

describe("humanize", () => {
  it("title-cases a snake/kebab identifier", () => {
    assert.equal(humanize("fill_depressions"), "Fill Depressions");
    assert.equal(humanize("lidar-tin--gridding"), "Lidar Tin Gridding");
  });

  it("falls back to Tool for an empty or separator-only id", () => {
    assert.equal(humanize(""), "Tool");
    assert.equal(humanize("__"), "Tool");
  });
});

describe("toolLabel", () => {
  it("prefers the catalog translation", () => {
    const t = fakeT({ "processing.toolMeta.whitebox.slope.name": "Pendiente" });
    assert.equal(toolLabel(t, tool("slope", [], { display_name: "Slope" })), "Pendiente");
  });

  it("falls back to the display name, then the humanized id", () => {
    assert.equal(
      toolLabel(fakeT(), tool("slope", [], { display_name: "Slope (deg)" })),
      "Slope (deg)",
    );
    assert.equal(toolLabel(fakeT(), tool("fill_depressions")), "Fill Depressions");
    // An empty display name is treated as missing.
    assert.equal(
      toolLabel(fakeT(), tool("fill_depressions", [], { display_name: "" })),
      "Fill Depressions",
    );
  });
});

describe("isOutputParameter / isDataInputParameter", () => {
  it("classifies explicit kinds", () => {
    for (const kind of ["raster_out", "vector_out", "lidar_out", "file_out"]) {
      assert.equal(isOutputParameter(param("o", { kind })), true, kind);
      assert.equal(isDataInputParameter(param("o", { kind })), false, kind);
    }
    for (const kind of ["raster_in", "vector_in", "lidar_in", "file_in"]) {
      assert.equal(isOutputParameter(param("i", { kind })), false, kind);
      assert.equal(isDataInputParameter(param("i", { kind })), true, kind);
    }
    for (const kind of ["bool", "int", "double", "enum", "string"]) {
      assert.equal(isOutputParameter(param("x", { kind })), false, kind);
      assert.equal(isDataInputParameter(param("x", { kind })), false, kind);
    }
  });

  it("resolves a WASM manifest parameter through its schema", () => {
    const out = param("output", { io_role: "output", data_kind: "raster" });
    const input = param("input", { schema: { kind: "input", dataset: { kind: "vector" } } });
    assert.equal(isOutputParameter(out), true);
    assert.equal(isDataInputParameter(input), true);
  });

  it("treats a parameter with no kind as a plain string", () => {
    assert.equal(isOutputParameter(param("x")), false);
    assert.equal(isDataInputParameter(param("x")), false);
  });
});

describe("fileOutputExtension", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);

  it("sniffs each supported magic number", () => {
    assert.equal(fileOutputExtension(bytes(0x49, 0x49, 0x2a, 0x00)), "tif");
    assert.equal(fileOutputExtension(bytes(0x4d, 0x4d, 0x00, 0x2b)), "tif"); // BigTIFF
    assert.equal(fileOutputExtension(bytes(0x50, 0x41, 0x52, 0x31, 0)), "parquet");
    assert.equal(fileOutputExtension(bytes(0x66, 0x67, 0x62, 0x03)), "fgb");
    assert.equal(fileOutputExtension(bytes(0x50, 0x4b, 0x03, 0x04)), "zip");
    assert.equal(fileOutputExtension(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)), "png");
    assert.equal(fileOutputExtension(bytes(0x4c, 0x41, 0x53, 0x46)), "las");
    assert.equal(fileOutputExtension(new TextEncoder().encode("PMTiles\u0003rest")), "pmtiles");
  });

  it("tells LAZ from LAS by the compression bit on the point data format", () => {
    // LAS and LAZ share "LASF"; LASzip sets bit 7 of the header's point data
    // record format (byte 104). The WASM tools write format 6 as 0x06 for
    // `.las` and 0x86 (134) for `.laz`.
    const header = (pointFormat: number) => {
      const out = new Uint8Array(227);
      out.set([0x4c, 0x41, 0x53, 0x46]);
      out[104] = pointFormat;
      return out;
    };
    assert.equal(fileOutputExtension(header(0x06)), "las");
    assert.equal(fileOutputExtension(header(0x86)), "laz");
    assert.equal(fileOutputExtension(header(0x83)), "laz"); // format 3, compressed
    assert.equal(fileOutputExtension(header(0x00)), "las");
  });

  it("calls a LASF header too short to carry the point format .las", () => {
    assert.equal(fileOutputExtension(bytes(0x4c, 0x41, 0x53, 0x46, 1, 4)), "las");
  });

  it("falls back to .bin for empty, truncated or unknown bytes", () => {
    assert.equal(fileOutputExtension(bytes()), "bin");
    assert.equal(fileOutputExtension(bytes(0x50, 0x41, 0x52)), "bin"); // truncated PAR1
    assert.equal(fileOutputExtension(new TextEncoder().encode("PMTile")), "bin");
    assert.equal(fileOutputExtension(bytes(0, 1, 2, 3)), "bin");
  });
});

describe("isSubsetUrlParameter", () => {
  const url = param("url", { kind: "string" });

  it("matches the url string of each subset extractor", () => {
    for (const id of ["extract_cog_subset", "extract_wms_subset", "extract_xyz_tile_subset"]) {
      assert.equal(isSubsetUrlParameter(tool(id), url), true, id);
    }
  });

  it("rejects other tools, other names and non-string kinds", () => {
    assert.equal(isSubsetUrlParameter(tool("slope"), url), false);
    assert.equal(
      isSubsetUrlParameter(tool("extract_cog_subset"), param("input", { kind: "string" })),
      false,
    );
    assert.equal(
      isSubsetUrlParameter(tool("extract_cog_subset"), param("url", { kind: "file_in" })),
      false,
    );
    // An untyped parameter defaults to the string kind.
    assert.equal(isSubsetUrlParameter(tool("extract_cog_subset"), param("url")), true);
  });
});

describe("isFieldParameter", () => {
  it("matches a string parameter named like a column", () => {
    for (const name of [
      "field",
      "line_field",
      "sort_field",
      "fields",
      "class_attribute",
      "attributes",
    ]) {
      assert.equal(isFieldParameter(param(name, { kind: "string" })), true, name);
    }
  });

  it("rejects non-string kinds and other names", () => {
    assert.equal(isFieldParameter(param("class_field", { kind: "lidar_in" })), false);
    assert.equal(isFieldParameter(param("class_field", { kind: "enum" })), false);
    assert.equal(isFieldParameter(param("fieldname", { kind: "string" })), false);
    assert.equal(isFieldParameter(param("input", { kind: "string" })), false);
  });
});

describe("isCrsParameter", () => {
  it("matches numeric epsg parameters by name suffix", () => {
    for (const name of ["epsg", "dst_epsg", "epsg_code", "output_epsg", "EPSG"]) {
      assert.equal(isCrsParameter(param(name, { kind: "int" })), true, name);
      assert.equal(isCrsParameter(param(name, { kind: "double" })), true, name);
    }
  });

  it("rejects string kinds and lookalike names", () => {
    assert.equal(isCrsParameter(param("sidewalks_epsg", { kind: "string" })), false);
    assert.equal(isCrsParameter(param("epsg")), false); // untyped -> string
    assert.equal(isCrsParameter(param("epsgs", { kind: "int" })), false);
    assert.equal(isCrsParameter(param("myepsg", { kind: "int" })), false);
    assert.equal(isCrsParameter(param("epsg_code_out", { kind: "int" })), false);
  });

  it("resolves a WASM scalar parameter's kind from its schema", () => {
    const p = param("epsg", { data_kind: "number", schema: { kind: "scalar", scalar: "int32" } });
    assert.equal(isCrsParameter(p), true);
  });
});

describe("isDistanceParameter", () => {
  it("matches double distance parameters", () => {
    for (const name of ["search_dist", "radius", "grid_spacing", "snap_tolerance", "cell_size"]) {
      assert.equal(isDistanceParameter(param(name, { kind: "double" })), true, name);
    }
  });

  it("rejects ints, strings and dimensionless names", () => {
    assert.equal(isDistanceParameter(param("radius", { kind: "int" })), false);
    assert.equal(isDistanceParameter(param("radius", { kind: "string" })), false);
    assert.equal(isDistanceParameter(param("corridor_tolerance", { kind: "double" })), false);
    assert.equal(isDistanceParameter(param("z_factor", { kind: "double" })), false);
  });
});

describe("wgs84ToolLayerIds", () => {
  const vin = (name: string, required = true) => param(name, { kind: "vector_in", required });

  it("returns null without a tool or parameters", () => {
    assert.equal(wgs84ToolLayerIds(null, {}), null);
    assert.equal(wgs84ToolLayerIds(tool("x"), {}), null);
    assert.equal(wgs84ToolLayerIds(tool("x", []), {}), null);
  });

  it("returns null when any raster, LiDAR or file input is present", () => {
    for (const kind of ["raster_in", "lidar_in", "file_in"]) {
      const t = tool("x", [vin("input"), param("other", { kind })]);
      assert.equal(wgs84ToolLayerIds(t, { input: "layer:a" }), null, kind);
    }
  });

  it("returns null when the tool has no vector input", () => {
    assert.equal(wgs84ToolLayerIds(tool("x", [param("d", { kind: "double" })]), {}), null);
  });

  it("collects layer ids from every vector input, including multi-select arrays", () => {
    const t = tool("x", [vin("input"), vin("overlay"), param("d", { kind: "double" })]);
    assert.deepEqual(wgs84ToolLayerIds(t, { input: "layer:a", overlay: ["layer:b", "layer:c"] }), [
      "a",
      "b",
      "c",
    ]);
  });

  it("returns null when an input is a file path or a required input is empty", () => {
    const t = tool("x", [vin("input"), vin("overlay")]);
    assert.equal(wgs84ToolLayerIds(t, { input: "layer:a", overlay: "/data/b.shp" }), null);
    assert.equal(wgs84ToolLayerIds(t, { input: "layer:a", overlay: "" }), null);
  });

  it("skips an empty optional input", () => {
    const t = tool("x", [vin("input"), vin("mask", false)]);
    assert.deepEqual(wgs84ToolLayerIds(t, { input: "layer:a" }), ["a"]);
    assert.equal(wgs84ToolLayerIds(tool("x", [vin("mask", false)]), {}), null);
  });
});

describe("isPathParameter", () => {
  it("treats data inputs and outputs as paths", () => {
    assert.equal(isPathParameter(param("dem", { kind: "raster_in" })), true);
    assert.equal(isPathParameter(param("output", { kind: "vector_out" })), true);
  });

  it("matches a path-like word of a snake_case, camelCase or kebab-case name", () => {
    for (const name of [
      "folder",
      "output_folder",
      "input_file",
      "outputFolder",
      "inputFile",
      "csv-path",
      "INPUT_DIRECTORY",
      "out_filename",
      "image_files",
      "inputJSONFile",
    ]) {
      assert.equal(isPathParameter(param(name, { kind: "string" })), true, name);
    }
    // Untyped parameters resolve to the string kind.
    assert.equal(isPathParameter(param("output_folder")), true);
  });

  it("does not match a path word buried inside a longer word", () => {
    assert.equal(isPathParameter(param("profile_name", { kind: "string" })), false);
    assert.equal(isPathParameter(param("pathway", { kind: "string" })), false);
    // `dir` is flow direction in hydrology tools, not a folder.
    assert.equal(isPathParameter(param("flow_dir", { kind: "string" })), false);
  });

  it("falls back to whole-word path wording in the description or type", () => {
    assert.equal(isPathParameter(param("x", { description: "Input file to read" })), true);
    assert.equal(isPathParameter(param("x", { description: "The working DIRECTORY" })), true);
    assert.equal(isPathParameter(param("x", { type: "path" })), true);
    assert.equal(isPathParameter(param("x", { description: "Profile name" })), false);
    assert.equal(isPathParameter(param("x", { description: "Number of files" })), false);
  });

  it("never offers a picker for a numeric, boolean or enum parameter", () => {
    // Real catalog cases: split_lidar's `interval` ("points-per-output-file"),
    // points_to_path's `close_path` and optimal_path_as_line's `path_type`.
    assert.equal(isPathParameter(param("n", { kind: "int", description: "Rows per file" })), false);
    assert.equal(
      isPathParameter(param("interval", { kind: "double", description: "points-per-output-file" })),
      false,
    );
    assert.equal(isPathParameter(param("close_path", { kind: "bool" })), false);
    assert.equal(isPathParameter(param("path_type", { kind: "enum" })), false);
    assert.equal(isPathParameter(param("output_file", { kind: "int" })), false);
    // A WASM scalar resolves its kind from the schema.
    assert.equal(
      isPathParameter(
        param("path_corrected_direction_preference", {
          data_kind: "number",
          schema: { kind: "scalar", scalar: "f64" },
        }),
      ),
      false,
    );
  });

  it("returns false for an empty parameter", () => {
    assert.equal(isPathParameter(param("")), false);
  });
});

describe("pathFiltersForParameter / acceptForParameter", () => {
  it("offers raster extensions for raster inputs and outputs", () => {
    for (const kind of ["raster_in", "raster_out"]) {
      const [filter] = pathFiltersForParameter(param("x", { kind }));
      assert.equal(filter.name, "Raster");
      assert.ok(filter.extensions.includes("tif"));
    }
    assert.equal(
      acceptForParameter(param("x", { kind: "raster_in" })),
      ".tif,.tiff,.img,.bil,.flt,.sdat,.rdc,.asc",
    );
  });

  it("offers vector and LiDAR extensions", () => {
    assert.equal(pathFiltersForParameter(param("x", { kind: "vector_out" }))[0].name, "Vector");
    assert.equal(
      acceptForParameter(param("x", { kind: "vector_in" })),
      ".geojson,.json,.shp,.gpkg,.fgb,.sqlite,.gml,.kml",
    );
    assert.equal(
      acceptForParameter(param("x", { kind: "lidar_in" })),
      ".las,.laz,.zlidar,.copc,.e57,.ply",
    );
  });

  it("offers text formats when the name or type mentions one", () => {
    const expected = ".csv,.json,.geojson,.html,.txt,.xml";
    assert.equal(acceptForParameter(param("csv", { kind: "file_in" })), expected);
    assert.equal(acceptForParameter(param("report", { kind: "file_out", type: "HTML" })), expected);
    // One word of a snake_case, camelCase or kebab-case name is enough.
    for (const name of ["output_csv", "out_html", "sweep_spec_json", "reportXml", "notes-txt"]) {
      assert.equal(acceptForParameter(param(name, { kind: "file_out" })), expected, name);
    }
    assert.equal(acceptForParameter(param("csvish_output", { kind: "file_out" })), "");
    // The description is not consulted.
    assert.equal(acceptForParameter(param("x", { kind: "file_in", description: "a csv" })), "");
  });

  it("returns no filters for anything else", () => {
    assert.deepEqual(pathFiltersForParameter(param("x", { kind: "file_in" })), []);
    assert.deepEqual(pathFiltersForParameter(param("x")), []);
    assert.equal(acceptForParameter(param("x", { kind: "double" })), "");
  });
});

describe("outputExtensionForParameter", () => {
  it("maps dataset outputs to their default container", () => {
    assert.equal(outputExtensionForParameter(param("o", { kind: "raster_out" })), ".tif");
    assert.equal(outputExtensionForParameter(param("o", { kind: "vector_out" })), ".shp");
    assert.equal(outputExtensionForParameter(param("o", { kind: "lidar_out" })), ".laz");
  });

  it("sniffs a text format for other outputs", () => {
    assert.equal(
      outputExtensionForParameter(
        param("output", { kind: "file_out", description: "Output CSV path" }),
      ),
      ".csv",
    );
    assert.equal(
      outputExtensionForParameter(param("report", { kind: "file_out", type: "html" })),
      ".html",
    );
    assert.equal(
      outputExtensionForParameter(
        param("o", { kind: "file_out", description: "Output (.gpkg recommended)" }),
      ),
      ".gpkg",
    );
    assert.equal(
      outputExtensionForParameter(param("o", { kind: "file_out", data_kind: "table" })),
      ".csv",
    );
  });

  it("falls back to .txt", () => {
    assert.equal(outputExtensionForParameter(param("output", { kind: "file_out" })), ".txt");
    assert.equal(outputExtensionForParameter(param("")), ".txt");
  });
});

describe("defaultOutputName", () => {
  it("joins the tool id and parameter name with the output extension", () => {
    assert.equal(
      defaultOutputName("slope", param("output", { kind: "raster_out" })),
      "slope_output.tif",
    );
  });

  it("sanitizes unsafe characters into single underscores", () => {
    assert.equal(
      defaultOutputName("my tool!", param("out-file", { kind: "vector_out" })),
      "my_tool_out_file.shp",
    );
    // Runs of underscores collapse, and edge underscores are trimmed.
    assert.equal(defaultOutputName("_x_", param("y__", { kind: "lidar_out" })), "x_y.laz");
    assert.equal(defaultOutputName("a__b", param("c - d", { kind: "raster_out" })), "a_b_c_d.tif");
  });

  it("falls back for an empty tool id, parameter name or stem", () => {
    assert.equal(
      defaultOutputName("", param("output", { kind: "raster_out" })),
      "whitebox_output.tif",
    );
    assert.equal(defaultOutputName("slope", param("", { kind: "raster_out" })), "slope_output.tif");
    assert.equal(defaultOutputName("", param("")), "whitebox_output.txt");
    assert.equal(
      defaultOutputName("!!!", param("??", { kind: "raster_out" })),
      "whitebox_output.tif",
    );
  });

  it("replaces non-ASCII characters", () => {
    assert.equal(
      defaultOutputName("pente", param("sortie_é", { kind: "raster_out" })),
      "pente_sortie.tif",
    );
  });
});

describe("isFeatureCollection", () => {
  it("accepts a FeatureCollection with a features array", () => {
    assert.equal(isFeatureCollection({ type: "FeatureCollection", features: [] }), true);
  });

  it("rejects everything else", () => {
    for (const value of [
      null,
      undefined,
      0,
      "",
      "FeatureCollection",
      [],
      {},
      { type: "Feature", features: [] },
      { type: "FeatureCollection" },
      { type: "FeatureCollection", features: {} },
    ]) {
      assert.equal(isFeatureCollection(value), false, JSON.stringify(value));
    }
  });
});

describe("defaultParameterValue / createDefaultValues", () => {
  it("leaves outputs blank even when they carry a default", () => {
    assert.equal(defaultParameterValue(param("o", { kind: "raster_out", default: "out.tif" })), "");
  });

  it("keeps a falsy but defined default", () => {
    assert.equal(defaultParameterValue(param("n", { kind: "int", default: 0 })), 0);
    assert.equal(defaultParameterValue(param("b", { kind: "bool", default: false })), false);
    assert.equal(defaultParameterValue(param("s", { kind: "string", default: "" })), "");
    assert.equal(defaultParameterValue(param("b", { kind: "bool", default: true })), true);
  });

  it("does not coerce the default to the parameter kind", () => {
    assert.equal(defaultParameterValue(param("n", { kind: "double", default: "1.5" })), "1.5");
  });

  it("defaults booleans to false and everything else to an empty string", () => {
    assert.equal(defaultParameterValue(param("b", { kind: "bool" })), false);
    assert.equal(defaultParameterValue(param("b", { kind: "bool", default: null })), false);
    assert.equal(defaultParameterValue(param("n", { kind: "int", default: null })), "");
    assert.equal(defaultParameterValue(param("x")), "");
  });

  it("builds a value map keyed by parameter name", () => {
    const t = tool("x", [
      param("input", { kind: "raster_in" }),
      param("output", { kind: "raster_out", default: "o.tif" }),
      param("z", { kind: "double", default: 1 }),
      param("flag", { kind: "bool" }),
    ]);
    assert.deepEqual(createDefaultValues(t), { input: "", output: "", z: 1, flag: false });
  });

  it("returns an empty map for no tool or no parameters", () => {
    assert.deepEqual(createDefaultValues(null), {});
    assert.deepEqual(createDefaultValues(tool("x")), {});
  });
});

describe("mergeCatalogParameterFallbacks", () => {
  const snapParams = [param("dem", { kind: "raster_in" })];

  it("keeps a live tool that already has parameters", () => {
    const live = tool("slope", [param("input", { kind: "raster_in" })]);
    const [merged] = mergeCatalogParameterFallbacks([live], [tool("slope", snapParams)]);
    assert.equal(merged, live);
  });

  it("fills missing or empty parameters from the snapshot", () => {
    const snapshot = tool("slope", snapParams, { return_type: "raster" });
    const [a, b] = mergeCatalogParameterFallbacks(
      [tool("slope", undefined, { display_name: "Slope" }), tool("slope", [])],
      [snapshot],
    );
    assert.deepEqual(a, {
      id: "slope",
      display_name: "Slope",
      params: snapParams,
      return_type: "raster",
    });
    assert.equal(b.params, snapParams);
  });

  it("keeps the live return type over the snapshot's", () => {
    const [merged] = mergeCatalogParameterFallbacks(
      [tool("slope", [], { return_type: "json" })],
      [tool("slope", snapParams, { return_type: "raster" })],
    );
    assert.equal(merged.return_type, "json");
  });

  it("leaves a tool alone when the snapshot has nothing for it", () => {
    const live = tool("slope", []);
    assert.equal(mergeCatalogParameterFallbacks([live], [])[0], live);
    assert.equal(mergeCatalogParameterFallbacks([live], [tool("slope", [])])[0], live);
    assert.equal(mergeCatalogParameterFallbacks([live], [tool("aspect", snapParams)])[0], live);
  });

  it("preserves live order and ignores snapshot-only tools", () => {
    const merged = mergeCatalogParameterFallbacks(
      [tool("b", [param("x")]), tool("a", [param("y")])],
      [tool("c", snapParams)],
    );
    assert.deepEqual(
      merged.map((t) => t.id),
      ["b", "a"],
    );
    assert.deepEqual(mergeCatalogParameterFallbacks([], [tool("c", snapParams)]), []);
  });
});

describe("outputPath / outputEntries", () => {
  it("reads a trimmed path from a string or a { path } object", () => {
    assert.equal(outputPath("  /tmp/out.tif "), "/tmp/out.tif");
    assert.equal(outputPath({ path: " /tmp/out.shp" }), "/tmp/out.shp");
  });

  it("returns null for blank or unrecognized values", () => {
    for (const value of [null, undefined, "", "   ", 42, true, [], {}, { path: "" }, { path: 7 }]) {
      assert.equal(outputPath(value), null, JSON.stringify(value));
    }
  });

  it("keeps only outputs with a path, in insertion order", () => {
    assert.deepEqual(
      outputEntries({
        output: "/tmp/a.tif",
        stats: { path: "/tmp/b.json" },
        blank: "",
        number: 3,
      }),
      [
        ["output", "/tmp/a.tif"],
        ["stats", "/tmp/b.json"],
      ],
    );
    assert.deepEqual(outputEntries({}), []);
  });
});

describe("isJsonOutputPath", () => {
  it("matches .json and .geojson case-insensitively", () => {
    assert.equal(isJsonOutputPath("/tmp/out.json"), true);
    assert.equal(isJsonOutputPath("/tmp/out.GeoJSON"), true);
  });

  it("rejects other extensions and a bare suffix-less name", () => {
    assert.equal(isJsonOutputPath("/tmp/out.json.gz"), false);
    assert.equal(isJsonOutputPath("/tmp/out.tif"), false);
    assert.equal(isJsonOutputPath("json"), false);
    assert.equal(isJsonOutputPath(""), false);
  });
});

describe("jobStatusTone", () => {
  it("maps each status to a text tone", () => {
    assert.equal(jobStatusTone(null), "text-muted-foreground");
    assert.equal(jobStatusTone(job("succeeded")), "text-emerald-700");
    assert.equal(jobStatusTone(job("failed")), "text-destructive");
    assert.equal(jobStatusTone(job("running")), "text-primary");
    assert.equal(jobStatusTone(job("pending")), "text-primary");
    assert.equal(jobStatusTone(job("cancelled")), "text-primary");
  });
});
