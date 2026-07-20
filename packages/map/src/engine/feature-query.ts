import union from "@turf/union";
import type {
  Feature,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

/** Map style-layer types whose features can be represented as GeoJSON. */
export const QUERYABLE_VECTOR_LAYER_TYPES = new Set([
  "fill",
  "line",
  "circle",
  "symbol",
  "fill-extrusion",
]);

/** A renderer layer and source pair that can be queried in the current view. */
export interface ViewVectorLayer {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly sourceLayer?: string;
}

/** Geographic bounds used by the viewport-intersection test. */
export interface ViewBounds {
  readonly west: number;
  readonly east: number;
  readonly south: number;
  readonly north: number;
}

/**
 * Package-private structural surface used by the MapLibre adapter. Renderer
 * consumers must use `MapEngineClient.layers.queryInView()` instead.
 */
export interface FeatureQueryMap {
  getStyle: () => { layers?: unknown[]; sources?: Record<string, unknown> } | undefined;
  querySourceFeatures: (
    sourceId: string,
    options?: { sourceLayer?: string },
  ) => Array<{
    id?: unknown;
    geometry: Geometry;
    properties?: Record<string, unknown> | null;
  }>;
  getBounds: () => {
    getWest: () => number;
    getEast: () => number;
    getSouth: () => number;
    getNorth: () => number;
  };
}

/** The store-layer fields needed to resolve a renderer source. */
export interface QueryableStoreLayer {
  readonly id: string;
  readonly metadata?: {
    readonly sourceIds?: unknown;
    readonly sourceId?: unknown;
    readonly nativeLayerIds?: unknown;
  };
}

/** True when a renderer layer is an editor or GeoLibre scratch overlay. */
export function isInternalOverlayLayerId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.startsWith("gm_") ||
    lower.startsWith("gm-") ||
    lower.startsWith("geo-editor") ||
    lower.startsWith("geoman") ||
    lower.startsWith("geolibre-")
  );
}

/** List vector/GeoJSON style layers that can be queried as GeoJSON. */
export function listViewVectorLayers(
  style: { layers?: unknown[]; sources?: Record<string, unknown> } | undefined,
): ViewVectorLayer[] {
  const layers = style?.layers;
  if (!Array.isArray(layers)) return [];
  const sources = style?.sources ?? {};
  const result: ViewVectorLayer[] = [];

  for (const raw of layers) {
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as Record<string, unknown>;
    const id = layer.id;
    const type = layer.type;
    const sourceId = layer.source;
    if (typeof id !== "string" || typeof type !== "string") continue;
    if (typeof sourceId !== "string" || sourceId.length === 0) continue;
    if (!QUERYABLE_VECTOR_LAYER_TYPES.has(type) || isInternalOverlayLayerId(id)) continue;

    const sourceType = (sources[sourceId] as { type?: string } | undefined)?.type;
    if (sourceType !== "vector" && sourceType !== "geojson") continue;

    const sourceLayer = layer["source-layer"];
    result.push({
      id,
      type,
      sourceId,
      ...(typeof sourceLayer === "string" ? { sourceLayer } : {}),
    });
  }

  return result;
}

function conventionalStyleLayerIds(layerId: string): string[] {
  return [
    `layer-${layerId}-fill`,
    `layer-${layerId}-extrusion`,
    `layer-${layerId}-line`,
    `layer-${layerId}-circle`,
    `layer-${layerId}-symbol`,
    `layer-${layerId}-text`,
  ];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Resolve an authoritative store layer to its renderer query source. */
export function resolveStoreLayerViewSource(
  layer: QueryableStoreLayer,
  style: { layers?: unknown[]; sources?: Record<string, unknown> } | undefined,
): ViewVectorLayer | null {
  const layers = style?.layers;
  if (!Array.isArray(layers)) return null;
  const sources = style?.sources ?? {};
  const candidateIds = new Set([
    ...stringArray(layer.metadata?.nativeLayerIds),
    ...conventionalStyleLayerIds(layer.id),
  ]);
  const candidateSources = new Set(stringArray(layer.metadata?.sourceIds));
  if (typeof layer.metadata?.sourceId === "string") {
    candidateSources.add(layer.metadata.sourceId);
  }

  for (const raw of layers) {
    if (!raw || typeof raw !== "object") continue;
    const styleLayer = raw as Record<string, unknown>;
    const id = String(styleLayer.id ?? "");
    const type = styleLayer.type;
    const sourceId = styleLayer.source;
    if (typeof type !== "string" || !QUERYABLE_VECTOR_LAYER_TYPES.has(type)) continue;
    if (typeof sourceId !== "string" || sourceId.length === 0) continue;
    if (isInternalOverlayLayerId(id)) continue;
    if (!candidateIds.has(id) && !candidateSources.has(sourceId)) continue;

    const sourceType = (sources[sourceId] as { type?: string } | undefined)?.type;
    if (sourceType !== "vector" && sourceType !== "geojson") continue;

    const sourceLayer = styleLayer["source-layer"];
    return {
      id: layer.id,
      type,
      sourceId,
      ...(typeof sourceLayer === "string" ? { sourceLayer } : {}),
    };
  }

  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function geometryBbox(geometry: Geometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
      const [lng, lat] = value as [number, number];
      minX = Math.min(minX, lng);
      minY = Math.min(minY, lat);
      maxX = Math.max(maxX, lng);
      maxY = Math.max(maxY, lat);
      return;
    }
    for (const item of value) walk(item);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Whether a geometry's bounding box overlaps the current viewport. */
export function geometryIntersectsBounds(
  geometry: Geometry | null | undefined,
  bounds: ViewBounds,
): boolean {
  if (!geometry) return false;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((entry) => geometryIntersectsBounds(entry, bounds));
  }
  const bbox = geometryBbox(geometry);
  if (!bbox) return false;
  const [minX, minY, maxX, maxY] = bbox;
  return minX <= bounds.east && maxX >= bounds.west && minY <= bounds.north && maxY >= bounds.south;
}

/** A stable rough geometry size used to select a safe merge fallback. */
export function geometryCoordinateCount(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0;
  try {
    return JSON.stringify(geometry).length;
  } catch {
    return 0;
  }
}

function isPolygonal(feature: Feature): feature is Feature<Polygon | MultiPolygon> {
  return feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
}

function isLinear(feature: Feature): feature is Feature<LineString | MultiLineString> {
  return feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString";
}

function mergeClippedPieces(pieces: Feature[]): Feature {
  let largest = pieces[0];
  let largestSize = geometryCoordinateCount(largest.geometry);
  for (const piece of pieces) {
    const size = geometryCoordinateCount(piece.geometry);
    if (size > largestSize) {
      largest = piece;
      largestSize = size;
    }
  }
  if (pieces.length === 1) return largest;

  const withMergedGeometry = (geometry: Geometry): Feature => ({
    type: "Feature",
    ...(largest.id != null ? { id: largest.id } : {}),
    geometry,
    properties: { ...(largest.properties ?? {}) },
  });

  if (pieces.every(isPolygonal)) {
    try {
      const merged = union({
        type: "FeatureCollection",
        features: pieces as Feature<Polygon | MultiPolygon>[],
      });
      if (merged?.geometry) return withMergedGeometry(merged.geometry);
    } catch {
      // Degenerate tile pieces fall back to the largest valid geometry.
    }
  } else if (pieces.every(isLinear)) {
    const lines: Position[][] = [];
    for (const piece of pieces) {
      const geometry = piece.geometry;
      if (geometry.type === "LineString") lines.push(geometry.coordinates);
      else lines.push(...geometry.coordinates);
    }
    if (lines.length > 0) {
      return withMergedGeometry({ type: "MultiLineString", coordinates: lines });
    }
  }

  return largest;
}

/** Deduplicate tile-clipped source features and retain only in-view geometry. */
export function dedupeViewportFeatures(
  sourceFeatures: Array<{
    id?: unknown;
    geometry: Geometry;
    properties?: Record<string, unknown> | null;
  }>,
  bounds: ViewBounds,
): Feature[] {
  const groups = new Map<string, Feature[]>();
  let autoIndex = 0;

  for (const raw of sourceFeatures) {
    if (!geometryIntersectsBounds(raw.geometry, bounds)) continue;
    const properties = raw.properties ?? {};
    const key =
      String(raw.id ?? properties.id ?? properties.osm_id ?? "") || `__auto_${autoIndex++}`;
    const feature: Feature = {
      type: "Feature",
      geometry: raw.geometry,
      properties: { ...properties },
      ...(raw.id != null ? { id: raw.id as string | number } : {}),
    };
    const group = groups.get(key);
    if (group) group.push(feature);
    else groups.set(key, [feature]);
  }

  return [...groups.values()].map(mergeClippedPieces);
}

/** Query one resolved renderer source and normalize it to in-view GeoJSON. */
export function queryViewLayerFeatures(map: FeatureQueryMap, layer: ViewVectorLayer): Feature[] {
  const sourceFeatures = map.querySourceFeatures(
    layer.sourceId,
    layer.sourceLayer ? { sourceLayer: layer.sourceLayer } : undefined,
  );
  if (!sourceFeatures || sourceFeatures.length === 0) return [];

  const bounds = map.getBounds();
  return dedupeViewportFeatures(sourceFeatures, {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  });
}
