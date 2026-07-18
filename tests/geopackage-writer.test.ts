import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";
import type { FeatureCollection } from "geojson";
import { writeGeoPackageSync } from "../apps/geolibre-desktop/src/lib/geopackage-writer";

const require = createRequire(import.meta.url);

let SQL: SqlJsStatic;

before(async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({ locateFile: () => wasmPath });
});

const SAMPLE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10, 20] },
      properties: { name: "Alpha", value: 12, ratio: 1.5, ok: true },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-30, 40] },
      properties: { name: "Bravo", value: 34, ratio: 2.25, ok: false },
    },
  ],
};

describe("writeGeoPackage", () => {
  it("produces a valid GeoPackage SQLite file", () => {
    const bytes = writeGeoPackageSync(SQL, SAMPLE, "places");
    assert.equal(Buffer.from(bytes.subarray(0, 16)).toString("latin1"), "SQLite format 3\0");

    const db = new SQL.Database(bytes);
    try {
      // application_id must be the GeoPackage magic "GPKG".
      const appId = db.exec("PRAGMA application_id")[0].values[0][0];
      assert.equal(appId, 0x47504b47);

      // The required metadata tables exist.
      const tables = new Set(
        db
          .exec("SELECT name FROM sqlite_master WHERE type='table'")[0]
          .values.map((row) => String(row[0])),
      );
      for (const required of [
        "gpkg_spatial_ref_sys",
        "gpkg_contents",
        "gpkg_geometry_columns",
        "gpkg_ogr_contents",
        "places",
      ]) {
        assert.ok(tables.has(required), `missing table ${required}`);
      }

      // gpkg_contents registers the feature table in WGS84 with a bbox.
      const contents = db.exec(
        "SELECT data_type, srs_id, min_x, max_x FROM gpkg_contents WHERE table_name='places'",
      )[0].values[0];
      assert.equal(contents[0], "features");
      assert.equal(contents[1], 4326);
      assert.equal(contents[2], -30);
      assert.equal(contents[3], 10);

      // gpkg_ogr_contents carries the feature count so readers stay on the fast path.
      const count = db.exec(
        "SELECT feature_count FROM gpkg_ogr_contents WHERE table_name='places'",
      )[0].values[0][0];
      assert.equal(count, 2);

      // Rows round-trip with their attribute values and a non-null geometry blob.
      const rows = db.exec("SELECT name, value, ratio, ok, geom FROM places ORDER BY fid")[0];
      assert.deepEqual(
        rows.values.map((r) => [r[0], r[1], r[2], r[3]]),
        [
          ["Alpha", 12, 1.5, 1],
          ["Bravo", 34, 2.25, 0],
        ],
      );
      // The geometry blob starts with the GeoPackage "GP" magic.
      const blob = rows.values[0][4] as Uint8Array;
      assert.equal(blob[0], 0x47);
      assert.equal(blob[1], 0x50);
    } finally {
      db.close();
    }
  });

  it("rejects an empty FeatureCollection", () => {
    assert.throws(() => writeGeoPackageSync(SQL, { type: "FeatureCollection", features: [] }, "x"));
  });
});
