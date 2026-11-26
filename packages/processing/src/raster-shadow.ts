import type { Feature, Geometry, Position } from "geojson";
import type { RasterData } from "./raster-client";
import { geoKeysForEpsg } from "./raster-geo";
import { clearSkyDni, localTimeToUtc, sunPosition } from "./solar-position";

/**
 * Building shadows, sun hours and clear-sky insolation from extruded
 * footprints (issue #3530).
 *
 * The footprints are burned into a local height grid (metres, flat ground at
 * 0), and each sun position casts every building's shadow:
 *
 *  - **On the ground**, a prism's shadow on flat ground is exactly the union of
 *    its footprint and, for every footprint edge, the quadrilateral swept by
 *    translating that edge by the shadow offset `h / tan(elevation)` away from
 *    the sun. Those polygons are scan-converted, so the ground answer is exact
 *    to the cell; the sweeps cost the shadowed area, on top of one pass over
 *    the grid per sun position.
 *  - **On a roof**, a taller neighbour may shade it. Roof cells walk the
 *    height grid toward the sun instead, stopping once the ray climbs above
 *    the tallest building or leaves the grid. In a dense district roofs can be
 *    half the cells, so this walk is usually the larger cost.
 *
 * Shadow lengths use the sun's geometric elevation (light travels in a
 * straight line near the ground); the apparent, refracted elevation decides
 * whether the sun is up and feeds the air mass of the irradiance model.
 *
 * Sun hours and insolation repeat that for sun positions every `step` minutes
 * from midnight to midnight local time, counting only positions with the sun
 * up. Insolation integrates the clear-sky direct beam on a horizontal surface
 * (`DNI · sin(elevation)`); diffuse sky light is not modelled.
 *
 * The output grid is EPSG:4326, built from the requested metre cell size with
 * the WGS84 metres-per-degree at the footprints' centre latitude
 * ({@link metersPerDegree}). The east-west scale drifts by about
 * `tan(lat) · Δlat` away from the centre: under 0.01% within 1.5 km of it at
 * 40°, about 0.07% at the edge of a 10 km district.
 */

/**
 * Heights are clamped to this. The tallest building is about 830 m, and one
 * bad attribute (an OSM `height=99999`) would otherwise make every roof walk
 * run to the grid edge.
 */
export const MAX_BUILDING_HEIGHT_METERS = 1000;

/** NoData of the shadow outputs (none of the modes leave a cell undefined). */
export const SHADOW_NODATA = -9999;

/** Most cells one run may allocate, so a continent of footprints cannot hang the tab. */
export const MAX_SHADOW_CELLS = 4_000_000;

/**
 * Most cell-by-sun-position evaluations a day simulation may run (cells times
 * daylight samples), since it runs on the browser's main thread. A Midtown
 * Manhattan block of 400,000 cells at 15-minute steps is about 24 million.
 */
export const MAX_SHADOW_WORK = 100_000_000;

/**
 * Most cell visits one run may make, counting every cell a wall sweep paints
 * (overlaps included) and every cell a roof trace crosses. Both depend on the
 * skyline, so they cannot be bounded up front the way {@link MAX_SHADOW_WORK}
 * bounds the cell passes; they are counted as they happen instead, so even a
 * single sun position cannot run away. The Midtown Manhattan example makes
 * about 620 million over a solstice day at 15-minute steps (roughly 6 s), so
 * the cap leaves it about 3x headroom.
 */
export const MAX_ROOF_WALK_SAMPLES = 2_000_000_000;

/** Thrown when a run exceeds {@link MAX_ROOF_WALK_SAMPLES}. */
const ROOF_WALK_BUDGET_MESSAGE =
  "Tracing sunlight across the roofs is taking too long for the browser; use a longer time step, a larger cell size, or fewer buildings.";

/** Lowest sun elevation that casts a shadow; below it the sun counts as down. */
export const MIN_SUN_ELEVATION_DEGREES = 0.5;

/**
 * Metres per degree of latitude and of longitude at a latitude, from the
 * standard WGS84 series (good to about a centimetre per degree).
 *
 * @param latDeg - Latitude in degrees.
 * @returns Metres per degree along each axis.
 */
export function metersPerDegree(latDeg: number): { lat: number; lon: number } {
  const r = latDeg * (Math.PI / 180);
  return {
    lat: 111_132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r),
    lon: 111_412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r),
  };
}

export type ShadowMode = "shadow" | "sun-hours" | "insolation";

export interface BuildingShadowParams {
  mode?: ShadowMode | string;
  /** Property holding a height in metres. */
  height_field?: string;
  /** Property holding a storey count, used when the height is missing. */
  levels_field?: string;
  /** Metres per storey (default 3). */
  level_height?: number;
  /** Height used when a building has neither (default 10). */
  default_height?: number;
  /** Output cell size in metres (default 2). */
  cell_size?: number;
  /** Ground margin around the footprints, in metres (default 100). */
  margin?: number;
  /** Local date, `YYYY-MM-DD`. */
  date?: string;
  /** Local time `HH:MM` for the shadow mode. */
  time?: string;
  /** Local time minus UTC, hours. */
  utc_offset?: number;
  /** Sampling step for sun hours and insolation, minutes (default 15). */
  step_minutes?: number;
}

/** One building as burned into the grid. */
interface Building {
  /** Outer ring then holes, each in grid cell coordinates (x right, y down). */
  rings: Position[][];
  height: number;
}

/** A row-major height grid in metres on a local metric frame. */
export interface HeightGrid {
  width: number;
  height: number;
  /** Building height per cell, 0 for open ground. */
  heights: Float32Array;
  /** Cell size in metres. */
  cellSize: number;
  /** Buildings in cell coordinates, for shadow casting. */
  buildings: Building[];
  maxHeight: number;
  /** Geographic bounds `[west, south, east, north]`. */
  bbox: [number, number, number, number];
  /** Centre latitude/longitude the frame is built around. */
  lat0: number;
  lon0: number;
}

function polygonsOf(geometry: Geometry | null): Position[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(polygonsOf);
  return [];
}

/**
 * Parse a length attribute strictly: a bare number or one with a metre or
 * foot unit (`"12"`, `"12 m"`, `"40 ft"`, `"40'"`), in metres. Anything else
 * (`"1,200 m"`, `"tall"`) is null, so it falls through to the next rule
 * instead of silently reading its leading digits.
 */
export function parseLength(text: string): number | null {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(m|metres?|meters?|ft|feet|foot|')?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  return unit === "ft" || unit === "feet" || unit === "foot" || unit === "'"
    ? value * 0.3048
    : value;
}

/**
 * A building's height from its properties: the height field, else storeys
 * times the storey height, else the default. Strings like "12 m" parse.
 */
export function buildingHeight(
  properties: Record<string, unknown> | null | undefined,
  params: BuildingShadowParams,
): number {
  // External GeoJSON: only numbers and strings count. Heights accept a
  // metre or foot unit; storey counts are unitless.
  const read = (key: string | undefined, parse: (text: string) => number | null) => {
    if (!key || !properties) return null;
    const raw = properties[key];
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? parse(raw) : null;
    return n != null && Number.isFinite(n) && n > 0 ? n : null;
  };
  const h = read(params.height_field ?? "height", parseLength);
  if (h != null) return Math.min(h, MAX_BUILDING_HEIGHT_METERS);
  const levels = read(params.levels_field ?? "building:levels", (text) =>
    /^\s*[0-9]*\.?[0-9]+\s*$/.test(text) ? Number(text) : null,
  );
  if (levels != null) {
    const levelHeight = params.level_height == null ? 3 : Number(params.level_height);
    if (!(Number.isFinite(levelHeight) && levelHeight > 0)) {
      throw new Error("The storey height must be greater than zero.");
    }
    return Math.min(levels * levelHeight, MAX_BUILDING_HEIGHT_METERS);
  }
  const fallback = Number(params.default_height ?? 10);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 10;
}

/**
 * Scan-convert a polygon (outer ring and holes, cell coordinates) into a mask
 * by the cell-centre rule, applying `paint` to every covered cell index.
 */
export function fillPolygon(
  rings: Position[][],
  width: number,
  height: number,
  paint: (index: number) => void,
): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const [, y] of ring) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const row0 = Math.max(0, Math.ceil(minY - 0.5));
  const row1 = Math.min(height - 1, Math.floor(maxY - 0.5));
  const xs: number[] = [];
  for (let row = row0; row <= row1; row += 1) {
    const yc = row + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > yc !== yj > yc) xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let col = c0; col <= c1; col += 1) paint(row * width + col);
    }
  }
}

/**
 * Burn footprints (WGS84 GeoJSON features) into a local height grid.
 *
 * @param features - Polygon or MultiPolygon features in lon/lat.
 * @param params - Height fields, cell size and margin.
 * @returns The grid, or throws when there is nothing to burn or it is too big.
 */
export function buildHeightGrid(features: Feature[], params: BuildingShadowParams): HeightGrid {
  const cellSize = Number(params.cell_size ?? 2);
  if (!(Number.isFinite(cellSize) && cellSize > 0)) {
    throw new Error("The cell size must be a finite number greater than zero.");
  }
  const margin = Math.max(0, Number(params.margin ?? 100) || 0);
  const polys: { rings: Position[][]; height: number }[] = [];
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const feature of features) {
    const h = buildingHeight(feature.properties, params);
    for (const rings of polygonsOf(feature.geometry)) {
      if (!rings.length || rings[0].length < 4) continue;
      for (const [lon, lat] of rings[0]) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      polys.push({ rings, height: h });
    }
  }
  if (!polys.length) throw new Error("The buildings layer has no polygon footprints.");
  // Footprints split at the antimeridian (RFC 7946) span ~360° numerically;
  // shift the western-hemisphere parts by +360° so the extent stays local.
  let shiftLon = (lon: number) => lon;
  if (east - west > 180) {
    shiftLon = (lon: number) => (lon < 0 ? lon + 360 : lon);
    west = Infinity;
    east = -Infinity;
    for (const poly of polys) {
      for (const [lon] of poly.rings[0]) {
        const shifted = shiftLon(lon);
        if (shifted < west) west = shifted;
        if (shifted > east) east = shifted;
      }
    }
  }
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const { lat: mPerDegLat, lon: mPerDegLon } = metersPerDegree(lat0);
  const dLat = margin / mPerDegLat;
  const dLon = margin / mPerDegLon;
  const gWest = west - dLon;
  const gNorth = north + dLat;
  const width = Math.max(1, Math.ceil(((east - west) * mPerDegLon + 2 * margin) / cellSize));
  const height = Math.max(1, Math.ceil(((north - south) * mPerDegLat + 2 * margin) / cellSize));
  if (width * height > MAX_SHADOW_CELLS) {
    throw new Error(
      `The grid would be ${width} x ${height} cells (limit ${MAX_SHADOW_CELLS.toLocaleString("en-US")}); use a larger cell size, a smaller margin, or fewer buildings.`,
    );
  }
  const toCell = ([lon, lat]: Position): Position => [
    ((shiftLon(lon) - gWest) * mPerDegLon) / cellSize,
    ((gNorth - lat) * mPerDegLat) / cellSize,
  ];
  const heights = new Float32Array(width * height);
  const buildings: Building[] = [];
  let maxHeight = 0;
  for (const poly of polys) {
    const rings = poly.rings.map((ring) => ring.map(toCell));
    buildings.push({ rings, height: poly.height });
    if (poly.height > maxHeight) maxHeight = poly.height;
    fillPolygon(rings, width, height, (i) => {
      if (poly.height > heights[i]) heights[i] = poly.height;
    });
  }
  const resLon = cellSize / mPerDegLon;
  const resLat = cellSize / mPerDegLat;
  return {
    width,
    height,
    heights,
    cellSize,
    buildings,
    maxHeight,
    bbox: [gWest, gNorth - height * resLat, gWest + width * resLon, gNorth],
    lat0,
    lon0,
  };
}

/**
 * Mark the cells in shadow for one sun position.
 *
 * @param grid - The height grid.
 * @param azimuth - Sun azimuth, degrees clockwise from north.
 * @param elevation - Sun elevation, degrees (must be above the horizon).
 * @param out - Reused mask: 1 shadowed, 0 lit; cleared first.
 * @param sampleBudget - Most cell visits (wall sweeps plus roof traces)
 *   this call may make.
 * @returns The number of cell visits made, for work accounting.
 * @throws When the visits exceed `sampleBudget`.
 */
export function castShadows(
  grid: HeightGrid,
  azimuth: number,
  elevation: number,
  out: Uint8Array,
  sampleBudget = MAX_ROOF_WALK_SAMPLES,
): number {
  out.fill(0);
  const { width, height, heights, cellSize } = grid;
  const tanEl = Math.tan(elevation * (Math.PI / 180));
  const az = azimuth * (Math.PI / 180);
  // Unit vector toward the sun in cell space: x east, y south (rows grow down).
  const sunX = Math.sin(az);
  const sunY = -Math.cos(az);
  // Ground: footprint plus the edge sweeps, offset away from the sun. Every
  // cell a sweep visits counts against the budget, overlaps included.
  let work = 0;
  for (const building of grid.buildings) {
    const length = building.height / tanEl / cellSize;
    const ox = -sunX * length;
    const oy = -sunY * length;
    const markGround = (i: number) => {
      work += 1;
      if (heights[i] === 0) out[i] = 1;
    };
    // Every wall casts, courtyard (hole) walls included.
    for (const ring of building.rings) {
      for (let k = 0; k + 1 < ring.length; k += 1) {
        const [ax, ay] = ring[k];
        const [bx, by] = ring[k + 1];
        fillPolygon(
          [
            [
              [ax, ay],
              [bx, by],
              [bx + ox, by + oy],
              [ax + ox, ay + oy],
              [ax, ay],
            ],
          ],
          width,
          height,
          markGround,
        );
        if (work > sampleBudget) throw new Error(ROOF_WALK_BUDGET_MESSAGE);
      }
    }
  }
  // Roofs: trace the ray toward the sun cell by cell (Amanatides-Woo), so no
  // crossed cell is skipped, until it clears the tallest building or leaves
  // the grid. A crossed cell shades the roof when it rises above the ray at
  // the point the ray enters it.
  const stepX = sunX > 0 ? 1 : -1;
  const stepY = sunY > 0 ? 1 : -1;
  const tDeltaX = sunX !== 0 ? Math.abs(1 / sunX) : Infinity;
  const tDeltaY = sunY !== 0 ? Math.abs(1 / sunY) : Infinity;
  const rise = cellSize * tanEl;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const h0 = heights[i];
      if (h0 === 0) continue;
      const maxDistance = (grid.maxHeight - h0) / rise;
      let c = col;
      let r = row;
      // From the cell centre, the first boundary is half a cell away.
      let tMaxX = sunX !== 0 ? 0.5 * tDeltaX : Infinity;
      let tMaxY = sunY !== 0 ? 0.5 * tDeltaY : Infinity;
      for (;;) {
        let tEntry: number;
        if (tMaxX < tMaxY) {
          tEntry = tMaxX;
          tMaxX += tDeltaX;
          c += stepX;
        } else {
          tEntry = tMaxY;
          tMaxY += tDeltaY;
          r += stepY;
        }
        if (tEntry > maxDistance) break;
        if (c < 0 || r < 0 || c >= width || r >= height) break;
        work += 1;
        if (work > sampleBudget) throw new Error(ROOF_WALK_BUDGET_MESSAGE);
        if (heights[r * width + c] > h0 + tEntry * rise) {
          out[i] = 1;
          break;
        }
      }
    }
  }
  return work;
}

/**
 * The elevation shadows are cast at: the geometric elevation, floored just
 * above the horizon, since refraction can lift the apparent sun into view
 * while the geometric one is still at or below it.
 */
function shadowElevation(geometric: number): number {
  return Math.max(geometric, 0.1);
}

/** The outcome of {@link buildingShadows}. */
export interface BuildingShadowResult {
  raster: RasterData;
  messages: string[];
}

/**
 * Run the building shadow tool on WGS84 footprints.
 *
 * Output values: `shadow` 0 lit ground, 1 shaded ground, 2 lit roof, 3 shaded
 * roof; `sun-hours` hours of direct sun; `insolation` clear-sky direct beam
 * on a horizontal surface in kWh/m².
 *
 * @param features - Footprints in lon/lat.
 * @param params - Mode, heights, grid and time settings.
 * @returns A single-band EPSG:4326 raster and log lines.
 */
export function buildingShadows(
  features: Feature[],
  params: BuildingShadowParams,
): BuildingShadowResult {
  const mode = String(params.mode ?? "shadow") as ShadowMode;
  if (!["shadow", "sun-hours", "insolation"].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  const date = String(params.date ?? "");
  const offset = Number(params.utc_offset ?? 0);
  const grid = buildHeightGrid(features, params);
  const { width, height, heights, lat0, lon0 } = grid;
  const cells = width * height;
  const mask = new Uint8Array(cells);
  const band = new Float32Array(cells);
  const messages = [
    `Burned ${grid.buildings.length} footprint(s) into a ${width} x ${height} grid of ${grid.cellSize} m cells (tallest ${grid.maxHeight.toFixed(1)} m).`,
  ];
  let groundCells = 0;
  for (let i = 0; i < cells; i += 1) if (heights[i] === 0) groundCells += 1;

  if (mode === "shadow") {
    const instant = localTimeToUtc(date, String(params.time ?? "12:00"), offset);
    const sun = sunPosition(instant, lat0, lon0);
    messages.push(
      `Sun at ${new Date(instant).toISOString().replace(".000Z", "Z")}: azimuth ${sun.azimuth.toFixed(2)}°, elevation ${sun.elevation.toFixed(2)}°.`,
    );
    const up = sun.elevation >= MIN_SUN_ELEVATION_DEGREES;
    if (up) castShadows(grid, sun.azimuth, shadowElevation(sun.geometricElevation), mask);
    else mask.fill(1);
    let shadedGround = 0;
    for (let i = 0; i < cells; i += 1) {
      const roof = heights[i] > 0;
      band[i] = (roof ? 2 : 0) + mask[i];
      if (!roof && mask[i]) shadedGround += 1;
    }
    messages.push(
      up
        ? `Shaded ground: ${((100 * shadedGround) / Math.max(groundCells, 1)).toFixed(1)}% of ${groundCells} ground cells.`
        : "The sun is below the horizon: everything is in shade.",
      "Values: 0 lit ground, 1 shaded ground, 2 lit roof, 3 shaded roof.",
    );
  } else {
    const step = Number(params.step_minutes ?? 15);
    if (!(step >= 1 && step <= 120)) throw new Error("The time step must be 1 to 120 minutes.");
    const midnight = localTimeToUtc(date, "00:00", offset);
    // Count the daylight samples first, so an oversized run fails up front
    // instead of freezing the tab.
    // Intervals of `step` minutes tiling the day, the last one clipped at
    // midnight; each is sampled at its midpoint and weighted by its length.
    const intervals: { mid: number; minutes: number }[] = [];
    for (let start = 0; start < 1440; start += step) {
      const end = Math.min(start + step, 1440);
      intervals.push({ mid: (start + end) / 2, minutes: end - start });
    }
    let daylight = 0;
    for (const { mid } of intervals) {
      if (sunPosition(midnight + mid * 60_000, lat0, lon0).elevation >= MIN_SUN_ELEVATION_DEGREES)
        daylight += 1;
    }
    if (daylight * cells > MAX_SHADOW_WORK) {
      throw new Error(
        `This run would evaluate ${daylight} sun positions over ${cells.toLocaleString("en-US")} cells, more than the browser budget of ${MAX_SHADOW_WORK.toLocaleString("en-US")}; use a longer time step or a larger cell size.`,
      );
    }
    let walked = 0;
    let firstUp: number | null = null;
    let lastUp: number | null = null;
    let positions = 0;
    let maxElevation = -90;
    for (const { mid: minute, minutes } of intervals) {
      const instant = midnight + minute * 60_000;
      const sun = sunPosition(instant, lat0, lon0);
      if (sun.elevation > maxElevation) maxElevation = sun.elevation;
      if (sun.elevation < MIN_SUN_ELEVATION_DEGREES) continue;
      positions += 1;
      firstUp ??= minute;
      lastUp = minute;
      walked += castShadows(
        grid,
        sun.azimuth,
        shadowElevation(sun.geometricElevation),
        mask,
        MAX_ROOF_WALK_SAMPLES - walked,
      );
      const weight =
        mode === "sun-hours"
          ? minutes / 60
          : (clearSkyDni(sun.elevation) * Math.sin(sun.elevation * (Math.PI / 180)) * minutes) /
            60 /
            1000;
      for (let i = 0; i < cells; i += 1) if (!mask[i]) band[i] += weight;
    }
    const hhmm = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
    messages.push(
      positions
        ? `Sampled ${positions} sun position(s) every ${step} min, about ${hhmm(firstUp! - step / 2)} to ${hhmm(lastUp! + step / 2)} local time (peak elevation ${maxElevation.toFixed(1)}°).`
        : "The sun stays below the horizon all day.",
    );
    let groundSum = 0;
    let roofSum = 0;
    let groundMax = 0;
    for (let i = 0; i < cells; i += 1) {
      if (heights[i] > 0) roofSum += band[i];
      else {
        groundSum += band[i];
        if (band[i] > groundMax) groundMax = band[i];
      }
    }
    const roofCells = cells - groundCells;
    const unit = mode === "sun-hours" ? "h" : "kWh/m²";
    messages.push(
      `Mean on ground (shaded cells included): ${(groundSum / Math.max(groundCells, 1)).toFixed(2)} ${unit}; best-lit ground: ${groundMax.toFixed(2)} ${unit}; mean on roofs: ${(roofSum / Math.max(roofCells, 1)).toFixed(2)} ${unit}.`,
      mode === "sun-hours"
        ? "Values: hours of direct sun."
        : "Values: clear-sky direct beam on a horizontal surface, kWh/m² (diffuse sky light not included).",
    );
  }

  const [west, , , north] = grid.bbox;
  const raster: RasterData = {
    bands: [band],
    width,
    height,
    originX: west,
    originY: north,
    resX: (grid.bbox[2] - west) / width,
    resY: (north - grid.bbox[1]) / height,
    nodata: SHADOW_NODATA,
    geoKeys: geoKeysForEpsg(4326, true),
  };
  return { raster, messages };
}
