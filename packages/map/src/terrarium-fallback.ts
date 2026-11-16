import type { CogDemFallback } from "./cog-dem-source";

const TILE_SIZE = 256;
/** Decoded ancestor tiles kept for overzoomed reads; each is 256 KiB. */
const MAX_CACHED_TILES = 64;

/**
 * Decode Terrarium-encoded RGBA to metres: `R * 256 + G + B / 256 - 32768`.
 * A transparent pixel has no elevation and decodes to NaN.
 *
 * @param rgba - Row-major RGBA bytes of one tile.
 * @returns One elevation per pixel.
 */
export function decodeTerrariumRgba(rgba: ArrayLike<number>): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let index = 0; index < out.length; index += 1) {
    const offset = index * 4;
    out[index] =
      rgba[offset + 3] === 0
        ? Number.NaN
        : rgba[offset] * 256 + rgba[offset + 1] + rgba[offset + 2] / 256 - 32_768;
  }
  return out;
}

/**
 * The part of an ancestor tile that covers a deeper tile, resampled
 * (bilinear) to a full 256 x 256 tile. Used past the fallback source's
 * maximum zoom, where only a coarser tile exists.
 *
 * @param ancestor - The ancestor's elevations, 256 x 256 row-major.
 * @param depth - How many zoom levels the requested tile is below the ancestor.
 * @param x - The requested tile's column.
 * @param y - The requested tile's row.
 * @returns Elevations for the requested tile.
 */
export function sampleAncestorTile(
  ancestor: ArrayLike<number>,
  depth: number,
  x: number,
  y: number,
): Float32Array {
  if (depth <= 0) return Float32Array.from(ancestor);
  const scale = 2 ** depth;
  const span = TILE_SIZE / scale;
  const originX = (x % scale) * span;
  const originY = (y % scale) * span;
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  const at = (column: number, row: number) =>
    ancestor[
      Math.min(TILE_SIZE - 1, Math.max(0, row)) * TILE_SIZE +
        Math.min(TILE_SIZE - 1, Math.max(0, column))
    ];
  for (let row = 0; row < TILE_SIZE; row += 1) {
    // Pixel centres, so the deeper tile lines up with the ancestor's samples.
    const sourceY = originY + ((row + 0.5) * span) / TILE_SIZE - 0.5;
    const top = Math.floor(sourceY);
    const ty = sourceY - top;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const sourceX = originX + ((column + 0.5) * span) / TILE_SIZE - 0.5;
      const left = Math.floor(sourceX);
      const tx = sourceX - left;
      out[row * TILE_SIZE + column] =
        (at(left, top) * (1 - tx) + at(left + 1, top) * tx) * (1 - ty) +
        (at(left, top + 1) * (1 - tx) + at(left + 1, top + 1) * tx) * ty;
    }
  }
  return out;
}

/** Decode a PNG to RGBA with the browser's image pipeline. */
async function decodePng(bytes: Blob): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(bytes);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create a canvas to decode a terrain tile.");
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  } finally {
    bitmap.close();
  }
}

/** Options for {@link createTerrariumFallback}. */
export interface TerrariumFallbackOptions {
  /** XYZ template of a 256 px Terrarium PNG source, e.g. the AWS terrain tiles. */
  template: string;
  /** The deepest zoom the source serves; deeper tiles are cut from it. */
  maxzoom: number;
  /** Fetch and decode one tile to RGBA, or null when it has none (tests). */
  loadRgba?: (url: string) => Promise<ArrayLike<number> | null>;
}

/**
 * A {@link CogDemFallback} reading a global Terrarium tile source, so a custom
 * COG DEM is surrounded by global terrain instead of a 0 m plain (#3470).
 * Decoded tiles are cached so the many overzoomed tiles under one ancestor
 * fetch it once.
 *
 * @param options - The tile source and its maximum zoom.
 * @returns A fallback for `registerCogDemSource`.
 */
export function createTerrariumFallback(options: TerrariumFallbackOptions): CogDemFallback {
  const loadRgba =
    options.loadRgba ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) return null;
      return decodePng(await response.blob());
    });
  const cache = new Map<string, Promise<Float32Array | null>>();
  const load = (z: number, x: number, y: number): Promise<Float32Array | null> => {
    const key = `${z}/${x}/${y}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const url = options.template
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const pending = loadRgba(url).then(
      (rgba) =>
        rgba && rgba.length === TILE_SIZE * TILE_SIZE * 4 ? decodeTerrariumRgba(rgba) : null,
      () => null,
    );
    cache.set(key, pending);
    if (cache.size > MAX_CACHED_TILES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    // A failed read should be retried by the next tile that needs it.
    void pending.then((tile) => {
      if (!tile && cache.get(key) === pending) cache.delete(key);
    });
    return pending;
  };
  return async (z, x, y) => {
    const depth = Math.max(0, z - options.maxzoom);
    const ancestor = await load(z - depth, x >> depth, y >> depth);
    return ancestor ? sampleAncestorTile(ancestor, depth, x, y) : null;
  };
}
