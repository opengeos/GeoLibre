import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WhiteboxTool, WhiteboxToolParameter } from "../packages/processing/src/index";
import {
  cornerExtentParameters,
  extentFieldValues,
  extentParameterStyle,
  isBboxExtentParameter,
  isCornerExtentParameter,
} from "../apps/geolibre-desktop/src/lib/whitebox-extent";

function tool(params: WhiteboxToolParameter[], id = "test_tool"): WhiteboxTool {
  return { id, params };
}

// The four boundary numbers of `download_osm_vector`, in the order the tool
// declares them.
const OSM_PARAMS: WhiteboxToolParameter[] = [
  { name: "west", description: "West boundary longitude (EPSG:4326).", kind: "double" },
  { name: "south", description: "South boundary latitude (EPSG:4326).", kind: "double" },
  { name: "east", description: "East boundary longitude (EPSG:4326).", kind: "double" },
  { name: "north", description: "North boundary latitude (EPSG:4326).", kind: "double" },
  { name: "input_extent_epsg", kind: "int" },
  { name: "filter_preset", kind: "string" },
];

// A subset extractor's extent: one string plus its companion CRS.
const BBOX_PARAMS: WhiteboxToolParameter[] = [
  { name: "url", kind: "string" },
  { name: "bbox", kind: "string" },
  { name: "bbox_crs", kind: "int" },
];

const LAS_VEGAS: [number, number, number, number] = [
  -115.227034, 36.103098, -115.069792, 36.231702,
];

describe("extentParameterStyle", () => {
  it("recognizes both extent shapes and nothing else", () => {
    assert.equal(extentParameterStyle(tool(BBOX_PARAMS)), "bbox");
    assert.equal(extentParameterStyle(tool(OSM_PARAMS)), "corners");
    assert.equal(extentParameterStyle(tool([{ name: "input", kind: "vector_in" }])), null);
    assert.equal(extentParameterStyle(tool([])), null);
  });

  it("needs a bbox_crs beside the bbox", () => {
    // A lone `bbox` is not an extractor's extent (it could be any string), and
    // without the companion CRS there is nothing to keep consistent with 4326.
    assert.equal(extentParameterStyle(tool([{ name: "bbox", kind: "string" }])), null);
  });

  it("needs all four boundaries, each of them a number", () => {
    // Three of four is a partial match: filling only some fields would leave the
    // tool with an extent it cannot use.
    const missingNorth = OSM_PARAMS.filter((param) => param.name !== "north");
    assert.equal(extentParameterStyle(tool(missingNorth)), null);
    // A string `east` is something else (a direction, a column name), not a
    // coordinate the map shortcuts can write.
    const stringEast = OSM_PARAMS.map((param) =>
      param.name === "east" ? { ...param, kind: "string" as const } : param,
    );
    assert.equal(extentParameterStyle(tool(stringEast)), null);
  });

  it("resolves the boundary kind from a schema-only manifest", () => {
    // WASM tool manifests express the kind through `schema` rather than `kind`,
    // which is what the sidecar catalog carries.
    const schemaParams: WhiteboxToolParameter[] = ["west", "south", "east", "north"].map(
      (name) => ({ name, type: "number", schema: { kind: "scalar", scalar: "f64" } }),
    );
    assert.equal(extentParameterStyle(tool(schemaParams)), "corners");
  });
});

describe("extent parameter predicates", () => {
  it("marks only the field that holds each tool's extent", () => {
    const bboxTool = tool(BBOX_PARAMS);
    const cornerTool = tool(OSM_PARAMS);
    const paramOf = (source: WhiteboxToolParameter[], name: string) =>
      source.find((param) => param.name === name)!;

    assert.equal(isBboxExtentParameter(bboxTool, paramOf(BBOX_PARAMS, "bbox")), true);
    assert.equal(isBboxExtentParameter(bboxTool, paramOf(BBOX_PARAMS, "url")), false);
    for (const name of ["west", "south", "east", "north"]) {
      assert.equal(isCornerExtentParameter(cornerTool, paramOf(OSM_PARAMS, name)), true, name);
    }
    // The extent CRS keeps its own field (a searchable CRS picker), so it must
    // not be swallowed by the grouped control.
    assert.equal(
      isCornerExtentParameter(cornerTool, paramOf(OSM_PARAMS, "input_extent_epsg")),
      false,
    );
    // Neither predicate fires for the other tool's style.
    assert.equal(isCornerExtentParameter(bboxTool, paramOf(BBOX_PARAMS, "bbox")), false);
    assert.equal(isBboxExtentParameter(cornerTool, paramOf(OSM_PARAMS, "west")), false);
  });
});

describe("cornerExtentParameters", () => {
  it("returns the four boundaries in reading order, not declaration order", () => {
    // The tool declares west, south, east, north; the grouped control shows the
    // latitude pair above the longitude pair, like the Extract subset panel.
    assert.deepEqual(
      cornerExtentParameters(tool(OSM_PARAMS)).map((param) => param.name),
      ["north", "south", "west", "east"],
    );
    assert.deepEqual(cornerExtentParameters(tool(BBOX_PARAMS)), []);
  });
});

describe("extentFieldValues", () => {
  it("writes the four boundaries and the extent CRS for a corners tool", () => {
    assert.deepEqual(extentFieldValues(tool(OSM_PARAMS), LAS_VEGAS), {
      west: "-115.227034",
      south: "36.103098",
      east: "-115.069792",
      north: "36.231702",
      input_extent_epsg: "4326",
    });
  });

  it("writes the bbox string and its CRS for a bbox tool", () => {
    assert.deepEqual(extentFieldValues(tool(BBOX_PARAMS), LAS_VEGAS), {
      bbox: "-115.227034,36.103098,-115.069792,36.231702",
      bbox_crs: "4326",
    });
  });

  it("rounds to six decimals and drops trailing zeros", () => {
    // The fields hold strings, and a raw getBounds() corner carries ~15 digits
    // of float noise that would be pasted into a coordinate box.
    const values = extentFieldValues(
      tool(OSM_PARAMS),
      [-115.22703412345678, 36.10000000000001, -115.0697923456789, 36.2317026],
    );
    assert.equal(values?.west, "-115.227034");
    assert.equal(values?.south, "36.1");
    assert.equal(values?.north, "36.231703");
  });

  it("omits a companion CRS the tool does not declare", () => {
    const noCrs = OSM_PARAMS.filter((param) => param.name !== "input_extent_epsg");
    const values = extentFieldValues(tool(noCrs), LAS_VEGAS);
    assert.deepEqual(Object.keys(values ?? {}).sort(), ["east", "north", "south", "west"]);
  });

  it("rejects a box the extractors cannot use", () => {
    const cornerTool = tool(OSM_PARAMS);
    // Wraps the 180° meridian (west >= east): the tools mis-clip it.
    assert.equal(extentFieldValues(cornerTool, [170, 36, -170, 37]), null);
    // Zero-width / zero-height boxes.
    assert.equal(extentFieldValues(cornerTool, [-115, 36, -115, 37]), null);
    assert.equal(extentFieldValues(cornerTool, [-116, 36, -115, 36]), null);
    // Out of range, which a low-zoom view with several world copies produces
    // while still being correctly ordered.
    assert.equal(extentFieldValues(cornerTool, [-181, 36, -115, 37]), null);
    assert.equal(extentFieldValues(cornerTool, [-116, 36, 181, 37]), null);
    assert.equal(extentFieldValues(cornerTool, [-116, -91, -115, 37]), null);
    assert.equal(extentFieldValues(cornerTool, [-116, 36, -115, 91]), null);
    // A non-finite corner (an unprojectable view).
    assert.equal(extentFieldValues(cornerTool, [Number.NaN, 36, -115, 37]), null);
    // The whole world is a valid, if large, extent.
    assert.deepEqual(extentFieldValues(cornerTool, [-180, -90, 180, 90])?.west, "-180");
  });

  it("returns null for a tool with no extent parameters", () => {
    assert.equal(extentFieldValues(tool([{ name: "input", kind: "vector_in" }]), LAS_VEGAS), null);
  });
});
