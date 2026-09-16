import { geoArea, geoEqualEarth } from "d3-geo";
import type { FeatureCollection, Geometry, Position } from "geojson";

export const EQUAL_EARTH_MAX_ZOOM = 3;

/** A fixed central meridian keeps the antimeridian seam stable while panning. */
export function overviewProjection(
  width: number,
  height: number,
  zoom: number,
  center: [number, number],
) {
  const projection = geoEqualEarth()
    .scale((512 * 2 ** zoom) / (2 * Math.PI))
    .translate([0, 0]);
  const point = projection(center)!;
  return projection.translate([width / 2 - point[0], height / 2 - point[1]]);
}

/** D3 spherical polygons use clockwise shells, unlike RFC 7946 GeoJSON. */
export function sphericalGeoJSON(data: FeatureCollection): FeatureCollection {
  const polygon = (rings: Position[][]) =>
    rings.map((ring, index) => {
      const clockwise = geoArea({ type: "Polygon", coordinates: [ring] }) <= 2 * Math.PI;
      return clockwise === (index === 0) ? ring : [...ring].reverse();
    });
  const geometry = (g: Geometry): Geometry => {
    if (g.type === "Polygon") return { ...g, coordinates: polygon(g.coordinates) };
    if (g.type === "MultiPolygon") return { ...g, coordinates: g.coordinates.map(polygon) };
    if (g.type === "GeometryCollection") return { ...g, geometries: g.geometries.map(geometry) };
    return g;
  };
  return {
    type: "FeatureCollection",
    features: data.features.map((f) => ({ ...f, geometry: f.geometry && geometry(f.geometry) })),
  };
}
