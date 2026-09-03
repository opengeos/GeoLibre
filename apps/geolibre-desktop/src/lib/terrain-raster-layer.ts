import type { GeoLibreLayer } from "@geolibre/core";

import { rasterExportUrl } from "./raster-export";

export interface TerrainRasterLayerOption {
  id: string;
  name: string;
  source: string;
}

/**
 * Raster layers whose underlying GeoTIFF bytes can be reopened as a terrain
 * DEM. Tiled web services do not expose one source file and are excluded.
 */
export function terrainRasterLayerOptions(
  layers: readonly GeoLibreLayer[],
): TerrainRasterLayerOption[] {
  return layers.flatMap((layer) => {
    if (layer.type !== "cog" && layer.type !== "raster") return [];
    const source = rasterExportUrl(layer);
    return source ? [{ id: layer.id, name: layer.name, source }] : [];
  });
}
