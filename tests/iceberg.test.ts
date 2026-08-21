import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  buildIcebergAttachSql,
  buildIcebergDefaultSql,
  buildIcebergDetachSql,
  buildIcebergSelectSql,
  buildIcebergSourceSql,
  clampIcebergRowLimit,
  DEFAULT_ICEBERG_CRS,
  DEFAULT_ICEBERG_ROW_LIMIT,
  icebergCrsFromColumnType,
  icebergTransformCrs,
  keepOrDefaultGeometryColumn,
  getIcebergLayerConfig,
  icebergLayerMetadata,
  icebergNameFromLocation,
  icebergTableKey,
  ICEBERG_CATALOG_ALIAS,
  ICEBERG_SOURCE_KIND,
  isIcebergLayer,
  MAX_ICEBERG_ROW_LIMIT,
  normalizeIcebergLocation,
  normalizeIcebergSql,
  selectDefaultIcebergTable,
  type IcebergLayerConfig,
} from "../apps/geolibre-desktop/src/lib/iceberg";
import {
  isRefreshableLayer,
  supportsAutoRefresh,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";

const TABLE_CONFIG: IcebergLayerConfig = {
  mode: "table",
  location: "https://data.example.com/warehouse/taxis/metadata/v3.metadata.json",
  rowLimit: 1000,
};

const CATALOG_CONFIG: IcebergLayerConfig = {
  mode: "catalog",
  location: "my_warehouse",
  endpoint: "https://catalog.example.com/api/catalog",
  table: { schema: "nyc", name: "taxis" },
  rowLimit: 1000,
};

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Iceberg Layer",
    type: "geojson",
    source: { type: "geojson", service: "iceberg" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

describe("selectDefaultIcebergTable", () => {
  it("defaults to the only table when the source exposes exactly one", () => {
    const only = { name: "taxis" };
    assert.deepEqual(selectDefaultIcebergTable([only]), only);
  });

  it("makes the user choose when several tables are present", () => {
    assert.equal(selectDefaultIcebergTable([{ name: "taxis" }, { name: "trips" }]), null);
  });

  it("selects nothing for an empty catalog", () => {
    assert.equal(selectDefaultIcebergTable([]), null);
  });
});

describe("clampIcebergRowLimit", () => {
  it("keeps a sensible limit", () => {
    assert.equal(clampIcebergRowLimit(25_000), 25_000);
  });

  it("accepts a numeric string from the form field", () => {
    assert.equal(clampIcebergRowLimit(" 250 "), 250);
  });

  it("falls back to the default for non-numeric, zero, and negative input", () => {
    for (const value of ["", "abc", 0, -5, Number.NaN, null, undefined]) {
      assert.equal(clampIcebergRowLimit(value), DEFAULT_ICEBERG_ROW_LIMIT);
    }
  });

  it("caps a limit that would materialize more than the browser can hold", () => {
    assert.equal(clampIcebergRowLimit(1e12), MAX_ICEBERG_ROW_LIMIT);
  });

  it("floors a fractional limit so it can be interpolated into SQL", () => {
    assert.equal(clampIcebergRowLimit(10.9), 10);
  });
});

describe("normalizeIcebergLocation", () => {
  it("trims and drops a single trailing slash", () => {
    assert.equal(
      normalizeIcebergLocation("  https://host/warehouse/taxis/  "),
      "https://host/warehouse/taxis",
    );
  });

  it("leaves a cloud scheme untouched (manifests record absolute paths)", () => {
    assert.equal(normalizeIcebergLocation("s3://bucket/taxis"), "s3://bucket/taxis");
  });

  it("does not eat a lone slash", () => {
    assert.equal(normalizeIcebergLocation("/"), "/");
  });
});

describe("icebergNameFromLocation", () => {
  it("names the table, not its metadata file", () => {
    assert.equal(
      icebergNameFromLocation("https://host/warehouse/taxis/metadata/v3.metadata.json"),
      "taxis",
    );
  });

  it("handles a bare table directory", () => {
    assert.equal(icebergNameFromLocation("s3://bucket/warehouse/trips"), "trips");
  });

  it("ignores a query string", () => {
    assert.equal(icebergNameFromLocation("https://host/taxis?token=abc"), "taxis");
  });

  it("falls back when nothing usable is left", () => {
    assert.equal(icebergNameFromLocation("https://"), "Iceberg table");
  });
});

describe("Iceberg SQL builders", () => {
  it("scans a direct location through iceberg_scan", () => {
    assert.equal(
      buildIcebergSourceSql(TABLE_CONFIG),
      `SELECT * FROM iceberg_scan('${TABLE_CONFIG.location}')`,
    );
  });

  it("qualifies a catalog table under the attach alias", () => {
    assert.equal(
      buildIcebergSourceSql(CATALOG_CONFIG),
      `SELECT * FROM "${ICEBERG_CATALOG_ALIAS}"."nyc"."taxis"`,
    );
  });

  it("omits the namespace when the catalog reports none", () => {
    assert.equal(
      buildIcebergSourceSql({ ...CATALOG_CONFIG, table: { name: "taxis" } }),
      `SELECT * FROM "${ICEBERG_CATALOG_ALIAS}"."taxis"`,
    );
  });

  it("refuses to build a catalog scan with no table selected", () => {
    assert.throws(
      () => buildIcebergSourceSql({ ...CATALOG_CONFIG, table: undefined }),
      /Select an Iceberg table/,
    );
  });

  it("attaches the catalog under the fixed alias with its endpoint", () => {
    assert.equal(
      buildIcebergAttachSql(CATALOG_CONFIG),
      `ATTACH 'my_warehouse' AS "${ICEBERG_CATALOG_ALIAS}" ` +
        `(TYPE ICEBERG, ENDPOINT 'https://catalog.example.com/api/catalog')`,
    );
    assert.equal(buildIcebergDetachSql(), `DETACH "${ICEBERG_CATALOG_ALIAS}"`);
  });

  it("escapes a quote in a location rather than breaking out of the literal", () => {
    const sql = buildIcebergSourceSql({
      ...TABLE_CONFIG,
      location: "s3://b/it's/t",
    });
    assert.equal(sql, `SELECT * FROM iceberg_scan('s3://b/it''s/t')`);
  });

  it("caps the materialized read at the row limit", () => {
    const sql = buildIcebergSelectSql(
      "SELECT * FROM iceberg_scan('x')",
      'ST_AsGeoJSON("geom")',
      "__geom_json",
      250,
    );
    assert.match(sql, /LIMIT 250$/);
    assert.match(sql, /ST_AsGeoJSON\("geom"\) AS "__geom_json"/);
  });

  it("clamps an out-of-range limit rather than emitting it into SQL", () => {
    const sql = buildIcebergSelectSql("SELECT 1", "ST_AsGeoJSON(g)", "j", 1e12);
    assert.match(sql, new RegExp(`LIMIT ${MAX_ICEBERG_ROW_LIMIT}$`));
  });
});

describe("icebergTableKey", () => {
  it("qualifies a namespaced table and leaves a bare one alone", () => {
    assert.equal(icebergTableKey({ schema: "nyc", name: "taxis" }), "nyc.taxis");
    assert.equal(icebergTableKey({ name: "taxis" }), "taxis");
  });
});

describe("icebergLayerMetadata / getIcebergLayerConfig", () => {
  it("round-trips the config through the layer metadata", () => {
    const layer = makeLayer({ metadata: icebergLayerMetadata(CATALOG_CONFIG) });
    assert.equal(layer.metadata.sourceKind, ICEBERG_SOURCE_KIND);
    assert.deepEqual(getIcebergLayerConfig(layer), CATALOG_CONFIG);
    assert.equal(isIcebergLayer(layer), true);
  });

  it("ignores a layer that is not tagged as Iceberg", () => {
    assert.equal(getIcebergLayerConfig(makeLayer()), null);
    assert.equal(isIcebergLayer(makeLayer()), false);
  });

  it("rejects a hand-edited config with no location or an unknown mode", () => {
    for (const iceberg of [
      { mode: "table" },
      { mode: "table", location: "   " },
      { mode: "delta", location: "s3://b/t" },
      "not-an-object",
      null,
    ]) {
      const layer = makeLayer({
        metadata: { sourceKind: ICEBERG_SOURCE_KIND, iceberg },
      });
      assert.equal(getIcebergLayerConfig(layer), null);
    }
  });

  it("rejects a catalog config with no table, which has nothing to scan", () => {
    const layer = makeLayer({
      metadata: {
        sourceKind: ICEBERG_SOURCE_KIND,
        iceberg: { mode: "catalog", location: "wh", endpoint: "https://c" },
      },
    });
    assert.equal(getIcebergLayerConfig(layer), null);
  });

  it("clamps a hand-edited row limit instead of trusting it", () => {
    const layer = makeLayer({
      metadata: {
        sourceKind: ICEBERG_SOURCE_KIND,
        iceberg: { ...TABLE_CONFIG, rowLimit: 5_000_000 },
      },
    });
    assert.equal(getIcebergLayerConfig(layer)?.rowLimit, MAX_ICEBERG_ROW_LIMIT);
  });

  it("drops blank optional fields so they are not persisted as empty strings", () => {
    const layer = makeLayer({
      metadata: {
        sourceKind: ICEBERG_SOURCE_KIND,
        iceberg: { ...TABLE_CONFIG, endpoint: "  ", geometryColumn: "", sql: "  ;  " },
      },
    });
    assert.deepEqual(getIcebergLayerConfig(layer), TABLE_CONFIG);
  });

  it("round-trips a custom statement, normalized", () => {
    const layer = makeLayer({
      metadata: {
        sourceKind: ICEBERG_SOURCE_KIND,
        iceberg: { ...TABLE_CONFIG, sql: "  SELECT * FROM t WHERE x > 1;  " },
      },
    });
    assert.equal(getIcebergLayerConfig(layer)?.sql, "SELECT * FROM t WHERE x > 1");
  });

  it("is not an Iceberg layer when the layer is not GeoJSON-backed", () => {
    const layer = makeLayer({
      type: "raster",
      metadata: icebergLayerMetadata(TABLE_CONFIG),
    });
    assert.equal(isIcebergLayer(layer), false);
  });
});

describe("CRS detection from the geometry column type", () => {
  it("reads the CRS DuckDB renders as GEOMETRY(<crs>)", () => {
    assert.equal(icebergCrsFromColumnType("GEOMETRY(EPSG:3857)"), "EPSG:3857");
    assert.equal(icebergCrsFromColumnType("GEOMETRY(OGC:CRS84)"), "OGC:CRS84");
  });

  it("tolerates the quoted form the spatial extension renders", () => {
    assert.equal(icebergCrsFromColumnType("GEOMETRY('EPSG:3857')"), "EPSG:3857");
  });

  it("returns null for a bare GEOMETRY and for non-geometry columns", () => {
    assert.equal(icebergCrsFromColumnType("GEOMETRY"), null);
    assert.equal(icebergCrsFromColumnType("VARCHAR"), null);
    assert.equal(icebergCrsFromColumnType("BLOB"), null);
    assert.equal(icebergCrsFromColumnType(undefined), null);
  });

  it("skips the transform for CRS already in GeoJSON's convention", () => {
    // Iceberg's default is OGC:CRS84 (lon/lat), which is what GeoJSON wants, so
    // reprojecting would be a pointless round trip through PROJ.
    for (const type of [
      "GEOMETRY",
      "GEOMETRY(OGC:CRS84)",
      "GEOMETRY(ogc:crs84)",
      "GEOMETRY(EPSG:4326)",
    ]) {
      assert.equal(icebergTransformCrs(type), null, type);
    }
  });

  it("reprojects a genuinely projected column", () => {
    assert.equal(icebergTransformCrs("GEOMETRY(EPSG:3857)"), "EPSG:3857");
    assert.equal(icebergTransformCrs("GEOMETRY(EPSG:27700)"), "EPSG:27700");
  });

  it("names Iceberg's documented default", () => {
    assert.equal(DEFAULT_ICEBERG_CRS, "OGC:CRS84");
    assert.equal(icebergTransformCrs(`GEOMETRY(${DEFAULT_ICEBERG_CRS})`), null);
  });
});

describe("custom SQL as the scan source", () => {
  it("strips a trailing terminator so it can be wrapped as a sub-select", () => {
    assert.equal(normalizeIcebergSql("  SELECT 1 ;; "), "SELECT 1");
  });

  it("replaces the generated select when set", () => {
    const sql = "SELECT geom FROM iceberg_scan('x') WHERE id > 5";
    assert.equal(buildIcebergSourceSql({ ...TABLE_CONFIG, sql }), sql);
  });

  it("falls back to the generated select when absent or blank", () => {
    const generated = buildIcebergDefaultSql(TABLE_CONFIG);
    assert.equal(buildIcebergSourceSql(TABLE_CONFIG), generated);
    assert.equal(buildIcebergSourceSql({ ...TABLE_CONFIG, sql: "   " }), generated);
  });

  it("lets a catalog statement stand in for a table selection", () => {
    // The generated form needs a table; an explicit statement names its own.
    const sql = 'SELECT * FROM "geolibre_iceberg"."nyc"."taxis"';
    assert.equal(buildIcebergSourceSql({ ...CATALOG_CONFIG, table: undefined, sql }), sql);
  });

  it("still wraps and row-caps a custom statement", () => {
    const wrapped = buildIcebergSelectSql(
      buildIcebergSourceSql({ ...TABLE_CONFIG, sql: "SELECT * FROM t WHERE x" }),
      'ST_AsGeoJSON("geom")',
      "__g",
      10,
    );
    assert.match(wrapped, /FROM \(SELECT \* FROM t WHERE x\) AS iceberg_source LIMIT 10$/);
  });
});

describe("multiple geometry columns", () => {
  it("excludes every geometry column from the wildcard", () => {
    // Including the rendered one: it reaches the features through the
    // ST_AsGeoJSON alias, so its raw value would be redundant binary.
    const sql = buildIcebergSelectSql(
      "SELECT * FROM iceberg_scan('x')",
      'ST_AsGeoJSON("geom_a")',
      "__g",
      100,
      ["geom_a", "geom_b"],
    );
    assert.match(sql, /^SELECT \* EXCLUDE \("geom_a", "geom_b"\), ST_AsGeoJSON/);
    assert.match(sql, /LIMIT 100$/);
  });

  it("omits the clause entirely when nothing is excluded", () => {
    // DuckDB rejects an empty EXCLUDE ().
    const sql = buildIcebergSelectSql("SELECT 1", "ST_AsGeoJSON(g)", "__g", 10, []);
    assert.doesNotMatch(sql, /EXCLUDE/);
    assert.match(sql, /^SELECT \*, ST_AsGeoJSON\(g\)/);
  });

  it("defaults to no exclusions when the argument is omitted", () => {
    assert.doesNotMatch(buildIcebergSelectSql("SELECT 1", "ST_AsGeoJSON(g)", "__g", 10), /EXCLUDE/);
  });

  it("escapes a quote in a column name rather than breaking out", () => {
    const sql = buildIcebergSelectSql("SELECT 1", "ST_AsGeoJSON(g)", "__g", 10, ['ge"om']);
    assert.match(sql, /EXCLUDE \("ge""om"\)/);
  });
});

describe("keepOrDefaultGeometryColumn", () => {
  const COLUMNS = [
    { name: "geom_a", type: "GEOMETRY" },
    { name: "geom_b", type: "GEOMETRY(EPSG:3857)" },
  ];

  it("keeps a deliberate pick that the source still exposes", () => {
    // Re-inspection runs on every SQL edit; without this the choice would
    // silently revert to the first column.
    assert.equal(keepOrDefaultGeometryColumn("geom_b", COLUMNS), "geom_b");
  });

  it("falls back to the first when the pick is gone", () => {
    assert.equal(keepOrDefaultGeometryColumn("geom_removed", COLUMNS), "geom_a");
  });

  it("defaults to the first when nothing is selected yet", () => {
    assert.equal(keepOrDefaultGeometryColumn("", COLUMNS), "geom_a");
  });

  it("selects nothing when the source has no geometry", () => {
    assert.equal(keepOrDefaultGeometryColumn("geom_a", []), "");
    assert.equal(keepOrDefaultGeometryColumn("", []), "");
  });
});

describe("Iceberg refresh policy", () => {
  it("can be refreshed on demand", () => {
    assert.equal(
      isRefreshableLayer(makeLayer({ metadata: icebergLayerMetadata(TABLE_CONFIG) })),
      true,
    );
  });

  it("is never refreshed on a timer", () => {
    assert.equal(
      supportsAutoRefresh(makeLayer({ metadata: icebergLayerMetadata(TABLE_CONFIG) })),
      false,
    );
  });

  it("leaves every other layer's auto-refresh untouched", () => {
    assert.equal(supportsAutoRefresh(makeLayer()), true);
  });
});
