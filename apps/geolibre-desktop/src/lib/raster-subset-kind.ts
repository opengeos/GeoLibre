import type { GeoLibreLayer } from "@geolibre/core";

import { fetchableUrl } from "./url-utils";

/**
 * Pure (browser/Node-safe) classification helpers for the raster subset
 * extractors. Kept separate from `raster-subset-export.ts` so they can be
 * imported without pulling in that module's heavy, browser-only dependencies
 * (the WASM extractors and the Tauri save path).
 */

/** Raster layer families that support in-browser bounding-box subset export. */
export type RasterSubsetKind = "cog" | "wms" | "xyz";

/**
 * The subset-extraction family a layer belongs to, or `null` when the layer's
 * type or source can't be extracted. A COG needs a fetchable file (an HTTP COG
 * or a File-loaded one); a WMS needs its endpoint and layer names; an XYZ needs
 * a tile-URL template.
 *
 * @param layer - The store layer to classify.
 * @returns The subset kind, or `null` if the layer can't be subset-extracted.
 */
export function rasterSubsetKind(layer: GeoLibreLayer): RasterSubsetKind | null {
  const source = layer.source as Record<string, unknown>;
  if (layer.type === "cog") {
    const url = fetchableUrl(layer.metadata.localBytesUrl) ?? fetchableUrl(source.url);
    return url ? "cog" : null;
  }
  if (layer.type === "wms") {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const layers = typeof source.layers === "string" ? source.layers.trim() : "";
    return url && layers ? "wms" : null;
  }
  if (layer.type === "xyz") {
    const tiles = Array.isArray(source.tiles) ? source.tiles : [];
    const template = typeof tiles[0] === "string" ? tiles[0] : "";
    return template ? "xyz" : null;
  }
  return null;
}

/** Whether a layer can be exported as a bounding-box raster subset. */
export function canExtractRasterSubset(layer: GeoLibreLayer): boolean {
  return rasterSubsetKind(layer) !== null;
}

/**
 * Coerce a tile source's `subdomains` into the string of letters the WASM XYZ
 * extractor expects (it rotates `{s}` by indexing into the string per tile). A
 * plain string is passed through; a MapLibre/Leaflet-style `string[]` of single
 * letters (as offline-tiles.ts models it) is joined so the rotation is
 * preserved. Anything else yields `undefined` (no `{s}` rotation).
 *
 * @param value - The source's `subdomains` field, of unknown shape.
 * @returns The subdomain letters as a string, or `undefined`.
 */
export function normalizeSubdomains(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    // Only single-letter entries map onto the extractor's per-letter string
    // form. Concatenating multi-character subdomains (e.g. ["mt0","mt1"]) would
    // produce a garbage rotation string, so in that case drop rotation instead.
    const letters = value.filter((v): v is string => typeof v === "string" && v.length === 1);
    return letters.length > 0 && letters.length === value.length ? letters.join("") : undefined;
  }
  return undefined;
}
