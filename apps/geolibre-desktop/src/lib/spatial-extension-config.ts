// The shared implementation lives in @geolibre/core so the desktop loader and
// the maplibre-gl-vector plugin resolve VITE_DUCKDB_SPATIAL_EXTENSION_PATH the
// same way. Re-exported here to keep this module path stable for existing
// importers (sql-workspace, duckdb-vector-loader, ...).
export { getSpatialExtensionPath } from "@geolibre/core";
