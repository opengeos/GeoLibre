import type { Geometry, Position } from "geojson";

/**
 * Whether `lngLat` is on `geometry`, with `tolerance` in degrees of longitude
 * (already scaled for latitude by the caller) for points and lines. A pure
 * geometric test the engine uses for the synchronous identify, which the SDK
 * can only answer asynchronously.
 */
export function geometryContainsPoint(
  geometry: Geometry,
  lngLat: [number, number],
  tolerance: number,
): boolean {
  const [x, y] = lngLat;
  const near = (p: Position) => Math.hypot(p[0] - x, p[1] - y) <= tolerance;
  const nearSegment = (a: Position, b: Position) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const t =
      length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length));
    return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) <= tolerance;
  };
  const nearLine = (line: Position[]) => line.some((p, i) => i > 0 && nearSegment(line[i - 1], p));
  const inRing = (ring: Position[]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i],
        [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPolygon = (rings: Position[][]) =>
    rings.length > 0 && inRing(rings[0]) && !rings.slice(1).some(inRing);
  switch (geometry.type) {
    case "Point":
      return near(geometry.coordinates);
    case "MultiPoint":
      return geometry.coordinates.some(near);
    case "LineString":
      return nearLine(geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.some(nearLine);
    case "Polygon":
      return inPolygon(geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.some(inPolygon);
    case "GeometryCollection":
      return geometry.geometries.some((g) => geometryContainsPoint(g, lngLat, tolerance));
    default:
      return false;
  }
}
