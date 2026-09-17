import type { GeoLibreLayer } from "@geolibre/core";
import { cogRenderOptions, cogSourceUrl, rasterState, type CogTilerModule } from "./cog-imagery";
import type { ArcgisRasterLayer, ArcgisSdk } from "./arcgis-sdk";
import type { CogSource } from "cog-tiler-wasm";

// A style rebuild reuses the source; weak keys release statistics when its reader is forgotten.
const sourceStatistics = new WeakMap<CogSource, ReturnType<CogSource["statistics"]>>();

/** Open the existing COG tiler lazily, without importing the ArcGIS npm package. */
export async function loadCogTiler(): Promise<CogTilerModule> {
  const module = await import("cog-tiler-wasm");
  const { default: wasmUrl } = await import("lerc/lerc-wasm.wasm?url");
  module.configureLercDecoder({ wasmUrl });
  return module;
}

/** A native SDK tile layer sharing the raster control's persisted band/stretch settings. */
export function createArcgisCogLayer(
  sdk: ArcgisSdk,
  layer: GeoLibreLayer,
  properties: Record<string, unknown>,
  loadTiler: () => Promise<CogTilerModule> = loadCogTiler,
): ArcgisRasterLayer {
  const url = cogSourceUrl(layer);
  if (!url) throw new Error("The COG layer has no readable source");
  // Start on SDK load, not construction, so unused layers do not fetch data.
  let ready:
    | Promise<{
        source: Awaited<ReturnType<CogTilerModule["openCog"]>>;
        render: ReturnType<typeof cogRenderOptions>;
      }>
    | undefined;
  const prepare = () =>
    (ready ??= (async () => {
      const source = await (await loadTiler()).openCog(url);
      let statistics = null;
      if (!rasterState(layer).rescale) {
        let pending = sourceStatistics.get(source);
        if (!pending) {
          pending = source.statistics();
          sourceStatistics.set(source, pending);
          void pending.catch(() => sourceStatistics.delete(source));
        }
        statistics = await pending.catch(() => null);
      }
      return { source, render: cogRenderOptions(layer, statistics) };
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    }));
  const CustomLayer = sdk.layers.BaseTileLayer.createSubclass({
    load(this: ArcgisRasterLayer) {
      this.addResolvingPromise(
        prepare().then(({ source }) => {
          if (this.destroyed) return;
          const bounds = source.boundsLonLat;
          if (bounds?.length === 4 && bounds.every(Number.isFinite)) {
            this.fullExtent = sdk.webMercatorUtils.geographicToWebMercator(
              new sdk.Extent({
                xmin: bounds[0],
                ymin: bounds[1],
                xmax: bounds[2],
                ymax: bounds[3],
                spatialReference: { wkid: 4326 },
              }),
            );
          }
        }),
      );
    },
    async fetchTile(
      this: ArcgisRasterLayer,
      level: number,
      row: number,
      column: number,
      options?: { signal?: AbortSignal },
    ) {
      options?.signal?.throwIfAborted();
      const { source, render } = await prepare();
      options?.signal?.throwIfAborted();
      if (this.destroyed) throw new DOMException("Layer removed", "AbortError");
      const rgba = await source.renderTileRGBA(level, column, row, render);
      options?.signal?.throwIfAborted();
      if (this.destroyed) throw new DOMException("Layer removed", "AbortError");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      if (rgba?.length) {
        // Copy WASM memory before another render can reuse its backing buffer.
        canvas
          .getContext("2d")!
          .putImageData(new ImageData(new Uint8ClampedArray(rgba), 256, 256), 0, 0);
      }
      return canvas;
    },
  });
  const bounds = layer.metadata.bounds;
  const fullExtent =
    Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
      ? sdk.webMercatorUtils.geographicToWebMercator(
          new sdk.Extent({
            xmin: bounds[0],
            ymin: bounds[1],
            xmax: bounds[2],
            ymax: bounds[3],
            spatialReference: { wkid: 4326 },
          }),
        )
      : undefined;
  return new CustomLayer({ ...properties, ...(fullExtent ? { fullExtent } : {}) });
}
