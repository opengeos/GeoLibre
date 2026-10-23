import type { DuckDbCapability, DuckDbGeoJsonSource } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { stripAutoFidColumn } from "./duckdb-geometry";

let counter = 0;

/**
 * Imports the DuckDB loader on first use. The processing dialogs that build a
 * capability stay mounted from startup, so a static import would put the loader
 * and its Arrow dependency on the startup path.
 *
 * @returns The DuckDB vector loader module.
 */
function loadDuckDbLoader(): Promise<typeof import("./duckdb-vector-loader")> {
  return import("./duckdb-vector-loader");
}

/**
 * A {@link DuckDbCapability} backed by the shared DuckDB-WASM instance. Each
 * call opens a short-lived connection; loaded extensions persist at the
 * database level, so `ensureExtensions` and `query` may use separate
 * connections safely.
 */
export function createDuckDbCapability(): DuckDbCapability {
  return {
    async ensureExtensions(names: string[]): Promise<void> {
      const {
        ensureA5Extension,
        ensureDuckDggsExtension,
        ensureH3Extension,
        ensureSpatialExtension,
        getDatabase,
      } = await loadDuckDbLoader();
      const db = await getDatabase();
      const connection = await db.connect();
      try {
        if (names.includes("spatial")) await ensureSpatialExtension(db, connection);
        if (names.includes("h3")) await ensureH3Extension(connection);
        if (names.includes("a5")) await ensureA5Extension(connection);
        if (names.includes("duck_dggs")) await ensureDuckDggsExtension(connection);
      } finally {
        await connection.close();
      }
    },

    async registerGeoJson(geojson: FeatureCollection): Promise<DuckDbGeoJsonSource> {
      const { getDatabase, quoteSqlString } = await loadDuckDbLoader();
      const db = await getDatabase();
      counter += 1;
      const name = `__geolibre_geojson_${Date.now()}_${counter}.geojson`;
      // Drop any reserved OGC_FID property before ST_Read re-reads the file:
      // a layer from a GDAL export (e.g. a GeoParquet whose columns include
      // OGC_FID) carries it as a property, and GDAL's GeoJSON driver adds its
      // own OGC_FID id column, so the read aborts with a duplicate-column
      // binder error (issues #499, #944).
      await db.registerFileText(name, JSON.stringify(stripAutoFidColumn(geojson)));
      return {
        sql: `ST_Read(${quoteSqlString(name)})`,
        async release(): Promise<void> {
          try {
            await db.dropFiles([name]);
          } catch {
            // File may already be gone; releasing twice is harmless.
          }
        },
      };
    },

    async query(sql: string): Promise<Record<string, unknown>[]> {
      const { getDatabase, rowsFromResult } = await loadDuckDbLoader();
      const db = await getDatabase();
      const connection = await db.connect();
      try {
        return rowsFromResult(await connection.query(sql));
      } finally {
        await connection.close();
      }
    },
  };
}
