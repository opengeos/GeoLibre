import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import {
  ensureGpkgFeatureCountSync,
  looksLikeSqlite,
} from "../apps/geolibre-desktop/src/lib/gpkg-ogr-contents";

const require = createRequire(import.meta.url);

let SQL: SqlJsStatic;

before(async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({ locateFile: () => wasmPath });
});

/** Build a minimal in-memory GeoPackage and return its bytes. */
function buildGpkg(options: {
  withOgrContents?: boolean;
  featureCount?: number;
  tableName?: string;
}): Uint8Array {
  const tableName = options.tableName ?? "places";
  const featureCount = options.featureCount ?? 3;
  const db: Database = new SQL.Database();
  db.run(`
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY,
      data_type TEXT NOT NULL,
      identifier TEXT,
      description TEXT,
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER
    );
    CREATE TABLE "${tableName}" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
  `);
  db.run(
    "INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES (:t, 'features', 4326)",
    { ":t": tableName },
  );
  for (let i = 0; i < featureCount; i += 1) {
    db.run(`INSERT INTO "${tableName}" (name) VALUES (:n)`, {
      ":n": `feature-${i}`,
    });
  }
  if (options.withOgrContents) {
    db.run(
      "CREATE TABLE gpkg_ogr_contents (table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER)",
    );
    db.run(
      "INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:t, :c)",
      { ":t": tableName, ":c": featureCount },
    );
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

function readOgrContents(
  bytes: Uint8Array,
): Array<{ table_name: string; feature_count: number }> {
  const db = new SQL.Database(bytes);
  try {
    const result = db.exec(
      "SELECT table_name, feature_count FROM gpkg_ogr_contents ORDER BY table_name",
    );
    if (result.length === 0) return [];
    return result[0].values.map((row) => ({
      table_name: row[0] as string,
      feature_count: row[1] as number,
    }));
  } finally {
    db.close();
  }
}

describe("looksLikeSqlite", () => {
  it("detects the SQLite magic header", () => {
    assert.equal(looksLikeSqlite(buildGpkg({})), true);
  });

  it("rejects non-SQLite buffers", () => {
    assert.equal(looksLikeSqlite(new Uint8Array([1, 2, 3, 4])), false);
    assert.equal(
      looksLikeSqlite(new TextEncoder().encode("not a database at all")),
      false,
    );
  });
});

describe("ensureGpkgFeatureCountSync", () => {
  it("injects gpkg_ogr_contents when missing", () => {
    const original = buildGpkg({ withOgrContents: false, featureCount: 5 });
    const patched = ensureGpkgFeatureCountSync(SQL, original);

    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [
      { table_name: "places", feature_count: 5 },
    ]);
  });

  it("adds a row for every feature table", () => {
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE roads (fid INTEGER PRIMARY KEY, geom BLOB);
      CREATE TABLE rivers (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('roads', 'features', 4326);
      INSERT INTO gpkg_contents VALUES ('rivers', 'features', 4326);
      INSERT INTO roads (geom) VALUES (NULL), (NULL);
      INSERT INTO rivers (geom) VALUES (NULL), (NULL), (NULL), (NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.deepEqual(readOgrContents(patched), [
      { table_name: "rivers", feature_count: 4 },
      { table_name: "roads", feature_count: 2 },
    ]);
  });

  it("leaves a complete GeoPackage untouched", () => {
    const original = buildGpkg({ withOgrContents: true, featureCount: 3 });
    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.equal(patched, original);
  });

  it("ignores SQLite databases that are not GeoPackages", () => {
    const db: Database = new SQL.Database();
    db.run("CREATE TABLE notes (id INTEGER, body TEXT); INSERT INTO notes VALUES (1, 'hi');");
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.equal(patched, original);
  });
});
