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
    db.run("INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:t, :c)", {
      ":t": tableName,
      ":c": featureCount,
    });
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

function readOgrContents(bytes: Uint8Array): Array<{ table_name: string; feature_count: number }> {
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
    assert.equal(looksLikeSqlite(new TextEncoder().encode("not a database at all")), false);
  });
});

describe("ensureGpkgFeatureCountSync", () => {
  it("injects gpkg_ogr_contents when missing", () => {
    const original = buildGpkg({ withOgrContents: false, featureCount: 5 });
    const patched = ensureGpkgFeatureCountSync(SQL, original);

    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "places", feature_count: 5 }]);
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

  it("fills gaps when gpkg_ogr_contents exists but is incomplete", () => {
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE roads (fid INTEGER PRIMARY KEY, geom BLOB);
      CREATE TABLE rivers (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('roads', 'features', 4326);
      INSERT INTO gpkg_contents VALUES ('rivers', 'features', 4326);
      INSERT INTO roads (geom) VALUES (NULL);
      INSERT INTO rivers (geom) VALUES (NULL), (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents VALUES ('roads', 1);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [
      { table_name: "rivers", feature_count: 3 },
      { table_name: "roads", feature_count: 1 },
    ]);
  });

  it("repairs a NULL feature_count (the crash in issue #376)", () => {
    // A row exists but its count is NULL, so GDAL recomputes it on read and
    // crashes the single-threaded WASM build. The previous logic saw the row
    // and skipped the file; the fix must overwrite the NULL with a real count.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE swamps (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('swamps', 'features', 4326);
      INSERT INTO swamps (geom) VALUES (NULL), (NULL), (NULL), (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES ('swamps', NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "swamps", feature_count: 5 }]);
  });

  it("counts a feature table registered only in gpkg_geometry_columns", () => {
    // Out-of-spec producers sometimes register the geometry column without a
    // matching gpkg_contents 'features' row; the table is still a feature table
    // and still triggers the threaded count path, so it must be repaired.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL
      );
      CREATE TABLE mounds (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_geometry_columns VALUES ('mounds', 'geom', 'POLYGON', 4326, 0, 0);
      INSERT INTO mounds (geom) VALUES (NULL), (NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "mounds", feature_count: 2 }]);
  });

  it("updates a NULL count for a table registered only in gpkg_geometry_columns", () => {
    // Exercises the UPDATE branch of the geometry-columns path: the table is
    // absent from gpkg_contents but has a NULL-count gpkg_ogr_contents row, so
    // the repair must UPDATE that row rather than INSERT a duplicate.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL
      );
      CREATE TABLE mounds (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_geometry_columns VALUES ('mounds', 'geom', 'POLYGON', 4326, 0, 0);
      INSERT INTO mounds (geom) VALUES (NULL), (NULL), (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES ('mounds', NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "mounds", feature_count: 4 }]);
  });

  it("matches table names case-insensitively and normalises to the canonical casing", () => {
    // gpkg_contents and gpkg_ogr_contents disagree on casing for the same
    // (case-insensitive) SQLite table. The repair must treat them as one table,
    // UPDATE the existing NULL row rather than INSERT a duplicate, and rewrite
    // table_name to the gpkg_contents spelling so GDAL's case-sensitive lookup
    // finds it.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE "Places" (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('Places', 'features', 4326);
      INSERT INTO "Places" (geom) VALUES (NULL), (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES ('places', NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "Places", feature_count: 3 }]);
  });

  it("repairs a non-ASCII table name whose count is NULL", () => {
    // SQLite's lower() is ASCII-only, so a `lower(table_name) = :key` predicate
    // would never match a non-ASCII name; matching on the exact stored name
    // keeps the UPDATE working here.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE "Über" (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('Über', 'features', 4326);
      INSERT INTO "Über" (geom) VALUES (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES ('Über', NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "Über", feature_count: 2 }]);
  });

  it("deduplicates a table listed in both gpkg_contents and gpkg_geometry_columns", () => {
    // A conformant GeoPackage registers each feature table in both tables. The
    // union must collapse to one entry so only a single gpkg_ogr_contents row is
    // written, not two.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE gpkg_geometry_columns (
        table_name TEXT NOT NULL, column_name TEXT NOT NULL,
        geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL
      );
      CREATE TABLE lakes (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('lakes', 'features', 4326);
      INSERT INTO gpkg_geometry_columns VALUES ('lakes', 'geom', 'POLYGON', 4326, 0, 0);
      INSERT INTO lakes (geom) VALUES (NULL), (NULL), (NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "lakes", feature_count: 3 }]);
  });

  it("recomputes a negative (dirty) feature_count", () => {
    // GDAL stores -1 as an invalid/dirty sentinel and recomputes the count for
    // it (the multithreaded path that crashes WASM), so it must be repaired even
    // though typeof(-1) is 'integer'.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE swamps (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('swamps', 'features', 4326);
      INSERT INTO swamps (geom) VALUES (NULL), (NULL);
      CREATE TABLE gpkg_ogr_contents (
        table_name TEXT NOT NULL PRIMARY KEY, feature_count INTEGER
      );
      INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES ('swamps', -1);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    assert.deepEqual(readOgrContents(patched), [{ table_name: "swamps", feature_count: 2 }]);
  });

  it("skips an unreadable phantom table and still repairs the others", () => {
    // gpkg_contents lists a table that does not exist as a real SQLite table
    // (a deleted/virtual/view entry). count(*) on it throws; the repair must
    // skip it and still patch the readable feature table.
    const db: Database = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, srs_id INTEGER
      );
      CREATE TABLE real_table (fid INTEGER PRIMARY KEY, geom BLOB);
      INSERT INTO gpkg_contents VALUES ('real_table', 'features', 4326);
      INSERT INTO gpkg_contents VALUES ('ghost_table', 'features', 4326);
      INSERT INTO real_table (geom) VALUES (NULL), (NULL);
    `);
    const original = db.export();
    db.close();

    const patched = ensureGpkgFeatureCountSync(SQL, original);
    assert.notEqual(patched, original);
    // ghost_table is silently skipped; real_table is repaired.
    assert.deepEqual(readOgrContents(patched), [{ table_name: "real_table", feature_count: 2 }]);
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
