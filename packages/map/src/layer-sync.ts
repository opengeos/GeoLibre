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
import { circlePaint, fillPaint, linePaint } from "./style-mapper";

export function syncLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (isPlaceholderLayer(layer)) return;

  if (layer.type === "geojson" && layer.geojson) {
    syncGeoJsonLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "xyz") {
    syncXyzLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "vector-tiles") {
    syncVectorTileLayer(map, layer, beforeId);
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
    ensureLayer(map, fillLayerId(layer.id), {
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
    }, beforeId);
  } else {
    removeIfExists(map, fillLayerId(layer.id));
  }

  if (profile.hasLine || profile.hasPolygon) {
    ensureLayer(map, lineLayerId(layer.id), {
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
    }, beforeId);
  } else {
    removeIfExists(map, lineLayerId(layer.id));
  }

  if (profile.hasPoint) {
    ensureLayer(map, circleLayerId(layer.id), {
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
    }, beforeId);
  } else {
    removeIfExists(map, circleLayerId(layer.id));
  }
}

function syncXyzLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-raster`;
  const tiles = (layer.source.tiles as string[]) ?? [];
  if (!map.getSource(src)) {
    map.addSource(src, { type: "raster", tiles, tileSize: 256 });
  }
  ensureLayer(map, lid, {
    id: lid,
    type: "raster",
    source: src,
    paint: { "raster-opacity": layer.opacity },
    layout: { visibility: layer.visible ? "visible" : "none" },
  }, beforeId);
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
  ensureLayer(map, styleLayerId, {
    id: styleLayerId,
    type: "fill",
    source: src,
    "source-layer": sourceLayer,
    paint: fillPaint(layer.style, layer.opacity),
    layout: { visibility: layer.visible ? "visible" : "none" },
  }, beforeId);
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
    return;
  }
  map.addLayer(spec, beforeId);
}

function removeIfExists(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}

export function removeLayerFromMap(
  map: maplibregl.Map,
  layerId: string,
): void {
  for (const id of [
    fillLayerId(layerId),
    lineLayerId(layerId),
    circleLayerId(layerId),
    `layer-${layerId}-raster`,
    `layer-${layerId}-vector`,
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  const src = sourceId(layerId);
  if (map.getSource(src)) map.removeSource(src);
}

