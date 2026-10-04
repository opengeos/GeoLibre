import type { Feature, FeatureCollection, Geometry } from "geojson";

// GeoJSON (RFC 7946 section 3.2) allows an unlocated feature, `"geometry":
// null`, and real data carries it: a joined CSV table, a WFS feature without a
// shape, a CZML row. The code under test handles it, but the default `Feature`
// and `FeatureCollection` type parameters in `@types/geojson` (and so
// `GeoLibreLayer.geojson`) exclude `null`. Tests that exercise the null case
// use these instead of scattering casts.

/** A feature's `null` geometry, typed as `Geometry`. */
export const NULL_GEOMETRY = null as unknown as Geometry;

/**
 * Pass a feature collection that holds null geometries to an API typed as
 * `FeatureCollection`.
 *
 * @param collection A collection whose features may have null geometry.
 * @returns The same object, typed as a plain `FeatureCollection`.
 */
export function withNullGeometries(
  collection: FeatureCollection<Geometry | null>,
): FeatureCollection {
  return collection as FeatureCollection;
}

/**
 * Single-feature form of {@link withNullGeometries}.
 *
 * @param feature A feature whose geometry may be null.
 * @returns The same object, typed as a plain `Feature`.
 */
export function withNullGeometry(feature: Feature<Geometry | null>): Feature {
  return feature as Feature;
}
