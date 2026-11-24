import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { WhiteboxJob, WhiteboxTool, WhiteboxToolParameter } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import {
  RUNNING_JOB_STATUSES,
  binaryOutputExtension,
  buildCategoryOptions,
  collectLayerFieldNames,
  combinedMidLatitude,
  countToolSources,
  distanceDraftForUnit,
  distanceDraftToStored,
  evictOldestEntries,
  extentKindLabel,
  fieldOptionsForParameter,
  geoJsonOutputEntries,
  isJobRunning,
  isMissingRequiredValue,
  isRunDisabled,
  keepOrFirstToolId,
  keywordOnlyTools,
  latitudeLabelKey,
  localCatalogLoadError,
  matchesToolSource,
  parseBrowsedInput,
  resetVectorOutputFormats,
  resolveRunInputs,
  resolveSelectedTool,
  runVectorOutputFormat,
  runtimeStatusText,
  scopeTools,
  semanticMatchTools,
  shareLinkParameters,
  stepNumberValue,
  subsetCompanionReset,
  toolSearchFields,
  type BrowsedInput,
  type ResolveRunInputsOptions,
} from "../apps/geolibre-desktop/src/lib/processing-dialog-model";

/** A translate stub that echoes the key plus any interpolation values. */
function fakeT(catalog: Record<string, string> = {}): TFunction {
  const translate = ((key: string, options?: Record<string, unknown>) => {
    if (catalog[key]) return catalog[key];
    const extra = options
      ? Object.entries(options)
          .filter(([name]) => name !== "defaultValue")
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(",")
      : "";
    return extra ? `${key}(${extra})` : key;
  }) as unknown as TFunction;
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

function fc(properties: Record<string, unknown>[] = []): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: properties.map((props) => ({
      type: "Feature",
      properties: props,
      geometry: { type: "Point", coordinates: [0, 0] },
    })),
  };
}

function layer(id: string, extra: Record<string, unknown> = {}): GeoLibreLayer {
  return {
    id,
    name: `Layer ${id}`,
    source: {},
    ...extra,
  } as unknown as GeoLibreLayer;
}

const vectorIn = (name: string, extra: Partial<WhiteboxToolParameter> = {}) =>
  param(name, { kind: "vector_in", ...extra });

describe("isJobRunning", () => {
  it("is true only for pending or running jobs", () => {
    assert.deepEqual([...RUNNING_JOB_STATUSES].sort(), ["pending", "running"]);
    assert.equal(isJobRunning(job("pending")), true);
    assert.equal(isJobRunning(job("running")), true);
    assert.equal(isJobRunning(job("succeeded")), false);
    assert.equal(isJobRunning(job("failed")), false);
    assert.equal(isJobRunning(null), false);
  });
});

describe("resolveSelectedTool", () => {
  it("returns the matching tool unchanged when it has no varargs", () => {
    const slope = tool("slope", [param("dem")]);
    assert.equal(resolveSelectedTool([tool("a"), slope], "slope"), slope);
  });

  it("falls back to the first tool, then null", () => {
    const first = tool("first");
    assert.equal(resolveSelectedTool([first, tool("b")], "missing"), first);
    assert.equal(resolveSelectedTool([], "x"), null);
  });

  it("drops *args/**kwargs parameters without mutating the catalog", () => {
    const original = tool("x", [param("dem"), param("*args"), param("**kwargs")]);
    const resolved = resolveSelectedTool([original], "x");
    assert.deepEqual(
      resolved?.params?.map((p) => p.name),
      ["dem"],
    );
    assert.equal(original.params?.length, 3);
  });
});

describe("keepOrFirstToolId", () => {
  it("keeps a still-present selection, else picks the first tool", () => {
    const tools = [tool("a"), tool("b")];
    assert.equal(keepOrFirstToolId(tools, "b"), "b");
    assert.equal(keepOrFirstToolId(tools, "gone"), "a");
    assert.equal(keepOrFirstToolId([], "gone"), "");
  });
});

describe("collectLayerFieldNames", () => {
  it("unions property keys of the sampled features per GeoJSON layer", () => {
    const layers = [
      layer("a", { geojson: fc([{ name: 1 }, { pop: 2, name: 3 }]) }),
      layer("b", { geojson: fc([{}]) }),
      layer("c"),
    ];
    const fields = collectLayerFieldNames(layers);
    assert.deepEqual(fields.get("a"), ["name", "pop"]);
    assert.equal(fields.has("b"), false);
    assert.equal(fields.has("c"), false);
  });

  it("only scans the first `sample` features", () => {
    const layers = [layer("a", { geojson: fc([{ first: 1 }, { second: 2 }]) })];
    assert.deepEqual(collectLayerFieldNames(layers, 1).get("a"), ["first"]);
  });
});

describe("combinedMidLatitude", () => {
  const layers = [
    layer("north", { geojson: fc() }),
    layer("south", { geojson: fc() }),
    layer("table", { geojson: fc() }),
    layer("remote"),
  ];
  const bounds: Record<string, [number, number, number, number] | null> = {
    north: [0, 40, 1, 50],
    south: [0, -10, 1, 0],
    table: null,
  };
  const boundsOf = (item: GeoLibreLayer) => bounds[item.id] ?? null;

  it("takes the middle of the combined extent", () => {
    assert.equal(combinedMidLatitude(["north"], layers, boundsOf), 45);
    assert.equal(combinedMidLatitude(["north", "south"], layers, boundsOf), 20);
  });

  it("skips extentless layers but returns null when none has an extent", () => {
    assert.equal(combinedMidLatitude(["north", "table"], layers, boundsOf), 45);
    assert.equal(combinedMidLatitude(["table"], layers, boundsOf), null);
  });

  it("returns null for a layer without in-memory GeoJSON or an unknown id", () => {
    assert.equal(combinedMidLatitude(["north", "remote"], layers, boundsOf), null);
    assert.equal(combinedMidLatitude(["nope"], layers, boundsOf), null);
  });
});

describe("fieldOptionsForParameter", () => {
  const fields = new Map([
    ["l1", ["a", "b"]],
    ["l2", ["b", "c"]],
  ]);

  it("offers nothing for a non-field parameter or a tool without vector inputs", () => {
    assert.deepEqual(
      fieldOptionsForParameter(param("radius"), [vectorIn("input")], {}, fields),
      [],
    );
    assert.deepEqual(fieldOptionsForParameter(param("line_field"), [], {}, fields), []);
  });

  it("uses the single vector input's layer columns", () => {
    const values = { input: "layer:l1" };
    assert.deepEqual(
      fieldOptionsForParameter(param("line_field"), [vectorIn("input")], values, fields),
      ["a", "b"],
    );
  });

  it("is empty when the input is a file path rather than a layer", () => {
    const values = { input: "/data/roads.shp" };
    assert.deepEqual(
      fieldOptionsForParameter(param("line_field"), [vectorIn("input")], values, fields),
      [],
    );
  });

  it("matches a named input, else unions every input's columns", () => {
    const inputs = [vectorIn("target"), vectorIn("source")];
    const values = { target: "layer:l1", source: "layer:l2" };
    assert.deepEqual(fieldOptionsForParameter(param("source_field"), inputs, values, fields), [
      "b",
      "c",
    ]);
    assert.deepEqual(fieldOptionsForParameter(param("compare_field"), inputs, values, fields), [
      "a",
      "b",
      "c",
    ]);
  });
});

describe("shareLinkParameters", () => {
  it("keeps only changed, non-blank, non-path values", () => {
    const slope = tool("slope", [
      param("dem", { kind: "raster_in" }),
      param("output", { kind: "raster_out" }),
      param("zfactor", { default: 1 }),
      param("units", { default: "degrees" }),
      param("note"),
    ]);
    const params = shareLinkParameters(slope, {
      dem: "/tmp/dem.tif",
      output: "/tmp/out.tif",
      zfactor: 2,
      units: "degrees",
      note: "  ",
    });
    assert.deepEqual(params, { zfactor: "2" });
  });
});

describe("source and category filtering", () => {
  const tools = [
    tool("a", [], { source: "geolibre", category: "Conversion" }),
    tool("b", [], { category: "Hydrology" }),
    tool("c", [], { category: "Conversion" }),
    tool("d"),
  ];

  it("matchesToolSource ignores the filter when no GeoLibre tools exist", () => {
    assert.equal(matchesToolSource(tools[0], "whitebox", false), true);
    assert.equal(matchesToolSource(tools[0], "whitebox", true), false);
    assert.equal(matchesToolSource(tools[0], "geolibre", true), true);
    assert.equal(matchesToolSource(tools[1], "whitebox", true), true);
    assert.equal(matchesToolSource(tools[1], "All", true), true);
  });

  it("countToolSources splits GeoLibre and Whitebox tools", () => {
    assert.deepEqual(countToolSources(tools), {
      all: 4,
      geolibre: 1,
      whitebox: 3,
    });
  });

  it("buildCategoryOptions counts within the source filter and sorts by name", () => {
    const options = buildCategoryOptions(
      tools,
      (item) => matchesToolSource(item, "whitebox", true),
      fakeT(),
      "en",
    );
    assert.equal(options[0].value, "All");
    // The GeoLibre-authored tool "a" is outside the source filter.
    assert.match(options[0].label, /total=3/);
    const rest = options.slice(1);
    assert.deepEqual(
      new Set(rest.map((option) => option.value)),
      new Set(["", "Conversion", "Hydrology"]),
    );
    const labels = rest.map((option) => option.label);
    assert.deepEqual(
      labels,
      [...labels].sort((x, y) => x.localeCompare(y, "en")),
    );
    assert.ok(rest.every((option) => /\(1\)$/.test(option.label)));
  });

  it("scopeTools applies the category and source filters", () => {
    const all = () => true;
    assert.deepEqual(
      scopeTools(tools, "Conversion", all).map((item) => item.id),
      ["a", "c"],
    );
    assert.deepEqual(
      scopeTools(tools, "", all).map((item) => item.id),
      ["d"],
    );
    assert.deepEqual(
      scopeTools(tools, "All", (item) => item.source !== "geolibre").map((item) => item.id),
      ["b", "c", "d"],
    );
  });
});

describe("toolSearchFields", () => {
  it("indexes names and categories but ranks on the tool's own names", () => {
    const fields = toolSearchFields(
      fakeT(),
      tool("fill_depressions", [], {
        category: "Hydrology",
        summary: "Fills sinks.",
      }),
    );
    assert.equal(fields.identifiers[0], "fill_depressions");
    assert.equal(fields.identifiers.length, 2);
    assert.ok(fields.name.startsWith("fill_depressions "));
    assert.ok(fields.name.includes("Hydrology"));
    assert.equal(fields.summary, "Fills sinks.");
    assert.equal(toolSearchFields(fakeT(), tool("x")).summary, "");
  });
});

describe("semantic matches", () => {
  const scoped = [tool("a"), tool("b"), tool("c")];

  it("resolves hits in ranked order and drops unknown ids", () => {
    assert.deepEqual(
      semanticMatchTools(scoped, [{ id: "c" }, { id: "zzz" }, { id: "a" }]).map((item) => item.id),
      ["c", "a"],
    );
    assert.deepEqual(semanticMatchTools(scoped, null), []);
    assert.deepEqual(semanticMatchTools(scoped, []), []);
  });

  it("keywordOnlyTools removes tools already in the ranked group", () => {
    const filtered = [scoped[0], scoped[1]];
    assert.equal(keywordOnlyTools(filtered, []), filtered);
    assert.deepEqual(
      keywordOnlyTools(filtered, [scoped[0]]).map((item) => item.id),
      ["b"],
    );
  });
});

describe("localCatalogLoadError", () => {
  const t = fakeT();
  const clean = {
    wasmError: null,
    catalogError: null,
    catalogEmpty: false,
    toolCount: 5,
  };

  it("is null for a clean load", () => {
    assert.equal(localCatalogLoadError(clean, t), null);
  });

  it("prefers the WASM runner error over a catalog error", () => {
    assert.equal(
      localCatalogLoadError({ ...clean, wasmError: new Error("w"), catalogError: "c" }, t),
      "processing.whitebox.localRunnerError",
    );
  });

  it("surfaces the catalog error message, or a generic one", () => {
    assert.equal(localCatalogLoadError({ ...clean, catalogError: new Error("404") }, t), "404");
    assert.equal(
      localCatalogLoadError({ ...clean, catalogError: "boom" }, t),
      "processing.whitebox.catalogSnapshotError",
    );
  });

  it("flags an empty catalog or an empty merged tool list", () => {
    assert.equal(
      localCatalogLoadError({ ...clean, catalogEmpty: true }, t),
      "processing.whitebox.catalogSnapshotError",
    );
    assert.equal(
      localCatalogLoadError({ ...clean, toolCount: 0 }, t),
      "processing.whitebox.catalogSnapshotError",
    );
  });
});

describe("runtimeStatusText", () => {
  const t = fakeT();
  it("covers checking, available and unavailable states", () => {
    assert.equal(runtimeStatusText(t, null, "x", 3), "processing.whitebox.checkingRuntime");
    assert.equal(runtimeStatusText(t, true, "Ready", 3), "Ready");
    assert.equal(runtimeStatusText(t, true, "", 3), "processing.whitebox.toolsAvailable(count=3)");
    assert.equal(runtimeStatusText(t, false, "Down", 3), "Down");
    assert.equal(runtimeStatusText(t, false, "", 3), "processing.whitebox.runtimeUnavailable");
  });
});

describe("isRunDisabled", () => {
  const base = {
    tool: tool("slope"),
    running: false,
    runLocal: false,
    runtimeAvailable: true,
  };

  it("enables a runnable tool and disables missing, locked or running ones", () => {
    assert.equal(isRunDisabled(base), false);
    assert.equal(isRunDisabled({ ...base, tool: null }), true);
    assert.equal(isRunDisabled({ ...base, tool: tool("slope", [], { locked: true }) }), true);
    assert.equal(isRunDisabled({ ...base, running: true }), true);
  });

  it("needs local mode or a live sidecar, except for the global DEM download", () => {
    assert.equal(isRunDisabled({ ...base, runtimeAvailable: false }), true);
    assert.equal(isRunDisabled({ ...base, runtimeAvailable: null }), true);
    assert.equal(isRunDisabled({ ...base, runtimeAvailable: false, runLocal: true }), false);
    assert.equal(
      isRunDisabled({
        ...base,
        tool: tool("download_global_dem"),
        runtimeAvailable: false,
      }),
      false,
    );
  });
});

describe("subsetCompanionReset", () => {
  const defaults = { styles: "", tile_size: 256, subdomains: "abc", url: "" };
  it("resets only the companion fields of the subset kind", () => {
    assert.deepEqual(subsetCompanionReset("wms", defaults), { styles: "" });
    assert.deepEqual(subsetCompanionReset("xyz", defaults), {
      tile_size: 256,
      subdomains: "abc",
    });
    assert.deepEqual(subsetCompanionReset("cog", defaults), {});
    assert.deepEqual(subsetCompanionReset(null, defaults), {});
  });
});

describe("resetVectorOutputFormats", () => {
  it("resets a vector_out holding a format name, but keeps a typed path", () => {
    const t1 = tool("reproject_vector", [
      param("output", { kind: "vector_out" }),
      param("epsg", { default: 4326 }),
    ]);
    const values = { output: "geoparquet", epsg: 3857 };
    const next = resetVectorOutputFormats(t1, values);
    assert.deepEqual(next, { output: "", epsg: 3857 });
    assert.notEqual(next, values);
    assert.deepEqual(resetVectorOutputFormats(t1, { output: "/tmp/out.shp", epsg: 1 }), {
      output: "/tmp/out.shp",
      epsg: 1,
    });
  });
});

describe("parseBrowsedInput", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("parses a GeoJSON FeatureCollection up front", () => {
    const bytes = encode(JSON.stringify(fc([{ a: 1 }])));
    const input = parseBrowsedInput("roads.GeoJSON", bytes);
    assert.equal(input.name, "roads.GeoJSON");
    assert.equal(input.bytes, bytes);
    assert.equal(input.geojson?.features.length, 1);
  });

  it("leaves invalid JSON, non-collections and other formats as raw bytes", () => {
    assert.equal(parseBrowsedInput("bad.json", encode("{not json")).geojson, undefined);
    assert.equal(
      parseBrowsedInput("feature.json", encode('{"type":"Feature"}')).geojson,
      undefined,
    );
    assert.equal(parseBrowsedInput("data.shp", encode(JSON.stringify(fc()))).geojson, undefined);
  });
});

describe("isMissingRequiredValue", () => {
  it("flags empty required inputs only", () => {
    const required = param("dem", { required: true });
    for (const empty of [undefined, null, "", []]) {
      assert.equal(isMissingRequiredValue(required, empty), true);
    }
    assert.equal(isMissingRequiredValue(required, 0), false);
    assert.equal(isMissingRequiredValue(required, false), false);
    assert.equal(isMissingRequiredValue(param("dem"), ""), false);
    assert.equal(
      isMissingRequiredValue(param("out", { required: true, kind: "raster_out" }), ""),
      false,
    );
  });
});

describe("resolveRunInputs", () => {
  const t = fakeT();
  const fetched = new Uint8Array([1, 2, 3]);

  function options(overrides: Partial<ResolveRunInputsOptions>): ResolveRunInputsOptions {
    return {
      tool: tool("t", []),
      values: {},
      layers: [],
      browsedInputs: new Map<string, BrowsedInput[]>(),
      runLocal: true,
      t,
      parameterLabel: (p) => `<${p.name}>`,
      fetchLayerBytes: async (item) => (item.id === "remote" ? null : fetched),
      ...overrides,
    };
  }

  const roads = layer("roads", {
    geojson: fc([{ a: 1 }]),
    sourcePath: "/d/roads.geojson",
  });
  const dem = layer("dem", { sourcePath: "/d/dem.tif" });
  const remote = layer("remote", { sourcePath: "/d/remote.tif" });

  it("passes plain values through and reports a missing required value", async () => {
    const result = await resolveRunInputs(
      options({
        tool: tool("t", [param("zfactor"), param("units")]),
        values: { zfactor: 2, units: "m" },
      }),
    );
    assert.deepEqual(result, {
      ok: true,
      parameters: { zfactor: 2, units: "m" },
      layerInputs: {},
    });

    const missing = await resolveRunInputs(
      options({ tool: tool("t", [param("dem", { required: true })]) }),
    );
    assert.deepEqual(missing, {
      ok: false,
      error: "processing.whitebox.missingRequiredParameter(label=<dem>)",
    });
  });

  it("feeds browsed files to the runner, but rejects raw bytes in sidecar mode", async () => {
    const bytes = new Uint8Array([9]);
    const geo = fc();
    const browsedInputs = new Map<string, BrowsedInput[]>([
      ["input", [{ name: "a.tif", bytes }]],
      ["vec", [{ name: "v.geojson", bytes, geojson: geo }]],
    ]);
    const t1 = tool("t", [param("input", { kind: "raster_in" }), vectorIn("vec")]);
    const local = await resolveRunInputs(options({ tool: t1, browsedInputs }));
    assert.ok(local.ok);
    assert.deepEqual(local.layerInputs, {
      input: { name: "a.tif", kind: "raster_in", bytes },
      vec: { name: "v.geojson", kind: "vector_in", geojson: geo },
    });

    const sidecar = await resolveRunInputs(options({ tool: t1, browsedInputs, runLocal: false }));
    assert.deepEqual(sidecar, {
      ok: false,
      error: "processing.whitebox.sidecarCannotReadBrowserFiles(label=<input>)",
    });
  });

  it("keeps several browsed files as a list", async () => {
    const firstBytes = new Uint8Array([1]);
    const secondBytes = new Uint8Array([2]);
    const browsedInputs = new Map<string, BrowsedInput[]>([
      [
        "inputs",
        [
          { name: "a.tif", bytes: firstBytes },
          { name: "b.tif", bytes: secondBytes },
        ],
      ],
    ]);
    const result = await resolveRunInputs(
      options({
        tool: tool("t", [param("inputs", { kind: "raster_in" })]),
        browsedInputs,
      }),
    );
    assert.ok(result.ok);
    assert.deepEqual(result.layerInputs.inputs, [
      { name: "a.tif", kind: "raster_in", bytes: firstBytes },
      { name: "b.tif", kind: "raster_in", bytes: secondBytes },
    ]);
  });

  it("resolves a single layer token by kind and mode", async () => {
    const t1 = tool("t", [
      vectorIn("vec"),
      param("ras", { kind: "raster_in" }),
      param("far", { kind: "raster_in" }),
      param("gone", { kind: "raster_in" }),
    ]);
    const values = {
      vec: "layer:roads",
      ras: "layer:dem",
      far: "layer:remote",
      gone: "layer:missing",
    };
    const local = await resolveRunInputs(
      options({ tool: t1, values, layers: [roads, dem, remote] }),
    );
    assert.ok(local.ok);
    assert.deepEqual(local.layerInputs, {
      vec: { name: "Layer roads", kind: "vector_in", geojson: roads.geojson },
      ras: { name: "Layer dem", kind: "raster_in", bytes: fetched },
    });
    // Unfetchable bytes fall back to the path; an unknown layer is skipped.
    assert.deepEqual(local.parameters, { far: "/d/remote.tif" });

    const sidecar = await resolveRunInputs(
      options({
        tool: t1,
        values,
        layers: [roads, dem, remote],
        runLocal: false,
      }),
    );
    assert.ok(sidecar.ok);
    assert.deepEqual(sidecar.parameters, {
      ras: "/d/dem.tif",
      far: "/d/remote.tif",
    });
  });

  describe("multiple-dataset parameters", () => {
    const multi = (kind: string) =>
      tool("t", [param("inputs", { kind, schema: { cardinality: "multiple" } })]);

    it("reports a selected layer that no longer exists", async () => {
      const result = await resolveRunInputs(
        options({
          tool: multi("vector_in"),
          values: { inputs: ["layer:roads", "layer:gone"] },
          layers: [roads],
        }),
      );
      assert.deepEqual(result, {
        ok: false,
        error: "processing.whitebox.selectedLayersMissing(label=<inputs>)",
      });
    });

    it("needs in-memory GeoJSON for local vector inputs", async () => {
      const ok = await resolveRunInputs(
        options({
          tool: multi("vector_in"),
          values: { inputs: ["layer:roads"] },
          layers: [roads],
        }),
      );
      assert.ok(ok.ok);
      assert.deepEqual(ok.layerInputs.inputs, [
        { name: "Layer roads", kind: "vector_in", geojson: roads.geojson },
      ]);

      const bad = await resolveRunInputs(
        options({
          tool: multi("vector_in"),
          values: { inputs: ["layer:dem"] },
          layers: [dem],
        }),
      );
      assert.deepEqual(bad, {
        ok: false,
        error: "processing.whitebox.layerMissingGeoJson(layer=Layer dem,label=<inputs>)",
      });
    });

    it("fetches bytes for local raster stacks", async () => {
      const ok = await resolveRunInputs(
        options({
          tool: multi("raster_in"),
          values: { inputs: ["layer:dem"] },
          layers: [dem],
        }),
      );
      assert.ok(ok.ok);
      assert.deepEqual(ok.layerInputs.inputs, [
        { name: "Layer dem", kind: "raster_in", bytes: fetched },
      ]);

      const bad = await resolveRunInputs(
        options({
          tool: multi("raster_in"),
          values: { inputs: ["layer:dem", "layer:remote"] },
          layers: [dem, remote],
        }),
      );
      assert.deepEqual(bad, {
        ok: false,
        error: "processing.whitebox.layerNotFetchable(layer=Layer remote,label=<inputs>)",
      });
    });

    it("sends GeoJSON or comma-joined paths to the sidecar", async () => {
      const vec = await resolveRunInputs(
        options({
          tool: multi("vector_in"),
          values: { inputs: ["layer:roads"] },
          layers: [roads],
          runLocal: false,
        }),
      );
      assert.ok(vec.ok);
      assert.equal((vec.layerInputs.inputs as unknown[]).length, 1);

      const paths = await resolveRunInputs(
        options({
          tool: multi("raster_in"),
          values: { inputs: ["layer:dem", "layer:remote"] },
          layers: [dem, remote],
          runLocal: false,
        }),
      );
      assert.ok(paths.ok);
      assert.deepEqual(paths.parameters, {
        inputs: "/d/dem.tif,/d/remote.tif",
      });

      const pathless = layer("mem");
      const missingPath = await resolveRunInputs(
        options({
          tool: multi("raster_in"),
          values: { inputs: ["layer:mem"] },
          layers: [pathless],
          runLocal: false,
        }),
      );
      assert.deepEqual(missingPath, {
        ok: false,
        error: "processing.whitebox.layerMissingPath(layer=Layer mem,label=<inputs>)",
      });
    });
  });
});

describe("runVectorOutputFormat", () => {
  const t1 = tool("t", [param("output", { kind: "vector_out" })]);
  it("reads the vector_out format in local mode only", () => {
    assert.equal(runVectorOutputFormat(t1, { output: "flatgeobuf" }, true), "flatgeobuf");
    assert.equal(runVectorOutputFormat(t1, { output: "flatgeobuf" }, false), "geojson");
    assert.equal(runVectorOutputFormat(t1, { output: "/tmp/x.shp" }, true), "geojson");
  });
});

describe("evictOldestEntries", () => {
  it("drops the oldest keys until within the cap and reports each", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    const evicted: string[] = [];
    evictOldestEntries(map, 1, (key) => evicted.push(key));
    assert.deepEqual([...map.keys()], ["c"]);
    assert.deepEqual(evicted, ["a", "b"]);
    evictOldestEntries(map, 5);
    assert.equal(map.size, 1);
  });
});

describe("geoJsonOutputEntries", () => {
  it("keeps inline collections and JSON paths", () => {
    const collection = fc();
    const entries = geoJsonOutputEntries({
      inline: collection,
      path: "/out/result.geojson",
      raster: "/out/result.tif",
      bytes: new Uint8Array([1]),
    });
    assert.deepEqual(
      entries.map(([name]) => name),
      ["inline", "path"],
    );
  });
});

describe("binaryOutputExtension", () => {
  const unknown = new Uint8Array([0, 1, 2, 3]);
  const parquet = new Uint8Array([0x50, 0x41, 0x52, 0x31]);
  const fileOut = param("output", { kind: "file_out" });

  it("uses the sniffed extension when it recognizes the bytes", () => {
    assert.equal(binaryOutputExtension(parquet, "file_out", fileOut, "x.csv"), "parquet");
  });

  it("falls back to the typed path for an opaque file_out", () => {
    assert.equal(binaryOutputExtension(unknown, "file_out", fileOut, "/tmp/report.CSV"), "csv");
  });

  it("keeps .bin for other kinds or an unknown parameter", () => {
    assert.equal(binaryOutputExtension(unknown, "vector_out", fileOut, "x.csv"), "bin");
    assert.equal(binaryOutputExtension(unknown, "file_out", undefined, "x.csv"), "bin");
  });
});

describe("extentKindLabel", () => {
  it("names every distinct kind, sorted", () => {
    assert.equal(
      extentKindLabel([
        param("west", { kind: "double" }),
        param("north", { kind: "int" }),
        param("east", { kind: "double" }),
      ]),
      "double, int",
    );
  });
});

describe("stepNumberValue", () => {
  it("steps integers by one, truncating", () => {
    assert.equal(stepNumberValue("4", true, 1), "5");
    assert.equal(stepNumberValue("4.7", true, -1), "3");
  });

  it("steps decimals by 0.1 without float noise", () => {
    assert.equal(stepNumberValue("0.2", false, 1), "0.3");
    assert.equal(stepNumberValue("0", false, -1), "-0.1");
  });

  it("treats unparsable text as zero", () => {
    assert.equal(stepNumberValue("", true, 1), "1");
    assert.equal(stepNumberValue("abc", false, 1), "0.1");
  });
});

describe("distance drafts", () => {
  it("stores converted degrees, blank, or the raw text", () => {
    assert.equal(distanceDraftToStored("0.5", "degrees", 0), "0.5");
    assert.equal(distanceDraftToStored("  ", "meters", 0), "");
    assert.equal(distanceDraftToStored("12a", "meters", 0), "12a");
    const stored = Number(distanceDraftToStored("1000", "meters", 0));
    assert.ok(stored > 0.008 && stored < 0.01);
  });

  it("carries a stored value across units and round-trips it", () => {
    const meters = distanceDraftForUnit("0.01", "meters", 45);
    assert.ok(Number(meters) > 500);
    assert.equal(distanceDraftToStored(meters, "meters", 45), "0.01");
    assert.equal(distanceDraftForUnit("oops", "meters", 45), "oops");
  });
});

describe("latitudeLabelKey", () => {
  it("names the hemisphere, or the equator when it rounds to zero", () => {
    assert.deepEqual(latitudeLabelKey(44.04), {
      key: "processing.distance.north",
      latitude: "44.0",
    });
    assert.deepEqual(latitudeLabelKey(-12.36), {
      key: "processing.distance.south",
      latitude: "12.4",
    });
    assert.deepEqual(latitudeLabelKey(-0.04), {
      key: "processing.distance.equator",
      latitude: "0.0",
    });
  });
});

describe("processing controller isolation", () => {
  it("imports without initializing the application store", () => {
    const modelUrl = new URL(
      "../apps/geolibre-desktop/src/lib/processing-dialog-model.ts",
      import.meta.url,
    ).href;
    const storeUrl = new URL("../packages/core/src/store.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(
        "export async function load(url, context, next) { " +
        "if(url.includes('/core/src/store')) throw new Error('Controller initialized the store'); " +
        "return next(url, context); }"
      ), import.meta.url);
      try {
        await import(${JSON.stringify(storeUrl)});
        throw new Error("Store guard did not run");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Controller initialized the store")) throw error;
      }
      await import(${JSON.stringify(modelUrl)});
    `,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
  });
});
