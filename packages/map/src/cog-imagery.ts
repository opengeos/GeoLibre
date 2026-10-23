import type { GeoLibreLayer } from "@geolibre/core";
import type { CogSource, RenderOptions } from "cog-tiler-wasm";

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
  nodata?: number | "auto" | "off" | null;
  stretch?: "linear" | "sqrt" | "log";
  gamma?: number;
}

/** Per-band statistics as `CogSource.statistics()` reports them. */
export type BandStats = {
  min?: number;
  max?: number;
  percentile_2?: number;
  percentile_98?: number;
};

export function rasterState(layer: GeoLibreLayer): PersistedRasterState {
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
  // The tiler resolves an omitted `nodata` to the source's own declared value
  // (`opts.nodata != null ? opts.nodata : this.nodata`), which is exactly what
  // "auto" means, so "auto" is the omitted case. "off" has to be said out loud:
  // omitting it would mask on the source's nodata, the opposite of what the
  // control shows in 2D. NaN is the tiler's own "no nodata" sentinel -- it
  // gates masking on `!Number.isNaN(nodata)`.
  if (typeof state.nodata === "number") options.nodata = state.nodata;
  else if (state.nodata === "off") options.nodata = Number.NaN;
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

/**
 * What `styleSignature`-style change detection compares for a COG layer.
 *
 * The resolved band list is carried alongside the raw state because it is not
 * a function of the state alone: an RGB state whose `bands` array is short (a
 * hand-authored project, an older save) composites `[1, 2, 3]` or a single
 * band depending on `metadata.bandCount`, which is null until the GeoTIFF
 * header loads and resolves in place afterwards. Without it a layer built
 * during that window would keep the single-band fallback on the globe while
 * the 2D map moved on to the composite, with nothing in the signature to say
 * so.
 */
export function cogRenderSignature(layer: GeoLibreLayer): string {
  const state = rasterState(layer);
  const bandCount = layer.metadata?.bandCount;
  return JSON.stringify([
    cogSourceUrl(layer),
    state,
    cogRenderBands(state, typeof bandCount === "number" ? bandCount : null),
  ]);
}
