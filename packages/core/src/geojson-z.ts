import type {
  Feature,
  FeatureCollection,
  GeoJSON,
  Geometry,
  Position,
} from "geojson";

/**
 * Helpers for vector data whose coordinates carry a Z value (elevation), e.g.
 * GPX tracks with `<ele>` readings or LineStringZ/PointZ geometries. MapLibre's
 * 2D style layers ignore the third coordinate, so layers that want to render
 * their Z values use these helpers to detect and rescale elevations before
 * handing the data to a deck.gl overlay.
 */

/**
 * Returns true when any coordinate in the GeoJSON carries a finite, non-zero
 * Z value. All-zero Z arrays are treated as flat data because rendering them
 * "in 3D" would be indistinguishable from the 2D result.
 *
 * @param geojson - Any GeoJSON object (geometry, feature, or collection).
 */
export function geojsonHasZCoordinates(
  geojson: GeoJSON | null | undefined,
): boolean {
  if (!geojson) return false;
  return someGeometry(geojson, (geometry) =>
    somePosition(geometry, (position) => {
      const z = position[2];
      return typeof z === "number" && Number.isFinite(z) && z !== 0;
    }),
  );
}

/**
 * Returns a copy of the GeoJSON with every coordinate's Z value mapped to
 * `z * verticalScale + offset` (missing Z treated as 0). Used to apply
 * vertical exaggeration and a constant altitude offset before 3D rendering.
 * When the transform is the identity (`verticalScale === 1 && offset === 0`)
 * the input is returned unchanged.
 *
 * @param geojson - The feature collection to transform.
 * @param verticalScale - Multiplier applied to each Z value.
 * @param offset - Constant altitude in meters added after scaling.
 */
export function transformGeojsonElevation(
  geojson: FeatureCollection,
  verticalScale: number,
  offset: number,
): FeatureCollection {
  if (verticalScale === 1 && offset === 0) return geojson;
  // Positions are normalized to [x, y, z]; a 4th measure value (M), which
  // some producers emit, is intentionally dropped — nothing downstream of
  // this render path consumes it.
  const mapPosition = (position: Position): Position => [
    position[0],
    position[1],
    (typeof position[2] === "number" && Number.isFinite(position[2])
      ? position[2]
      : 0) *
      verticalScale +
      offset,
  ];
  return {
    ...geojson,
    features: geojson.features.map((feature) => ({
      ...feature,
      geometry: mapGeometryPositions(feature.geometry, mapPosition),
    })),
  };
}

function someGeometry(
  geojson: GeoJSON,
  predicate: (geometry: Geometry) => boolean,
): boolean {
  switch (geojson.type) {
    case "FeatureCollection":
      return geojson.features.some((feature) =>
        feature.geometry ? someGeometry(feature.geometry, predicate) : false,
      );
    case "Feature":
      return geojson.geometry
        ? someGeometry(geojson.geometry, predicate)
        : false;
    case "GeometryCollection":
      return geojson.geometries.some((geometry) =>
        someGeometry(geometry, predicate),
      );
    default:
      return predicate(geojson);
  }
}

function somePosition(
  geometry: Geometry,
  predicate: (position: Position) => boolean,
): boolean {
  switch (geometry.type) {
    case "Point":
      return predicate(geometry.coordinates);
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates.some(predicate);
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.some((ring) => ring.some(predicate));
    case "MultiPolygon":
      return geometry.coordinates.some((polygon) =>
        polygon.some((ring) => ring.some(predicate)),
      );
    case "GeometryCollection":
      return geometry.geometries.some((child) =>
        somePosition(child, predicate),
      );
    default:
      return false;
  }
}

function mapGeometryPositions(
  geometry: Feature["geometry"],
  mapPosition: (position: Position) => Position,
): Feature["geometry"] {
  if (!geometry) return geometry;
  switch (geometry.type) {
    case "Point":
      return { ...geometry, coordinates: mapPosition(geometry.coordinates) };
    case "MultiPoint":
    case "LineString":
      return { ...geometry, coordinates: geometry.coordinates.map(mapPosition) };
    case "MultiLineString":
    case "Polygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((ring) => ring.map(mapPosition)),
      };
    case "MultiPolygon":
      return {
        ...geometry,
        coordinates: geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map(mapPosition)),
        ),
      };
    case "GeometryCollection":
      return {
        ...geometry,
        geometries: geometry.geometries.map(
          (child) => mapGeometryPositions(child, mapPosition) as Geometry,
        ),
      };
    default:
      return geometry;
  }
}
