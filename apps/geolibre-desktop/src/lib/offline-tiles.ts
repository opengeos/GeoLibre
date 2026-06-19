/**
 * Offline region download: enumerate every basemap resource (vector/raster
 * tiles, the style JSON, sprite, and glyphs) that covers a chosen map area +
 * zoom range, then `fetch()` each one so the service worker's CacheFirst rules
 * store it for offline use.
 *
 * The mechanism is deliberately indirect: we do NOT write to the Cache Storage
 * API ourselves, because the generated Workbox service worker only *serves*
 * responses from the caches its own routes populate. Instead we issue ordinary
 * `fetch()`es; those pass through the SW, whose `geolibre-basemaps` CacheFirst
 * route (see vite.config.ts) stores them. That route matches by host
 * (openfreemap.org / cartocdn.com) and caches every path on those hosts — style,
 * sprite, glyphs, and tiles alike — so warming the viewport's resources makes
 * the region render fully offline afterwards. Resources on other hosts are
 * fetched too but will not persist (no matching SW route); callers should warn.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

/** [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Convert a longitude/latitude to the XYZ tile column/row containing it at the
 * given zoom (Web Mercator, the scheme MapLibre and XYZ/TMS tile services use).
 *
 * Args:
 *   lng: Longitude in degrees.
 *   lat: Latitude in degrees (clamped to the Web Mercator limit ~±85.0511°).
 *   z: Zoom level.
 *
 * Returns:
 *   The tile column (`x`) and row (`y`), clamped to the valid range for `z`.
 */
export function lngLatToTile(
  lng: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = clamp(lat, -85.05112878, 85.05112878);
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

/** The inclusive tile-column/row rectangle covering `bbox` at zoom `z`. */
export function tileRangeForBbox(
  bbox: Bbox,
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const [west, south, east, north] = bbox;
  const nw = lngLatToTile(west, north, z);
  const se = lngLatToTile(east, south, z);
  return {
    minX: Math.min(nw.x, se.x),
    maxX: Math.max(nw.x, se.x),
    minY: Math.min(nw.y, se.y),
    maxY: Math.max(nw.y, se.y),
  };
}

/**
 * Split a bbox that crosses the antimeridian (`west > east`, e.g. a Pacific view
 * where MapLibre returns west≈170, east≈-170) into the two non-wrapping halves
 * `[west, 180]` and `[-180, east]`. A normal bbox is returned unchanged. Without
 * this, `tileRangeForBbox` would cover the wrong (Eurasian) strip.
 */
function splitAntimeridian(bbox: Bbox): Bbox[] {
  const [west, south, east, north] = bbox;
  return west > east
    ? [
        [west, south, 180, north],
        [-180, south, east, north],
      ]
    : [bbox];
}

/**
 * Count the tiles covering `bbox` across `[minZoom, maxZoom]` without
 * materializing them — used to preview download size before committing.
 */
export function countTiles(
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
): number {
  let total = 0;
  for (const part of splitAntimeridian(bbox)) {
    for (let z = minZoom; z <= maxZoom; z++) {
      const r = tileRangeForBbox(part, z);
      total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
    }
  }
  return total;
}

/** Yield every tile covering `bbox` across `[minZoom, maxZoom]`. */
export function* enumerateTiles(
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
): Generator<TileCoord> {
  for (const part of splitAntimeridian(bbox)) {
    for (let z = minZoom; z <= maxZoom; z++) {
      const r = tileRangeForBbox(part, z);
      for (let x = r.minX; x <= r.maxX; x++) {
        for (let y = r.minY; y <= r.maxY; y++) {
          yield { z, x, y };
        }
      }
    }
  }
}

/** Microsoft-style quadkey for a tile (for `{quadkey}` URL templates). */
export function tileToQuadkey({ z, x, y }: TileCoord): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}

/**
 * Expand a tile URL template for a tile coordinate, supporting the `{z}`/`{x}`/
 * `{y}`, TMS `{-y}`, and `{quadkey}` placeholders. `{s}` subdomain placeholders
 * are resolved to the first listed subdomain so every tile maps to a single,
 * stable URL; when no subdomains are given, `{s}` is dropped together with its
 * trailing `.` separator so `https://{s}.host/…` becomes `https://host/…`
 * rather than the invalid `https://.host/…`.
 */
export function expandTileUrl(
  template: string,
  tile: TileCoord,
  subdomains?: string[],
): string {
  const tmsY = 2 ** tile.z - 1 - tile.y;
  const sub = subdomains?.[0];
  return template
    .replace(/\{z\}/g, String(tile.z))
    .replace(/\{x\}/g, String(tile.x))
    .replace(/\{y\}/g, String(tile.y))
    .replace(/\{-y\}/g, String(tmsY))
    .replace(/\{quadkey\}/g, tileToQuadkey(tile))
    .replace(/\{s\}\.?/g, (match) =>
      sub ? (match.endsWith(".") ? `${sub}.` : sub) : "",
    );
}

/** Resolve a possibly-relative style asset URL against the document origin. */
function absolute(url: string): string {
  try {
    return new URL(url, self.location?.href ?? "http://localhost/").toString();
  } catch {
    return url;
  }
}

interface RasterTileJson {
  tiles?: string[];
}

/**
 * Read the active MapLibre style and collect every URL needed to render the
 * given region offline: vector/raster tiles for each source across the zoom
 * range, the sprite (json + png, 1x and 2x), and glyph PBFs for the fontstacks
 * the style actually uses.
 *
 * Sources whose tile templates are not embedded in the style (vector sources
 * declared with a TileJSON `url`) are resolved by fetching that TileJSON.
 *
 * Args:
 *   map: The live MapLibre map.
 *   bbox: Region to cover, [west, south, east, north].
 *   minZoom: Lowest zoom to include.
 *   maxZoom: Highest zoom to include.
 *   options.glyphRanges: Unicode glyph ranges to warm per fontstack (default
 *     ["0-255", "256-511"]). Glyphs are otherwise fetched lazily as labels
 *     render, so warming the common ranges is what makes offline labels appear.
 *   options.signal: Aborts the TileJSON discovery fetch (so Cancel is responsive
 *     before warming starts).
 *
 * Returns:
 *   A de-duplicated list of absolute URLs to fetch.
 */
export async function collectOfflineUrls(
  map: MapLibreMap,
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
  options: { glyphRanges?: string[]; signal?: AbortSignal } = {},
): Promise<string[]> {
  const { glyphRanges = ["0-255", "256-511"], signal } = options;
  const style = map.getStyle();
  const urls = new Set<string>();

  // Tile sources.
  for (const source of Object.values(style.sources ?? {})) {
    const spec = source as {
      type?: string;
      tiles?: string[];
      url?: string;
      subdomains?: string[];
    };
    if (spec.type !== "vector" && spec.type !== "raster") continue;

    let templates = spec.tiles;
    if ((!templates || templates.length === 0) && spec.url) {
      try {
        const res = await fetch(absolute(spec.url), { signal });
        if (res.ok) {
          const tilejson = (await res.json()) as RasterTileJson;
          templates = tilejson.tiles;
        }
      } catch {
        // Unreachable TileJSON: skip this source rather than abort the whole run.
      }
    }
    if (!templates || templates.length === 0) continue;

    const template = templates[0];
    for (const tile of enumerateTiles(bbox, minZoom, maxZoom)) {
      urls.add(absolute(expandTileUrl(template, tile, spec.subdomains)));
    }
  }

  // Sprite (icons): json + png at 1x and 2x. MapLibre allows `sprite` to be a
  // string or an array of { id, url } objects (multi-sprite styles).
  const spriteSpec = style.sprite;
  const spriteUrls =
    typeof spriteSpec === "string"
      ? [spriteSpec]
      : Array.isArray(spriteSpec)
        ? (spriteSpec as { url: string }[]).map((s) => s.url)
        : [];
  for (const sprite of spriteUrls) {
    for (const suffix of ["", "@2x"]) {
      urls.add(absolute(`${sprite}${suffix}.json`));
      urls.add(absolute(`${sprite}${suffix}.png`));
    }
  }

  // Glyphs (label fonts): one PBF per (fontstack, range). MapLibre substitutes
  // `{fontstack}` with a raw string (commas and spaces unescaped) and lets the
  // browser normalize the request URL; we do the same so our warmed URL matches
  // MapLibre's actual glyph request and the SW cache key lines up. (Encoding the
  // fontstack here would percent-encode the comma separators and miss.)
  const glyphs = style.glyphs;
  if (glyphs) {
    const fontstacks = new Set<string>();
    for (const layer of style.layers ?? []) {
      const fonts = (layer as { layout?: { "text-font"?: string[] } }).layout?.[
        "text-font"
      ];
      if (Array.isArray(fonts) && fonts.length > 0) {
        fontstacks.add(fonts.join(","));
      }
    }
    for (const stack of fontstacks) {
      for (const range of glyphRanges) {
        urls.add(
          absolute(
            glyphs.replace("{fontstack}", stack).replace("{range}", range),
          ),
        );
      }
    }
  }

  return [...urls];
}

export interface WarmProgress {
  done: number;
  total: number;
  failed: number;
  /**
   * URLs that failed to warm (non-OK response or network error). Lets callers
   * offer a "retry failed tiles" action without re-fetching the whole region.
   */
  failedUrls: string[];
}

/**
 * Fetch every URL (so the service worker caches it) with bounded concurrency,
 * reporting progress and honoring an AbortSignal. Failures are counted, not
 * thrown — a partial offline region is still useful.
 *
 * Args:
 *   urls: Absolute URLs to warm.
 *   options.concurrency: Max simultaneous requests (default 6).
 *   options.signal: Abort signal to cancel in-flight and pending fetches.
 *   options.onProgress: Called after each request settles.
 *
 * Returns:
 *   Final progress counters.
 */
export async function warmUrls(
  urls: string[],
  options: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (progress: WarmProgress) => void;
  } = {},
): Promise<WarmProgress> {
  const { concurrency = 6, signal, onProgress } = options;
  const progress: WarmProgress = {
    done: 0,
    total: urls.length,
    failed: 0,
    failedUrls: [],
  };
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < urls.length) {
      if (signal?.aborted) return;
      const url = urls[cursor++];
      try {
        // CacheFirst means already-cached URLs return instantly; new ones hit
        // the network and are stored by the SW. We discard the body.
        const res = await fetch(url, { signal, cache: "no-cache" });
        if (!res.ok) {
          progress.failed++;
          progress.failedUrls.push(url);
        }
      } catch {
        if (signal?.aborted) return;
        progress.failed++;
        progress.failedUrls.push(url);
      } finally {
        // `finally` runs even after the `return` above, so only count requests
        // that actually settled — not ones interrupted by an abort.
        if (!signal?.aborted) {
          progress.done++;
          // Copy `failedUrls` so each snapshot is independent — a shallow
          // `{ ...progress }` would share the one array reference across every
          // emitted snapshot, and later `push()`es would mutate state React
          // already holds (unsafe under Strict Mode / concurrent rendering).
          onProgress?.({ ...progress, failedUrls: [...progress.failedUrls] });
        }
      }
    }
  }

  // Clamp to at least one worker (a 0/negative concurrency would spawn none and
  // silently warm nothing), and never more than there are URLs.
  const workerCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    urls.length,
  );
  const workers = Array.from({ length: workerCount }, worker);
  await Promise.all(workers);
  return progress;
}

/** Whether a service worker currently controls the page (offline caching works). */
export function hasActiveServiceWorker(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    !!navigator.serviceWorker.controller
  );
}
