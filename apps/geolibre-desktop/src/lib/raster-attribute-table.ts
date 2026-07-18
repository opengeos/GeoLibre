import {
  type GeoLibreLayer,
  getVectorColorRamp,
  interpolateColors,
  normalizeHexColor,
  rgbToHex,
} from "@geolibre/core";
import type { RasterSymbology } from "@geolibre/plugins";

import { csvCell, spreadsheetSafeText } from "./csv";

/**
 * Raster Attribute Table (issue #1307).
 *
 * Pure data logic for the RAT panel: enumerating a categorical band's classes,
 * reading a GDAL PAM (`.aux.xml`) raster attribute table, deriving a
 * categorical symbology from the table, and exporting it to CSV. The record is
 * persisted at `layer.metadata.rasterAttributeTable` so labels and colors
 * survive in the project file and drive the layer's symbology and legend.
 */

/** One class row: a raw pixel value with its census and display attributes. */
export type RasterAttributeTableRow = {
  /** The raw (stored) pixel value of this class. */
  value: number;
  /** Number of pixels holding this value (nodata excluded). */
  count: number;
  /** Human-readable class name; defaults to the bare value. */
  label: string;
  /** Class color as `#rrggbb`. */
  color: string;
};

/** The persisted table, stored at `metadata.rasterAttributeTable`. */
export type RasterAttributeTableRecord = {
  /** The 1-indexed band the table was computed from. */
  band: number;
  /** Class rows, ascending by value. */
  rows: RasterAttributeTableRow[];
  /** Approximate area of one pixel in square meters, or null when unknown. */
  pixelAreaM2: number | null;
};

/** A row read from a GDAL PAM raster attribute table (`.aux.xml`). */
export type GdalRatEntry = {
  value: number;
  count?: number;
  label?: string;
  color?: string;
};

/**
 * Upper bound on distinct values the table will enumerate. A band with more is
 * treated as continuous (not categorical) rather than building an unusable
 * thousands-row table.
 */
export const MAX_RAT_ROWS = 1024;

/**
 * Upper bound on classes "apply as symbology" supports: the injected colormap
 * lookup texture is 256 texels wide, so more classes cannot be told apart.
 * Mirrors `RASTER_MAX_STORED_CLASSES` in `@geolibre/plugins` — not imported
 * because a value import of that package would pull its browser-only renderer
 * deps into this pure module's `node --test` run; a unit test pins the two
 * constants equal so they cannot drift.
 */
export const MAX_RAT_SYMBOLOGY_CLASSES = 256;

/** Ramp used to seed class colors when the raster carries no palette or RAT. */
const DEFAULT_RAT_RAMP = "viridis";

/**
 * Counts the occurrences of each distinct value in a band.
 *
 * @param values - The band's pixel values (row-major, any typed array).
 * @param nodata - The nodata value to skip, or null when the band has none.
 * @param maxUnique - Bail-out cap on distinct values.
 * @returns Value → pixel count, or null when the band holds more than
 *   `maxUnique` distinct values (i.e. it is not categorical).
 */
export function computeValueCounts(
  values: ArrayLike<number>,
  nodata: number | null,
  maxUnique: number = MAX_RAT_ROWS,
): Map<number, number> | null {
  const counts = new Map<number, number>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue;
    if (nodata !== null && value === nodata) continue;
    const previous = counts.get(value);
    if (previous === undefined) {
      if (counts.size >= maxUnique) return null;
      counts.set(value, 1);
    } else {
      counts.set(value, previous + 1);
    }
  }
  return counts;
}

// --- GDAL PAM (.aux.xml) RAT parsing ---------------------------------------

/**
 * The URL of a raster's GDAL PAM sidecar: `.aux.xml` appended to the path,
 * not the raw string — a query-authenticated URL (a presigned S3/Azure link,
 * a `?token=` tile host) must keep its query after the suffix, or the request
 * asks for the wrong resource.
 *
 * @param url - The raster's http(s) URL.
 * @returns The sidecar URL, or null when `url` is not parseable.
 */
export function gdalAuxXmlUrl(url: string): string | null {
  try {
    const sidecar = new URL(url);
    sidecar.pathname += ".aux.xml";
    return sidecar.toString();
  } catch {
    return null;
  }
}

/** Unescapes the five XML entities GDAL writes in PAM text nodes. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** All `<tag …>…</tag>` blocks of a fragment (attributes allowed). */
function xmlBlocks(xml: string, tag: string): string[] {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g")) ?? [];
}

/** The first `<tag>` text node of a fragment, or "" when absent. */
function xmlTag(fragment: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(fragment);
  return match ? decodeXml(match[1]).trim() : "";
}

/** A numeric attribute of a block's opening tag, or null. */
function xmlAttr(block: string, attr: string): number | null {
  const match = new RegExp(`^<[^>]*\\b${attr}="([^"]*)"`).exec(block);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * GDAL RAT field usages (`GDALRATFieldUsage`) the parser understands. GDAL
 * writes the usage as a numeric `<Usage>` in each `<FieldDefn>`.
 */
const GFU_PIXEL_COUNT = 1;
const GFU_NAME = 2;
const GFU_MIN = 3;
const GFU_MIN_MAX = 5;
const GFU_RED = 6;
const GFU_GREEN = 7;
const GFU_BLUE = 8;

/** Fallback field-name matches for RATs written without usage metadata. */
const VALUE_FIELD_NAMES = new Set(["value"]);
const COUNT_FIELD_NAMES = new Set(["count", "histogram", "pixelcount"]);
const LABEL_FIELD_NAMES = new Set(["label", "name", "class_name", "classname"]);

/**
 * Parses a GDAL PAM sidecar (`<raster>.aux.xml`) raster attribute table into
 * per-value entries. Follows the repo's scoped-regex XML convention (see
 * `source-coop-api.ts`): PAM files are flat and machine-generated, and this
 * keeps the module testable under `node --test` (no `DOMParser` there).
 *
 * @param xml - The `.aux.xml` document text.
 * @param band - The 1-indexed band whose RAT to read.
 * @returns Entries ascending by value, or null when the document carries no
 *   usable RAT for the band (no value column, or no rows).
 */
export function parseGdalRat(xml: string, band = 1): GdalRatEntry[] | null {
  const bandBlock =
    xmlBlocks(xml, "PAMRasterBand").find((block) => (xmlAttr(block, "band") ?? 1) === band) ?? null;
  if (!bandBlock) return null;
  const rat = xmlBlocks(bandBlock, "GDALRasterAttributeTable")[0];
  if (!rat) return null;

  // Column roles by usage, with common field-name fallbacks. GFU_MIN doubles
  // as the value column for athematic RATs (value ranges); the row's minimum
  // is the closest single-value stand-in.
  let valueIndex: number | null = null;
  let countIndex: number | null = null;
  let labelIndex: number | null = null;
  let redIndex: number | null = null;
  let greenIndex: number | null = null;
  let blueIndex: number | null = null;
  for (const field of xmlBlocks(rat, "FieldDefn")) {
    const index = xmlAttr(field, "index");
    if (index === null) continue;
    const usage = Number(xmlTag(field, "Usage"));
    const name = xmlTag(field, "Name").toLowerCase();
    if (usage === GFU_MIN_MAX || usage === GFU_MIN) valueIndex ??= index;
    else if (usage === GFU_PIXEL_COUNT) countIndex ??= index;
    else if (usage === GFU_NAME) labelIndex ??= index;
    else if (usage === GFU_RED) redIndex ??= index;
    else if (usage === GFU_GREEN) greenIndex ??= index;
    else if (usage === GFU_BLUE) blueIndex ??= index;
    else if (VALUE_FIELD_NAMES.has(name)) valueIndex ??= index;
    else if (COUNT_FIELD_NAMES.has(name)) countIndex ??= index;
    else if (LABEL_FIELD_NAMES.has(name)) labelIndex ??= index;
  }
  // A RAT without a value column may still define row values by linear
  // binning: row i covers value Row0Min + i * BinSize (GDAL writes both as
  // attributes on the table element).
  const row0Min = xmlAttr(rat, "Row0Min");
  const binSize = xmlAttr(rat, "BinSize");
  const hasLinearBinning = row0Min !== null && binSize !== null && binSize > 0;
  if (valueIndex === null && !hasLinearBinning) return null;

  const channel = (fields: string[], index: number | null): number | null => {
    if (index === null) return null;
    const value = Number(fields[index]);
    return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : null;
  };

  // Row cells: paired <F>…</F> blocks and self-closing <F/> (an empty cell,
  // which GDAL writes for blank strings) — skipping the latter would shift
  // every later column of the row one place left.
  const rowCells = (row: string): string[] =>
    (row.match(/<F(?:\s[^>]*)?\/>|<F(?:\s[^>]*)?>[\s\S]*?<\/F>/g) ?? []).map((cell) =>
      cell.endsWith("/>") ? "" : xmlTag(cell, "F"),
    );

  const entries: GdalRatEntry[] = [];
  for (const [rowIndex, row] of xmlBlocks(rat, "Row").entries()) {
    const fields = rowCells(row);
    const value =
      valueIndex === null
        ? (row0Min as number) + rowIndex * (binSize as number)
        : Number(fields[valueIndex]);
    if (!Number.isFinite(value)) continue;
    const entry: GdalRatEntry = { value };
    if (countIndex !== null) {
      const count = Number(fields[countIndex]);
      if (Number.isFinite(count) && count >= 0) entry.count = count;
    }
    if (labelIndex !== null && fields[labelIndex]) {
      entry.label = fields[labelIndex];
    }
    const r = channel(fields, redIndex);
    const g = channel(fields, greenIndex);
    const b = channel(fields, blueIndex);
    if (r !== null && g !== null && b !== null) {
      entry.color = rgbToHex({ r, g, b });
    }
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  return entries.sort((a, b) => a.value - b.value);
}

// --- Pixel area -------------------------------------------------------------

/** GeoTIFF GeoKey ids/values needed to classify the CRS kind. */
const GT_MODEL_TYPE_PROJECTED = 1;
const GT_MODEL_TYPE_GEOGRAPHIC = 2;
const LINEAR_UNIT_METER = 9001;

/** Meters per degree of latitude / of longitude at the equator (WGS84 mean). */
const METERS_PER_DEG_LAT = 111132;
const METERS_PER_DEG_LON = 111320;

/**
 * Approximate area of one pixel in square meters, from the raster's
 * georeferencing. Projected rasters in meters use the resolution directly;
 * geographic rasters scale degrees by the raster's center latitude. Other or
 * unknown units return null (the table then shows counts without areas).
 *
 * @param info - The raster's resolution, origin Y, height, GeoKeys and south-up
 *   flag (the fields `readRasterData` provides): `resY` is positive, `originY`
 *   is the northern edge for a north-up raster and the southern edge when
 *   `flipY` is set.
 * @returns Square meters per pixel, or null when the CRS units are unknown.
 */
export function pixelAreaSquareMeters(info: {
  resX: number;
  resY: number;
  originY: number;
  height: number;
  flipY?: boolean;
  geoKeys: Record<string, unknown>;
}): number | null {
  const model = Number(info.geoKeys.GTModelTypeGeoKey);
  if (model === GT_MODEL_TYPE_PROJECTED) {
    const units = info.geoKeys.ProjLinearUnitsGeoKey;
    if (units !== undefined && Number(units) !== LINEAR_UNIT_METER) return null;
    return Math.abs(info.resX * info.resY);
  }
  if (model === GT_MODEL_TYPE_GEOGRAPHIC) {
    const halfSpan = (info.height * info.resY) / 2;
    const centerLat = info.flipY ? info.originY + halfSpan : info.originY - halfSpan;
    if (!Number.isFinite(centerLat) || Math.abs(centerLat) > 90) return null;
    const metersPerDegLon = METERS_PER_DEG_LON * Math.cos((centerLat * Math.PI) / 180);
    return Math.abs(info.resX * metersPerDegLon * info.resY * METERS_PER_DEG_LAT);
  }
  return null;
}

// --- Row seeding ------------------------------------------------------------

/**
 * Builds the table rows from a value census, seeding labels and colors from
 * (in priority order) an existing GDAL RAT, the raster's embedded palette, and
 * a color ramp sampled across the classes.
 *
 * @param counts - Value → pixel count (from {@link computeValueCounts} or the
 *   sidecar).
 * @param options.rat - Entries read from a `.aux.xml` RAT, if any.
 * @param options.palette - Value → color from the raster's embedded color
 *   table, if any.
 * @returns Rows ascending by value.
 */
export function seedRatRows(
  counts: ReadonlyMap<number, number>,
  options: {
    rat?: readonly GdalRatEntry[] | null;
    palette?: ReadonlyMap<number, string> | null;
  } = {},
): RasterAttributeTableRow[] {
  const values = [...counts.keys()].sort((a, b) => a - b);
  const ratByValue = new Map((options.rat ?? []).map((entry) => [entry.value, entry]));
  const rampColors = interpolateColors(getVectorColorRamp(DEFAULT_RAT_RAMP).colors, values.length);
  return values.map((value, index) => {
    const rat = ratByValue.get(value);
    return {
      value,
      count: counts.get(value) ?? 0,
      label: rat?.label ?? String(value),
      color: rat?.color ?? options.palette?.get(value) ?? rampColors[index] ?? "#808080",
    };
  });
}

// --- Persistence ------------------------------------------------------------

/**
 * Reads and validates the persisted attribute table from a store layer's
 * metadata, keeping only well-formed rows so a hand-edited project file cannot
 * crash the panel. Mirrors the defensive style of `savedRasterSymbology`.
 *
 * @param layer - A raster store layer.
 * @returns The validated record, or null when absent / malformed.
 */
export function savedRasterAttributeTable(layer: GeoLibreLayer): RasterAttributeTableRecord | null {
  const raw = layer.metadata.rasterAttributeTable;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const band =
    typeof candidate.band === "number" && Number.isInteger(candidate.band) && candidate.band >= 1
      ? candidate.band
      : null;
  if (band === null || !Array.isArray(candidate.rows)) return null;

  const rows: RasterAttributeTableRow[] = [];
  for (const entry of candidate.rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
    if (typeof row.count !== "number" || !Number.isFinite(row.count) || row.count < 0) {
      continue;
    }
    const color = typeof row.color === "string" ? normalizeHexColor(row.color) : null;
    if (!color) continue;
    rows.push({
      value: row.value,
      count: row.count,
      label: typeof row.label === "string" ? row.label : String(row.value),
      color,
    });
  }
  if (rows.length === 0 || rows.length > MAX_RAT_ROWS) return null;
  rows.sort((a, b) => a.value - b.value);

  const pixelAreaM2 =
    typeof candidate.pixelAreaM2 === "number" &&
    Number.isFinite(candidate.pixelAreaM2) &&
    candidate.pixelAreaM2 > 0
      ? candidate.pixelAreaM2
      : null;
  return { band, rows, pixelAreaM2 };
}

// --- Symbology --------------------------------------------------------------

/**
 * Class edges for a categorical value set: midpoints between consecutive
 * values, padded by half the smallest gap (or 0.5 for a single value) at both
 * ends, so every stored value falls inside its own class.
 *
 * @param values - Distinct class values, ascending.
 * @returns Edges ascending, length `values.length + 1`.
 */
export function categoricalBreaks(values: readonly number[]): number[] {
  let pad = 0.5;
  for (let i = 1; i < values.length; i++) {
    pad = Math.min(pad, (values[i] - values[i - 1]) / 2);
  }
  if (!(pad > 0)) pad = 0.5;
  const edges = [values[0] - pad];
  for (let i = 1; i < values.length; i++) {
    edges.push((values[i - 1] + values[i]) / 2);
  }
  edges.push(values[values.length - 1] + pad);
  return edges;
}

/**
 * Turns the table into the layer's categorical rendering: a classified
 * symbology with one class per row, colored by the row colors, plus the
 * rescale window the injected colormap texture expects.
 *
 * @param rows - The table rows (ascending by value, at least one).
 * @returns The symbology and matching `rasterState.rescale`, or null when the
 *   table is empty or exceeds {@link MAX_RAT_SYMBOLOGY_CLASSES}.
 */
export function categoricalSymbologyFromRows(
  rows: readonly RasterAttributeTableRow[],
): { symbology: RasterSymbology; rescale: [number, number][] } | null {
  if (rows.length === 0 || rows.length > MAX_RAT_SYMBOLOGY_CLASSES) return null;
  let values = rows.map((row) => row.value);
  let colors = rows.map((row) => row.color);
  if (rows.length === 1) {
    // A one-class table still needs two classes (the symbology minimum) and
    // two custom colors (fewer fall back to the named ramp): split the single
    // value's class in half, both halves the same color.
    values = [values[0] - 0.25, values[0] + 0.25];
    colors = [colors[0], colors[0]];
  }
  const breaks = categoricalBreaks(values);
  return {
    symbology: {
      classified: true,
      ramp: DEFAULT_RAT_RAMP,
      customColors: colors,
      method: "manual",
      classCount: values.length,
      breaks,
    },
    rescale: [[breaks[0], breaks[breaks.length - 1]]],
  };
}

// --- CSV --------------------------------------------------------------------

/**
 * Serializes the table to CSV (RFC 4180 quoting). The percent column is over
 * the counted (non-nodata) pixels; the area column appears only when the pixel
 * area is known.
 *
 * @param rows - The table rows.
 * @param pixelAreaM2 - Square meters per pixel, or null to omit areas.
 * @returns The CSV text, header first.
 */
export function ratRowsToCsv(
  rows: readonly RasterAttributeTableRow[],
  pixelAreaM2: number | null,
): string {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const header = ["value", "count", "percent"];
  if (pixelAreaM2 !== null) header.push("area_m2");
  header.push("color", "label");
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const cells: unknown[] = [
      row.value,
      row.count,
      total > 0 ? ((row.count / total) * 100).toFixed(2) : "0.00",
    ];
    if (pixelAreaM2 !== null) cells.push((row.count * pixelAreaM2).toFixed(1));
    // Labels are free text that can come from a remote RAT; guard the export
    // against spreadsheet formula injection. Values/counts/colors are numeric
    // or format-validated and stay verbatim.
    cells.push(row.color, spreadsheetSafeText(row.label));
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}
