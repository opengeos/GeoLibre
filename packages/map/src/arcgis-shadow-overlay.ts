import { createStyleLayerEvaluator, type StyleGeometryKind } from "@geolibre/core";
import type { Feature, Geometry, MultiLineString, Position } from "geojson";
import type { LayerSpecification } from "maplibre-gl";
import { geometryContainsPoint } from "./arcgis-layers";
import type { IdentifiedFeature } from "./map-engine";

/** One graphic the overlay draws: a GeoJSON geometry and a 2D SDK symbol. */
export interface OverlayGraphic {
  layerId: string;
  featureId: string;
  properties: Record<string, unknown>;
  /** What is drawn: a polygon's rings for a `line` layer. */
  geometry: Geometry;
  /** The feature's own geometry, which a pick reports. */
  featureGeometry: Geometry;
  symbol: Record<string, unknown>;
}

/** What {@link shadowOverlayGraphics} reads: the shadow style, uncopied. */
export interface OverlayStyle {
  sources: Record<string, Record<string, unknown>>;
  layers: LayerSpecification[];
}

type Rgba = [number, number, number, number];

const DRAWN_TYPES = new Set(["fill", "line", "circle", "symbol"]);

function kindOf(geometry: Geometry): StyleGeometryKind | null {
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return "Point";
    case "LineString":
    case "MultiLineString":
      return "LineString";
    case "Polygon":
    case "MultiPolygon":
      return "Polygon";
    default:
      return null;
  }
}

/** The features a GeoJSON source's inline `data` holds; a URL holds none here. */
function sourceFeatures(source: Record<string, unknown> | undefined): Feature[] {
  if (!source || source.type !== "geojson") return [];
  const data = source.data as { type?: string } | undefined;
  if (!data || typeof data !== "object") return [];
  if (data.type === "FeatureCollection")
    return ((data as { features?: Feature[] }).features ?? []).filter(Boolean);
  if (data.type === "Feature") return [data as Feature];
  if (typeof data.type === "string")
    return [{ type: "Feature", properties: {}, geometry: data as Geometry }];
  return [];
}

/** A polygon's rings as the lines a MapLibre `line` layer strokes. */
function outline(geometry: Geometry): MultiLineString | Geometry {
  if (geometry.type === "Polygon")
    return { type: "MultiLineString", coordinates: geometry.coordinates };
  if (geometry.type === "MultiPolygon")
    return {
      type: "MultiLineString",
      coordinates: geometry.coordinates.flat() as Position[][],
    };
  return geometry;
}

function rgba(value: unknown, opacity: unknown): Rgba | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const alpha = Number(value[3]) * (typeof opacity === "number" ? opacity : 1);
  return [value[0], value[1], value[2], Math.max(0, Math.min(1, alpha))];
}

/** A ring's area-weighted centroid, or its first vertex when it has no area. */
function ringCentroid(ring: Position[]): Position | null {
  let area = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    area += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  if (area === 0) return ring[0] ?? null;
  return [x / (3 * area), y / (3 * area)];
}

/**
 * Where a label goes: a point as is, a polygon at its outer ring's centroid
 * (the largest part of a multipolygon), a line at its middle vertex. MapLibre
 * places point labels the same way, up to its collision handling.
 */
function labelPoint(geometry: Geometry): Geometry | null {
  const middle = (line: Position[]) => line[Math.floor((line.length - 1) / 2)];
  const point = (coordinates: Position | null | undefined): Geometry | null =>
    coordinates ? { type: "Point", coordinates } : null;
  switch (geometry.type) {
    case "Point":
    case "MultiPoint":
      return geometry;
    case "LineString":
      return point(middle(geometry.coordinates));
    case "MultiLineString": {
      const longest = geometry.coordinates.reduce<Position[]>(
        (best, line) => (line.length > best.length ? line : best),
        [],
      );
      return point(middle(longest));
    }
    case "Polygon":
      return point(ringCentroid(geometry.coordinates[0] ?? []));
    case "MultiPolygon": {
      const largest = geometry.coordinates.reduce<Position[]>(
        (best, polygon) => ((polygon[0]?.length ?? 0) > best.length ? polygon[0] : best),
        [],
      );
      return point(ringCentroid(largest));
    }
    default:
      return null;
  }
}

const px = (value: unknown, fallback: number): string =>
  `${typeof value === "number" && Number.isFinite(value) ? value : fallback}px`;

/**
 * The SDK graphics for a shadow style's GeoJSON layers: the overlays a plugin
 * control draws on MapLibre (a grid, a selection outline, a draw preview, a
 * trace) that no store layer mirrors, drawn as the ArcGIS renderer's own 2D
 * symbols. Fill, line, circle and text are drawn, with paint and filters
 * evaluated per feature as MapLibre evaluates them; icons, patterns,
 * extrusions and text placement along lines are not. A layer the store
 * mirrors (`isMirrored`) is skipped: the engine already draws that record.
 *
 * @param style - The shadow style's sources and layers, bottom to top.
 * @param zoom - The view's zoom, for zoom ranges and zoom expressions.
 * @param isMirrored - Whether a store layer already draws a style layer.
 * @returns The graphics, bottom to top.
 */
export function shadowOverlayGraphics(
  style: OverlayStyle,
  zoom: number,
  isMirrored: (layerId: string, sourceId: string) => boolean,
): OverlayGraphic[] {
  const graphics: OverlayGraphic[] = [];
  for (const layer of style.layers) {
    if (!DRAWN_TYPES.has(layer.type) || !("source" in layer)) continue;
    const sourceId = typeof layer.source === "string" ? layer.source : undefined;
    if (!sourceId || isMirrored(layer.id, sourceId)) continue;
    if ((layer.layout as { visibility?: string } | undefined)?.visibility === "none") continue;
    if (layer.minzoom !== undefined && zoom < layer.minzoom) continue;
    if (layer.maxzoom !== undefined && zoom >= layer.maxzoom) continue;
    const features = sourceFeatures(style.sources[sourceId]);
    if (!features.length) continue;
    const evaluator = createStyleLayerEvaluator(layer as never);
    const paint = (layer.paint ?? {}) as Record<string, unknown>;
    features.forEach((feature, index) => {
      const geometry = feature.geometry;
      const kind = geometry ? kindOf(geometry) : null;
      if (!geometry || !kind) return;
      const input = { id: feature.id, properties: feature.properties, kind };
      if (!evaluator.passes(zoom, input)) return;
      const value = (group: "paint" | "layout", name: string) =>
        evaluator.value(group, name, zoom, input);
      const featureId = String(feature.id ?? index);
      const push = (drawn: Geometry, symbol: Record<string, unknown>) =>
        graphics.push({
          layerId: layer.id,
          featureId,
          properties: feature.properties ?? {},
          geometry: drawn,
          featureGeometry: geometry,
          symbol,
        });
      switch (layer.type) {
        case "fill": {
          if (kind !== "Polygon") return;
          const color = rgba(value("paint", "fill-color"), value("paint", "fill-opacity"));
          // MapLibre strokes a fill only when told to; the SDK's default is a
          // black outline, so say "none" explicitly otherwise.
          const outlineColor =
            paint["fill-outline-color"] !== undefined
              ? rgba(value("paint", "fill-outline-color"), value("paint", "fill-opacity"))
              : null;
          if (!color && !outlineColor) return;
          push(geometry, {
            type: "simple-fill",
            color: color ?? [0, 0, 0, 0],
            outline: outlineColor
              ? { color: outlineColor, width: "1px" }
              : { color: [0, 0, 0, 0], width: 0 },
          });
          return;
        }
        case "line": {
          if (kind === "Point") return;
          const color = rgba(value("paint", "line-color"), value("paint", "line-opacity"));
          if (!color || color[3] === 0) return;
          push(outline(geometry) as Geometry, {
            type: "simple-line",
            color,
            width: px(value("paint", "line-width"), 1),
            style: paint["line-dasharray"] !== undefined ? "dash" : "solid",
            cap: value("layout", "line-cap") === "round" ? "round" : "butt",
            join: value("layout", "line-join") === "round" ? "round" : "miter",
          });
          return;
        }
        case "circle": {
          if (kind !== "Point") return;
          const color = rgba(value("paint", "circle-color"), value("paint", "circle-opacity"));
          const radius = value("paint", "circle-radius");
          const stroke = rgba(
            value("paint", "circle-stroke-color"),
            value("paint", "circle-stroke-opacity"),
          );
          push(geometry, {
            type: "simple-marker",
            style: "circle",
            color: color ?? [0, 0, 0, 0],
            size: px(typeof radius === "number" ? radius * 2 : undefined, 10),
            outline: {
              color: stroke ?? [0, 0, 0, 0],
              width: px(value("paint", "circle-stroke-width"), 0),
            },
          });
          return;
        }
        case "symbol": {
          const text = value("layout", "text-field");
          if (typeof text !== "string" || text === "") return;
          const anchor = labelPoint(geometry);
          if (!anchor) return;
          const color = rgba(value("paint", "text-color"), value("paint", "text-opacity"));
          const halo = rgba(value("paint", "text-halo-color"), value("paint", "text-opacity"));
          push(anchor, {
            type: "text",
            text,
            color: color ?? [0, 0, 0, 1],
            haloColor: halo ?? [0, 0, 0, 0],
            haloSize: px(value("paint", "text-halo-width"), 0),
            font: { size: px(value("layout", "text-size"), 16) },
          });
          return;
        }
      }
    });
  }
  return graphics;
}

/**
 * The overlay graphics a click at `lngLat` lands on for one style layer,
 * topmost first, in the engine's identify shape.
 */
export function pickOverlayGraphics(
  graphics: readonly OverlayGraphic[],
  lngLat: [number, number],
  layerId: string,
  tolerance: number,
): IdentifiedFeature[] {
  const hits: IdentifiedFeature[] = [];
  const seen = new Set<string>();
  for (let index = graphics.length - 1; index >= 0; index--) {
    const graphic = graphics[index];
    if (graphic.layerId !== layerId || seen.has(graphic.featureId)) continue;
    if (!geometryContainsPoint(graphic.geometry, lngLat, tolerance)) continue;
    seen.add(graphic.featureId);
    hits.push({
      layerId,
      featureId: graphic.featureId,
      properties: graphic.properties,
      geometry: graphic.featureGeometry,
    });
  }
  return hits;
}
