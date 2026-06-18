import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import { createColormapTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import {
  type AutoStats,
  computeAutoStats,
  loadGeoTIFF,
} from "maplibre-gl-raster";
import {
  COLORMAP_TEXTURE_WIDTH,
  RASTER_MIN_CUSTOM_COLORS,
  type RasterBandStats,
  type RasterSymbology,
  buildContinuousColormapRgba,
  buildSteppedColormapRgba,
  savedRasterSymbology,
} from "./raster-symbology";
import {
  RASTER_SOURCE_KIND,
  isRasterControlStoreLayer,
  isRasterStoreSyncSuspended,
} from "./raster-layer-sync";
import { colormapColors, warmColormapColors } from "./colormap-colors";

// These types mirror undocumented private members of the maplibre-gl-raster
// LayerManager (verified against v0.5.0) and the deck.gl-raster Colormap
// module name (deck.gl-raster v0.7.0). Access is feature-detected and falls
// back to a no-op rather than throwing -- re-verify these names AND the
// "colormap" module name when bumping either dependency.
type GpuTexture = { destroy?: () => void };
type RenderPipelineModule = {
  module?: { name?: string };
  props?: Record<string, unknown>;
};
type RenderTileResult = { renderPipeline?: RenderPipelineModule[] } | null;
type RenderTileFn = (data: unknown) => RenderTileResult;
type RasterLayerLike = {
  id: string;
  state?: { mode?: string; colormap?: string };
};
type RasterLayerManager = {
  _device?: unknown;
  _colormapTexture?: unknown;
  _renderTileFor?: (layer: RasterLayerLike) => RenderTileFn;
  _rebuild?: () => void;
  _deps?: { geolibreClassifiedPatched?: boolean };
};
type ControlWithManager = {
  _layerManager?: RasterLayerManager;
  getRaster?: (id: string) => RasterInfoLike | undefined;
};
type RasterInfoLike = {
  source?:
    | { kind: "url"; url: string }
    | { kind: "file"; fileName: string; objectUrl: string };
};

type ClassificationEntry = {
  symbology: RasterSymbology;
  /** Whether the ramp is reversed (from `rasterState.reversed`); baked into
   * the injected texture. */
  reversed: boolean;
  /** Cache key for the built texture (breaks + ramp + customColors + reversed). */
  key: string;
  texture?: GpuTexture;
};

/** Whether a symbology carries a usable custom color ramp. */
function hasCustomColors(symbology: RasterSymbology): boolean {
  return (symbology.customColors?.length ?? 0) >= RASTER_MIN_CUSTOM_COLORS;
}

/**
 * Whether a single-band layer needs a GeoLibre-injected colormap texture: a
 * stepped lookup when classified, or a smooth gradient when a custom ramp is
 * applied to a continuous layer. A built-in continuous ramp renders through
 * the upstream sprite (including its native `reversed`), so it needs no texture.
 */
function needsTexture(symbology: RasterSymbology): boolean {
  return symbology.classified || hasCustomColors(symbology);
}

/** Reads `rasterState.reversed` from a store layer's metadata. */
function readRasterReversed(layer: GeoLibreLayer): boolean {
  const raw = layer.metadata.rasterState;
  return (
    !!raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).reversed === true
  );
}

// Per-layer classification state and built GPU textures. Module-global to
// match the single mounted raster control (see maplibre-raster.ts).
const entries = new Map<string, ClassificationEntry>();
// Keyed by layerId: computeAutoStats derives every band in one GeoTIFF pass,
// so caching the whole AutoStats lets band-picker switches hit the cache
// instead of re-scanning the file, and keeps the key aligned with the
// disposal key below (so eviction actually matches).
const statsCache = new Map<string, AutoStats>();
const statsInflight = new Map<string, AbortController>();
let storeUnsubscribe: (() => void) | null = null;

function symbologyKey(symbology: RasterSymbology, reversed: boolean): string {
  return JSON.stringify([
    symbology.breaks,
    symbology.ramp,
    symbology.customColors ?? null,
    reversed,
  ]);
}

/**
 * Installs the per-layer symbology injection on a raster control. Wraps the
 * LayerManager's `_renderTileFor` so a single-band layer renders through the
 * unchanged upstream pipeline (composite / nodata / rescale / stretch) but,
 * when classified or using a custom ramp, samples a GeoLibre-built colormap
 * texture instead of the shared named-colormap sprite (reversal baked in).
 * Built-in continuous ramps -- including their reversal via
 * `rasterState.reversed` -- render through the upstream control untouched.
 * Idempotent and feature-detected: if the private surface is missing it warns
 * once and leaves the control untouched.
 *
 * @param control - The mounted maplibre-gl-raster control.
 */
export function installRasterClassification(control: unknown): void {
  const manager = (control as ControlWithManager)._layerManager;
  if (
    !manager ||
    typeof manager._renderTileFor !== "function" ||
    typeof createColormapTexture !== "function"
  ) {
    console.warn(
      "[GeoLibre] Raster classification unavailable: maplibre-gl-raster internals not found (re-verify on dependency bump).",
    );
    return;
  }

  manager._deps ??= {};
  if (!manager._deps.geolibreClassifiedPatched) {
    const originalRenderTileFor = manager._renderTileFor.bind(manager);
    manager._renderTileFor = (layer: RasterLayerLike): RenderTileFn => {
      const renderTile = originalRenderTileFor(layer);
      const entry = entries.get(layer.id);
      // A texture is injected only for classified / custom ramps. A built-in
      // continuous ramp (including its reversal) renders through the upstream
      // sprite via rasterState.reversed, so it has no entry and passes through.
      if (
        layer.state?.mode !== "single" ||
        !entry ||
        !needsTexture(entry.symbology) ||
        !manager._device
      ) {
        return renderTile;
      }
      return (data: unknown): RenderTileResult => {
        const result = renderTile(data);
        const pipeline = result?.renderPipeline;
        if (!Array.isArray(pipeline)) return result;
        const texture = ensureTexture(manager, entry);
        if (!texture) return result;
        // Swap ONLY the trailing colormap module's texture; every other module
        // (composite, nodata, rescale, stretch, gamma) is reused as built
        // upstream, so nodata transparency and the rescale window behave
        // identically to the named-colormap path. Any reversal is already baked
        // into the injected texture, so the shader uniform must stay false or
        // the two cancel out.
        const patched = pipeline.map((mod) =>
          mod?.module?.name === "colormap"
            ? {
                ...mod,
                props: {
                  ...mod.props,
                  colormapTexture: texture,
                  colormapIndex: 0,
                  reversed: false,
                },
              }
            : mod,
        );
        return { ...result, renderPipeline: patched };
      };
    };
    manager._deps.geolibreClassifiedPatched = true;
  }

  subscribeToStore();
}

function ensureTexture(
  manager: RasterLayerManager,
  entry: ClassificationEntry,
): GpuTexture | null {
  const key = symbologyKey(entry.symbology, entry.reversed);
  if (entry.texture && entry.key === key) return entry.texture;
  entry.texture?.destroy?.();
  try {
    const { classified, breaks, ramp, customColors } = entry.symbology;
    const reversed = entry.reversed;
    // Classified ramps step through the class breaks; a custom continuous ramp
    // is a smooth gradient of the user's colors. (A built-in continuous ramp
    // never reaches here -- it has no texture.) For a named sprite colormap the
    // colors come from the warmed cache; until it resolves, colormapColors is
    // null and buildSteppedColormapRgba falls back (reconcile rebuilds on warm).
    const custom =
      customColors && customColors.length >= RASTER_MIN_CUSTOM_COLORS
        ? customColors
        : undefined;
    // The continuous branch only runs for a custom ramp (needsTexture), so
    // `custom` is set; the grayscale fallback just keeps the contract explicit
    // rather than producing a silent all-black gradient.
    const rgba = classified
      ? buildSteppedColormapRgba(
          breaks,
          ramp,
          reversed,
          custom ?? colormapColors(ramp) ?? undefined,
        )
      : buildContinuousColormapRgba(custom ?? ["#000000", "#ffffff"], reversed);
    // The DOM ImageData ctor types its buffer as ArrayBuffer (not the wider
    // ArrayBufferLike the Uint8ClampedArray generic carries); the runtime
    // buffer is a plain ArrayBuffer, so narrow it for the type checker.
    const imageData = new ImageData(
      rgba as Uint8ClampedArray<ArrayBuffer>,
      COLORMAP_TEXTURE_WIDTH,
      1,
    );
    entry.texture = createColormapTexture(
      manager._device as never,
      imageData,
    ) as GpuTexture;
    entry.key = key;
    return entry.texture;
  } catch (error) {
    console.error("[GeoLibre] Failed to build raster classification texture", error);
    entry.texture = undefined;
    return null;
  }
}

/**
 * Reconciles the classification registry with the current store layers and
 * triggers a re-render when a classified layer's symbology changes. Driven by
 * the store subscription so the UI only has to write `metadata.rasterSymbology`.
 *
 * @param control - The mounted raster control (for `_rebuild`).
 */
function reconcile(control: unknown): void {
  const manager = (control as ControlWithManager)._layerManager;
  if (!manager) return;

  const layers = useAppStore.getState().layers;
  const seen = new Set<string>();
  let changed = false;

  for (const layer of layers) {
    if (!isRasterControlStoreLayer(layer)) continue;
    seen.add(layer.id);
    const symbology = savedRasterSymbology(layer);
    const existing = entries.get(layer.id);

    // Track the layer only while it needs an injected texture (classified or a
    // custom ramp). A built-in continuous ramp -- reversed or not -- renders
    // through the upstream sprite, so drop any stale entry.
    if (!symbology || !needsTexture(symbology)) {
      if (existing) {
        existing.texture?.destroy?.();
        entries.delete(layer.id);
        changed = true;
      }
      continue;
    }

    // Reverse lives on rasterState (the control renders it for built-in ramps;
    // the injected texture bakes it here for classified / custom).
    const reversed = readRasterReversed(layer);
    const key = symbologyKey(symbology, reversed);
    if (!existing) {
      entries.set(layer.id, { symbology, reversed, key });
      changed = true;
    } else if (existing.key !== key) {
      existing.symbology = symbology;
      existing.reversed = reversed;
      // Texture rebuilt lazily on next render via ensureTexture's key check.
      changed = true;
    }

    // A classified sprite colormap (named, not a built-in ramp, no custom
    // colors) needs its colors sampled from the renderer's sprite. Warm the
    // cache and, once the colors arrive, drop the stale fallback texture and
    // re-render. symbologyKey can't see the async colors, so invalidate here.
    if (
      symbology.classified &&
      !hasCustomColors(symbology) &&
      colormapColors(symbology.ramp) === null
    ) {
      const id = layer.id;
      const ramp = symbology.ramp;
      void warmColormapColors(ramp).then((colors) => {
        if (!colors) return;
        const current = entries.get(id);
        if (!current || current.symbology.ramp !== ramp) return;
        current.texture?.destroy?.();
        current.texture = undefined;
        manager._rebuild?.();
      });
    }
  }

  // Drop entries for rasters that left the store.
  for (const id of [...entries.keys()]) {
    if (!seen.has(id)) {
      entries.get(id)?.texture?.destroy?.();
      entries.delete(id);
      changed = true;
    }
  }

  if (changed) manager._rebuild?.();
}

function subscribeToStore(): void {
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers === previous.layers) return;
    // Skip the control->store echo: when the control rewrites a store layer
    // from its own state (e.g. after setRasterState), symbology is unchanged,
    // so reconciling again is wasted work.
    if (isRasterStoreSyncSuspended()) return;
    // Cheap guard: only reconcile when a control-managed raster is present.
    if (
      !state.layers.some(isRasterControlStoreLayer) &&
      !previous.layers.some(isRasterControlStoreLayer)
    ) {
      return;
    }
    reconcile(currentControl);
  });
}

// The single mounted control, set by installRasterClassification's caller.
let currentControl: unknown = null;

/**
 * Points the classification manager at the active control and performs an
 * initial reconcile. Call after the control mounts (and on project restore).
 *
 * @param control - The mounted raster control.
 */
export function activateRasterClassification(control: unknown): void {
  currentControl = control;
  installRasterClassification(control);
  reconcile(control);
}

/**
 * Disposes a single layer's classification texture (on raster removal).
 *
 * @param layerId - The layer id.
 */
export function disposeRasterClassification(layerId: string): void {
  const entry = entries.get(layerId);
  entry?.texture?.destroy?.();
  entries.delete(layerId);
  statsCache.delete(layerId);
  statsInflight.get(layerId)?.abort();
  statsInflight.delete(layerId);
}

/**
 * Disposes all classification textures and detaches the store subscription
 * (on control teardown).
 */
export function disposeAllRasterClassification(): void {
  for (const entry of entries.values()) entry.texture?.destroy?.();
  entries.clear();
  for (const controller of statsInflight.values()) controller.abort();
  statsInflight.clear();
  statsCache.clear();
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  currentControl = null;
}

function sourceUrl(info: RasterInfoLike | undefined): string | null {
  const source = info?.source;
  if (!source) return null;
  if (source.kind === "url") return source.url;
  if (source.kind === "file") return source.objectUrl;
  return null;
}

function bandStatsFromAuto(stats: AutoStats, band: number): RasterBandStats | null {
  // Only fall back to the averaged global block when per-band stats are
  // unavailable entirely; if the per-band map exists but lacks this band,
  // the global average would be wrong for it, so report unknown instead.
  const perBand = stats.perBand
    ? (stats.perBand.get(band) ?? null)
    : stats.global;
  if (!perBand) return null;
  return {
    min: perBand.min,
    max: perBand.max,
    histogram: [...perBand.histogram],
  };
}

/**
 * Fetches (and caches) a band's min/max/histogram for classification breaks,
 * reading the GeoTIFF via the same loader the control uses. Aborts any prior
 * in-flight request for the layer. File-backed rasters use the session blob
 * URL and are unavailable after a project reload (no URL persisted).
 *
 * @param control - The mounted raster control.
 * @param layerId - The layer id.
 * @param band - The 1-indexed band to summarize.
 * @returns The band statistics, or null when the source is unavailable.
 */
export async function getRasterBandStats(
  layerId: string,
  band: number,
): Promise<RasterBandStats | null> {
  const cached = statsCache.get(layerId);
  if (cached) return bandStatsFromAuto(cached, band);

  const info = (currentControl as ControlWithManager | null)?.getRaster?.(
    layerId,
  );
  const url = sourceUrl(info);
  if (!url) return null;

  statsInflight.get(layerId)?.abort();
  const controller = new AbortController();
  statsInflight.set(layerId, controller);
  try {
    const tiff = await loadGeoTIFF(url);
    const auto = await computeAutoStats(tiff, controller.signal);
    statsCache.set(layerId, auto);
    return bandStatsFromAuto(auto, band);
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn(
        `[GeoLibre] Failed to compute raster statistics for layer "${layerId}"`,
        error,
      );
    }
    return null;
  } finally {
    if (statsInflight.get(layerId) === controller) {
      statsInflight.delete(layerId);
    }
  }
}

export { RASTER_SOURCE_KIND };
