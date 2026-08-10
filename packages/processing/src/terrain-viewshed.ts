/**
 * Interactive viewshed from a clicked map point (issue #1815).
 *
 * GeoLibre already ships a Whitebox `viewshed`, but it consumes a DEM raster
 * file *and* a station-point vector file and emits a raster file. From a point
 * the user just clicked, that is three format round-trips before any analysis
 * happens, and it requires the user to have found and loaded a DEM first —
 * which is the data-prep step the issue is about removing.
 *
 * So this module answers the same question directly against the terrain the map
 * is already rendering:
 *
 *  1. {@link assembleTerrainDem} fetches the Terrarium RGB tiles the terrain
 *     control uses and decodes them into one elevation grid over a radius.
 *  2. {@link computeViewshed} walks a line of sight from the observer to every
 *     cell and marks it visible or hidden.
 *
 * The Whitebox tool stays untouched and remains the right choice for rigorous
 * work against a DEM the user has in hand; this is the exploratory path.
 *
 * The computation is deliberately separated from the tile fetching so the
 * geometry can be tested without a network.
 */

import type { ViewshedWorkerRequest, ViewshedWorkerResponse } from "./terrain-viewshed.worker";

/** The Terrarium terrain tiles the map's terrain control already uses. */
export const TERRARIUM_TILE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** Terrarium tiles are 256px and published up to zoom 15. */
export const TERRARIUM_TILE_SIZE = 256;
export const TERRARIUM_MAX_ZOOM = 15;

/**
 * Decode a Terrarium RGB triple to elevation in metres.
 *
 * Terrarium packs elevation as `(R * 256 + G + B / 256) - 32768`, which covers
 * -32768 to +32768 m at 1/256 m precision.
 */
export function decodeTerrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Decode a tile's RGBA bytes into elevations.
 *
 * Takes the dimensions as arguments rather than reading them from the source
 * image, so a caller cannot accidentally size the output from an ImageBitmap it
 * has already closed.
 */
export function decodeTerrariumRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const elevations = new Float32Array(width * height);
  for (let i = 0; i < elevations.length; i += 1) {
    const offset = i * 4;
    elevations[i] = decodeTerrariumElevation(data[offset], data[offset + 1], data[offset + 2]);
  }
  return elevations;
}

/** An elevation grid in EPSG:4326, row 0 at the north edge. */
export interface TerrainDem {
  width: number;
  height: number;
  /** Row-major elevations in metres, `width * height` long. */
  values: Float32Array;
  /** Geographic bounds as [west, south, east, north]. */
  bbox: [number, number, number, number];
}

/** Metres per degree of latitude, near enough for a local viewshed. */
const METERS_PER_DEGREE_LAT = 111320;

/** Longitude degrees spanning `meters` at a latitude. */
export function metersToLonDegrees(meters: number, lat: number): number {
  const scale = Math.cos((lat * Math.PI) / 180);
  return meters / (METERS_PER_DEGREE_LAT * Math.max(scale, 1e-6));
}

/** Latitude degrees spanning `meters`. */
export function metersToLatDegrees(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT;
}

/**
 * The tile zoom whose ground resolution best fits a radius, capped so a large
 * radius cannot ask for thousands of tiles.
 *
 * Aims for roughly {@link TARGET_GRID_SPAN} pixels across the analysed square:
 * enough detail for a ridge to block a line of sight, small enough that both
 * the tile fetch and the line walk stay interactive. The walk is O(n³) in the
 * grid's side length -- a ray of up to n steps for each of n² cells -- so the
 * span, not the requested radius, is what bounds the cost.
 */
export const TARGET_GRID_SPAN = 512;

export function zoomForRadius(radiusMeters: number, lat: number): number {
  // Ground resolution of a Terrarium pixel at zoom z and latitude lat.
  const resolutionAtZoom = (z: number) =>
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
  const wanted = (radiusMeters * 2) / TARGET_GRID_SPAN;
  for (let z = TERRARIUM_MAX_ZOOM; z >= 0; z -= 1) {
    if (resolutionAtZoom(z) >= wanted) return z;
  }
  return 0;
}

/** Slippy-map tile x/y for a coordinate at a zoom. */
export function tileForLngLat(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Abort a terrain tile request that has not responded within this window. */
export const TILE_FETCH_TIMEOUT_MS = 15000;

/** Bounds a viewshed request is clamped to, so one click cannot fetch a continent. */
export const MAX_VIEWSHED_RADIUS_METERS = 50_000;
export const MIN_VIEWSHED_RADIUS_METERS = 100;

export interface ViewshedObserver {
  lng: number;
  lat: number;
  /** Height of the observer above the ground, in metres. */
  heightMeters: number;
}

export interface ViewshedResult {
  width: number;
  height: number;
  /** 1 where visible, 0 where hidden, row-major. */
  visible: Uint8Array;
  bbox: [number, number, number, number];
  /** Ground elevation under the observer, in metres. */
  observerGroundMeters: number;
  /** Count of visible cells, for reporting coverage. */
  visibleCells: number;
}

/**
 * Compute which cells of a DEM are visible from an observer.
 *
 * Walks a straight line from the observer to each cell, tracking the greatest
 * slope seen so far; a cell is visible when its own slope from the observer
 * exceeds every slope along the way. This is the standard R3-style line-of-sight
 * — exact per ray, and simple enough to reason about, at the cost of resampling
 * the same near-observer cells for many rays.
 *
 * The grid is treated as uniform in latitude, while its rows come from tiles
 * uniform in Web Mercator Y. The crop compensates when locating the window
 * (see `rowOf`), but the cell height used here is still a single constant for
 * the whole grid, so a tall square at high latitude carries a small north-south
 * stretch. At the radii this is capped to it stays well under a cell.
 *
 * Earth curvature and refraction are **not** modelled. Over the radii this is
 * capped to (50 km) curvature drop reaches ~180 m, which matters for a
 * long-range radio study but not for the "what can I see from this overlook"
 * question this answers. The Whitebox tool remains the rigorous option.
 *
 * @param dem - The elevation grid to analyse.
 * @param observer - Position and height above ground.
 * @param radiusMeters - Ignore cells beyond this distance, or 0 for no limit.
 */
export function computeViewshed(
  dem: TerrainDem,
  observer: ViewshedObserver,
  radiusMeters = 0,
): ViewshedResult {
  const { width, height, values, bbox } = dem;
  const [west, south, east, north] = bbox;
  const visible = new Uint8Array(width * height);

  // Observer position in grid space.
  const col = Math.round(((observer.lng - west) / (east - west)) * (width - 1));
  const row = Math.round(((north - observer.lat) / (north - south)) * (height - 1));
  const clampedCol = Math.min(width - 1, Math.max(0, col));
  const clampedRow = Math.min(height - 1, Math.max(0, row));
  const groundMeters = values[clampedRow * width + clampedCol] ?? 0;
  const eyeMeters = groundMeters + observer.heightMeters;

  // Cell size in metres, so slopes compare like with like on both axes.
  const cellLatMeters = ((north - south) / Math.max(height - 1, 1)) * METERS_PER_DEGREE_LAT;
  const midLat = (north + south) / 2;
  const cellLonMeters =
    ((east - west) / Math.max(width - 1, 1)) *
    METERS_PER_DEGREE_LAT *
    Math.cos((midLat * Math.PI) / 180);

  let visibleCells = 0;
  const markVisible = (index: number): void => {
    if (visible[index] === 0) {
      visible[index] = 1;
      visibleCells += 1;
    }
  };
  markVisible(clampedRow * width + clampedCol);

  for (let targetRow = 0; targetRow < height; targetRow += 1) {
    for (let targetCol = 0; targetCol < width; targetCol += 1) {
      if (targetRow === clampedRow && targetCol === clampedCol) continue;

      const dCol = targetCol - clampedCol;
      const dRow = targetRow - clampedRow;
      const groundDistance = Math.hypot(dCol * cellLonMeters, dRow * cellLatMeters);
      if (radiusMeters > 0 && groundDistance > radiusMeters) continue;

      // Step along the ray one cell at a time on its dominant axis.
      const steps = Math.max(Math.abs(dCol), Math.abs(dRow));
      let maxSlope = -Infinity;
      let blocked = false;
      for (let step = 1; step < steps; step += 1) {
        const t = step / steps;
        const sampleCol = Math.round(clampedCol + dCol * t);
        const sampleRow = Math.round(clampedRow + dRow * t);
        const elevation = values[sampleRow * width + sampleCol];
        if (elevation === undefined) continue;
        const distance = Math.hypot(
          (sampleCol - clampedCol) * cellLonMeters,
          (sampleRow - clampedRow) * cellLatMeters,
        );
        if (distance <= 0) continue;
        const slope = (elevation - eyeMeters) / distance;
        if (slope > maxSlope) maxSlope = slope;
      }

      const targetElevation = values[targetRow * width + targetCol];
      if (targetElevation === undefined || groundDistance <= 0) continue;
      const targetSlope = (targetElevation - eyeMeters) / groundDistance;
      // Strictly greater: a cell exactly on the horizon line is grazed, not seen.
      blocked = targetSlope <= maxSlope;
      if (!blocked) markVisible(targetRow * width + targetCol);
    }
  }

  return {
    width,
    height,
    visible,
    bbox,
    observerGroundMeters: groundMeters,
    visibleCells,
  };
}

/**
 * Render a viewshed to RGBA bytes: a translucent wash over visible ground,
 * fully transparent elsewhere, so the imagery underneath stays readable.
 */
export function viewshedToRgba(
  result: ViewshedResult,
  color: [number, number, number] = [56, 189, 108],
  alpha = 110,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(result.width * result.height * 4);
  for (let i = 0; i < result.visible.length; i += 1) {
    if (result.visible[i] !== 1) continue;
    const offset = i * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

// --- Tile assembly (browser) -----------------------------------------------

/** Decode one Terrarium PNG tile to elevations via an offscreen canvas. */
interface DecodedTile {
  width: number;
  height: number;
  values: Float32Array;
}

async function decodeTile(
  url: string,
  signal?: AbortSignal,
  timeoutMs = TILE_FETCH_TIMEOUT_MS,
): Promise<DecodedTile | null> {
  // A hung tile request would otherwise stall the whole assembly behind
  // Promise.all with no recovery, since fetch has no default timeout.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const composed =
    signal && typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout.signal])
      : (signal ?? timeout.signal);
  try {
    const response = await fetch(url, { signal: composed });
    if (!response.ok) return null;
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    // Dimensions are read before close(), which zeroes them. Passing them into
    // decodeTerrariumRgba rather than reading bitmap.width again afterwards is
    // what keeps that ordering hazard from returning -- a 0x0 tile decodes
    // without error and is then silently discarded by the assembly loop as the
    // wrong size, which is how it broke the first time.
    const width = bitmap.width;
    const height = bitmap.height;
    const { data } = context.getImageData(0, 0, width, height);
    bitmap.close();
    return { width, height, values: decodeTerrariumRgba(data, width, height) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Web Mercator Y for a latitude, normalised so 0 is the north edge of the world
 * and 1 the south — the space tile rows are uniformly spaced in.
 */
function mercatorY(lat: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/** Longitude/latitude of a tile's north-west corner. */
function tileNorthWest(x: number, y: number, zoom: number): [number, number] {
  const n = Math.pow(2, zoom);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return [lng, (latRad * 180) / Math.PI];
}

export interface AssembleTerrainDemOptions {
  lng: number;
  lat: number;
  radiusMeters: number;
  signal?: AbortSignal;
  /** Override the tile template (tests, or a self-hosted terrain source). */
  tileUrl?: string;
}

/**
 * Fetch and stitch Terrarium tiles into one elevation grid covering a radius
 * around a point.
 *
 * Tiles that fail to load leave their cells at 0 rather than aborting the whole
 * assembly: a viewshed with one missing tile is degraded but still useful,
 * while a hard failure would make a transient network error look like the
 * feature is broken. The returned grid is cropped to the requested square, so
 * the result is not padded out to tile boundaries.
 *
 * @returns The DEM, or null when no tile could be loaded at all.
 */
export async function assembleTerrainDem(
  options: AssembleTerrainDemOptions,
): Promise<TerrainDem | null> {
  const { lng, lat, signal, tileUrl = TERRARIUM_TILE_URL } = options;
  const radiusMeters = Math.min(
    MAX_VIEWSHED_RADIUS_METERS,
    Math.max(MIN_VIEWSHED_RADIUS_METERS, options.radiusMeters),
  );
  const zoom = zoomForRadius(radiusMeters, lat);

  const dLat = metersToLatDegrees(radiusMeters);
  const dLon = metersToLonDegrees(radiusMeters, lat);
  const west = lng - dLon;
  const east = lng + dLon;
  const south = lat - dLat;
  const north = lat + dLat;

  // Web Mercator (and therefore the tile grid) is undefined beyond ~85 degrees,
  // and a square straddling the antimeridian would produce a negative tile x.
  // Both are rejected up front rather than left to fail as 404s partway through.
  if (!Number.isFinite(lat) || north > 85 || south < -85) return null;
  if (west < -180 || east > 180) return null;

  const topLeft = tileForLngLat(west, north, zoom);
  const bottomRight = tileForLngLat(east, south, zoom);
  const tileCount = Math.pow(2, zoom);
  if (topLeft.x < 0 || topLeft.y < 0 || bottomRight.x >= tileCount || bottomRight.y >= tileCount) {
    return null;
  }
  const tilesWide = bottomRight.x - topLeft.x + 1;
  const tilesTall = bottomRight.y - topLeft.y + 1;
  if (tilesWide <= 0 || tilesTall <= 0) return null;

  const mosaicWidth = tilesWide * TERRARIUM_TILE_SIZE;
  const mosaicHeight = tilesTall * TERRARIUM_TILE_SIZE;
  const mosaic = new Float32Array(mosaicWidth * mosaicHeight);

  const requests: Promise<void>[] = [];
  let loaded = 0;
  for (let ty = 0; ty < tilesTall; ty += 1) {
    for (let tx = 0; tx < tilesWide; tx += 1) {
      const url = tileUrl
        .replace("{z}", String(zoom))
        .replace("{x}", String(topLeft.x + tx))
        .replace("{y}", String(topLeft.y + ty));
      requests.push(
        decodeTile(url, signal).then((tile) => {
          if (!tile) return;
          // A tile served at a size other than the mosaic assumes would be
          // copied at the wrong stride, shearing the elevations. Skipping it
          // degrades that patch instead.
          if (tile.width !== TERRARIUM_TILE_SIZE || tile.height !== TERRARIUM_TILE_SIZE) return;
          loaded += 1;
          for (let row = 0; row < TERRARIUM_TILE_SIZE; row += 1) {
            const target =
              (ty * TERRARIUM_TILE_SIZE + row) * mosaicWidth + tx * TERRARIUM_TILE_SIZE;
            mosaic.set(
              tile.values.subarray(row * TERRARIUM_TILE_SIZE, (row + 1) * TERRARIUM_TILE_SIZE),
              target,
            );
          }
        }),
      );
    }
  }
  await Promise.all(requests);
  if (loaded === 0) return null;

  // Crop the tile mosaic down to the requested square.
  const [mosaicWest, mosaicNorth] = tileNorthWest(topLeft.x, topLeft.y, zoom);
  const [mosaicEast, mosaicSouth] = tileNorthWest(bottomRight.x + 1, bottomRight.y + 1, zoom);
  const colOf = (x: number) =>
    Math.round(((x - mosaicWest) / (mosaicEast - mosaicWest)) * (mosaicWidth - 1));
  // Tile rows are uniformly spaced in Web Mercator Y, not in latitude, so the
  // row lookup interpolates in mercator space. Interpolating in latitude
  // instead skews the crop north-south, and the error grows with latitude.
  const rowOf = (y: number) => {
    const top = mercatorY(mosaicNorth);
    const bottom = mercatorY(mosaicSouth);
    return Math.round(((mercatorY(y) - top) / (bottom - top)) * (mosaicHeight - 1));
  };

  const cropLeft = Math.max(0, colOf(west));
  const cropRight = Math.min(mosaicWidth - 1, colOf(east));
  const cropTop = Math.max(0, rowOf(north));
  const cropBottom = Math.min(mosaicHeight - 1, rowOf(south));
  const width = cropRight - cropLeft + 1;
  const height = cropBottom - cropTop + 1;
  if (width <= 1 || height <= 1) return null;

  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const source = (cropTop + row) * mosaicWidth + cropLeft;
    values.set(mosaic.subarray(source, source + width), row * width);
  }

  return { width, height, values, bbox: [west, south, east, north] };
}

// --- Off-main-thread execution ---------------------------------------------

/**
 * Compute a viewshed on a Web Worker, falling back to this thread where Workers
 * are unavailable (SSR, a test runner, a locked-down webview).
 *
 * The walk is O(n³) in the grid's side length with no yield points, so running
 * it inline freezes the tab until it finishes — several seconds at the largest
 * radius preset on modest hardware. The DEM and the visibility grid are both
 * plain typed arrays, so the round trip costs one structured clone in and one
 * transfer out.
 *
 * Mirrors `runToolOnWorker` in `wasm-convert.ts`: one job per worker,
 * terminated on the terminal message, and no timeout — how long this takes is
 * bounded by the grid, not the clock, and cutting off work that would have
 * finished is worse than waiting.
 */
export function computeViewshedAsync(
  dem: TerrainDem,
  observer: ViewshedObserver,
  radiusMeters = 0,
): Promise<ViewshedResult> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(computeViewshed(dem, observer, radiusMeters));
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./terrain-viewshed.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      // A bundler or runtime that cannot construct the worker should still
      // produce a viewshed rather than an error.
      resolve(computeViewshed(dem, observer, radiusMeters));
      return;
    }
    const settle = (fn: () => void): void => {
      worker.terminate();
      fn();
    };
    worker.addEventListener("message", (event: MessageEvent<ViewshedWorkerResponse>) => {
      const data = event.data;
      settle(() => {
        if (!data.ok) {
          reject(new Error(data.error || "The viewshed worker failed."));
          return;
        }
        const { ok: _ok, ...result } = data;
        resolve(result);
      });
    });
    worker.addEventListener("error", (event) => {
      settle(() => reject(new Error(event.message || "The viewshed worker failed.")));
    });
    // `error` does not fire when a posted message cannot be deserialized, which
    // would otherwise leave this promise pending forever.
    worker.addEventListener("messageerror", () => {
      settle(() => reject(new Error("The viewshed worker posted an undeserializable message.")));
    });
    try {
      // The DEM is cloned rather than transferred: the caller still owns it (it
      // is reused for the result's bbox), and a neutered input would be a trap.
      worker.postMessage({ dem, observer, radiusMeters } satisfies ViewshedWorkerRequest);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
