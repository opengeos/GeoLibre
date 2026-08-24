import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEOPARQUET_METADATA_COLUMN,
  GEOPARQUET_METADATA_KEY,
  geoParquetMetadataSql,
  geoParquetSourceCrs,
} from "../apps/geolibre-desktop/src/lib/geoparquet-crs";

/** A `geo` document shaped the way GeoPandas/GDAL write one. */
function geoMetadata(crs: unknown, options: { column?: string; omitCrs?: boolean } = {}) {
  const column = options.column ?? "geometry";
  const entry: Record<string, unknown> = { encoding: "WKB" };
  if (!options.omitCrs) entry.crs = crs;
  return JSON.stringify({
    version: "1.0.0",
    primary_column: column,
    columns: { [column]: entry },
  });
}

/** The PROJJSON GeoPandas writes for GGRS87 / Greek Grid, trimmed to what is read. */
const GREEK_GRID_PROJJSON = {
  $schema: "https://proj.org/schemas/v0.7/projjson.schema.json",
  type: "ProjectedCRS",
  name: "GGRS87 / Greek Grid",
  base_crs: { name: "GGRS87", id: { authority: "EPSG", code: 4121 } },
  id: { authority: "EPSG", code: 2100 },
};

describe("geoParquetMetadataSql", () => {
  it("reads the `geo` key of the named file as text", () => {
    const sql = geoParquetMetadataSql("greece.parquet");
    assert.match(sql, /parquet_kv_metadata\('greece\.parquet'\)/);
    assert.match(sql, new RegExp(`decode\\(value\\) AS ${GEOPARQUET_METADATA_COLUMN}`));
    // The key is compared as a BLOB rather than decoded, so a file carrying a
    // non-UTF-8 metadata key cannot fail the read.
    assert.match(sql, new RegExp(`key = encode\\('${GEOPARQUET_METADATA_KEY}'\\)`));
    assert.doesNotMatch(sql, /decode\(key\)/);
  });

  it("escapes a quote in the file name", () => {
    assert.match(
      geoParquetMetadataSql("o'brien.parquet"),
      /parquet_kv_metadata\('o''brien\.parquet'\)/,
    );
  });
});

describe("geoParquetSourceCrs", () => {
  it("returns the EPSG identity of a projected CRS", () => {
    assert.equal(geoParquetSourceCrs(geoMetadata(GREEK_GRID_PROJJSON)), "EPSG:2100");
  });

  it("prefers the CRS's own id over its base CRS", () => {
    // The base_crs of EPSG:2100 is EPSG:4121, a geographic system: reading that
    // one instead would leave the metre coordinates untransformed.
    assert.notEqual(geoParquetSourceCrs(geoMetadata(GREEK_GRID_PROJJSON)), "EPSG:4121");
  });

  it("skips reprojection for WGS84 and CRS84 identities", () => {
    assert.equal(geoParquetSourceCrs(geoMetadata({ id: { authority: "EPSG", code: 4326 } })), null);
    assert.equal(
      geoParquetSourceCrs(geoMetadata({ id: { authority: "OGC", code: "CRS84" } })),
      null,
    );
  });

  it("skips reprojection for an absent crs member (the spec default is CRS84)", () => {
    assert.equal(geoParquetSourceCrs(geoMetadata(null, { omitCrs: true })), null);
  });

  it("skips reprojection for an explicit null crs (no known CRS)", () => {
    assert.equal(geoParquetSourceCrs(geoMetadata(null)), null);
  });

  it("hands PROJ the whole PROJJSON when the CRS has no authority code", () => {
    const custom = { type: "ProjectedCRS", name: "Custom Site Grid" };
    assert.equal(geoParquetSourceCrs(geoMetadata(custom)), JSON.stringify(custom));
  });

  it("accepts the WKT string the pre-1.0 drafts wrote", () => {
    const wkt = 'PROJCS["Greek_Grid",GEOGCS["GCS_GGRS_1987"]]';
    assert.equal(geoParquetSourceCrs(geoMetadata(wkt)), wkt);
    assert.equal(geoParquetSourceCrs(geoMetadata("EPSG:4326")), null);
  });

  it("reads the column named by primary_column, not the first one listed", () => {
    const metadata = JSON.stringify({
      primary_column: "geom_2100",
      columns: {
        geom_4326: { crs: { id: { authority: "EPSG", code: 4326 } } },
        geom_2100: { crs: GREEK_GRID_PROJJSON },
      },
    });
    assert.equal(geoParquetSourceCrs(metadata), "EPSG:2100");
  });

  it("falls back to the only column when primary_column names none", () => {
    const metadata = JSON.stringify({
      primary_column: "missing",
      columns: { geometry: { crs: GREEK_GRID_PROJJSON } },
    });
    assert.equal(geoParquetSourceCrs(metadata), "EPSG:2100");
  });

  it("returns null for a plain Parquet with no metadata, or an unreadable one", () => {
    assert.equal(geoParquetSourceCrs(null), null);
    assert.equal(geoParquetSourceCrs(undefined), null);
    assert.equal(geoParquetSourceCrs(""), null);
    assert.equal(geoParquetSourceCrs("not json"), null);
    assert.equal(geoParquetSourceCrs("{}"), null);
    assert.equal(geoParquetSourceCrs(JSON.stringify({ columns: {} })), null);
  });
});
