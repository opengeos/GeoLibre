import { DEFAULT_LAYER_STYLE, useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../types";
import type { addRasterToMap, LocalRasterFileReader } from "./maplibre-raster";
import { RASTER_SOURCE_KIND } from "./raster-layer-sync";

/** Keep a browser file readable until its store layer is removed or replaced. */
function retainFile(id: string, url: string): void {
  const unsubscribe = useAppStore.subscribe((state) => {
    const layer = state.layers.find((entry) => entry.id === id);
    if (layer?.metadata.localBytesUrl === url || layer?.source.url === url) return;
    unsubscribe();
    URL.revokeObjectURL(url);
  });
}

/** Import through the store; the ArcGIS engine owns the native tile layer. */
export async function addArcgisRaster(
  app: GeoLibreAppAPI,
  source: string | File,
  options: Parameters<typeof addRasterToMap>[2] = {},
): Promise<string> {
  const { openCog } = await import("cog-tiler-wasm");
  const cog = await openCog(source);
  const bandCount = cog.levels[0]?.bands ?? 1;
  const id = crypto.randomUUID();
  const file = typeof source !== "string";
  const local = file || !!options.localPath;
  const url = file ? URL.createObjectURL(source) : source;
  const state = {
    mode: bandCount >= 3 ? "rgb" : "single",
    bands: bandCount >= 3 ? (options.defaults?.rgbBands ?? [1, 2, 3]) : [1],
    colormap: cog.hasPalette ? "palette" : (options.defaults?.colormap ?? "viridis"),
    ...options.state,
  };
  useAppStore.getState().addLayer(
    {
      id,
      name: options.name || (file ? source.name : source.split("/").pop()?.split("?")[0]) || "COG",
      type: "cog",
      source: { type: "raster", ...(!local ? { url } : {}) },
      sourcePath: file ? source.name : (options.localPath ?? source),
      visible: options.state?.visible ?? true,
      opacity: options.state?.opacity ?? 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        sourceKind: RASTER_SOURCE_KIND,
        externalNativeLayer: true,
        customLayerType: "raster",
        rasterSource: local ? "file" : "url",
        rasterState: state,
        bandCount,
        bounds: cog.boundsLonLat,
        ...(local ? { localBytesUrl: url } : {}),
        ...(options.localPath ? { localFilePath: options.localPath } : {}),
      },
    },
    options.beforeId,
  );
  if (file) retainFile(id, url);
  if (options.zoomTo !== false && cog.boundsLonLat.length === 4)
    app.fitBounds?.(cog.boundsLonLat as [number, number, number, number]);
  return id;
}

/** Restore desktop file references without mounting the MapLibre raster control. */
export async function restoreArcgisRasterFiles(
  reader: LocalRasterFileReader | null,
): Promise<void> {
  if (!reader) return;
  for (const layer of useAppStore.getState().layers) {
    const path = layer.metadata.localFilePath;
    if (
      layer.type !== "cog" ||
      layer.source.url ||
      layer.metadata.localBytesUrl ||
      typeof path !== "string"
    )
      continue;
    try {
      const source = await reader(path);
      if (useAppStore.getState().layers.find((current) => current.id === layer.id) !== layer)
        continue;
      const url = typeof source === "string" ? source : URL.createObjectURL(source);
      useAppStore.getState().updateLayer(layer.id, {
        metadata: { ...layer.metadata, localBytesUrl: url },
      });
      if (typeof source !== "string") retainFile(layer.id, url);
    } catch (error) {
      console.warn(`[GeoLibre] Could not reopen raster ${layer.name}`, error);
    }
  }
}
