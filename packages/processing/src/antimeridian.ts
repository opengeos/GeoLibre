import type { Geometry } from "geojson";

/**
 * Unwrap successive ring vertices so consecutive longitudes stay within 180°.
 * DuckDB H3 / duck_dggs emit longitudes in [-180, 180]; dateline-straddling
 * cells then draw the long way around MapLibre unless vertices are shifted
 * into an adjacent world copy.
 */
export function unwrapAntimeridianRing(ring: number[][]): number[][] {
  if (ring.length === 0) return ring;
  const firstLon = ring[0]![0]!;
  const firstLat = ring[0]![1]!;
  const last = ring[ring.length - 1]!;
  const closed = ring.length > 1 && last[0] === firstLon && last[1] === firstLat;
  const limit = closed ? ring.length - 1 : ring.length;

  // Preserve elevation / M and any further components; only longitude shifts.
  const out: number[][] = [[...ring[0]!]];
  for (let i = 1; i < limit; i += 1) {
    let lon = ring[i]![0]!;
    const rest = ring[i]!.slice(1);
    const prev = out[i - 1]![0]!;
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ...rest]);
  }
  if (closed) out.push([...out[0]!]);
  return out;
}

/** Unwrap Polygon / MultiPolygon rings across ±180°; other geometry types pass through. */
export function unwrapAntimeridianGeometry(geometry: Geometry): Geometry {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map(unwrapAntimeridianRing),
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly) => poly.map(unwrapAntimeridianRing)),
    };
  }
  return geometry;
}
