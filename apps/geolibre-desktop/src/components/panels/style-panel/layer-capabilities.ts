import type { GeoLibreLayer, LayerType } from "@geolibre/core";

export function isRasterPaintLayer(type: LayerType): boolean {
  return type === "raster" || type === "wms" || type === "wmts" || type === "xyz";
}

export function hasExternalNativeLayers(layer: { metadata: Record<string, unknown> }) {
  return Array.isArray(layer.metadata.nativeLayerIds) && layer.metadata.nativeLayerIds.length > 0;
}

export function hasExternalDeckLayer(layer: { metadata: Record<string, unknown> }) {
  return layer.metadata.externalDeckLayer === true;
}

export function hasTextMarkerFeatures(layer: {
  geojson?: {
    features?: Array<{
      geometry?: { type?: string } | null;
      properties?: Record<string, unknown> | null;
    }>;
  };
}): boolean {
  return (layer.geojson?.features ?? []).some((feature) => {
    const geometryType = feature.geometry?.type;
    if (geometryType !== "Point" && geometryType !== "MultiPoint") {
      return false;
    }
    const properties = feature.properties;
    return properties?.__gm_shape === "text_marker" || properties?.shape === "text_marker";
  });
}

export function supportsExtrusionControls(layer: {
  type: LayerType;
  source: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): boolean {
  if (layer.type === "geojson" || layer.type === "vector-tiles" || layer.type === "mbtiles") {
    return true;
  }

  if (layer.type === "pmtiles") {
    return layer.metadata.tileType === "vector" || layer.source.type === "vector";
  }

  if (layer.type === "flatgeobuf") {
    return hasPolygonGeometryMetadata(layer.metadata.geometryTypes);
  }

  if (layer.type === "arcgis") {
    return true;
  }

  if (hasExternalDeckLayer(layer)) {
    return true;
  }

  return (
    hasExternalNativeLayers(layer) &&
    layer.metadata.tileType !== "raster" &&
    layer.source.type !== "raster"
  );
}

function hasPolygonGeometryMetadata(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some(
    (geometryType) =>
      typeof geometryType === "string" && geometryType.toLowerCase().includes("polygon"),
  );
}

/**
 * True when a GeoJSON layer contains only point geometry, so the heatmap and
 * cluster renderers (which only make sense for points) can be offered.
 */
export function isPointOnlyGeoJsonLayer(layer: {
  type: LayerType;
  geojson?: { features?: Array<{ geometry?: { type?: string } | null }> };
}): boolean {
  if (layer.type !== "geojson") return false;
  const features = layer.geojson?.features ?? [];
  if (features.length === 0) return false;
  return features.every((feature) => {
    const type = feature.geometry?.type;
    return type === "Point" || type === "MultiPoint";
  });
}

/**
 * True when the heatmap and cluster renderers apply to a layer: a point-only
 * core GeoJSON layer, or a point layer painted by the maplibre-gl-vector
 * control. Shared by the panel's own gating and the style-suggestion memo, so
 * the two cannot disagree about where a heatmap is offerable.
 *
 * @param pointOnly - Result of {@link isPointOnlyGeoJsonLayer}, passed in so
 *   the caller can reuse its memoized value instead of re-scanning features.
 */
export function supportsPointRendererFor(layer: GeoLibreLayer, pointOnly: boolean): boolean {
  if (hasExternalDeckLayer(layer)) return false;
  if (!hasExternalNativeLayers(layer)) return pointOnly;
  return (
    layer.type === "geojson" &&
    layer.metadata.sourceKind === "maplibre-gl-vector" &&
    layer.metadata.geometryType === "point"
  );
}

export interface GeometryFlags {
  hasPoint: boolean;
  hasLine: boolean;
  hasPolygon: boolean;
}

// Sample the layer's geometry so the proportional-size, fill-pattern, and marker
// sections only appear where they apply. When the layer has no in-memory GeoJSON
// (tile/external layers whose geometry is unknown here) every flag is true so the
// controls stay available rather than being hidden incorrectly.
export function getGeometryFlags(layer: {
  geojson?: { features?: Array<{ geometry?: { type?: string } | null }> };
}): GeometryFlags {
  const features = layer.geojson?.features;
  if (!features || features.length === 0) {
    return { hasPoint: true, hasLine: true, hasPolygon: true };
  }
  const flags: GeometryFlags = {
    hasPoint: false,
    hasLine: false,
    hasPolygon: false,
  };
  const limit = Math.min(features.length, 2000);
  for (let index = 0; index < limit; index += 1) {
    const type = features[index]?.geometry?.type;
    if (type === "Point" || type === "MultiPoint") flags.hasPoint = true;
    else if (type === "LineString" || type === "MultiLineString") flags.hasLine = true;
    else if (type === "Polygon" || type === "MultiPolygon") flags.hasPolygon = true;
    if (flags.hasPoint && flags.hasLine && flags.hasPolygon) break;
  }
  return flags;
}
