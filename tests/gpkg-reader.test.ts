import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import type { Geometry } from "geojson";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { encodeWkb } from "../apps/geolibre-desktop/src/lib/geometry-wkb";
import {
  isLikelyGeoPackage,
  readGeoPackageSync,
  stripGeoPackageHeader,
} from "../apps/geolibre-desktop/src/lib/gpkg-reader";

const require = createRequire(import.meta.url);
let SQL: SqlJsStatic;

before(async () => {
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  SQL = await initSqlJs({ locateFile: () => wasmPath });
});

/** Wrap WKB in a minimal little-endian GeoPackage geometry blob (no envelope). */
function geoPackageBlob(geometry: Geometry, srsId = 4326): Uint8Array {
  const wkb = encodeWkb(geometry);
  const blob = new Uint8Array(8 + wkb.length);
  const view = new DataView(blob.buffer);
  blob[0] = 0x47; // 'G'
  blob[1] = 0x50; // 'P'
  blob[2] = 0x00; // version
  blob[3] = 0x01; // flags: little-endian header, no envelope
  view.setInt32(4, srsId, true);
  blob.set(wkb, 8);
  return blob;
}

interface FeatureSpec {
  geometry: Geometry | null;
  name: string;
}

/** Build a single-layer GeoPackage with a geom + name column from specs. */
function buildGpkg(
  features: FeatureSpec[],
  options: { srsId?: number; srs?: { id: number; org: string; code: number } } = {},
): Uint8Array {
  const srsId = options.srsId ?? 4326;
  const db: Database = new SQL.Database();
  db.run(`
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT
    );
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
      identifier TEXT, description TEXT,
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER
    );
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT, m TINYINT
    );
    CREATE TABLE "places" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
  `);
  db.run(
    "INSERT INTO gpkg_contents (table_name, data_type, srs_id) VALUES ('places','features',:s)",
    { ":s": srsId },
  );
  db.run("INSERT INTO gpkg_geometry_columns VALUES ('places','geom','GEOMETRY',:s,0,0)", {
    ":s": srsId,
  });
  if (options.srs) {
    db.run("INSERT INTO gpkg_spatial_ref_sys VALUES (:n,:id,:org,:code,'','')", {
      ":n": "custom",
      ":id": options.srs.id,
      ":org": options.srs.org,
      ":code": options.srs.code,
    });
  }
  for (const feature of features) {
    db.run("INSERT INTO places (geom, name) VALUES (:g, :n)", {
      ":g": feature.geometry ? geoPackageBlob(feature.geometry, srsId) : null,
      ":n": feature.name,
    });
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

describe("stripGeoPackageHeader", () => {
  it("strips the GP header and returns the inner WKB", () => {
    const geometry: Geometry = { type: "Point", coordinates: [1, 2] };
    const wkb = encodeWkb(geometry);
    const stripped = stripGeoPackageHeader(geoPackageBlob(geometry));
    assert.deepEqual([...stripped], [...wkb]);
  });

  it("accounts for an XY envelope (32 bytes)", () => {
    const wkb = encodeWkb({ type: "Point", coordinates: [1, 2] });
    const blob = new Uint8Array(8 + 32 + wkb.length);
    blob[0] = 0x47;
    blob[1] = 0x50;
    blob[3] = 0b0000_0010; // envelope indicator 1 (XY) in bits 1-3
    blob.set(wkb, 8 + 32);
    assert.deepEqual([...stripGeoPackageHeader(blob)], [...wkb]);
  });

  it("returns bare WKB unchanged", () => {
    const wkb = encodeWkb({ type: "Point", coordinates: [1, 2] });
    assert.deepEqual([...stripGeoPackageHeader(wkb)], [...wkb]);
  });

  it("throws on a reserved envelope indicator (5-7)", () => {
    const blob = new Uint8Array(16);
    blob[0] = 0x47;
    blob[1] = 0x50;
    blob[3] = 5 << 1; // envelope indicator 5 (reserved) in bits 1-3
    assert.throws(() => stripGeoPackageHeader(blob), /reserved envelope indicator 5/);
  });

  it("throws on a truncated header", () => {
    // 'GP' magic but fewer than the 8 mandatory header bytes.
    const blob = new Uint8Array([0x47, 0x50, 0x00, 0x01]);
    assert.throws(() => stripGeoPackageHeader(blob), /truncated header/);
  });

  it("throws on a truncated envelope", () => {
    const blob = new Uint8Array(10); // declares an XY envelope (needs 8 + 32)
    blob[0] = 0x47;
    blob[1] = 0x50;
    blob[3] = 0b0000_0010; // envelope indicator 1 (XY)
    assert.throws(() => stripGeoPackageHeader(blob), /truncated envelope/);
  });
});

describe("readGeoPackageSync", () => {
  it("reads features with geometry and properties, excluding the id column", () => {
    const bytes = buildGpkg([
      { geometry: { type: "Point", coordinates: [-85.6, 42.9] }, name: "a" },
      {
        geometry: {
          type: "LineString",
          coordinates: [
            [-85.6, 42.9],
            [-85.5, 43],
          ],
        },
        name: "b",
      },
    ]);
    const { featureCollection, epsgCode } = readGeoPackageSync(SQL, bytes);
    assert.equal(epsgCode, null); // 4326 → no reprojection
    assert.equal(featureCollection.features.length, 2);
    assert.deepEqual(featureCollection.features[0], {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-85.6, 42.9] },
      properties: { name: "a" }, // fid excluded
    });
    assert.equal(featureCollection.features[1].geometry?.type, "LineString");
  });

  it("keeps a null geometry as a null-geometry feature", () => {
    const bytes = buildGpkg([{ geometry: null, name: "empty" }]);
    const { featureCollection } = readGeoPackageSync(SQL, bytes);
    assert.equal(featureCollection.features.length, 1);
    assert.equal(featureCollection.features[0].geometry, null);
    assert.deepEqual(featureCollection.features[0].properties, { name: "empty" });
  });

  it("reports a non-WGS84 EPSG code for reprojection", () => {
    const bytes = buildGpkg([{ geometry: { type: "Point", coordinates: [1, 2] }, name: "a" }], {
      srsId: 3857,
      srs: { id: 3857, org: "EPSG", code: 3857 },
    });
    assert.equal(readGeoPackageSync(SQL, bytes).epsgCode, 3857);
  });

  it("treats WGS84 3D (EPSG:4979) as needing no reprojection", () => {
    const bytes = buildGpkg([{ geometry: { type: "Point", coordinates: [1, 2] }, name: "a" }], {
      srsId: 4979,
      srs: { id: 4979, org: "EPSG", code: 4979 },
    });
    assert.equal(readGeoPackageSync(SQL, bytes).epsgCode, null);
  });

  it("treats a non-numeric EPSG code as no reprojection (not EPSG:NaN)", () => {
    // organization_coordsys_id has no column affinity here, so the text value is
    // stored verbatim; Number(...) yields NaN, which must resolve to null.
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id, definition TEXT, description TEXT);
      CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, srs_id INTEGER);
      CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT);
      CREATE TABLE "places" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
      INSERT INTO gpkg_spatial_ref_sys VALUES ('custom', 9999, 'EPSG', 'not-a-number', '', '');
      INSERT INTO gpkg_contents VALUES ('places','features',9999);
      INSERT INTO gpkg_geometry_columns VALUES ('places','geom','GEOMETRY',9999,0,0);
    `);
    db.run("INSERT INTO places (geom, name) VALUES (:g, 'a')", {
      ":g": geoPackageBlob({ type: "Point", coordinates: [1, 2] }, 9999),
    });
    const bytes = db.export();
    db.close();
    assert.equal(readGeoPackageSync(SQL, bytes).epsgCode, null);
  });

  it("throws when there is no feature layer", () => {
    const db = new SQL.Database();
    db.run(
      "CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, srs_id INTEGER)",
    );
    const bytes = db.export();
    db.close();
    assert.throws(() => readGeoPackageSync(SQL, bytes), /No vector feature layer/);
  });

  it("throws when the declared geometry column is missing from the table", () => {
    // gpkg_geometry_columns declares "geom" but the table column is "shape".
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, srs_id INTEGER);
      CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT);
      CREATE TABLE "places" (fid INTEGER PRIMARY KEY, shape BLOB, name TEXT);
      INSERT INTO gpkg_contents VALUES ('places','features',4326);
      INSERT INTO gpkg_geometry_columns VALUES ('places','geom','GEOMETRY',4326,0,0);
      INSERT INTO "places" (name) VALUES ('a');
    `);
    const bytes = db.export();
    db.close();
    assert.throws(
      () => readGeoPackageSync(SQL, bytes),
      /missing its declared geometry column "geom"/,
    );
  });

  it("keeps the feature but drops an unreadable geometry blob, warning once", () => {
    // A 'GP' blob with a reserved envelope indicator cannot be located. The bad
    // feature must not abort the layer: it is kept with a null geometry (and the
    // good feature still loads), with a warning rather than a silent drop.
    const badBlob = new Uint8Array(16);
    badBlob[0] = 0x47;
    badBlob[1] = 0x50;
    badBlob[3] = 6 << 1; // reserved envelope indicator 6
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, srs_id INTEGER);
      CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT);
      CREATE TABLE "places" (fid INTEGER PRIMARY KEY, geom BLOB, name TEXT);
      INSERT INTO gpkg_contents VALUES ('places','features',4326);
      INSERT INTO gpkg_geometry_columns VALUES ('places','geom','GEOMETRY',4326,0,0);
    `);
    db.run("INSERT INTO places (geom, name) VALUES (:g, 'bad')", { ":g": badBlob });
    db.run("INSERT INTO places (geom, name) VALUES (:g, 'good')", {
      ":g": geoPackageBlob({ type: "Point", coordinates: [1, 2] }),
    });
    const bytes = db.export();
    db.close();

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const { featureCollection } = readGeoPackageSync(SQL, bytes);
      assert.equal(featureCollection.features.length, 2);
      assert.equal(featureCollection.features[0].geometry, null);
      assert.deepEqual(featureCollection.features[0].properties, { name: "bad" });
      assert.equal(featureCollection.features[1].geometry?.type, "Point");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
  });

  it("returns null (no layer) when gpkg_contents is missing", () => {
    // A malformed file with gpkg_geometry_columns but no gpkg_contents must not
    // throw an opaque sql.js error from the JOIN.
    const db = new SQL.Database();
    db.run(
      "CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT)",
    );
    const bytes = db.export();
    db.close();
    assert.throws(() => readGeoPackageSync(SQL, bytes), /No vector feature layer/);
  });
});

describe("isLikelyGeoPackage", () => {
  it("recognises a SQLite/GeoPackage buffer", () => {
    assert.equal(isLikelyGeoPackage(buildGpkg([])), true);
    assert.equal(isLikelyGeoPackage(new Uint8Array([1, 2, 3, 4])), false);
  });
});
