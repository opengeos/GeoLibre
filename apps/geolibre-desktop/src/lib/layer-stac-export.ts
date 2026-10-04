import {
  buildLayerStacItem,
  redactUrlCredentials,
  type GeoLibreLayer,
  type StacItem,
} from "@geolibre/core";
import { getLayerBounds } from "@geolibre/map/headless";
import type { Map as MapLibreMap } from "maplibre-gl";
import { saveTextFileWithFallback } from "./tauri-io";
import { resolveLayerGeojson, sanitizeExportFileName } from "./vector-export";

/** URL schemes a STAC asset href may point at: fetchable remote data only. */
const ASSET_PROTOCOLS = new Set(["http:", "https:", "s3:", "gs:"]);

/**
 * A remote, credential-free URL of a layer's data, for the STAC Item's `data`
 * asset. Local file paths are left out: they mean nothing on another machine
 * and would leak the author's directory layout.
 *
 * @param layer - The layer being described.
 * @returns The URL, or `null` when the layer has no remote source.
 */
export function layerStacAssetHref(layer: GeoLibreLayer): string | null {
  const tiles = Array.isArray(layer.source.tiles) ? layer.source.tiles[0] : undefined;
  const candidates: unknown[] = [
    layer.source.url,
    layer.metadata.originalUrl,
    layer.metadata.sourceUrl,
    typeof layer.source.data === "string" ? layer.source.data : undefined,
    layer.sourcePath,
    tiles,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const value = candidate.trim();
    try {
      if (!ASSET_PROTOCOLS.has(new URL(value).protocol)) continue;
    } catch {
      continue;
    }
    return redactUrlCredentials(value);
  }
  return null;
}

/**
 * A layer's WGS84 extent: the store's features or recorded bounds, else the
 * features an Add Vector Layer layer keeps in its map source.
 *
 * @param layer - The layer being described.
 * @param map - The live map, to read source-backed features from.
 * @returns `[west, south, east, north]`, or `null` when unknown.
 */
export async function layerStacBbox(
  layer: GeoLibreLayer,
  map: MapLibreMap | undefined,
): Promise<[number, number, number, number] | null> {
  const bounds = getLayerBounds(layer);
  if (bounds) return bounds;
  if (layer.geojson) return null;
  try {
    const geojson = await resolveLayerGeojson(layer, map);
    return geojson ? getLayerBounds({ ...layer, geojson }) : null;
  } catch {
    return null;
  }
}

/**
 * Build a layer's STAC Item with its extent and data URL filled in.
 *
 * @param layer - The layer being described.
 * @param map - The live map, to read source-backed features from.
 * @returns The STAC Item.
 */
export async function buildLayerStacItemForExport(
  layer: GeoLibreLayer,
  map: MapLibreMap | undefined,
): Promise<StacItem> {
  return buildLayerStacItem(layer, {
    bbox: await layerStacBbox(layer, map),
    assetHref: layerStacAssetHref(layer),
  });
}

/**
 * Save a layer's STAC Item as JSON through the native or browser save dialog.
 *
 * @param layer - The layer being described.
 * @param map - The live map, to read source-backed features from.
 * @returns The saved path (a file name in the browser), or `null` when cancelled.
 */
export async function exportLayerStacItem(
  layer: GeoLibreLayer,
  map: MapLibreMap | undefined,
): Promise<string | null> {
  const item = await buildLayerStacItemForExport(layer, map);
  return saveTextFileWithFallback(`${JSON.stringify(item, null, 2)}\n`, {
    defaultName: `${sanitizeExportFileName(layer.name)}.stac-item.json`,
    filters: [{ name: "STAC Item", extensions: ["json"] }],
    browserTypes: [{ description: "STAC Item", accept: { "application/geo+json": [".json"] } }],
    mimeType: "application/geo+json",
  });
}
