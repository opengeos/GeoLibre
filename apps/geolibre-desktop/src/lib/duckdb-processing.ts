import type {
  DuckDbCapability,
  DuckDbGeoJsonSource,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { stripReservedFidProperty } from "./duckdb-geojson-fid";
import {
  ensureH3Extension,
  ensureSpatialExtension,
  getDatabase,
  quoteSqlString,
  rowsFromResult,
} from "./duckdb-vector-loader";

let counter = 0;

/**
 * A {@link DuckDbCapability} backed by the shared DuckDB-WASM instance. Each
 * call opens a short-lived connection; loaded extensions persist at the
 * database level, so `ensureExtensions` and `query` may use separate
 * connections safely.
 */
export function createDuckDbCapability(): DuckDbCapability {
  return {
    async ensureExtensions(names: string[]): Promise<void> {
      const db = await getDatabase();
      const connection = await db.connect();
      try {
        if (names.includes("spatial")) await ensureSpatialExtension(connection);
        if (names.includes("h3")) await ensureH3Extension(connection);
      } finally {
        await connection.close();
      }
    },

    async registerGeoJson(
      geojson: FeatureCollection,
    ): Promise<DuckDbGeoJsonSource> {
      const db = await getDatabase();
      counter += 1;
      const name = `__geolibre_geojson_${Date.now()}_${counter}.geojson`;
      await db.registerFileText(
        name,
        JSON.stringify(stripReservedFidProperty(geojson)),
      );
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
