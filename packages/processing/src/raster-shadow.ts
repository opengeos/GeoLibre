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
 *    to the cell and costs only the shadowed area.
 *  - **On a roof**, a taller neighbour may shade it. Roof cells (a small share
 *    of the grid) walk the height grid toward the sun instead, stopping once
 *    the ray climbs above the tallest building.
 *
 * Sun hours and insolation repeat that for sun positions every `step` minutes
 * from midnight to midnight local time, counting only positions with the sun
 * up. Insolation integrates the clear-sky direct beam on a horizontal surface
 * (`DNI · sin(elevation)`); diffuse sky light is not modelled.
 *
 * The output grid is EPSG:4326, built from the requested metre cell size at
 * the footprints' centre latitude, which keeps it a few centimetres true over
 * a city district.
 */

/** NoData of the shadow outputs (none of the modes leave a cell undefined). */
export const SHADOW_NODATA = -9999;

/** Most cells one run may allocate, so a continent of footprints cannot hang the tab. */
export const MAX_SHADOW_CELLS = 4_000_000;

/** Lowest sun elevation that casts a shadow; below it the sun counts as down. */
export const MIN_SUN_ELEVATION_DEGREES = 0.5;

const METERS_PER_DEGREE_LAT = 111_320;

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
 * A building's height from its properties: the height field, else storeys
 * times the storey height, else the default. Strings like "12 m" parse.
 */
export function buildingHeight(
  properties: Record<string, unknown> | null | undefined,
  params: BuildingShadowParams,
): number {
  const read = (key: string | undefined): number | null => {
    if (!key || !properties) return null;
    const raw = properties[key];
    const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const h = read(params.height_field ?? "height");
  if (h != null) return h;
  const levels = read(params.levels_field ?? "building:levels");
  if (levels != null) return levels * (Number(params.level_height) || 3);
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
  if (!(cellSize > 0)) throw new Error("The cell size must be greater than zero.");
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
  const lat0 = (south + north) / 2;
  const lon0 = (west + east) / 2;
  const mPerDegLon = METERS_PER_DEGREE_LAT * Math.cos(lat0 * (Math.PI / 180));
  const dLat = margin / METERS_PER_DEGREE_LAT;
  const dLon = margin / mPerDegLon;
  const gWest = west - dLon;
  const gNorth = north + dLat;
  const width = Math.max(1, Math.ceil(((east - west) * mPerDegLon + 2 * margin) / cellSize));
  const height = Math.max(
    1,
    Math.ceil(((north - south) * METERS_PER_DEGREE_LAT + 2 * margin) / cellSize),
  );
  if (width * height > MAX_SHADOW_CELLS) {
    throw new Error(
      `The grid would be ${width} x ${height} cells (limit ${MAX_SHADOW_CELLS.toLocaleString("en-US")}); use a larger cell size, a smaller margin, or fewer buildings.`,
    );
  }
  const toCell = ([lon, lat]: Position): Position => [
    ((lon - gWest) * mPerDegLon) / cellSize,
    ((gNorth - lat) * METERS_PER_DEGREE_LAT) / cellSize,
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
  const resLat = cellSize / METERS_PER_DEGREE_LAT;
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
 */
export function castShadows(
  grid: HeightGrid,
  azimuth: number,
  elevation: number,
  out: Uint8Array,
): void {
  out.fill(0);
  const { width, height, heights, cellSize } = grid;
  const tanEl = Math.tan(elevation * (Math.PI / 180));
  const az = azimuth * (Math.PI / 180);
  // Unit vector toward the sun in cell space: x east, y south (rows grow down).
  const sunX = Math.sin(az);
  const sunY = -Math.cos(az);
  // Ground: footprint plus the edge sweeps, offset away from the sun.
  for (const building of grid.buildings) {
    const length = building.height / tanEl / cellSize;
    const ox = -sunX * length;
    const oy = -sunY * length;
    const markGround = (i: number) => {
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
      }
    }
  }
  // Roofs: walk toward the sun until the ray clears the tallest building.
  const step = 0.5;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const h0 = heights[i];
      if (h0 === 0) continue;
      const maxDistance = (grid.maxHeight - h0) / tanEl / cellSize;
      const x0 = col + 0.5;
      const y0 = row + 0.5;
      for (let d = step; d <= maxDistance; d += step) {
        const c = Math.floor(x0 + sunX * d);
        const r = Math.floor(y0 + sunY * d);
        if (c < 0 || r < 0 || c >= width || r >= height) break;
        if (heights[r * width + c] > h0 + d * cellSize * tanEl) {
          out[i] = 1;
          break;
        }
      }
    }
  }
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
    if (up) castShadows(grid, sun.azimuth, sun.elevation, mask);
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
    let firstUp: number | null = null;
    let lastUp: number | null = null;
    let positions = 0;
    let maxElevation = -90;
    // Midpoint sampling: each sample stands for the `step` minutes around it.
    for (let minute = step / 2; minute < 1440; minute += step) {
      const instant = midnight + minute * 60_000;
      const sun = sunPosition(instant, lat0, lon0);
      if (sun.elevation > maxElevation) maxElevation = sun.elevation;
      if (sun.elevation < MIN_SUN_ELEVATION_DEGREES) continue;
      positions += 1;
      firstUp ??= minute;
      lastUp = minute;
      castShadows(grid, sun.azimuth, sun.elevation, mask);
      const weight =
        mode === "sun-hours"
          ? step / 60
          : (clearSkyDni(sun.elevation) * Math.sin(sun.elevation * (Math.PI / 180)) * step) /
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
      `Mean on open ground: ${(groundSum / Math.max(groundCells, 1)).toFixed(2)} ${unit} (unobstructed: ${groundMax.toFixed(2)} ${unit}); mean on roofs: ${(roofSum / Math.max(roofCells, 1)).toFixed(2)} ${unit}.`,
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
