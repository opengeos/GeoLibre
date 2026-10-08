import type { GeoLibreLayer } from "@geolibre/core";
import { splitImageBands, type ObiaImage } from "@geolibre/processing";
import { fetchLayerBytes } from "../whitebox-layer-inputs";

// The last image read, so listing bands, segmenting and measuring the same
// layer fetch its bytes once. One entry: the workbench works on one image.
let cached: { layerId: string; bytes: Uint8Array } | null = null;

/**
 * GeoTIFF bytes of a workbench source layer, cached for the last layer read.
 *
 * @param layer A raster/COG layer.
 * @returns The bytes, or null when the layer's data is not fetchable in the
 *   browser.
 */
export async function obiaSourceBytes(layer: GeoLibreLayer): Promise<Uint8Array | null> {
  if (cached?.layerId === layer.id) return cached.bytes;
  const bytes = await fetchLayerBytes(layer);
  if (bytes) cached = { layerId: layer.id, bytes };
  return bytes;
}

/**
 * The source layer's bands as single-band GeoTIFFs, in the given order.
 *
 * @param layer A raster/COG layer.
 * @param bandIndexes 1-based source bands.
 */
export async function obiaSourceBands(
  layer: GeoLibreLayer,
  bandIndexes: readonly number[],
): Promise<ObiaImage | null> {
  const bytes = await obiaSourceBytes(layer);
  return bytes ? splitImageBands(bytes, bandIndexes) : null;
}
