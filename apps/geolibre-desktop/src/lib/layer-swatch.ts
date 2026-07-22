/**
 * The small symbology swatch shown on each Layers-panel row: a representative
 * color plus a shape reflecting the layer's geometry (point → dot, line → line,
 * polygon/raster → square). Reuses {@link legendSwatchesForLayer} for the color
 * so the panel symbol and the legend never disagree.
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { legendSwatchesForLayer } from "./print-legend";

export type LayerSwatchShape = "circle" | "line" | "square" | "raster";

/** Layer types styled as vectors (a colored dot/line/fill represents them). */
const VECTOR_TYPES = new Set<GeoLibreLayer["type"]>([
  "geojson",
  "flatgeobuf",
  "geoparquet",
  "vector-tiles",
  "pmtiles",
  "duckdb-query",
  "deckgl-viz",
]);

/**
 * Layer types that are neither vector nor raster imagery (3D tiles, point
 * clouds, media). They get the neutral geometry fallback, not the raster glyph.
 * Mirrors NON_LEGEND_TYPES in print-legend.ts.
 */
const NON_RASTER_TYPES = new Set<GeoLibreLayer["type"]>([
  "lidar",
  "gaussian-splat",
  "3d-tiles",
  "video",
  "image",
]);

/** Whether a layer is raster/imagery (COG, XYZ, WMS/WMTS, raster MBTiles, …). */
function isRasterLike(layer: GeoLibreLayer): boolean {
  if (VECTOR_TYPES.has(layer.type) || NON_RASTER_TYPES.has(layer.type)) return false;
  if (layer.type === "mbtiles") {
    return layer.metadata.tileType === "raster" || layer.source.type === "raster";
  }
  return true;
}

export interface LayerSwatch {
  /** First representative color of the layer's symbology. */
  color: string;
  /** Geometry-driven shape: point → circle, line → line, polygon/other → square. */
  shape: LayerSwatchShape;
}

/** Neutral fallback color, matching the legend's raster/service swatch. */
const NEUTRAL = "#94a3b8";

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Resolve the geometry-driven swatch shape for a layer. Prefers the host's
 * canonical `metadata.geometryType` (set by the vector control and the GeoLens
 * plugin — the only signal a tile layer has), then falls back to sampling local
 * GeoJSON geometry, then a neutral square for raster/service/unknown layers.
 */
export function layerSwatchShape(layer: GeoLibreLayer): LayerSwatchShape {
  // Raster/imagery layers get an image glyph, not a solid square.
  if (isRasterLike(layer)) return "raster";

  const geometryType = stringMetadata(layer.metadata?.geometryType);
  if (geometryType === "point") return "circle";
  if (geometryType === "line") return "line";
  if (geometryType === "polygon") return "square";

  const features = layer.geojson?.features;
  if (features && features.length > 0) {
    let hasPolygon = false;
    let hasLine = false;
    let hasPoint = false;
    for (const feature of features.slice(0, 500)) {
      const type = feature.geometry?.type ?? "";
      if (type.includes("Polygon")) hasPolygon = true;
      else if (type.includes("LineString")) hasLine = true;
      else if (type.includes("Point")) hasPoint = true;
    }
    // Prefer the highest-dimension geometry present (polygon > line > point).
    if (hasPolygon) return "square";
    if (hasLine) return "line";
    if (hasPoint) return "circle";
  }

  return "square";
}

/** The Layers-panel symbol for a layer: a color plus a geometry-driven shape. */
export function layerSwatch(layer: GeoLibreLayer): LayerSwatch {
  const swatches = legendSwatchesForLayer(layer);
  return {
    color: swatches[0]?.color ?? NEUTRAL,
    shape: layerSwatchShape(layer),
  };
}

/** One flattened row in the on-map legend (the legend control has no raster glyph). */
export interface AutoLegendItem {
  label: string;
  color: string;
  shape: "square" | "circle" | "line";
}

/**
 * Flatten the VISIBLE layers into legend rows (top-of-stack first). A
 * single-symbol layer contributes one row (its name + geometry swatch); a
 * graduated / categorized / rule-based layer contributes a name row followed by
 * one row per class — mirroring the Layers panel's swatches. Kept pure (no
 * React / map deps) so it is unit testable.
 */
export function autoLegendItems(layers: GeoLibreLayer[]): AutoLegendItem[] {
  const items: AutoLegendItem[] = [];
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    const swatches = legendSwatchesForLayer(layer);
    if (swatches.length === 0) continue;
    // The legend control has no raster glyph, so it falls back to a square.
    const resolved = layerSwatchShape(layer);
    const shape = resolved === "raster" ? "square" : resolved;
    if (swatches.length === 1) {
      items.push({ label: layer.name, color: swatches[0].color || NEUTRAL, shape });
      continue;
    }
    items.push({ label: layer.name, color: swatches[0].color || NEUTRAL, shape });
    for (const swatch of swatches) {
      items.push({ label: swatch.label ?? "", color: swatch.color || NEUTRAL, shape: "square" });
    }
  }
  return items;
}
