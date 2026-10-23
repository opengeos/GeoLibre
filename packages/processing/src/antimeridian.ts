import type { GeoJSON, Geometry, Position } from "geojson";

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

function eachPosition(geometry: Geometry, visit: (position: Position) => void): void {
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      for (const position of geometry.coordinates) visit(position);
      return;
    case "MultiLineString":
    case "Polygon":
      for (const line of geometry.coordinates) for (const position of line) visit(position);
      return;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) for (const position of ring) visit(position);
      }
      return;
    case "GeometryCollection":
      for (const child of geometry.geometries) eachPosition(child, visit);
      return;
    default:
      return;
  }
}

/** Every longitude in `geojson`, skipping features whose geometry is null. */
function longitudesOf(geojson: GeoJSON): number[] {
  const lons: number[] = [];
  const visit = (position: Position) => {
    if (typeof position[0] === "number" && Number.isFinite(position[0])) lons.push(position[0]);
  };
  const walk = (node: GeoJSON) => {
    switch (node.type) {
      case "FeatureCollection":
        for (const feature of node.features) if (feature.geometry) walk(feature.geometry);
        return;
      case "Feature":
        if (node.geometry) walk(node.geometry);
        return;
      case "GeometryCollection":
        for (const child of node.geometries) walk(child);
        return;
      default:
        eachPosition(node as Geometry, visit);
    }
  };
  walk(geojson);
  return lons;
}

/**
 * The narrowest band of longitude that can hold every value in `lons`, as the
 * two longitudes it runs between — eastward from `from` to `to`, so `to` may
 * be the smaller of the two — or `null` when the values are spread around so
 * much of the globe that no band of 180° or less fits them.
 *
 * Every set of longitudes has two readings, a band and the rest of the circle,
 * and only the emptier one can be the layer's real extent. Cutting the circle
 * at its widest empty gap picks exactly that band, which is what tells a
 * dateline-straddling layer apart from a genuinely global one: Fiji's vertices
 * leave one huge gap across the Pacific, a world coastline leaves none.
 */
function narrowestLonBand(lons: number[]): [number, number] | null {
  if (lons.length === 0) return null;
  const sorted = [...lons].sort((a, b) => a - b);
  let widest = -1;
  let from = sorted[0]!;
  let to = sorted[0]!;
  for (let i = 0; i < sorted.length; i += 1) {
    // The gap after the last value closes the circle back round to the first.
    const last = i === sorted.length - 1;
    const next = last ? sorted[0]! : sorted[i + 1]!;
    const gap = (last ? next + 360 : next) - sorted[i]!;
    if (gap > widest) {
      widest = gap;
      from = next;
      to = sorted[i]!;
    }
  }
  const width = to >= from ? to - from : to - from + 360;
  return width <= 180 ? [from, to] : null;
}

/**
 * Split a layer's longitude extent into parts that each stay inside
 * [-180, 180] with `west <= east`, so a downstream WKT ring cannot be read as
 * sweeping the long way around the globe. Most layers come back as a single
 * part; only a layer that straddles the dateline comes back as two.
 *
 * A bounding box on its own cannot make that call: Fiji's real extent and a
 * world coastline layer both read as a box wider than 180°. So the decision is
 * made from the coordinates — the extent is narrowed to its narrowest band only
 * while that band is 180° or less, and a band reaching past the dateline is
 * cut in two there. Anything wider keeps the full-longitude box, which is what
 * a truly global layer deserves.
 *
 * @param geojson - The layer the box was measured from, the source of the
 *   longitudes this decides on.
 * @param box - Its extent, `[west, south, east, north]`, supplying the
 *   latitudes and the fallback for a layer with no usable coordinates.
 */
export function datelineBboxParts(
  geojson: GeoJSON,
  box: [number, number, number, number],
): [number, number, number, number][] {
  const [west, south, east, north] = box;
  // Most layers are nowhere near the seam, and their own box already says so.
  if (west <= east && east - west <= 180) return [box];
  const band = narrowestLonBand(longitudesOf(geojson));
  if (!band) return [[-180, south, 180, north]];
  const [from, to] = band;
  // `from` landing beyond `to` means the band runs over the seam.
  if (from <= to) return [[from, south, to, north]];
  return [
    [from, south, 180, north],
    [-180, south, to, north],
  ];
}
