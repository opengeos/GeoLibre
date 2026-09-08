import type { GeoLibreLayer } from "@geolibre/core";
import type { CogSource, RenderOptions } from "cog-tiler-wasm";
import {
  CESIUM_IMAGE_BITMAP_OPTIONS,
  ProtocolImageryProvider,
  webMercatorRectangle,
  type DecodedTile,
} from "./cesium-protocol-imagery";

// COG layers on the globe (issue #2283).
//
// On the 2D map a Cloud Optimized GeoTIFF is owned by the maplibre-gl-raster
// control, whose `cog-tiler-wasm` engine decodes each `{z}/{x}/{y}` tile in
// WebAssembly behind a private MapLibre protocol. The control is MapLibre-only,
// so the globe drives the same tiler directly: open the COG once, render each
// requested tile to RGBA with the layer's persisted visualisation state
// (`metadata.rasterState`, the same record the control restores from), and
// hand the pixels to a `ProtocolImageryProvider` through an injected loader.
//
// The engine namespace and the tiler are both injected (type-only imports), so
// this module adds nothing to the 2D boot path: the tiler is `import()`-ed on
// first use by `CesiumLayerSync`, exactly as the raster control does.

type CesiumNs = typeof import("@cesium/engine");

/** The tiler surface this module drives; the real module, or a test fake. */
export interface CogTilerModule {
  openCog(source: string | ArrayBuffer | Uint8Array | Blob): Promise<CogSource>;
}

/**
 * Wrap a tiler so each URL is opened once and shared. Opening a COG reads and
 * parses its header over range requests; a symbology edit rebuilds the
 * imagery provider but not the source, so the sync keeps one of these for
 * the widget's lifetime and forgets a URL when its last layer goes.
 */
export function cachingCogTiler(module: CogTilerModule): CogTilerModule & {
  forget(url: string): void;
  clear(): void;
} {
  const sources = new Map<string, Promise<CogSource>>();
  return {
    openCog(source) {
      if (typeof source !== "string") return module.openCog(source);
      let pending = sources.get(source);
      if (!pending) {
        pending = module.openCog(source);
        // A failed open must not poison every later attempt at the URL.
        pending.catch(() => {
          if (sources.get(source) === pending) sources.delete(source);
        });
        sources.set(source, pending);
      }
      return pending;
    },
    forget: (url) => void sources.delete(url),
    clear: () => sources.clear(),
  };
}

/** `metadata.rasterState`, as maplibre-gl-raster persists it. */
interface PersistedRasterState {
  mode?: "rgb" | "single" | "index";
  bands?: number[];
  colormap?: string;
  reversed?: boolean;
  rescale?: [number, number][] | [number, number] | null;
  nodata?: number | "auto" | null;
  stretch?: "linear" | "sqrt" | "log";
  gamma?: number;
}

/** Per-band statistics as `CogSource.statistics()` reports them. */
type BandStats = { min?: number; max?: number; percentile_2?: number; percentile_98?: number };

function rasterState(layer: GeoLibreLayer): PersistedRasterState {
  const raw = layer.metadata?.rasterState;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as PersistedRasterState) : {};
}

/**
 * The 1-based bands a raster state renders: one for a colormapped mode, the
 * first three for RGB. Mirrors maplibre-gl-raster's own resolution so the globe
 * composites the same channels the 2D map does.
 */
export function cogRenderBands(state: PersistedRasterState, bandCount?: number | null): number[] {
  const bands = Array.isArray(state.bands) ? state.bands : [];
  const colormapped = state.mode === "single" || state.mode === "index";
  if (colormapped) return [bands[0] || 1];
  const rgb = bands.slice(0, 3).map((b) => b || 1);
  if (rgb.length >= 3) return rgb;
  // A state with fewer than three bands (a hand-authored project, an older
  // save) composites the first three when the source has them — the control's
  // own default — and otherwise draws the one band it can.
  return typeof bandCount === "number" && bandCount >= 3 ? [1, 2, 3] : [rgb[0] ?? 1];
}

/**
 * The 2–98 percentile range of a band, falling back to its min/max — the same
 * default stretch the raster control applies when the state carries no
 * explicit rescale.
 */
export function autoRange(stats: BandStats | undefined): [number, number] | null {
  if (!stats) return null;
  const lo = stats.percentile_2 ?? stats.min;
  const hi = stats.percentile_98 ?? stats.max;
  if (typeof lo !== "number" || typeof hi !== "number") return null;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo === hi ? [lo, hi + 1] : [lo, hi];
}

/**
 * Translate a persisted raster state into cog-tiler render options, resolving
 * an absent rescale from the source's statistics. Mirrors the raster control's
 * `_renderOptionsFor`, so a COG looks the same on both renderers.
 */
export function cogRenderOptions(
  layer: GeoLibreLayer,
  statistics: Record<string, BandStats> | null,
): RenderOptions {
  const state = rasterState(layer);
  const colormapped = state.mode === "single" || state.mode === "index";
  const bandCount = layer.metadata?.bandCount;
  const bidx = cogRenderBands(state, typeof bandCount === "number" ? bandCount : null);
  const options: RenderOptions = { bidx };
  if (state.stretch) options.stretch = state.stretch;
  if (typeof state.gamma === "number" && Number.isFinite(state.gamma)) options.gamma = state.gamma;
  if (colormapped) {
    if (typeof state.reversed === "boolean") options.reversed = state.reversed;
    // "palette" means the GeoTIFF's own colour table, which the tiler applies
    // when no colormap is named.
    if (state.colormap && state.colormap !== "palette") options.colormap = state.colormap;
  }
  if (state.rescale) {
    options.rescale = state.rescale;
  } else if (statistics) {
    const ranges = bidx.map((b) => autoRange(statistics[`b${b}`]));
    if (ranges.every((r): r is [number, number] => r !== null)) options.rescale = ranges;
  }
  if (typeof state.nodata === "number") options.nodata = state.nodata;
  return options;
}

/**
 * The source the tiler should open for a COG layer: the remote URL, or the
 * blob URL the raster control keeps for a file added this session. A layer
 * restored from a project with only a desktop path has nothing the globe can
 * read (the control reads it through the host's file access), so it stays
 * "2D only" until the raster control has reopened it.
 */
export function cogSourceUrl(layer: GeoLibreLayer): string | undefined {
  const url = layer.source?.url;
  if (typeof url === "string" && url) return url;
  const local = layer.metadata?.localBytesUrl;
  return typeof local === "string" && local ? local : undefined;
}

/** What `styleSignature`-style change detection compares for a COG layer. */
export function cogRenderSignature(layer: GeoLibreLayer): string {
  return JSON.stringify([cogSourceUrl(layer), rasterState(layer)]);
}

/** Wrap a rendered RGBA tile as an image Cesium can upload. */
async function rgbaToTile(
  rgba: Uint8Array | Uint8ClampedArray,
  size: number,
): Promise<DecodedTile> {
  // Copy into a fresh buffer: the tiler may hand back a view over WASM
  // memory, which ImageData refuses (and which the next render would overwrite).
  const pixels = new Uint8ClampedArray(rgba.length);
  pixels.set(rgba);
  const data = new ImageData(pixels, size, size);
  return createImageBitmap(data, CESIUM_IMAGE_BITMAP_OPTIONS);
}

/**
 * Build the globe's imagery provider for a COG layer: open the source, read
 * its statistics when the state needs an automatic stretch, and return a
 * provider whose tiles the WASM tiler renders on demand.
 *
 * @param tileRenderer Overrides how RGBA pixels become an image (tests).
 */
export async function createCogImageryProvider(
  Cesium: CesiumNs,
  tiler: CogTilerModule,
  layer: GeoLibreLayer,
  tileRenderer: (
    rgba: Uint8Array | Uint8ClampedArray,
    size: number,
  ) => Promise<DecodedTile> = rgbaToTile,
): Promise<ProtocolImageryProvider> {
  const url = cogSourceUrl(layer);
  if (!url) throw new Error("the COG layer has no readable source");
  const source = await tiler.openCog(url);
  const state = rasterState(layer);
  let statistics: Record<string, BandStats> | null = null;
  if (!state.rescale && typeof source.statistics === "function") {
    try {
      statistics = (await source.statistics()) as Record<string, BandStats>;
    } catch {
      // Without statistics the tiler falls back to its own default range.
    }
  }
  const render = cogRenderOptions(layer, statistics);
  const bounds = source.boundsLonLat;
  const rectangle =
    Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
      ? webMercatorRectangle(Cesium, bounds as [number, number, number, number])
      : undefined;
  const size = 256;
  return new ProtocolImageryProvider(Cesium, {
    // Never fetched — the loader below renders straight from the open source —
    // but it names the layer for diagnostics and for the rebuild check.
    template: `cog://${layer.id}/{z}/{x}/{y}`,
    rectangle,
    tileWidth: size,
    tileHeight: size,
    credit: typeof layer.source?.attribution === "string" ? layer.source.attribution : undefined,
    // The tiler decodes on the main thread; keep the globe from queueing a
    // whole screen of tiles at once.
    maxConcurrentRequests: 4,
    loadImage: async (tileUrl) => {
      const [z, x, y] = tileUrl
        .slice(tileUrl.indexOf("//") + 2)
        .split("/")
        .slice(1)
        .map(Number);
      const rgba = await source.renderTileRGBA(z, x, y, render);
      if (!rgba || rgba.length === 0) return null;
      return tileRenderer(rgba, size);
    },
  });
}
