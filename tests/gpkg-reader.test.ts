import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { before, describe, it } from "node:test";
import type { Geometry } from "geojson";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { encodeWkb } from "../apps/geolibre-desktop/src/lib/geometry-wkb";
import {
  countGeoPackageFeaturesSync,
  isGeoPackage,
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
  db.run(
    "INSERT INTO gpkg_geometry_columns VALUES ('places','geom','GEOMETRY',:s,0,0)",
    { ":s": srsId },
  );
  if (options.srs) {
    db.run(
      "INSERT INTO gpkg_spatial_ref_sys VALUES (:n,:id,:org,:code,'','')",
      { ":n": "custom", ":id": options.srs.id, ":org": options.srs.org, ":code": options.srs.code },
    );
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
});

describe("readGeoPackageSync", () => {
  it("reads features with geometry and properties, excluding the id column", () => {
    const bytes = buildGpkg([
      { geometry: { type: "Point", coordinates: [-85.6, 42.9] }, name: "a" },
      {
        geometry: { type: "LineString", coordinates: [[-85.6, 42.9], [-85.5, 43]] },
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
    const bytes = buildGpkg(
      [{ geometry: { type: "Point", coordinates: [1, 2] }, name: "a" }],
      { srsId: 3857, srs: { id: 3857, org: "EPSG", code: 3857 } },
    );
    assert.equal(readGeoPackageSync(SQL, bytes).epsgCode, 3857);
  });

  it("treats WGS84 3D (EPSG:4979) as needing no reprojection", () => {
    const bytes = buildGpkg(
      [{ geometry: { type: "Point", coordinates: [1, 2] }, name: "a" }],
      { srsId: 4979, srs: { id: 4979, org: "EPSG", code: 4979 } },
    );
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
});

describe("countGeoPackageFeaturesSync / isGeoPackage", () => {
  it("counts the first layer's features", () => {
    const bytes = buildGpkg([
      { geometry: { type: "Point", coordinates: [0, 0] }, name: "a" },
      { geometry: { type: "Point", coordinates: [1, 1] }, name: "b" },
      { geometry: { type: "Point", coordinates: [2, 2] }, name: "c" },
    ]);
    assert.deepEqual(countGeoPackageFeaturesSync(SQL, bytes), {
      name: "places",
      featureCount: 3,
    });
  });

  it("recognises a SQLite/GeoPackage buffer", () => {
    assert.equal(isGeoPackage(buildGpkg([])), true);
    assert.equal(isGeoPackage(new Uint8Array([1, 2, 3, 4])), false);
  });
});
