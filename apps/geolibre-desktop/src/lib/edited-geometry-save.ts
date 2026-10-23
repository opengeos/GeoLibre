import { redactUrlCredentials } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";

/** Layers with committed geometry edits that need an explicit embedding choice. */
export function hasEditedGeometry(layer: GeoLibreLayer): boolean {
  return layer.metadata.geometryEdited === true && layer.geojson !== undefined;
}

/** Make the edited features authoritative in a saved project snapshot. */
export function embedEditedGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (!hasEditedGeometry(layer)) return layer;
  const { url: _url, ...source } = layer.source;
  const {
    originalUrl: _originalUrl,
    localFileReloadable: _reload,
    geometryEdited: _edited,
    ...metadata
  } = layer.metadata;
  return {
    ...layer,
    source,
    metadata:
      layer.metadata.sourceKind === "maplibre-gl-vector"
        ? { ...metadata, embeddedGeoJSON: layer.geojson }
        : metadata,
  };
}
function hasRestorableWfsUrl(layer: GeoLibreLayer): boolean {
  // Only the layer's own request URL counts: WFS hydration needs an HTTP(S)
  // `source.url`, so a stray `metadata.originalUrl` (a tile-layer field) must
  // not let a no-embed save drop features nothing can re-fetch.
  const value = layer.source.url;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      redactUrlCredentials(value) === value
    );
  } catch {
    return false;
  }
}

/** Honor an explicit no-embed choice for edited WFS layers with a reload URL. */
export function discardEditedWfsGeometry(layer: GeoLibreLayer): GeoLibreLayer {
  if (
    !hasEditedGeometry(layer) ||
    layer.metadata.sourceKind !== "wfs-getfeature" ||
    !hasRestorableWfsUrl(layer)
  ) {
    return layer;
  }
  const { geojson: _geojson, ...rest } = layer;
  const { geometryEdited: _edited, ...metadata } = layer.metadata;
  return { ...rest, metadata };
}
