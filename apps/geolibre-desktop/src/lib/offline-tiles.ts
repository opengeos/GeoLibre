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

/** The active style object, as returned by MapLibre's `map.getStyle()`. */
type StyleLike = ReturnType<MapLibreMap["getStyle"]>;

/** Default glyph ranges warmed per fontstack (the common Latin coverage). */
const DEFAULT_GLYPH_RANGES = ["0-255", "256-511"];

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

/** Resolved zoom plan for the offline download dialog. */
export interface OfflineZoomPlan {
  /** Lowest zoom to download — the snapshot view's integer zoom, never above the map's max. */
  baseZoom: number;
  /** Highest zoom to download. Always `>= baseZoom` (never an inverted range). */
  maxZoom: number;
  /**
   * Number of extra zoom levels available above the base zoom, capped at the
   * hard maximum. This is the slider's upper bound; it is `0` exactly when
   * `canIncludeExtra` is false (the view is at the map's max zoom). Callers
   * should gate on `canIncludeExtra` rather than relying on a non-zero value.
   */
  maxExtraLevels: number;
  /**
   * Whether extra higher-zoom detail can be added at all. False when the view is
   * already at the map's maximum zoom, where there is nothing deeper to fetch —
   * the dialog hides the "include extra" control in that case.
   */
  canIncludeExtra: boolean;
}

/**
 * Resolve the zoom range an offline download should cover from the dialog's
 * inputs, bounded by the map's actual maximum zoom rather than a fixed ceiling.
 *
 * This keeps the preview honest at high zoom: the extra-detail range tracks what
 * the map can really render (its configurable max zoom, up to 24), the slider
 * only offers levels that have an effect, and the resulting range is never
 * inverted (e.g. a "24–22" backwards range at the top of the zoom range).
 *
 * Args:
 *   viewZoom: The snapshot view's zoom (may be fractional).
 *   mapMaxZoom: The map's configured maximum zoom.
 *   includeExtra: Whether the "include extra detail levels" toggle is on.
 *   extraLevels: The extra-levels slider value. Floored to an integer and
 *     treated as at least 1 when `includeExtra` is on.
 *   hardMaxExtraLevels: The slider's absolute upper bound (the dialog's cap).
 *     Must be `>= 1`; the dialog passes a fixed positive constant.
 *
 * Returns:
 *   The resolved {@link OfflineZoomPlan}.
 */
export function planOfflineZoom(
  viewZoom: number,
  mapMaxZoom: number,
  includeExtra: boolean,
  extraLevels: number,
  hardMaxExtraLevels: number,
): OfflineZoomPlan {
  const ceil = Math.max(0, Math.floor(mapMaxZoom));
  const baseZoom = Math.min(Math.max(0, Math.floor(viewZoom)), ceil);
  const canIncludeExtra = baseZoom < ceil;
  // 0 when the view is already at the map's max zoom. The slider's `max` is
  // gated behind `canIncludeExtra` in the dialog, so it never receives 0; when
  // it is shown, `ceil - baseZoom >= 1` together with the `hardMaxExtraLevels
  // >= 1` precondition guarantees a valid (non-inverted) range.
  const maxExtraLevels = Math.min(hardMaxExtraLevels, ceil - baseZoom);
  const effectiveExtra =
    includeExtra && canIncludeExtra
      ? // Sub-1 values are treated as 1 extra level; the dialog's slider enforces
        // min=1, so this floor only guards out-of-range programmatic callers.
        Math.min(Math.max(1, Math.floor(extraLevels)), maxExtraLevels)
      : 0;
  return {
    baseZoom,
    maxZoom: baseZoom + effectiveExtra,
    maxExtraLevels,
    canIncludeExtra,
  };
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
  minzoom?: number;
  maxzoom?: number;
}

interface ResolvedTileSource {
  template: string;
  subdomains?: string[];
  /** Source coverage bounds; undefined when the source/TileJSON omits them. */
  minzoom?: number;
  maxzoom?: number;
}

/**
 * Clamp a requested `[minZoom, maxZoom]` range to a source's coverage
 * `[srcMin, srcMax]`, returning the zoom range to actually warm — or `null` when
 * there is nothing to warm.
 *
 * The point is to never request a tile **beyond the source's maxzoom**: those
 * 404 (e.g. OpenFreeMap's `ne2_shaded` raster stops at z6 and its vector tiles
 * at z14), which is what made over-zoomed offline downloads fail wholesale.
 * When the *entire* requested range sits above the source maxzoom (the user is
 * zoomed past it), we warm just the deepest available level — MapLibre overzooms
 * those tiles to render the higher zooms, so they still work offline.
 */
export function clampZoomRange(
  minZoom: number,
  maxZoom: number,
  srcMin?: number,
  srcMax?: number,
): { minZoom: number; maxZoom: number } | null {
  const lo = typeof srcMin === "number" ? srcMin : 0;
  const hi = typeof srcMax === "number" ? srcMax : maxZoom;
  // Requested range is entirely below where this source has data.
  if (maxZoom < lo) return null;
  // Over-zoomed past the source: warm only its deepest level for overzoom.
  if (minZoom > hi) return { minZoom: hi, maxZoom: hi };
  const z0 = Math.max(minZoom, lo);
  const z1 = Math.min(maxZoom, hi);
  if (z1 < z0) return null;
  return { minZoom: z0, maxZoom: z1 };
}

/**
 * Resolve every vector/raster source in the active style to a single tile-URL
 * template plus its coverage bounds, fetching the TileJSON for sources that
 * declare their tiles via a `url` (e.g. OpenFreeMap's vector source). Sources
 * with no usable template are dropped.
 */
async function resolveTileSources(
  map: MapLibreMap,
  signal?: AbortSignal,
): Promise<ResolvedTileSource[]> {
  const style = map.getStyle();
  const resolved: ResolvedTileSource[] = [];
  for (const source of Object.values(style.sources ?? {})) {
    const spec = source as {
      type?: string;
      tiles?: string[];
      url?: string;
      subdomains?: string[];
      minzoom?: number;
      maxzoom?: number;
    };
    if (spec.type !== "vector" && spec.type !== "raster") continue;

    let templates = spec.tiles;
    let minzoom = spec.minzoom;
    let maxzoom = spec.maxzoom;
    if ((!templates || templates.length === 0) && spec.url) {
      try {
        const res = await fetch(absolute(spec.url), { signal });
        if (res.ok) {
          const tilejson = (await res.json()) as RasterTileJson;
          templates = tilejson.tiles;
          // The style spec wins; fall back to the TileJSON's declared bounds.
          if (minzoom === undefined) minzoom = tilejson.minzoom;
          if (maxzoom === undefined) maxzoom = tilejson.maxzoom;
        }
      } catch {
        // Unreachable TileJSON: skip this source rather than abort the whole run.
      }
    }
    if (!templates || templates.length === 0) continue;
    resolved.push({
      template: templates[0],
      subdomains: spec.subdomains,
      minzoom,
      maxzoom,
    });
  }
  return resolved;
}

/**
 * Enumerate the distinct, absolute tile URLs an offline download would warm for
 * `bbox` across `[minZoom, maxZoom]`, per source and clamped to each source's
 * coverage. The result is de-duplicated across sources (two sources sharing a
 * tile template collapse to one URL), so it is the single source of truth for
 * both the size preview and the actual download — counting a separate per-source
 * sum could double-count shared URLs and drift from what really downloads (#992).
 */
async function collectTileUrls(
  map: MapLibreMap,
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const urls = new Set<string>();
  for (const src of await resolveTileSources(map, signal)) {
    const range = clampZoomRange(minZoom, maxZoom, src.minzoom, src.maxzoom);
    if (!range) continue;
    for (const tile of enumerateTiles(bbox, range.minZoom, range.maxZoom)) {
      urls.add(absolute(expandTileUrl(src.template, tile, src.subdomains)));
    }
  }
  return urls;
}

/**
 * Count the tiles an offline download would actually warm for `bbox` across
 * `[minZoom, maxZoom]`, clamped to each source's coverage and de-duplicated
 * across sources. This is the preview-accurate count: it counts exactly the tile
 * URLs `collectOfflineUrls` produces (so the dialog's estimate agrees with the
 * download total), unlike a naive `countTiles` that ignores source maxzoom and
 * over-counts.
 */
export async function countOfflineTiles(
  map: MapLibreMap,
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  return (await collectTileUrls(map, bbox, minZoom, maxZoom, options.signal))
    .size;
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
 *   `urls` — every de-duplicated absolute URL to fetch (tiles + shared assets).
 *   `tileUrls` — the region-specific raster/vector tile URLs only. Shared assets
 *   (style, sprite, glyphs) are excluded here because they are common to every
 *   region and must never be deleted when one region is removed; the offline
 *   manifest stores this subset so it can size and delete a region safely.
 */
export async function collectOfflineUrls(
  map: MapLibreMap,
  bbox: Bbox,
  minZoom: number,
  maxZoom: number,
  options: { glyphRanges?: string[]; signal?: AbortSignal } = {},
): Promise<{ urls: string[]; tileUrls: string[] }> {
  const { glyphRanges = DEFAULT_GLYPH_RANGES, signal } = options;
  const style = map.getStyle();

  // Tiles: enumerated (and de-duplicated) by the same helper the size preview
  // uses, so the estimate and the download can never disagree on the tile count.
  const tileUrls = await collectTileUrls(map, bbox, minZoom, maxZoom, signal);

  // Shared style assets (sprite + glyphs) are warmed too, but tracked only in
  // `urls` (not `tileUrls`): they are common to every region and must not be
  // deleted when one region is removed. Tiles and assets are served from
  // distinct paths, so the two URL sets are disjoint and the dialog's
  // `tiles + assets` preview equals `urls.length`. Warn if a style ever violates
  // that (an asset URL colliding with a tile URL) — the Set would silently
  // de-duplicate it and the preview would drift above the real download total.
  const urls = new Set(tileUrls);
  for (const url of collectStyleAssetUrls(style, glyphRanges)) {
    if (tileUrls.has(url)) {
      // `urls` still de-duplicates the collision, so the actual download count
      // (urls.length) stays correct; only the dialog's `tiles + assets` size
      // preview would over-count this URL by one asset.
      console.warn(
        `[GeoLibre] offline asset URL collides with a tile URL; the size preview over-counts it by one asset (the download itself is unaffected): ${url}`,
      );
    }
    urls.add(url);
  }

  return { urls: [...urls], tileUrls: [...tileUrls] };
}

/**
 * Enumerate the shared, non-tile style asset URLs that an offline download warms
 * alongside the tiles: the sprite (json + png at 1x and 2x) and one glyph PBF per
 * (fontstack, range) the style actually uses. Kept as the single source of truth
 * for these URLs so the download (`collectOfflineUrls`) and the size preview
 * (`countStyleAssets`) can never disagree about how many there are (#992).
 */
function collectStyleAssetUrls(
  style: StyleLike,
  glyphRanges: string[],
): string[] {
  const urls = new Set<string>();

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

/**
 * Count the shared style asset URLs (sprite + glyphs) an offline download warms
 * in addition to its tiles. Adding this to {@link countOfflineTiles} makes the
 * dialog's size preview equal the live download total, which counts every URL
 * (tiles + assets), so the estimate and the progress bar agree (#992).
 *
 * Args:
 *   map: The live MapLibre map.
 *   glyphRanges: Unicode glyph ranges warmed per fontstack; must match the value
 *     passed to {@link collectOfflineUrls} (both default to the same ranges).
 *
 * Returns:
 *   The number of distinct sprite/glyph URLs the download will fetch.
 */
export function countStyleAssets(
  map: MapLibreMap,
  glyphRanges: string[] = DEFAULT_GLYPH_RANGES,
): number {
  return collectStyleAssetUrls(map.getStyle(), glyphRanges).length;
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
 *   options.concurrency: Max simultaneous requests (default 6). Lowering this
 *     reduces the network footprint, which can get past aggressive server-side
 *     rate limiting that otherwise causes tiles to fail.
 *   options.timeoutMs: Per-request timeout in ms. A request that exceeds it is
 *     aborted and counted as a failure (so it lands in `failedUrls` and can be
 *     retried), without cancelling the rest of the run. 0 / undefined disables
 *     it (the browser default applies). Raising it helps slow connections.
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
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (progress: WarmProgress) => void;
  } = {},
): Promise<WarmProgress> {
  const { concurrency = 6, timeoutMs, signal, onProgress } = options;

  // Per-request signal: the parent cancel signal combined with a fresh timeout
  // (one timer per request). A timeout abort leaves the parent signal
  // un-aborted, so the catch below counts it as a failure rather than a cancel.
  const requestSignal = (): AbortSignal | undefined => {
    if (!timeoutMs || timeoutMs <= 0) return signal;
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    // AbortSignal.any shipped in Chrome 116 / Firefox 124 / Safari 17.4. On
    // older engines fall back to the timeout alone so the request still times
    // out (it just won't also abort on the parent cancel signal).
    return typeof AbortSignal.any === "function"
      ? AbortSignal.any([signal, timeout])
      : timeout;
  };
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
        const res = await fetch(url, {
          signal: requestSignal(),
          cache: "no-cache",
        });
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
