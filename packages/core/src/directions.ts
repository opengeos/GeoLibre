/** Renderer-neutral summary of a calculated directions route. */
export interface DirectionsRouteLegMetric {
  distanceMeters: number;
  durationSeconds: number;
}

export interface DirectionsRouteMetrics {
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  legs: DirectionsRouteLegMetric[];
}

/** State reported by an adapter-owned interactive directions session. */
export interface DirectionsRuntimeState {
  waypointCount: number;
  routeMetrics: DirectionsRouteMetrics | null;
  routeLoading: boolean;
  removalInFlight: boolean;
}

interface OsrmRouteLeg {
  distance?: unknown;
  duration?: unknown;
}

interface OsrmRoute {
  distance?: unknown;
  duration?: unknown;
  legs?: OsrmRouteLeg[];
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract a compact, validated metrics summary from the route payload returned
 * by the routing provider. The input remains structural so adapters do not
 * leak SDK-specific route types through the public contract.
 */
export function extractDirectionsRouteMetrics(value: unknown): DirectionsRouteMetrics | null {
  const routes =
    value && typeof value === "object" && Array.isArray((value as { routes?: unknown }).routes)
      ? (value as { routes: unknown[] }).routes
      : [];
  const route = routes[0] as OsrmRoute | undefined;
  if (!route) return null;

  const rawLegs = route.legs ?? [];
  const legs = rawLegs
    .map((leg) => {
      const distanceMeters = toFiniteNumber(leg.distance);
      const durationSeconds = toFiniteNumber(leg.duration);
      if (distanceMeters == null || durationSeconds == null) return null;
      return { distanceMeters, durationSeconds };
    })
    .filter((leg): leg is DirectionsRouteLegMetric => leg != null);

  const routeDistanceMeters = toFiniteNumber(route.distance);
  const routeDurationSeconds = toFiniteNumber(route.duration);
  const canUseLegTotals = rawLegs.length > 0 && legs.length === rawLegs.length;
  const totalDistanceMeters =
    routeDistanceMeters ??
    (canUseLegTotals ? legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) : null);
  const totalDurationSeconds =
    routeDurationSeconds ??
    (canUseLegTotals ? legs.reduce((sum, leg) => sum + leg.durationSeconds, 0) : null);

  if (
    totalDistanceMeters == null ||
    totalDurationSeconds == null ||
    totalDistanceMeters <= 0 ||
    totalDurationSeconds <= 0
  ) {
    return null;
  }
  return { totalDistanceMeters, totalDurationSeconds, legs };
}
