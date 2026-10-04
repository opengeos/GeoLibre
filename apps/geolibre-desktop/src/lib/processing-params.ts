import {
  outputTextFormatHint,
  type WhiteboxJob,
  type WhiteboxTool,
  type WhiteboxToolParameter,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import { humanizeIdentifier, translateToolName } from "./processing-tool-i18n";
import { isTiff } from "./scripting/binary-output";
import { subsetUrlToolKind } from "./subset-tool-url";
import type { FileDialogFilter } from "./tauri-io";
import { isDistanceParameterName, wgs84VectorLayerIds } from "./whitebox-distance-params";
import { isFieldParameterName } from "./whitebox-field-params";
import { identifierWords, parameterKind } from "./whitebox-param-kind";

/**
 * Pure parameter and output helpers for the Whitebox Processing dialog
 * (`components/processing/ProcessingDialog.tsx`): classifying a tool's
 * parameters, building file-picker filters and default output names, seeding a
 * form's default values, and reading a finished job's outputs. Nothing here
 * touches React, the store or the DOM, so it is unit-tested directly in
 * `tests/processing-params.test.ts`.
 */

export type ParameterValues = Record<string, unknown>;

export const LAYER_TOKEN_PREFIX = "layer:";

export function toolLabel(t: TFunction, tool: WhiteboxTool): string {
  return translateToolName(t, "whitebox", {
    id: tool.id,
    name: tool.display_name || humanize(tool.id),
  });
}

export function humanize(value: string): string {
  return humanizeIdentifier(value, "Tool");
}

export function isOutputParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param).endsWith("_out");
}

// Byte offset of the "point data record format" field in a LAS 1.x public
// header block. LASzip marks a compressed (LAZ) file by setting bit 7 of it.
const LAS_POINT_FORMAT_OFFSET = 104;
const LAZ_COMPRESSED_BIT = 0x80;

/**
 * Best-effort extension for a binary tool output, sniffed from its magic bytes.
 * Covers the formats GeoLibre `file_out`, (CRS-preserving) `vector_out` and
 * `lidar_out` tools emit today (GeoTIFF, GeoParquet, FlatGeobuf, zipped
 * Shapefile, PNG, LAS/LAZ, PMTiles); a genuinely opaque output falls back to
 * `.bin`. Extend the sniff here if a future tool writes a recognizable format.
 *
 * LAS and LAZ share the `LASF` signature, so the two are told apart by the
 * compression bit LASzip sets on the header's point data format. A header too
 * short to carry that field is reported as plain `.las`.
 *
 * @param bytes - The output's raw bytes.
 * @returns A bare extension (no leading dot), `bin` when nothing matches.
 */
export function fileOutputExtension(bytes: Uint8Array): string {
  const matches = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (isTiff(bytes)) return "tif";
  if (matches([0x50, 0x41, 0x52, 0x31])) return "parquet"; // "PAR1"
  if (matches([0x66, 0x67, 0x62, 0x03])) return "fgb"; // FlatGeobuf "fgb\x03"
  if (matches([0x50, 0x4b, 0x03, 0x04])) return "zip"; // Shapefile bundle "PK\x03\x04"
  if (matches([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (matches([0x4c, 0x41, 0x53, 0x46])) {
    // "LASF" (LAS/LAZ)
    const pointFormat = bytes[LAS_POINT_FORMAT_OFFSET];
    return pointFormat !== undefined && pointFormat & LAZ_COMPRESSED_BIT ? "laz" : "las";
  }
  // "PMTiles"
  if (matches([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73])) return "pmtiles";
  return "bin";
}

export function isDataInputParameter(param: WhiteboxToolParameter): boolean {
  return ["raster_in", "vector_in", "lidar_in", "file_in"].includes(parameterKind(param));
}

// The `url` string param of a COG/WMS/XYZ subset extractor, whose value can be
// filled from a compatible layer already loaded in the map (GeoLibre#1271). The
// tool-kind lookup keeps this to the subset extractors without hard-coding each
// id here; layer eligibility and the derived field values live in
// `subset-tool-url.ts`.
export function isSubsetUrlParameter(tool: WhiteboxTool, param: WhiteboxToolParameter): boolean {
  return (
    param.name === "url" && parameterKind(param) === "string" && subsetUrlToolKind(tool.id) !== null
  );
}

// A `*_field` / `*_attribute` string param names a column of one of the tool's
// vector inputs (points_to_line's `line_field`/`sort_field`, and ~170 other
// tools), so the dialog can offer the selected layer's attribute names instead
// of asking the user to recall a column name (GeoLibre#1459). The kind check is
// what keeps a same-named *dataset* param out (the catalog types
// classify_objects_svm's `class_field` as a LiDAR input): only a scalar string
// names a column.
export function isFieldParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param) === "string" && isFieldParameterName(param.name);
}

// A numeric `epsg` parameter names a coordinate reference system, so the field
// can offer a searchable CRS list instead of asking for a code from memory
// (GeoLibre#1538). Matching the name suffix covers `epsg`
// (assign_projection_vector), `dst_epsg` (reproject_vector/raster/lidar),
// `epsg_code`, `output_epsg` and the rest without hard-coding tool ids. The kind
// check keeps a *string* CRS override out (`sidewalks_epsg` takes an authority
// string, not a bare code), since the picker fills in a plain numeric code.
export function isCrsParameter(param: WhiteboxToolParameter): boolean {
  const kind = parameterKind(param);
  return (kind === "int" || kind === "double") && /(^|_)epsg(_code)?$/i.test(param.name);
}

// A `*_dist` / `*_radius` / `spacing` / `tolerance` (and friends) parameter is a
// ground distance in the input's coordinate units, so the field can offer
// metres/km/feet/miles alongside the degrees a WGS84 map layer forces on it
// (GeoLibre#1540). The name rule lives in `whitebox-distance-params.ts`. Only
// `double` qualifies: a metric distance almost always converts to a fractional
// number of degrees, which an integer parameter cannot carry, and the kind check
// also keeps a same-named enum or dataset parameter out.
export function isDistanceParameter(param: WhiteboxToolParameter): boolean {
  return parameterKind(param) === "double" && isDistanceParameterName(param.name);
}

/**
 * The map layers supplying a tool's coordinates when those coordinates are known
 * to be WGS84, or `null` when they are not.
 *
 * The distance unit picker is only safe when every dataset input is a map
 * layer's in-memory GeoJSON, which `runSelectedTool` hands over verbatim and RFC
 * 7946 fixes to WGS84. A raster or LiDAR input keeps its own CRS (GeoLibre never
 * reprojects those), so a tool with one is left alone entirely; the per-input
 * rule (a path leaves the units unknowable) lives in `wgs84VectorLayerIds`,
 * where it is unit-tested.
 *
 * Returns ids rather than latitudes so the caller can measure only the one or
 * two layers actually wired to the tool, instead of every layer in the project.
 *
 * @param tool - The selected tool.
 * @param values - The current form values.
 * @returns The chosen layers' ids, or `null` when the units are unknown.
 */
export function wgs84ToolLayerIds(
  tool: WhiteboxTool | null,
  values: ParameterValues,
): string[] | null {
  const params = tool?.params ?? [];
  if (!params.length) return null;
  const kinds = params.map((param) => parameterKind(param));
  if (kinds.some((kind) => kind === "raster_in" || kind === "lidar_in" || kind === "file_in")) {
    return null;
  }
  const vectorInputs = params.filter((_, index) => kinds[index] === "vector_in");
  if (!vectorInputs.length) return null;
  return wgs84VectorLayerIds(
    vectorInputs.map((param) => ({
      required: param.required,
      value: values[param.name],
    })),
    LAYER_TOKEN_PREFIX,
  );
}

// Name words that mark a free-text parameter as a filesystem path. `dir` is left
// out on purpose: hydrology tools use it for flow *direction* (`flow_dir`).
const PATH_NAME_WORDS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filename",
  "filenames",
  "filepath",
  "folder",
  "directory",
]);

/**
 * Whether a parameter takes a filesystem path, so the form renders a browse
 * button beside its text box.
 *
 * Typed dataset inputs and outputs (`raster_in`, `file_out`, …) always do. Any
 * other parameter qualifies only when it is free text (`string`): a number,
 * bool or enum never takes a path, whatever its description says ("Rows per
 * file" is a count). A string qualifies when a word of its name is path-like
 * (`output_folder`, `inputFile`, `csv-path`) or its description/type uses one
 * of the words path/file/folder/directory.
 *
 * @param param - A tool parameter from either catalog.
 * @returns True when the parameter should get a path picker.
 */
export function isPathParameter(param: WhiteboxToolParameter): boolean {
  if (isDataInputParameter(param) || isOutputParameter(param)) return true;
  if (parameterKind(param) !== "string") return false;
  if (identifierWords(param.name ?? "").some((word) => PATH_NAME_WORDS.has(word))) return true;
  const text = `${param.description ?? ""} ${param.type ?? ""}`.toLowerCase();
  return /\b(path|file|folder|directory)\b/.test(text);
}

const TEXT_FORMAT_WORDS = new Set(["csv", "json", "html", "txt", "xml"]);

export function pathFiltersForParameter(param: WhiteboxToolParameter): FileDialogFilter[] {
  const kind = parameterKind(param);
  if (kind.startsWith("raster")) {
    return [
      {
        name: "Raster",
        extensions: ["tif", "tiff", "img", "bil", "flt", "sdat", "rdc", "asc"],
      },
    ];
  }
  if (kind.startsWith("vector")) {
    return [
      {
        name: "Vector",
        extensions: ["geojson", "json", "shp", "gpkg", "fgb", "sqlite", "gml", "kml"],
      },
    ];
  }
  if (kind.startsWith("lidar")) {
    return [
      {
        name: "LiDAR",
        extensions: ["las", "laz", "zlidar", "copc", "e57", "ply"],
      },
    ];
  }
  // A text format named by a word of the parameter's name (`csv`, `output_csv`,
  // `reportHtml`) or its type; the description is not consulted.
  const words = [...identifierWords(param.name ?? ""), ...identifierWords(param.type ?? "")];
  if (words.some((word) => TEXT_FORMAT_WORDS.has(word))) {
    return [
      {
        name: "Files",
        extensions: ["csv", "json", "geojson", "html", "txt", "xml"],
      },
    ];
  }
  return [];
}

export function acceptForParameter(param: WhiteboxToolParameter): string {
  return pathFiltersForParameter(param)
    .flatMap((filter) => filter.extensions)
    .map((extension) => `.${extension}`)
    .join(",");
}

export function outputExtensionForParameter(param: WhiteboxToolParameter): string {
  const kind = parameterKind(param);
  if (kind === "raster_out") return ".tif";
  if (kind === "vector_out") return ".shp";
  if (kind === "lidar_out") return ".laz";
  // Sniff the intended text format from the parameter's name/description/type
  // via the same shared helper the WASM runner uses (e.g.
  // vector_summary_statistics' output is an "Output CSV path"). Only the
  // fallback differs: a friendly `.txt` here for a default filename suggestion,
  // vs the opaque `.dat` the runner writes.
  const hint = outputTextFormatHint(param);
  return hint ? `.${hint}` : ".txt";
}

/**
 * A suggested file name for a tool output, `<tool>_<param><ext>`, made safe for
 * any filesystem: every run of non-alphanumeric characters (including runs of
 * `_`, and the separator joining the two parts) collapses to a single `_`, and
 * edge underscores are trimmed.
 *
 * @param toolId - The tool id (`whitebox` when empty).
 * @param param - The output parameter (`output` when its name is empty).
 * @returns The file name with the parameter's default extension.
 */
export function defaultOutputName(toolId: string, param: WhiteboxToolParameter): string {
  const stem = `${toolId || "whitebox"}_${param.name || "output"}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${stem || "whitebox_output"}${outputExtensionForParameter(param)}`;
}

export function isFeatureCollection(value: unknown): value is FeatureCollection {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

export function defaultParameterValue(param: WhiteboxToolParameter): unknown {
  if (isOutputParameter(param)) return "";
  if (param.default !== undefined && param.default !== null) return param.default;
  if (parameterKind(param) === "bool") return false;
  return "";
}

export function createDefaultValues(tool: WhiteboxTool | null): ParameterValues {
  const values: ParameterValues = {};
  for (const param of tool?.params ?? []) {
    values[param.name] = defaultParameterValue(param);
  }
  return values;
}

export function mergeCatalogParameterFallbacks(
  liveTools: WhiteboxTool[],
  snapshotTools: WhiteboxTool[],
): WhiteboxTool[] {
  const snapshotById = new Map(snapshotTools.map((tool) => [tool.id, tool] as const));
  return liveTools.map((tool) => {
    if (tool.params?.length) return tool;
    const snapshot = snapshotById.get(tool.id);
    if (!snapshot?.params?.length) return tool;
    return {
      ...tool,
      params: snapshot.params,
      return_type: tool.return_type ?? snapshot.return_type,
    };
  });
}

export function outputPath(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string" && path.trim()) return path.trim();
  }
  return null;
}

export function outputEntries(outputs: Record<string, unknown>): [string, string][] {
  return Object.entries(outputs)
    .map(([name, value]) => [name, outputPath(value)] as const)
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function isJsonOutputPath(path: string): boolean {
  return /\.(geojson|json)$/i.test(path);
}

export function jobStatusTone(job: WhiteboxJob | null): string {
  if (!job) return "text-muted-foreground";
  if (job.status === "succeeded") return "text-emerald-700";
  if (job.status === "failed") return "text-destructive";
  return "text-primary";
}
