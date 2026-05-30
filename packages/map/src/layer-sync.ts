import type { GeoLibreLayer } from "@geolibre/core";
import type maplibregl from "maplibre-gl";
import {
  circleLayerId,
  detectGeometryProfile,
  fillLayerId,
  lineLayerId,
  sourceId,
} from "./geojson-loader";
import { isPlaceholderLayer } from "./placeholders";
import { circlePaint, fillPaint, linePaint, rasterPaint } from "./style-mapper";

const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
export function syncLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (isExternalNativeLayer(layer)) {
    syncExternalNativeLayer(map, layer, beforeId);
    return;
  }

  if (isPlaceholderLayer(layer)) return;

  if (layer.type === "geojson" && layer.geojson) {
    syncGeoJsonLayer(map, layer, beforeId);
    return;
  }

  if (
    layer.type === "raster" ||
    layer.type === "wms" ||
    layer.type === "xyz"
  ) {
    syncRasterTileLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "vector-tiles") {
    syncVectorTileLayer(map, layer, beforeId);
  }
}

function isExternalNativeLayer(layer: GeoLibreLayer): boolean {
  return getExternalNativeLayerIds(layer).length > 0;
}

function syncExternalNativeLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const nativeLayerIds = getExternalNativeLayerIds(layer);
  for (const nativeLayerId of nativeLayerIds) {
    const nativeLayer = map.getLayer(nativeLayerId);
    if (!nativeLayer) continue;

    map.setLayoutProperty(
      nativeLayerId,
      "visibility",
      layer.visible ? "visible" : "none",
    );

    setExternalNativeLayerPaint(map, nativeLayerId, nativeLayer.type, layer);

    moveLayer(map, nativeLayerId, beforeId);
  }
}

function setExternalNativeLayerPaint(
  map: maplibregl.Map,
  nativeLayerId: string,
  nativeLayerType: string,
  layer: GeoLibreLayer,
): void {
  const paint =
    nativeLayerType === "fill"
      ? fillPaint(layer.style, layer.opacity)
      : nativeLayerType === "line"
        ? linePaint(layer.style, layer.opacity)
        : nativeLayerType === "circle"
          ? circlePaint(layer.style, layer.opacity)
          : nativeLayerType === "raster"
            ? rasterPaint(layer.style, layer.opacity)
            : null;

  if (!paint) return;

  for (const [property, value] of Object.entries(paint)) {
    try {
      map.setPaintProperty(nativeLayerId, property, value);
    } catch {
      // External controls can create heterogeneous style layers. Ignore paint
      // properties that do not apply to a specific native layer type.
    }
  }
}

function syncGeoJsonLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const profile = detectGeometryProfile(layer.geojson!);

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "geojson",
      data: layer.geojson!,
    });
  } else {
    (map.getSource(src) as maplibregl.GeoJSONSource).setData(layer.geojson!);
  }

  const visibility = layer.visible ? "visible" : "none";
  const opacity = layer.opacity;

  if (profile.hasPolygon) {
    ensureLayer(
      map,
      fillLayerId(layer.id),
      {
        id: fillLayerId(layer.id),
        type: "fill",
        source: src,
        filter: [
          "match",
          ["geometry-type"],
          ["Polygon", "MultiPolygon"],
          true,
          false,
        ],
        paint: fillPaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, fillLayerId(layer.id));
  }

  if (profile.hasLine || profile.hasPolygon) {
    ensureLayer(
      map,
      lineLayerId(layer.id),
      {
        id: lineLayerId(layer.id),
        type: "line",
        source: src,
        filter: [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ],
        paint: linePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineLayerId(layer.id));
  }

  if (profile.hasPoint) {
    ensureLayer(
      map,
      circleLayerId(layer.id),
      {
        id: circleLayerId(layer.id),
        type: "circle",
        source: src,
        filter: [
          "match",
          ["geometry-type"],
          ["Point", "MultiPoint"],
          true,
          false,
        ],
        paint: circlePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, circleLayerId(layer.id));
  }
}

function syncRasterTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-raster`;
  const tiles = getRenderableRasterTiles(layer);
  const tileSize = (layer.source.tileSize as number | undefined) ?? 256;
  if (tiles.length === 0) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "raster", tiles, tileSize });
  }
  ensureLayer(
    map,
    lid,
    {
      id: lid,
      type: "raster",
      source: src,
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function getRenderableRasterTiles(layer: GeoLibreLayer): string[] {
  const tiles = (layer.source.tiles as string[]) ?? [];
  if (layer.type !== "wms" || !isViteDevServer()) return tiles;
  return tiles.map(proxyWmsTileUrl);
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

function proxyWmsTileUrl(tileUrl: string): string {
  const encodedUrl = encodeURIComponent(tileUrl).replaceAll(
    "%7Bbbox-epsg-3857%7D",
    "{bbox-epsg-3857}",
  );
  return `${WMS_PROXY_PATH}?url=${encodedUrl}`;
}

function syncVectorTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const url = layer.source.url as string | undefined;
  if (!url) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "vector", url });
  }
  const styleLayerId = `layer-${layer.id}-vector`;
  const sourceLayer = (layer.source.sourceLayer as string) ?? "";
  ensureLayer(
    map,
    styleLayerId,
    {
      id: styleLayerId,
      type: "fill",
      source: src,
      "source-layer": sourceLayer,
      paint: fillPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function ensureLayer(
  map: maplibregl.Map,
  id: string,
  spec: maplibregl.AddLayerObject & {
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  },
  beforeId?: string,
): void {
  if (map.getLayer(id)) {
    if (spec.paint) {
      for (const [key, value] of Object.entries(spec.paint)) {
        map.setPaintProperty(id, key, value);
      }
    }
    if (spec.layout) {
      for (const [key, value] of Object.entries(spec.layout)) {
        map.setLayoutProperty(id, key, value);
      }
    }
    moveLayer(map, id, beforeId);
    return;
  }
  const validBeforeId = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer(spec, validBeforeId);
}

function removeIfExists(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}

function moveLayer(
  map: maplibregl.Map,
  id: string,
  beforeId?: string,
): void {
  try {
    if (beforeId && beforeId !== id && map.getLayer(beforeId)) {
      map.moveLayer(id, beforeId);
      return;
    }
    map.moveLayer(id);
  } catch {
    // Reordering can race style reloads; the next sync pass will retry.
  }
}

export function removeLayerFromMap(
  map: maplibregl.Map,
  layerId: string,
  layer?: GeoLibreLayer,
): void {
  for (const id of [
    ...getExternalNativeLayerIds(layer),
    fillLayerId(layerId),
    lineLayerId(layerId),
    circleLayerId(layerId),
    `layer-${layerId}-raster`,
    `layer-${layerId}-vector`,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [getExternalSourceId(layer), sourceId(layerId)]) {
    if (src && map.getSource(src)) map.removeSource(src);
  }
}

function getExternalNativeLayerIds(layer?: GeoLibreLayer): string[] {
  const nativeLayerIds = layer?.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

function getExternalSourceId(layer?: GeoLibreLayer): string | undefined {
  return typeof layer?.metadata.sourceId === "string"
    ? layer.metadata.sourceId
    : undefined;
}
