import type { GeoLibreLayer } from "@geolibre/core";

import { normalizeSubdomains, rasterSubsetKind, type RasterSubsetKind } from "./raster-subset-kind";
import { fetchableUrl } from "./url-utils";

/**
 * The GeoLibre-authored subset extractors whose `url` parameter can be filled
 * from a compatible raster layer already loaded in the map (GeoLibre#1271).
 * Each tool maps to the raster family whose layers can supply its `url`: the COG
 * extractor reads an HTTP COG by byte range, the WMS extractor calls an endpoint,
 * and the XYZ extractor walks a tile template. Matching by kind keeps a picked
 * layer from populating the wrong tool (e.g. an XYZ template into the COG url).
 */
const SUBSET_URL_TOOL_KIND: Record<string, RasterSubsetKind> = {
  extract_cog_subset: "cog",
  extract_wms_subset: "wms",
  extract_xyz_tile_subset: "xyz",
};

/**
 * The raster family whose loaded layers can populate the given subset tool's
 * `url` field, or `null` when the tool is not a url-populatable subset extractor.
 *
 * @param toolId - The Whitebox/GeoLibre tool id.
 * @returns The matching {@link RasterSubsetKind}, or `null`.
 */
export function subsetUrlToolKind(toolId: string): RasterSubsetKind | null {
  return SUBSET_URL_TOOL_KIND[toolId] ?? null;
}

/**
 * An HTTP(S) url usable as a subset extractor's `url` string, or `null`. A blob
 * url (a File-loaded raster's retained bytes) is rejected: the `url` code path
 * does byte-range reads a blob url cannot serve, and such a layer is better used
 * through the tool's `input` field, which reads its bytes directly.
 *
 * @param value - A candidate url value of unknown shape.
 * @returns The http(s) url, or `null`.
 */
function httpUrl(value: unknown): string | null {
  const url = fetchableUrl(value);
  return url && /^https?:/i.test(url) ? url : null;
}

/**
 * Loaded layers that can populate the given subset tool's `url` field, matched
 * by raster family. A layer qualifies only when {@link subsetUrlFieldValues}
 * can actually derive field values for it, so the "From layer" list and the
 * click handler share one source of truth: a layer never appears in the list
 * yet silently no-op when picked. The family gate (`rasterSubsetKind`) also
 * keeps, say, a plain remote raster tile layer out of the COG tool.
 *
 * @param toolId - The subset tool id.
 * @param layers - The store's current layers.
 * @returns The subset of `layers` that can fill this tool's `url` field.
 */
export function layersForSubsetUrl(toolId: string, layers: GeoLibreLayer[]): GeoLibreLayer[] {
  const kind = subsetUrlToolKind(toolId);
  if (!kind) return [];
  return layers.filter(
    (layer) => rasterSubsetKind(layer) === kind && subsetUrlFieldValues(toolId, layer) !== null,
  );
}

/**
 * Derive the field values that populating the given subset tool's inputs from a
 * layer should set. Beyond the `url` itself this fills the companion fields the
 * extractor needs to run against that source: the WMS `layers` (and `styles`
 * when present), and the XYZ `tile_size`/`subdomains`. The extractors' own
 * defaults (WMS version 1.1.1, GeoTIFF format) are left untouched, matching the
 * layer-context-menu "Extract subset" path. Values are strings, matching the
 * dialog's convention that every parameter value is stored as a string.
 *
 * @param toolId - The subset tool id.
 * @param layer - The layer to populate from.
 * @returns A parameter-name to value map, or `null` when the layer can't supply
 *   a usable url for this tool.
 */
export function subsetUrlFieldValues(
  toolId: string,
  layer: GeoLibreLayer,
): Record<string, string> | null {
  const kind = subsetUrlToolKind(toolId);
  const source = layer.source as Record<string, unknown>;
  if (kind === "cog") {
    const url = httpUrl(source.url);
    return url ? { url } : null;
  }
  if (kind === "wms") {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const layers = typeof source.layers === "string" ? source.layers.trim() : "";
    if (!url || !layers) return null;
    const values: Record<string, string> = { url, layers };
    if (typeof source.styles === "string" && source.styles.trim()) {
      values.styles = source.styles.trim();
    }
    return values;
  }
  if (kind === "xyz") {
    const tiles = Array.isArray(source.tiles) ? source.tiles : [];
    const template = typeof tiles[0] === "string" ? tiles[0] : "";
    if (!template) return null;
    const values: Record<string, string> = { url: template };
    if (typeof source.tileSize === "number") {
      values.tile_size = String(source.tileSize);
    }
    const subdomains = normalizeSubdomains(source.subdomains);
    if (subdomains) values.subdomains = subdomains;
    return values;
  }
  return null;
}
