import type { GeoLibreLayer } from "@geolibre/core";
import {
  cogSourceUrl,
  cogRenderOptions,
  rasterState,
  type BandStats,
  type CogTilerModule,
} from "./cog-imagery";
export {
  cachingCogTiler,
  cogRenderBands,
  autoRange,
  cogRenderOptions,
  cogSourceUrl,
  cogRenderSignature,
  type CogTilerModule,
} from "./cog-imagery";
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
    loadImage: async (tileUrl, signal) => {
      // The last three segments are z/x/y whatever the layer id contains.
      const [z, x, y] = tileUrl.split("/").slice(-3).map(Number);
      // The WASM render cannot be interrupted once started (cog-tiler-wasm
      // 0.3.5 takes no signal), so a tile the provider has already abandoned
      // is skipped before the render rather than rendered and discarded.
      if (signal?.aborted) return null;
      const rgba = await source.renderTileRGBA(z, x, y, render);
      if (signal?.aborted || !rgba || rgba.length === 0) return null;
      return tileRenderer(rgba, size);
    },
  });
}
