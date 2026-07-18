import { loadGeoTIFF } from "maplibre-gl-raster";

/**
 * One legend entry derived from a paletted raster: the raw pixel value and the
 * hex color the embedded color table assigns it. The label is intentionally the
 * bare value so the user can rename it to a class name (e.g. "Tree cover").
 */
export type PaletteLegendEntry = {
  /** The raw (stored) pixel value this palette entry colors. */
  value: number;
  /** The entry's color as a `#rrggbb` hex string. */
  color: string;
};

/**
 * A raster resolution level (the full image or an overview) reduced to the
 * tile-read surface this module needs. Mirrors the shape of `@developmentseed/
 * geotiff`'s `GeoTIFF` / `Overview` without importing the (transitive) package.
 */
type RasterLevel = {
  tileCount: { x: number; y: number };
  fetchTile: (
    x: number,
    y: number,
    options?: { signal?: AbortSignal },
  ) => Promise<{ array: TileArray }>;
};

/** Decoded tile data, either pixel-interleaved or one array per band. */
type TileArray = {
  width: number;
  height: number;
  /** Non-zero = valid pixel, 0 = nodata; null when the image carries no mask. */
  mask: Uint8Array | null;
  /** Samples per pixel. */
  count: number;
} & (
  | { layout: "pixel-interleaved"; data: ArrayLike<number> }
  | { layout: "band-separate"; bands: ArrayLike<number>[] }
);

/** The loaded GeoTIFF reduced to the members this module reads. */
type LoadedTiff = RasterLevel & {
  cachedTags?: { colorMap?: ArrayLike<number>; nodata?: number | null };
  nodata: number | null;
  overviews: RasterLevel[];
};

/**
 * Backstop on how many tiles the value scan reads. A categorical COG's coarsest
 * overview is only a handful of tiles, so this never trips in practice; it just
 * bounds the work for an oddly-tiled or non-pyramided raster.
 */
const MAX_SCAN_TILES = 512;

/** Two-digit lowercase hex for a 0-255 channel. */
function hex2(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

/** First-band values of a decoded tile, regardless of interleave layout. */
function firstBandValues(array: TileArray): ArrayLike<number> {
  if (array.layout === "band-separate") return array.bands[0];
  if (array.count <= 1) return array.data;
  // Pixel-interleaved with multiple bands: band 0 sits at stride `count`.
  const pixels = array.width * array.height;
  const out = new Float64Array(pixels);
  for (let i = 0; i < pixels; i++) out[i] = array.data[i * array.count];
  return out;
}

/**
 * Reads a paletted raster's embedded color table and returns a legend entry for
 * every pixel value that actually occurs in the data (nodata excluded), each
 * paired with the color the palette assigns it.
 *
 * Filler entries a color table leaves at a placeholder color are skipped by
 * construction: only values present in the raster are returned, so a land-cover
 * palette with 256 slots but 8 real classes yields exactly those 8. Present
 * values are read from the coarsest overview, which — for the nearest-neighbor
 * overviews categorical COGs ship with — preserves the class set.
 *
 * @param url - A URL (remote COG or session blob) for the GeoTIFF to inspect.
 * @param signal - Optional abort signal for the tile reads; an abort rejects the
 *   returned promise (it never resolves to `null`).
 * @returns Sorted legend entries, an empty array when the raster has a color
 *   table but no non-nodata pixels, or `null` when it carries no color table.
 */
export async function extractPaletteLegend(
  url: string,
  signal?: AbortSignal,
): Promise<PaletteLegendEntry[] | null> {
  const tiff = (await loadGeoTIFF(url)) as unknown as LoadedTiff;
  return await buildPaletteLegend(tiff, signal);
}

/**
 * The color-table decode + present-value scan behind {@link extractPaletteLegend},
 * split out from the `loadGeoTIFF` fetch so the parsing is unit-testable with a
 * synthetic tiff. Not part of the package's public API.
 *
 * @param tiff - A loaded GeoTIFF (maplibre-gl-raster's internal shape).
 * @param signal - Optional abort signal for the tile reads.
 * @returns See {@link extractPaletteLegend}.
 * @internal
 */
export async function buildPaletteLegend(
  tiff: LoadedTiff,
  signal?: AbortSignal,
): Promise<PaletteLegendEntry[] | null> {
  const cmap = tiff.cachedTags?.colorMap;
  if (!cmap || cmap.length < 3) return null;

  // The reads below reach into maplibre-gl-raster's internal GeoTIFF shape via a
  // structural cast (see LoadedTiff). Guard the fields the scan needs so a
  // future upstream rename fails loudly here instead of silently yielding an
  // empty legend.
  if (!Array.isArray(tiff.overviews) || typeof tiff.fetchTile !== "function") {
    throw new Error(
      "maplibre-gl-raster loadGeoTIFF returned an unexpected shape; " +
        "the palette reader needs updating for this version.",
    );
  }

  // The ColorMap tag stores 16-bit R, then G, then B, each `entries` long.
  const entries = Math.floor(cmap.length / 3);
  const colorFor = (value: number): string | null => {
    if (!Number.isInteger(value) || value < 0 || value >= entries) return null;
    const r = Number(cmap[value]) >> 8;
    const g = Number(cmap[entries + value]) >> 8;
    const b = Number(cmap[2 * entries + value]) >> 8;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  };

  const nodata = tiff.cachedTags?.nodata ?? tiff.nodata ?? null;
  // The coarsest overview is the cheapest full-coverage read; fall back to the
  // full-resolution image for a raster with no overview pyramid.
  const level: RasterLevel =
    tiff.overviews.length > 0 ? tiff.overviews[tiff.overviews.length - 1] : tiff;

  const present = new Set<number>();
  const totalTiles = level.tileCount.x * level.tileCount.y;
  let tilesRead = 0;
  let truncated = false;
  outer: for (let ty = 0; ty < level.tileCount.y; ty++) {
    for (let tx = 0; tx < level.tileCount.x; tx++) {
      // Abort surfaces as a thrown error (the standard AbortSignal contract) so
      // it is never confused with the `null` "no color table" return.
      signal?.throwIfAborted();
      if (tilesRead >= MAX_SCAN_TILES) {
        truncated = true;
        break outer;
      }
      const { array } = await level.fetchTile(tx, ty, { signal });
      const values = firstBandValues(array);
      const { mask } = array;
      for (let i = 0; i < values.length; i++) {
        if (mask && mask[i] === 0) continue;
        const value = values[i];
        if (nodata !== null && value === nodata) continue;
        present.add(value);
      }
      tilesRead++;
    }
  }
  if (truncated) {
    // Don't silently ship a partial class set: a raster with no overview
    // pyramid (so the full image is scanned) could exceed the cap and drop
    // rare classes. Warn so an incomplete legend is at least traceable.
    console.warn(
      `[GeoLibre] Palette legend scan capped at ${MAX_SCAN_TILES}/${totalTiles} tiles; ` +
        "the legend may omit rare classes.",
    );
  }

  const legend: PaletteLegendEntry[] = [];
  for (const value of [...present].sort((a, b) => a - b)) {
    const color = colorFor(value);
    if (color) legend.push({ value, color });
  }
  return legend;
}

// One palette read per layer is enough (a layer id maps to a fixed source), so
// cache the result. Both the symbology panel's ramp preview and the
// "Create legend from palette" action share it, and a band/re-render doesn't
// re-scan the file. The in-flight promise is cached too, so concurrent callers
// (preview effect + button) join one read instead of racing two scans.
const legendCache = new Map<string, PaletteLegendEntry[] | Promise<PaletteLegendEntry[] | null>>();

/**
 * Cached wrapper around {@link extractPaletteLegend}, keyed by layer id, so the
 * palette is read from the file only once per layer.
 *
 * @param layerId - The store layer id, used as the cache key.
 * @param url - A URL (remote COG or session blob) for the GeoTIFF.
 * @param signal - Optional abort signal, forwarded on a cache miss.
 * @returns The cached or freshly-read legend entries, or `null` when the raster
 *   carries no color table.
 */
export async function getPaletteLegend(
  layerId: string,
  url: string,
  signal?: AbortSignal,
): Promise<PaletteLegendEntry[] | null> {
  const cached = legendCache.get(layerId);
  if (cached) return await cached;
  const read = extractPaletteLegend(url, signal)
    .then((entries) => {
      // Replace the in-flight promise with the resolved entries; drop the cache
      // slot when there is no palette so a later attempt can retry.
      if (entries) legendCache.set(layerId, entries);
      else legendCache.delete(layerId);
      return entries;
    })
    .catch((error) => {
      legendCache.delete(layerId);
      throw error;
    });
  legendCache.set(layerId, read);
  return await read;
}

/**
 * Drops a single layer's cached palette (on raster removal), mirroring
 * {@link disposeRasterClassification}.
 *
 * @param layerId - The layer id to evict.
 */
export function disposePaletteLegend(layerId: string): void {
  legendCache.delete(layerId);
}

/** Drops every cached palette (on raster control teardown). */
export function disposeAllPaletteLegends(): void {
  legendCache.clear();
}
