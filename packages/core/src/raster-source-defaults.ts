import type { GeoLibreLayer } from "./types";

/**
 * Older projects and manually added Wayback templates may omit the native
 * zoom limit. Cap their requests at level 19 so renderers overzoom available
 * imagery instead of requesting missing higher-level tiles (issue #3116).
 * Explicit numeric limits remain authoritative, including lower regional limits.
 * Renderers ignore string limits, so only numeric minzoom can constrain this default.
 */
export function withRasterSourceDefaults(layer: GeoLibreLayer): GeoLibreLayer {
  if (
    !["raster", "xyz", "wmts"].includes(layer.type) ||
    !layer.source ||
    (typeof layer.source.maxzoom === "number" && Number.isFinite(layer.source.maxzoom)) ||
    (typeof layer.source.minzoom === "number" && layer.source.minzoom > 19)
  ) {
    return layer;
  }
  const tiles =
    Array.isArray(layer.source.tiles) && layer.source.tiles.length
      ? layer.source.tiles
      : [layer.source.url];
  if (!tiles.every(isWaybackTileUrl)) return layer;
  return { ...layer, source: { ...layer.source, maxzoom: 19 } };
}

function isWaybackTileUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      /^wayback(?:-[a-z])?\.maptiles\.arcgis\.com$/i.test(url.hostname) &&
      /^\/arcgis\/rest\/services\/World_Imagery\/(?:WMTS\/1\.0\.0\/[^/]+\/)?MapServer\/tile\/\d+\//i.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
