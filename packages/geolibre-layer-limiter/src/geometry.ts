/**
 * Fast Planar Geodesic Shoelace Approximation for Ring Coordinates
 */
export function computeRingAreaHectares(coords: number[][]): number {
  if (!coords || coords.length < 3) return 0.0;
  let sum = 0.0;
  const n = coords.length;

  let centerLat = 0.0;
  for (let i = 0; i < n; i++) {
    centerLat += coords[i][1];
  }
  centerLat = (centerLat / n) * (Math.PI / 180.0);

  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * centerLat) + 1.175 * Math.cos(4 * centerLat);
  const mPerDegLng = 111412.84 * Math.cos(centerLat) - 93.5 * Math.cos(3 * centerLat);

  for (let i = 0; i < n - 1; i++) {
    const x1 = coords[i][0] * mPerDegLng;
    const y1 = coords[i][1] * mPerDegLat;
    const x2 = coords[i + 1][0] * mPerDegLng;
    const y2 = coords[i + 1][1] * mPerDegLat;
    sum += x1 * y2 - x2 * y1;
  }

  const areaSqMeters = Math.abs(sum) / 2.0;
  return areaSqMeters / 10000.0; // In hectares
}

export interface FeatureLike {
  type?: string;
  properties?: Record<string, unknown> | null;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  } | null;
}

/**
 * Extracts or estimates polygon surface area in hectares
 */
export function getFeatureArea(feature: FeatureLike, sortProperty: string = "area_ha"): number {
  if (!feature) return 0.0;

  if (feature.properties) {
    const propCandidates = [
      sortProperty,
      "area_ha",
      "area",
      "st_area",
      "shape_area",
      "AREA_HA",
      "Shape__Area",
    ];
    for (const prop of propCandidates) {
      if (
        prop in feature.properties &&
        feature.properties[prop] !== null &&
        feature.properties[prop] !== undefined
      ) {
        const rawVal = feature.properties[prop];
        const val = typeof rawVal === "number" ? rawVal : parseFloat(String(rawVal));
        if (!isNaN(val) && val > 0) {
          if (prop === "shape_area" || prop === "Shape__Area" || prop === "st_area") {
            return val > 100000000 ? val / 10000.0 : val > 1000 ? val / 10000.0 : val;
          }
          return val;
        }
      }
    }
  }

  const geom = feature.geometry;
  if (!geom || !geom.coordinates) return 0.0;

  let totalHa = 0.0;
  if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
    totalHa += computeRingAreaHectares(geom.coordinates[0] as number[][]);
  } else if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    for (let i = 0; i < geom.coordinates.length; i++) {
      const poly = geom.coordinates[i];
      if (Array.isArray(poly)) {
        totalHa += computeRingAreaHectares(poly[0] as number[][]);
      }
    }
  }
  return totalHa;
}

/**
 * Quick Bounding Box Intersection Test between Feature and Viewport
 */
export function isFeatureInBBox(
  feature: FeatureLike,
  bbox: [number, number, number, number] | null
): boolean {
  if (!bbox) return true;
  const [minX, minY, maxX, maxY] = bbox;
  const geom = feature.geometry;
  if (!geom || !geom.coordinates) return false;

  let fMinX = Infinity;
  let fMinY = Infinity;
  let fMaxX = -Infinity;
  let fMaxY = -Infinity;

  function expand(c: unknown): void {
    if (Array.isArray(c)) {
      if (typeof c[0] === "number" && typeof c[1] === "number") {
        if (c[0] < fMinX) fMinX = c[0];
        if (c[0] > fMaxX) fMaxX = c[0];
        if (c[1] < fMinY) fMinY = c[1];
        if (c[1] > fMaxY) fMaxY = c[1];
      } else {
        for (let i = 0; i < c.length; i++) expand(c[i]);
      }
    }
  }

  expand(geom.coordinates);
  return !(fMaxX < minX || fMinX > maxX || fMaxY < minY || fMinY > maxY);
}
