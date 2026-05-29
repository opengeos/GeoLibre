import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { Feature, FeatureCollection, Geometry } from "geojson";

const GEOMETRY_JSON_COLUMN = "__geolibre_geometry_geojson";

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbWasmMvp,
    mainWorker: mvpWorker,
  },
  eh: {
    mainModule: duckdbWasmEh,
    mainWorker: ehWorker,
  },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

interface DuckDbRow {
  toJSON?: () => Record<string, unknown>;
  [key: string]: unknown;
}

export interface DuckDbVectorFile {
  name: string;
  extension: string;
  data: Uint8Array<ArrayBuffer>;
  siblingFiles?: DuckDbVectorFile[];
}

function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= createDatabase();
  return dbPromise;
}

async function createDatabase(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowsFromResult(result: { toArray: () => DuckDbRow[] }) {
  return result.toArray().map((row) =>
    typeof row.toJSON === "function" ? row.toJSON() : { ...row },
  );
}

function sourceSql(fileName: string, extension: string): string {
  const quotedName = quoteSqlString(fileName);
  if (extension === "parquet" || extension === "geoparquet") {
    return `SELECT * FROM read_parquet(${quotedName})`;
  }
  return `SELECT * FROM ST_Read(${quotedName})`;
}

function toFeatureCollection(rows: Record<string, unknown>[]): FeatureCollection {
  const features = rows.map((row) => {
    const rawGeometry = row[GEOMETRY_JSON_COLUMN];
    if (typeof rawGeometry !== "string") {
      throw new Error("DuckDB returned a feature without GeoJSON geometry.");
    }
    const geometry = JSON.parse(rawGeometry) as Geometry;
    const properties: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (key === GEOMETRY_JSON_COLUMN || value instanceof Uint8Array) continue;
      properties[key] = normalizePropertyValue(value);
    }

    return {
      type: "Feature",
      geometry,
      properties,
    } satisfies Feature;
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function normalizePropertyValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePropertyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizePropertyValue(item),
      ]),
    );
  }
  return value;
}

export async function loadDuckDbVectorFile(
  file: DuckDbVectorFile,
): Promise<FeatureCollection> {
  const db = await getDatabase();
  const connection = await db.connect();

  try {
    await db.registerFileBuffer(file.name, file.data);
    for (const sibling of file.siblingFiles ?? []) {
      await db.registerFileBuffer(sibling.name, sibling.data);
    }
    await connection.query("INSTALL spatial");
    await connection.query("LOAD spatial");

    const sql = sourceSql(file.name, file.extension);
    const description = rowsFromResult(
      await connection.query(`DESCRIBE ${sql}`),
    );
    const geometryColumn = description.find(
      (row) =>
        typeof row.column_type === "string" &&
        row.column_type.toUpperCase() === "GEOMETRY",
    )?.column_name;

    if (typeof geometryColumn !== "string") {
      throw new Error("DuckDB did not find a GEOMETRY column in this file.");
    }

    const result = await connection.query(
      `SELECT *, ST_AsGeoJSON(${quoteIdentifier(
        geometryColumn,
      )}) AS ${quoteIdentifier(GEOMETRY_JSON_COLUMN)} FROM (${sql}) AS data`,
    );
    return toFeatureCollection(rowsFromResult(result));
  } finally {
    await connection.close();
  }
}
