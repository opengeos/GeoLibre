import type { RasterData } from "./raster-client";
import { assertSameGrid } from "./raster-change";
import { rasterEpsg, toNorthUp } from "./raster-geo";

/**
 * Cut-and-fill / surface volume between an existing surface and a reference
 * (issue #3530).
 *
 * The reference is either a flat plane at a fixed elevation (a design grade, a
 * flood level, a stockpile base) or a second surface on the same pixel grid
 * (a design surface, or a later survey of the same site). For every cell with
 * both elevations, the depth `existing - reference` is positive where material
 * sits above the reference and must be **cut**, and negative where the
 * reference is higher and the hole must be **filled**. Volumes are the depths
 * times each cell's ground area, summed separately for cut and fill.
 *
 * Cell areas are ground areas to within the projection's scale factor: a
 * projected raster's cell size is converted from its linear unit to metres
 * (UTM and state-plane grids stay within about 0.1% of the ground), Web
 * Mercator rows are scaled by `cos²φ`, and a geographic (degree) raster gets
 * a per-row spherical area, since a degree of longitude shrinks toward the
 * poles. Elevations can be metres or feet; volumes are always reported in
 * cubic metres.
 */

/** NoData written to the difference raster. */
export const CUT_FILL_NODATA = Number.NaN;

/** Authalic (equal-area) radius of the WGS84 ellipsoid, in metres. */
export const AUTHALIC_EARTH_RADIUS_METERS = 6_371_007.181;

/** Metres per elevation unit, keyed by the `z_units` parameter. */
export const ELEVATION_UNIT_METERS: Record<string, number> = {
  m: 1,
  ft: 0.3048,
  "us-ft": 1200 / 3937,
};

/**
 * Metres per linear unit for the GeoTIFF `ProjLinearUnitsGeoKey` codes
 * (EPSG unit codes: 9001 metre, 9002 international foot, 9003 US survey foot,
 * 9036 kilometre).
 */
const LINEAR_UNIT_METERS: Record<number, number> = {
  9001: 1,
  9002: 0.3048,
  9003: 1200 / 3937,
  9036: 1000,
};

export interface CutFillParams {
  /** `"plane"` (default) or `"surface"`. */
  reference?: "plane" | "surface" | string;
  /** Elevation of the reference plane, in the raster's elevation units. */
  plane_elevation?: number;
  /** One-based band of both surfaces (default 1). */
  band?: number;
  /** Elevation units: `"m"` (default), `"ft"` or `"us-ft"`. */
  z_units?: string;
}

/** Totals reported by {@link cutFill}. */
export interface CutFillSummary {
  /** Material above the reference, in cubic metres (>= 0). */
  cutVolume: number;
  /** Space below the reference to fill, in cubic metres (>= 0). */
  fillVolume: number;
  /** `cutVolume - fillVolume`: positive means a surplus of material. */
  netVolume: number;
  /** Ground area that needs cutting, in square metres. */
  cutArea: number;
  /** Ground area that needs filling, in square metres. */
  fillArea: number;
  /** Area of every cell compared (cut, fill, and exactly on grade). */
  analysedArea: number;
  /** Number of cells compared. */
  cells: number;
  /** Deepest cut and deepest fill, in elevation units (>= 0). */
  maxCutDepth: number;
  maxFillDepth: number;
}

function valid(v: number, nodata: number | null): boolean {
  return Number.isFinite(v) && (nodata == null || v !== nodata);
}

/** Whether a raster's GeoKeys describe a geographic (lat/long) CRS. */
export function isGeographicRaster(raster: Pick<RasterData, "geoKeys">): boolean {
  const keys = raster.geoKeys ?? {};
  const model = Number(keys.GTModelTypeGeoKey);
  if (model === 2) return true;
  if (model === 1 || model === 3) return false;
  return keys.GeographicTypeGeoKey != null && keys.ProjectedCSTypeGeoKey == null;
}

/**
 * Metres per horizontal unit of a projected raster, from its explicit
 * `ProjLinearUnitsGeoKey` or else its proj4 definition's `+units` /
 * `+to_meter`.
 *
 * @param raster - The raster whose GeoKeys to read.
 * @param proj4Definition - The CRS definition, when it could be resolved.
 * @returns Metres per unit, or null when the unit is unknown.
 */
export function projectedMetersPerUnit(
  raster: Pick<RasterData, "geoKeys">,
  proj4Definition?: string | null,
): number | null {
  const code = Number(raster.geoKeys?.ProjLinearUnitsGeoKey);
  if (LINEAR_UNIT_METERS[code] != null) return LINEAR_UNIT_METERS[code];
  if (proj4Definition) {
    const toMeter = /\+to_meter=([0-9.eE+-]+)/.exec(proj4Definition);
    if (toMeter && Number(toMeter[1]) > 0) return Number(toMeter[1]);
    const units = /\+units=([\w-]+)/.exec(proj4Definition)?.[1];
    if (units === "m") return 1;
    if (units === "km") return 1000;
    if (units === "ft") return 0.3048;
    if (units === "us-ft") return 1200 / 3937;
  }
  return null;
}

/** EPSG codes of spherical (Pseudo-)Mercator, whose cells are not equal-area. */
const WEB_MERCATOR_EPSG = new Set([3857, 3785, 900913, 102100, 102113]);

/** Sphere radius Web Mercator projects onto, in metres. */
const WEB_MERCATOR_RADIUS = 6_378_137;

/**
 * Ground area of one cell in each row, in square metres.
 *
 * A Web Mercator cell is `1/cos²φ` times larger on the map than on the
 * ground, so a raw `resX · resY` would overstate a mid-latitude volume by
 * 70 % or more; those rows are scaled back by `cos²φ` at the row's centre.
 *
 * @param raster - A north-up raster.
 * @param metersPerUnit - Metres per horizontal unit for a projected raster
 *   (ignored for a geographic one).
 * @returns One area per row; constant for an ordinary projected raster.
 */
export function cellAreasByRow(raster: RasterData, metersPerUnit: number): Float64Array {
  const areas = new Float64Array(raster.height);
  if (!isGeographicRaster(raster)) {
    const mapArea = raster.resX * metersPerUnit * raster.resY * metersPerUnit;
    const epsg = rasterEpsg(raster);
    if (epsg == null || !WEB_MERCATOR_EPSG.has(epsg)) {
      areas.fill(mapArea);
      return areas;
    }
    for (let row = 0; row < raster.height; row += 1) {
      const y = raster.originY - (row + 0.5) * raster.resY;
      const lat = Math.atan(Math.sinh(y / WEB_MERCATOR_RADIUS));
      areas[row] = mapArea * Math.cos(lat) ** 2;
    }
    return areas;
  }
  const unit = raster.geoKeys?.GeogAngularUnitsGeoKey;
  if (unit != null && Number(unit) !== 9102) {
    throw new Error(
      `Unsupported geographic angular unit (GeogAngularUnitsGeoKey ${String(unit)}); reproject the raster first.`,
    );
  }
  // A spherical zone between two parallels has area R² · Δλ · (sin φn − sin φs).
  const r2 = AUTHALIC_EARTH_RADIUS_METERS * AUTHALIC_EARTH_RADIUS_METERS;
  const dLambda = (raster.resX * Math.PI) / 180;
  const clampLat = (lat: number) => Math.max(-90, Math.min(90, lat));
  for (let row = 0; row < raster.height; row += 1) {
    const north = clampLat(raster.originY - row * raster.resY);
    const south = clampLat(raster.originY - (row + 1) * raster.resY);
    areas[row] =
      r2 *
      dLambda *
      Math.abs(Math.sin((north * Math.PI) / 180) - Math.sin((south * Math.PI) / 180));
  }
  return areas;
}

function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

/**
 * Format a {@link CutFillSummary} as log lines.
 *
 * @param summary - The totals.
 * @param zUnits - Elevation unit label for the depths.
 * @returns Human-readable lines.
 */
export function formatCutFillSummary(summary: CutFillSummary, zUnits = "m"): string[] {
  const hectares = (m2: number) => formatNumber(m2 / 10_000, 4);
  return [
    `Cut volume: ${formatNumber(summary.cutVolume)} m³ over ${formatNumber(summary.cutArea)} m² (${hectares(summary.cutArea)} ha).`,
    `Fill volume: ${formatNumber(summary.fillVolume)} m³ over ${formatNumber(summary.fillArea)} m² (${hectares(summary.fillArea)} ha).`,
    `Net volume (cut - fill): ${formatNumber(summary.netVolume)} m³ (${summary.netVolume >= 0 ? "surplus" : "deficit"}).`,
    `Analysed area: ${formatNumber(summary.analysedArea)} m² (${hectares(summary.analysedArea)} ha), ${summary.cells} cells.`,
    `Deepest cut: ${formatNumber(summary.maxCutDepth, 3)} ${zUnits}; deepest fill: ${formatNumber(summary.maxFillDepth, 3)} ${zUnits}.`,
  ];
}

/**
 * Compute cut and fill between an existing surface and a reference plane or
 * surface.
 *
 * @param existingInput - The existing (before) surface.
 * @param referenceInput - The reference surface on the same grid, or null to
 *   use the plane at `params.plane_elevation`.
 * @param params - Reference kind, plane elevation, band and elevation units.
 * @param metersPerUnit - Metres per horizontal unit of a projected raster
 *   (default 1; ignored for a geographic raster).
 * @returns A difference raster (`existing - reference`, NaN where either is
 *   NoData), the totals, and log lines.
 * @throws When the band is missing, the surfaces are on different grids, or
 *   the plane elevation is not a number.
 */
export function cutFill(
  existingInput: RasterData,
  referenceInput: RasterData | null,
  params: CutFillParams,
  metersPerUnit = 1,
): { raster: RasterData; summary: CutFillSummary; messages: string[] } {
  const existing = toNorthUp(existingInput);
  const usePlane = (params.reference ?? "plane") !== "surface";
  const reference = usePlane ? null : referenceInput ? toNorthUp(referenceInput) : null;
  if (!usePlane && !reference) throw new Error("Choose the reference surface raster.");
  if (reference) assertSameGrid(existing, reference, "reference surface");
  const bandNo = Math.trunc(Number(params.band ?? 1)) || 1;
  const a = existing.bands[bandNo - 1];
  if (!a) {
    throw new Error(
      `The existing surface has no band ${bandNo} (it has ${existing.bands.length} band(s)).`,
    );
  }
  const b = reference ? reference.bands[bandNo - 1] : null;
  if (reference && !b) {
    throw new Error(
      `The reference surface has no band ${bandNo} (it has ${reference.bands.length} band(s)).`,
    );
  }
  const plane = Number(params.plane_elevation ?? 0);
  if (usePlane && !Number.isFinite(plane)) throw new Error("The plane elevation must be a number.");
  const zUnits = params.z_units || "m";
  if (ELEVATION_UNIT_METERS[zUnits] == null) {
    throw new Error(`Unknown elevation unit "${zUnits}" (use m, ft or us-ft).`);
  }
  const zToMeters = ELEVATION_UNIT_METERS[zUnits];
  const areas = cellAreasByRow(existing, metersPerUnit);

  const out = new Float32Array(a.length);
  const summary: CutFillSummary = {
    cutVolume: 0,
    fillVolume: 0,
    netVolume: 0,
    cutArea: 0,
    fillArea: 0,
    analysedArea: 0,
    cells: 0,
    maxCutDepth: 0,
    maxFillDepth: 0,
  };
  const { width, height } = existing;
  for (let row = 0; row < height; row += 1) {
    const area = areas[row];
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const x = a[i];
      const y = b ? b[i] : plane;
      if (!valid(x, existing.nodata) || (b && !valid(y, reference?.nodata ?? null))) {
        out[i] = CUT_FILL_NODATA;
        continue;
      }
      const depth = x - y;
      out[i] = depth;
      summary.cells += 1;
      summary.analysedArea += area;
      if (depth > 0) {
        summary.cutVolume += depth * zToMeters * area;
        summary.cutArea += area;
        if (depth > summary.maxCutDepth) summary.maxCutDepth = depth;
      } else if (depth < 0) {
        summary.fillVolume += -depth * zToMeters * area;
        summary.fillArea += area;
        if (-depth > summary.maxFillDepth) summary.maxFillDepth = -depth;
      }
    }
  }
  summary.netVolume = summary.cutVolume - summary.fillVolume;
  if (summary.cells === 0) {
    throw new Error(
      "No cell has an elevation in both surfaces (inside the boundary, if one is set).",
    );
  }
  const messages = [
    usePlane
      ? `Reference: plane at ${formatNumber(plane, 3)} ${zUnits} (band ${bandNo}).`
      : `Reference: second surface (band ${bandNo}).`,
    ...formatCutFillSummary(summary, zUnits),
    "Output: existing - reference; positive cells are cut, negative cells are fill.",
  ];
  return {
    raster: { ...existing, bands: [out], nodata: CUT_FILL_NODATA },
    summary,
    messages,
  };
}
