/**
 * Touch-friendly feature identify helpers (GeoLibre#3537 Phase 3).
 *
 * On touchscreens, querying a single 1px point misses thin lines and small
 * markers. Expanding the query to a padded bounding box and sorting results by
 * geometry specificity (Point -> LineString -> Polygon) keeps taps accurate
 * without altering desktop mouse precision.
 */

/** Half-width in CSS pixels of the padded bounding box used for touch taps. */
export const TOUCH_IDENTIFY_HIT_RADIUS_PX = 14;

/** Minimal 2D screen point shape shared by MapLibre, Mapbox, and selection handlers. */
export interface IdentifyScreenPoint {
  x: number;
  y: number;
}

export type IdentifyQueryGeometry = IdentifyScreenPoint | [[number, number], [number, number]];

export interface GeometryTypedFeature {
  geometry?: { type?: string } | null;
}

/**
 * Determine whether an identify or pick interaction should use touch hit-radius
 * expansion based on the last pointer type or the active `data-touch-ui` mode.
 */
export function isTouchIdentifyActive(pointerType?: string | null): boolean {
  if (pointerType === "touch") return true;
  if (pointerType === "mouse") return false;
  return typeof document !== "undefined" && document.documentElement?.dataset?.touchUi === "true";
}

/**
 * Build a MapLibre/Mapbox `queryRenderedFeatures` geometry: exact point on
 * mouse (or custom desktop radius), or a padded box on touch.
 */
export function buildIdentifyQueryGeometry<P extends IdentifyScreenPoint>(
  point: P,
  touch: boolean,
  radiusPx = TOUCH_IDENTIFY_HIT_RADIUS_PX,
): P | [[number, number], [number, number]] {
  if (!touch || radiusPx <= 0) return point;
  return [
    [point.x - radiusPx, point.y - radiusPx],
    [point.x + radiusPx, point.y + radiusPx],
  ];
}

function geometryPriority(type: string | undefined): number {
  switch (type) {
    case "Point":
    case "MultiPoint":
      return 0;
    case "LineString":
    case "MultiLineString":
      return 1;
    default:
      return 2;
  }
}

/**
 * Stable sort prioritizing Point -> LineString -> Polygon hits while preserving
 * MapLibre's top-to-bottom draw order within each geometry tier.
 */
export function sortIdentifyFeaturesByGeometryPriority<T extends GeometryTypedFeature>(
  features: readonly T[],
): T[] {
  return features
    .map((feature, index) => ({
      feature,
      index,
      priority: geometryPriority(feature.geometry?.type),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.feature);
}
