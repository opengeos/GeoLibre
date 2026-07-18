import bbox from "@turf/bbox";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";

export type GeometryKind = "point" | "line" | "polygon";

export interface GeometryProfile {
  hasPoint: boolean;
  hasLine: boolean;
  hasPolygon: boolean;
}

export function detectGeometryProfile(fc: FeatureCollection): GeometryProfile {
  const profile: GeometryProfile = {
    hasPoint: false,
    hasLine: false,
    hasPolygon: false,
  };
  for (const feature of fc.features) {
    const type = feature.geometry?.type;
    if (!type) continue;
    if (type === "Point" || type === "MultiPoint") profile.hasPoint = true;
    if (type === "LineString" || type === "MultiLineString") {
      profile.hasLine = true;
    }
    if (type === "Polygon" || type === "MultiPolygon") {
      profile.hasPolygon = true;
    }
    if (type === "GeometryCollection") {
      for (const g of feature.geometry.geometries) {
        if (g.type === "Point" || g.type === "MultiPoint") profile.hasPoint = true;
        if (g.type === "LineString" || g.type === "MultiLineString") profile.hasLine = true;
        if (g.type === "Polygon" || g.type === "MultiPolygon") profile.hasPolygon = true;
      }
    }
  }
  return profile;
}

export function getLayerBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
  if (!layer.geojson?.features?.length) return null;
  const box = bbox(layer.geojson);
  // A collection whose features all carry a null geometry (e.g. a delimited
  // text file imported as an attribute table, or a non-spatial SQL result)
  // yields a degenerate ±Infinity box. Report "no bounds" so callers such as
  // fitLayer/"Zoom to layer" fall back or no-op instead of flying to an
  // invalid extent.
  if (!box.every((value) => Number.isFinite(value))) return null;
  return box as [number, number, number, number];
}

export function sourceId(layerId: string): string {
  return `source-${layerId}`;
}

export function fillLayerId(layerId: string): string {
  return `layer-${layerId}-fill`;
}

export function fillExtrusionLayerId(layerId: string): string {
  return `layer-${layerId}-extrusion`;
}

export function lineLayerId(layerId: string): string {
  return `layer-${layerId}-line`;
}

export function circleLayerId(layerId: string): string {
  return `layer-${layerId}-circle`;
}

export function heatmapLayerId(layerId: string): string {
  return `layer-${layerId}-heatmap`;
}

export function clusterLayerId(layerId: string): string {
  return `layer-${layerId}-cluster`;
}

export function clusterCountLayerId(layerId: string): string {
  return `layer-${layerId}-cluster-count`;
}

export function textLayerId(layerId: string): string {
  return `layer-${layerId}-text`;
}

export function markerLayerId(layerId: string): string {
  return `layer-${layerId}-marker`;
}

export function labelLayerId(layerId: string): string {
  return `layer-${layerId}-label`;
}

/**
 * Source id for the optional deduplicated label features (see
 * {@link LabelStyle.dedupe}). Separate from the layer's main source so the
 * symbol layer can read aggregated one-per-point labels without altering the
 * data the fill/line/circle layers render.
 */
export function labelSourceId(layerId: string): string {
  return `source-${layerId}-label`;
}

/**
 * Source id for the inverted-fill mask (see
 * {@link LayerStyle.invertedFillEnabled}). The mask is a derived polygon, so
 * it lives in its own GeoJSON source beside the layer's main source.
 */
export function invertedSourceId(layerId: string): string {
  return `source-${layerId}-inverted`;
}

export function invertedFillLayerId(layerId: string): string {
  return `layer-${layerId}-inverted-fill`;
}

/** Symbol layer that repeats decoration icons along line features. */
export function lineDecorationLayerId(layerId: string): string {
  return `layer-${layerId}-line-decoration`;
}

/**
 * Source id for the geometry generator's derived features (see
 * {@link LayerStyle.geometryGenerator}).
 */
export function generatorSourceId(layerId: string): string {
  return `source-${layerId}-generator`;
}

export function generatorFillLayerId(layerId: string): string {
  return `layer-${layerId}-generator-fill`;
}

export function generatorLineLayerId(layerId: string): string {
  return `layer-${layerId}-generator-line`;
}

export function generatorCircleLayerId(layerId: string): string {
  return `layer-${layerId}-generator-circle`;
}

export function highlightSourceId(): string {
  return "geolibre-highlight-source";
}

export function highlightFillLayerId(): string {
  return "geolibre-highlight-fill";
}

export function highlightLineLayerId(): string {
  return "geolibre-highlight-line";
}

export function highlightCircleLayerId(): string {
  return "geolibre-highlight-circle";
}
