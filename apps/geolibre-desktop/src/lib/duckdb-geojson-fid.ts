import type { FeatureCollection } from "geojson";

/** GDAL's GeoJSON driver reserves this name for its implicit feature-id column. */
const RESERVED_FID_PROPERTY = "OGC_FID";

/**
 * Drop the reserved {@link RESERVED_FID_PROPERTY} property from every feature so
 * the FeatureCollection can be round-tripped through DuckDB's `ST_Read`.
 *
 * GDAL's GeoJSON driver always exposes an implicit feature-id column named
 * `OGC_FID`. A layer that originated from a GDAL export (commonly a GeoParquet
 * whose `read_parquet` columns include `OGC_FID`) carries that same name as a
 * regular GeoJSON *property*, so re-reading the GeoJSON through `ST_Read` yields
 * two `OGC_FID` columns and DuckDB aborts with `Binder Error: table "st_read"
 * has duplicate column name "OGC_FID"` (issue #944).
 *
 * The dropped value is not lost: `ST_Read` still surfaces it under the same
 * `OGC_FID` name via its implicit id column, so a processing tool that
 * aggregates by that field keeps working. Returns the input unchanged (no copy)
 * when no feature carries the property.
 *
 * @param geojson The FeatureCollection about to be handed to `ST_Read`.
 * @returns A FeatureCollection with no `OGC_FID` properties.
 */
export function stripReservedFidProperty(
  geojson: FeatureCollection,
): FeatureCollection {
  const hasReserved = geojson.features.some(
    (feature) =>
      feature.properties != null && RESERVED_FID_PROPERTY in feature.properties,
  );
  if (!hasReserved) return geojson;
  return {
    ...geojson,
    features: geojson.features.map((feature) => {
      if (
        feature.properties == null ||
        !(RESERVED_FID_PROPERTY in feature.properties)
      ) {
        return feature;
      }
      const { [RESERVED_FID_PROPERTY]: _ignored, ...rest } = feature.properties;
      return { ...feature, properties: rest };
    }),
  };
}
