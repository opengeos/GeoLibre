/// <reference path="../mgrs.d.ts" />
/**
 * Tile grids the satellite embedding datasets are published on, and the UTM
 * helpers they share. Pure functions (no DOM, no map) so they are unit tested.
 *
 * - Tessera: a 0.1° lon/lat grid; a tile is named by its centre, e.g.
 *   `grid_-83.95_35.95`.
 * - Earth Index: Sentinel-2 tiles, named by their MGRS 100 km square, e.g.
 *   `17SKV`. A Sentinel-2 tile is 109.8 km on a side: it starts at the square's
 *   north-west corner and runs 9.8 km past the square to the east and south.
 */

import type { Feature, Polygon } from "geojson";
import { forward as mgrsForward, inverse as mgrsInverse } from "mgrs";
import proj4 from "proj4";

/** A `[west, south, east, north]` box in degrees. */
export type LonLatBbox = [number, number, number, number];

/** Most tiles one search may enumerate before asking the user to zoom in. */
export const MAX_GRID_TILES = 64;

// ---------------------------------------------------------------------------
// UTM
// ---------------------------------------------------------------------------

/** The proj4 definition of a WGS 84 UTM zone. */
export function utmProjection(zone: number, south: boolean): string {
  return `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

/**
 * Parses an EPSG code for a WGS 84 UTM zone (`EPSG:32617`, `32733`) into its
 * zone and hemisphere, or null for any other CRS.
 */
export function parseUtmEpsg(code: string | number): { zone: number; south: boolean } | null {
  const match = /(?:EPSG:)?(32[67])(\d{2})$/i.exec(String(code).trim());
  if (!match) return null;
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return null;
  return { zone, south: match[1] === "327" };
}

/**
 * Projects a UTM rectangle to a lon/lat polygon, sampling each edge so the ring
 * follows the curve a straight UTM line makes in lon/lat.
 */
export function utmRectToLonLatRing(
  projection: string,
  [minX, minY, maxX, maxY]: [number, number, number, number],
  samplesPerEdge = 8,
): [number, number][] {
  const toLonLat = proj4(projection, "EPSG:4326");
  const ring: [number, number][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let step = 0; step < samplesPerEdge; step += 1) {
      const t = step / samplesPerEdge;
      const [lon, lat] = toLonLat.forward([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      ring.push([lon, lat]);
    }
  };
  edge(minX, maxY, maxX, maxY);
  edge(maxX, maxY, maxX, minY);
  edge(maxX, minY, minX, minY);
  edge(minX, minY, minX, maxY);
  ring.push(ring[0]);
  return ring;
}

/** The lon/lat bounding box of a ring. */
export function ringBbox(ring: [number, number][]): LonLatBbox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    south = Math.min(south, lat);
    east = Math.max(east, lon);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/** Whether two lon/lat boxes overlap (touching edges do not count). */
export function bboxesIntersect(a: LonLatBbox, b: LonLatBbox): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/** The overlap of two lon/lat boxes, or null when they do not overlap. */
export function intersectBboxes(a: LonLatBbox, b: LonLatBbox): LonLatBbox | null {
  if (!bboxesIntersect(a, b)) return null;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

/** A closed rectangle ring for a lon/lat box. */
export function bboxRing([west, south, east, north]: LonLatBbox): [number, number][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Wraps a ring and properties as a polygon feature. */
export function polygonFeature<P extends Record<string, unknown>>(
  ring: [number, number][],
  properties: P,
): Feature<Polygon, P> {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [ring] } };
}

// ---------------------------------------------------------------------------
// Tessera 0.1° grid
// ---------------------------------------------------------------------------

/** Public bucket holding the Tessera embeddings. */
export const TESSERA_BASE_URL = "https://s3.us-west-2.amazonaws.com/tessera-embeddings";
const TESSERA_EMBEDDINGS_DIR = "v1/global_0.1_degree_representation";

/** One 0.1° Tessera tile. */
export interface TesseraTile {
  /** Tile name, e.g. `grid_-83.95_35.95`. */
  name: string;
  /** Longitude and latitude of the tile centre. */
  lon: number;
  lat: number;
  bbox: LonLatBbox;
}

/**
 * Lists the Tessera tiles whose 0.1° cells overlap a box, west to east and
 * south to north. Returns null when more than `limit` tiles would be needed.
 */
export function tesseraTilesForBbox(
  [west, south, east, north]: LonLatBbox,
  limit = MAX_GRID_TILES,
): TesseraTile[] | null {
  // Work in integer tenths so a 0.1 step never drifts (0.1 is not exact in
  // binary floating point). A box edge on a cell edge does not pull in the
  // neighbouring cell.
  const i0 = Math.floor(west * 10 + 1e-9);
  const i1 = Math.ceil(east * 10 - 1e-9) - 1;
  const j0 = Math.floor(Math.max(south, -90) * 10 + 1e-9);
  const j1 = Math.ceil(Math.min(north, 90) * 10 - 1e-9) - 1;
  const count = Math.max(0, i1 - i0 + 1) * Math.max(0, j1 - j0 + 1);
  if (count > limit) return null;
  const tiles: TesseraTile[] = [];
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const lon = (i + 0.5) / 10;
      const lat = (j + 0.5) / 10;
      tiles.push({
        name: `grid_${lon.toFixed(2)}_${lat.toFixed(2)}`,
        lon,
        lat,
        bbox: [i / 10, j / 10, (i + 1) / 10, (j + 1) / 10],
      });
    }
  }
  return tiles;
}

/** URLs of a Tessera tile's quantized embeddings and per-pixel scales. */
export function tesseraTileUrls(
  tileName: string,
  year: number,
): { embeddings: string; scales: string } {
  const base = `${TESSERA_BASE_URL}/${TESSERA_EMBEDDINGS_DIR}/${year}/${tileName}/${tileName}`;
  return { embeddings: `${base}.npy`, scales: `${base}_scales.npy` };
}

// ---------------------------------------------------------------------------
// MGRS / Sentinel-2 tiles (Earth Index)
// ---------------------------------------------------------------------------

/** Sentinel-2 tile edge length, in metres. */
const S2_TILE_SIZE = 109_800;
const MGRS_SQUARE_SIZE = 100_000;
const MGRS_TILE_RE = /^(\d{1,2})([C-X])([A-Z]{2})/;

/**
 * The Sentinel-2 / MGRS 100 km tile id (zero-padded zone, e.g. `01GDM`) that
 * contains a point, or null outside MGRS's UTM latitudes (80°S–84°N).
 */
export function mgrsTileId(lon: number, lat: number): string | null {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -80 || lat >= 84) return null;
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  let reference: string;
  try {
    reference = mgrsForward([wrappedLon, lat], 1);
  } catch {
    return null;
  }
  const match = MGRS_TILE_RE.exec(reference);
  if (!match) return null;
  return `${match[1].padStart(2, "0")}${match[2]}${match[3]}`;
}

/**
 * Lists the MGRS tiles that cover a box by sampling it on a grid finer than one
 * 100 km square. Returns null when more than `limit` tiles would be needed.
 */
export function mgrsTilesForBbox(
  [west, south, east, north]: LonLatBbox,
  limit = MAX_GRID_TILES,
): string[] | null {
  const clampedSouth = Math.max(south, -80);
  const clampedNorth = Math.min(north, 83.999);
  if (clampedSouth >= clampedNorth || west >= east) return [];
  // 0.2° is well under the ~0.9° a square spans in latitude, and under the
  // longitude span of a square up to ~75° latitude.
  const step = 0.2;
  const columns = Math.ceil((east - west) / step);
  const rows = Math.ceil((clampedNorth - clampedSouth) / step);
  if (columns * rows > limit * 50) return null;
  const ids = new Set<string>();
  for (let row = 0; row <= rows; row += 1) {
    const lat = Math.min(clampedSouth + row * step, clampedNorth);
    for (let column = 0; column <= columns; column += 1) {
      const lon = Math.min(west + column * step, east);
      const id = mgrsTileId(lon, lat);
      if (id) ids.add(id);
      if (ids.size > limit) return null;
    }
  }
  return [...ids].sort();
}

/**
 * The footprint of a Sentinel-2 tile as a lon/lat ring, or null for a
 * malformed id.
 */
export function sentinel2TileRing(tileId: string): [number, number][] | null {
  const match = MGRS_TILE_RE.exec(tileId);
  if (!match) return null;
  const zone = Number(match[1]);
  const south = match[2] < "N";
  let corner: number[];
  try {
    // `inverse` of a bare square reference is the square's south-west corner.
    corner = mgrsInverse(`${zone}${match[2]}${match[3]}`);
  } catch {
    return null;
  }
  const projection = utmProjection(zone, south);
  const [x, y] = proj4("EPSG:4326", projection).forward([corner[0], corner[1]]);
  const minX = Math.round(x / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE;
  const maxY = Math.round(y / MGRS_SQUARE_SIZE) * MGRS_SQUARE_SIZE + MGRS_SQUARE_SIZE;
  return utmRectToLonLatRing(projection, [minX, maxY - S2_TILE_SIZE, minX + S2_TILE_SIZE, maxY]);
}
