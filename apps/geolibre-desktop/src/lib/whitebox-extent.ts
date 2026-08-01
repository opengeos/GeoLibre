import type { WhiteboxTool, WhiteboxToolParameter } from "@geolibre/processing";
import { parameterKind } from "./whitebox-param-kind";

/**
 * A geographic box as `[west, south, east, north]`, the order MapLibre's
 * `getBounds().toArray()` flattens to and the order every extent parameter
 * below is written in.
 */
export type ExtentBounds = [number, number, number, number];

/**
 * How a Processing tool spells the geographic extent it works on:
 *
 * - `bbox`: one `bbox` string of `west,south,east,north` with a companion
 *   `bbox_crs` (the COG/WMS/XYZ subset extractors).
 * - `corners`: four separate numeric boundary parameters (`download_osm_vector`).
 */
export type ExtentParameterStyle = "bbox" | "corners";

/**
 * The four numeric boundary parameters of the `corners` style, in the order
 * they spell an {@link ExtentBounds} box.
 */
export const EXTENT_CORNER_PARAMS = ["west", "south", "east", "north"] as const;

/**
 * Reading order for the grouped corner fields: the latitude pair above the
 * longitude pair, matching the Extract subset panel so the two extent controls
 * in the app look the same.
 */
export const EXTENT_CORNER_FIELD_ORDER = ["north", "south", "west", "east"] as const;

/** Parameter that names the CRS the extent is expressed in, per style. */
const EXTENT_CRS_PARAM: Record<ExtentParameterStyle, string> = {
  bbox: "bbox_crs",
  corners: "input_extent_epsg",
};

function isNumericParameter(param: WhiteboxToolParameter): boolean {
  const kind = parameterKind(param);
  return kind === "int" || kind === "double";
}

function findParameter(tool: WhiteboxTool, name: string): WhiteboxToolParameter | undefined {
  return tool.params?.find((param) => param.name === name);
}

/**
 * Which extent shape `tool` takes, if any. Matching on the parameter set rather
 * than on tool ids keeps every current and future extractor covered: a `bbox`
 * paired with a `bbox_crs` is a subset extractor's extent (GeoLibre#1213), and
 * four numeric `west`/`south`/`east`/`north` parameters are an area of interest
 * asked for one boundary at a time (GeoLibre#1541).
 *
 * @param tool - The selected tool.
 * @returns The extent style, or `null` when the tool has no extent parameters.
 */
export function extentParameterStyle(tool: WhiteboxTool): ExtentParameterStyle | null {
  const bbox = findParameter(tool, "bbox");
  if (bbox && parameterKind(bbox) === "string" && findParameter(tool, "bbox_crs")) {
    return "bbox";
  }
  const corners = EXTENT_CORNER_PARAMS.map((name) => findParameter(tool, name));
  if (corners.every((param) => param && isNumericParameter(param))) return "corners";
  return null;
}

/**
 * Whether `param` is the single `bbox` string that holds `tool`'s extent, which
 * the form renders as a text field with the map-extent shortcuts beside it.
 *
 * @param tool - The selected tool.
 * @param param - One of its parameters.
 * @returns `true` for the `bbox` parameter of a `bbox`-style tool.
 */
export function isBboxExtentParameter(tool: WhiteboxTool, param: WhiteboxToolParameter): boolean {
  return param.name === "bbox" && extentParameterStyle(tool) === "bbox";
}

/**
 * Whether `param` is one of the four boundary numbers that hold `tool`'s extent,
 * which the form folds into a single grouped extent control.
 *
 * @param tool - The selected tool.
 * @param param - One of its parameters.
 * @returns `true` for `west`/`south`/`east`/`north` on a `corners`-style tool.
 */
export function isCornerExtentParameter(tool: WhiteboxTool, param: WhiteboxToolParameter): boolean {
  return (
    (EXTENT_CORNER_PARAMS as readonly string[]).includes(param.name) &&
    extentParameterStyle(tool) === "corners"
  );
}

/**
 * The four boundary parameters of a `corners`-style tool, in reading order for
 * the grouped control.
 *
 * @param tool - The selected tool.
 * @returns The parameters, or an empty array for any other extent style.
 */
export function cornerExtentParameters(tool: WhiteboxTool): WhiteboxToolParameter[] {
  if (extentParameterStyle(tool) !== "corners") return [];
  return EXTENT_CORNER_FIELD_ORDER.map((name) => findParameter(tool, name)).filter(
    (param): param is WhiteboxToolParameter => Boolean(param),
  );
}

/**
 * Parameter values that write `bounds` into `tool`'s extent fields, whichever
 * style it uses, plus the companion CRS so the pair stays consistent (a stale
 * `bbox_crs` / `input_extent_epsg` would misread the numbers we just wrote).
 * Values are strings to match the form's convention that every scalar field
 * holds one.
 *
 * An unnormalized box is rejected: a view or drawn box that wraps the 180°
 * meridian yields `west >= east`, and at low zoom (several world copies)
 * `getBounds()` corners can fall outside ±180°/±90° while still ordered, both of
 * which the extractors mis-clip or reject.
 *
 * @param tool - The selected tool.
 * @param bounds - A WGS84 `[west, south, east, north]` box.
 * @returns The field values to apply, or `null` when the tool takes no extent
 *   or the box is not a usable WGS84 extent.
 */
export function extentFieldValues(
  tool: WhiteboxTool,
  bounds: ExtentBounds,
): Record<string, string> | null {
  const style = extentParameterStyle(tool);
  if (!style) return null;
  const [west, south, east, north] = bounds;
  if (
    !bounds.every((value) => Number.isFinite(value)) ||
    !(west < east) ||
    !(south < north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90
  ) {
    return null;
  }
  const fmt = (value: number) => Number(value.toFixed(6)).toString();
  const values: Record<string, string> =
    style === "bbox"
      ? { bbox: bounds.map(fmt).join(",") }
      : { west: fmt(west), south: fmt(south), east: fmt(east), north: fmt(north) };
  const crsParam = EXTENT_CRS_PARAM[style];
  if (findParameter(tool, crsParam)) values[crsParam] = String(4326);
  return values;
}
