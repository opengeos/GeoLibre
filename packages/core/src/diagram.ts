/**
 * Pure helpers for the diagram renderer (per-feature pie/donut/bar charts,
 * QGIS-style diagram symbology). Everything here is DOM-free so the desktop
 * app, the deck.gl overlay, and the node test suite share one implementation:
 * anchor placement, value extraction, and size scaling. The canvas drawing and
 * deck.gl layer construction live in `@geolibre/plugins`.
 */
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { styleValue, type LayerStyle } from "./types";

/**
 * Hard cap on how many features get a diagram. Each diagram is rasterized into
 * an icon atlas, so an unbounded layer (e.g. a million-point parquet) would
 * hang the UI; typical thematic layers (counties, districts) sit well below
 * this.
 */
export const MAX_DIAGRAM_FEATURES = 2000;

/**
 * Hard cap on how many raw features {@link collectDiagramData} visits while
 * looking for drawable diagrams. Without it, a layer whose drawable ratio is
 * low (sparse attributes, degenerate geometry) degenerates to a full scan of
 * an arbitrarily large collection on every rebuild. Features past this bound
 * are treated as truncation, which the Style Panel surfaces.
 */
export const MAX_DIAGRAM_SCAN_FEATURES = 100_000;

/** Smallest rendered diagram size in pixels under scaled sizing. */
export const MIN_DIAGRAM_SIZE = 8;

/** One feature's chart, ready for drawing. */
export interface DiagramDatum {
  /** Anchor position: the point location or polygon/line midpoint centroid. */
  position: [number, number];
  /** One value per configured diagram field (negatives clamped to 0). */
  values: number[];
  /** Sum of {@link values}. */
  total: number;
  /** The value driving scaled sizing (total, attribute value, or 1 for fixed). */
  sizeValue: number;
}

/** The per-layer diagram dataset plus the maxima needed for scaling. */
export interface DiagramData {
  data: DiagramDatum[];
  /** Largest {@link DiagramDatum.sizeValue} (0 when there is no data). */
  maxSizeValue: number;
  /** Largest single field value across all features (for bar axis scaling). */
  maxFieldValue: number;
  /** Largest {@link DiagramDatum.total} across all features. */
  maxTotal: number;
  /** True when the feature cap truncated the dataset. */
  truncated: boolean;
}

/**
 * Whether a layer style has a drawable diagram configuration: a chart type and
 * at least one mapped attribute.
 *
 * @param style - The layer style to test.
 */
export function isDiagramStyleEnabled(style: LayerStyle): boolean {
  return (
    styleValue(style, "diagramType") !== "none" &&
    styleValue(style, "diagramFields").some((field) => field.property !== "")
  );
}

/**
 * Whether a heatmap/cluster point renderer suppresses the layer's diagrams.
 * The point renderer only applies (and is only user-editable) on point-only
 * layers, so a stale `pointRenderer` value on a layer that has since gained
 * non-point geometry must not block diagrams — this mirrors the Style Panel's
 * own `!supportsPointRenderer || pointRenderer === "single"` visibility gate,
 * keeping the render and legend gates consistent with what the panel lets the
 * user configure. The full feature list is scanned (matching the panel's
 * isPointOnlyGeoJsonLayer, which uses an uncapped every()) so the two gates
 * can never disagree on layers whose non-point features sit past a sampling
 * window; the scan only runs for the uncommon non-"single" renderer values.
 *
 * @param geojson - The layer's feature collection (undefined suppresses nothing).
 * @param style - The layer style carrying `pointRenderer`.
 */
export function diagramsSuppressedByPointRenderer(
  geojson: FeatureCollection | undefined,
  style: LayerStyle,
): boolean {
  if (styleValue(style, "pointRenderer") === "single") return false;
  const features = geojson?.features ?? [];
  if (features.length === 0) return false;
  return features.every((feature) => {
    const type = feature?.geometry?.type;
    return type === "Point" || type === "MultiPoint";
  });
}

/** Shoelace area of a linear ring (planar, in degree space; sign = winding). */
function ringArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    // Same sign convention as ringCentroid's cross terms, so centroid / area
    // divisions stay consistent for either winding.
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

/**
 * Area-weighted centroid of a polygon's outer ring, falling back to the ring's
 * vertex average when the area is degenerate. Planar math in degree space is
 * fine at diagram-placement accuracy.
 */
function ringCentroid(ring: Position[]): [number, number] | null {
  if (ring.length === 0) return null;
  const area = ringArea(ring);
  if (Math.abs(area) < 1e-12) {
    let x = 0;
    let y = 0;
    for (const [lng, lat] of ring) {
      x += lng;
      y += lat;
    }
    return [x / ring.length, y / ring.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

function finitePosition(position: Position | undefined): [number, number] | null {
  if (!position) return null;
  const [lng, lat] = position;
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng as number, lat as number] : null;
}

/**
 * Where a feature's diagram is anchored: the point itself, a line's middle
 * vertex, or the polygon centroid (largest part of a multi-polygon). Returns
 * null for empty/degenerate geometry so the feature is skipped.
 *
 * @param geometry - The feature geometry (may be null for null-geometry rows).
 */
export function diagramAnchor(geometry: Geometry | null | undefined): [number, number] | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case "Point":
      return finitePosition(geometry.coordinates);
    case "MultiPoint":
      return finitePosition(geometry.coordinates[0]);
    case "LineString": {
      const coords = geometry.coordinates;
      return finitePosition(coords[Math.floor(coords.length / 2)]);
    }
    case "MultiLineString": {
      // Anchor on the longest part (by vertex count) so the diagram sits on
      // the feature's dominant line.
      let longest: Position[] = [];
      for (const part of geometry.coordinates) {
        if (part.length > longest.length) longest = part;
      }
      return finitePosition(longest[Math.floor(longest.length / 2)]);
    }
    case "Polygon":
      return ringCentroid(geometry.coordinates[0] ?? []);
    case "MultiPolygon": {
      let best: Position[] = [];
      let bestArea = -1;
      for (const polygon of geometry.coordinates) {
        const ring = polygon[0] ?? [];
        const area = Math.abs(ringArea(ring));
        if (area > bestArea) {
          bestArea = area;
          best = ring;
        }
      }
      return ringCentroid(best);
    }
    case "GeometryCollection": {
      for (const child of geometry.geometries) {
        const anchor = diagramAnchor(child);
        if (anchor) return anchor;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Reads a feature property as a non-negative finite number (else 0). */
function readValue(feature: Feature, property: string): number {
  const raw = feature.properties?.[property];
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Extract the per-feature diagram dataset from a layer's GeoJSON and style:
 * one {@link DiagramDatum} per feature that has an anchor and at least one
 * positive value, capped at {@link MAX_DIAGRAM_FEATURES}, plus the global
 * maxima scaled sizing and bar axes need.
 *
 * @param geojson - The layer's feature collection.
 * @param style - The layer style carrying the diagram configuration.
 */
export function collectDiagramData(geojson: FeatureCollection, style: LayerStyle): DiagramData {
  const properties = styleValue(style, "diagramFields")
    .map((field) => field.property)
    .filter((property) => property !== "");
  const sizeMode = styleValue(style, "diagramSizeMode");
  const sizeProperty = styleValue(style, "diagramSizeProperty");

  const data: DiagramDatum[] = [];
  let maxSizeValue = 0;
  let maxFieldValue = 0;
  let maxTotal = 0;
  let truncated = false;
  let visited = 0;

  for (const feature of geojson.features) {
    if (data.length >= MAX_DIAGRAM_FEATURES || visited >= MAX_DIAGRAM_SCAN_FEATURES) {
      truncated = true;
      break;
    }
    visited += 1;
    const position = diagramAnchor(feature.geometry);
    if (!position) continue;
    const values = properties.map((property) => readValue(feature, property));
    const total = values.reduce((sum, value) => sum + value, 0);
    if (total <= 0) continue;
    // Attribute sizing with no attribute chosen yet falls back to a constant
    // (full-size diagrams) instead of collapsing everything to the floor.
    const sizeValue =
      sizeMode === "sum"
        ? total
        : sizeMode === "attribute" && sizeProperty !== ""
          ? readValue(feature, sizeProperty)
          : 1;
    if (sizeValue > maxSizeValue) maxSizeValue = sizeValue;
    if (total > maxTotal) maxTotal = total;
    for (const value of values) {
      if (value > maxFieldValue) maxFieldValue = value;
    }
    data.push({ position, values, total, sizeValue });
  }

  return { data, maxSizeValue, maxFieldValue, maxTotal, truncated };
}

/**
 * The rendered size (diameter for pie/donut, box height/width for bars) of one
 * diagram in pixels. Fixed sizing returns the configured size; scaled sizing
 * maps the datum's size value onto the configured size by square root, so
 * diagram *area* tracks the value, with a small floor to keep every drawn
 * diagram legible.
 *
 * @param datum - The feature's diagram datum.
 * @param style - The layer style carrying the diagram configuration.
 * @param maxSizeValue - The dataset's largest size value (from
 *   {@link collectDiagramData}).
 */
export function diagramPixelSize(
  datum: DiagramDatum,
  style: LayerStyle,
  maxSizeValue: number,
): number {
  const size = Math.max(4, styleValue(style, "diagramSize"));
  if (styleValue(style, "diagramSizeMode") === "fixed") return size;
  if (maxSizeValue <= 0 || datum.sizeValue <= 0) return MIN_DIAGRAM_SIZE;
  return Math.max(MIN_DIAGRAM_SIZE, size * Math.sqrt(datum.sizeValue / maxSizeValue));
}
