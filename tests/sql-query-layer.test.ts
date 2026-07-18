import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  getSqlQueryLayerConfig,
  isSqlQueryLayer,
  refreshSqlQueryLayer,
  sourceLayersForQueryRefresh,
  sqlQueryLayerMetadata,
  SQL_QUERY_SOURCE_KIND,
} from "../apps/geolibre-desktop/src/lib/sql-query-layer";
import { isRefreshableLayer } from "../apps/geolibre-desktop/src/lib/layer-refresh";

const QUERY = "SELECT NAME, geom FROM countries WHERE POP_EST > 50000000";

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Query result",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

function makeQueryLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return makeLayer({ metadata: sqlQueryLayerMetadata(QUERY), ...patch });
}

describe("sqlQueryLayerMetadata / getSqlQueryLayerConfig", () => {
  it("round-trips the SQL through the layer metadata", () => {
    const layer = makeQueryLayer();
    assert.deepEqual(getSqlQueryLayerConfig(layer), {
      engine: "duckdb",
      sql: QUERY,
    });
    assert.equal(layer.metadata.sourceKind, SQL_QUERY_SOURCE_KIND);
  });

  it("returns null for a layer without the query source kind", () => {
    const layer = makeLayer({
      metadata: { sqlQuery: { engine: "duckdb", sql: QUERY } },
    });
    assert.equal(getSqlQueryLayerConfig(layer), null);
  });

  it("returns null when the query definition is missing or malformed", () => {
    for (const sqlQuery of [
      undefined,
      null,
      "SELECT 1",
      [],
      { engine: "duckdb" },
      { engine: "duckdb", sql: "" },
      { engine: "duckdb", sql: "   " },
      { engine: "duckdb", sql: 42 },
    ]) {
      const layer = makeLayer({
        metadata: { sourceKind: SQL_QUERY_SOURCE_KIND, sqlQuery },
      });
      assert.equal(getSqlQueryLayerConfig(layer), null);
    }
  });

  it("returns null for an unknown engine", () => {
    const layer = makeLayer({
      metadata: {
        sourceKind: SQL_QUERY_SOURCE_KIND,
        sqlQuery: { engine: "postgis", sql: QUERY },
      },
    });
    assert.equal(getSqlQueryLayerConfig(layer), null);
  });
});

describe("isSqlQueryLayer", () => {
  it("accepts a geojson layer carrying a valid query definition", () => {
    assert.equal(isSqlQueryLayer(makeQueryLayer()), true);
  });

  it("rejects non-geojson layers even with query metadata", () => {
    assert.equal(isSqlQueryLayer(makeQueryLayer({ type: "raster" })), false);
  });

  it("rejects plain geojson layers", () => {
    assert.equal(isSqlQueryLayer(makeLayer()), false);
  });
});

describe("isRefreshableLayer (SQL query layers)", () => {
  it("treats a query layer as refreshable without a source URL", () => {
    assert.equal(isRefreshableLayer(makeQueryLayer()), true);
  });

  it("does not treat a plain in-memory geojson layer as refreshable", () => {
    assert.equal(isRefreshableLayer(makeLayer()), false);
  });
});

describe("sourceLayersForQueryRefresh", () => {
  it("excludes the query layer itself and keeps every other layer", () => {
    const query = makeQueryLayer({ id: "query" });
    const source = makeLayer({ id: "source", name: "countries" });
    const other = makeLayer({ id: "other", name: "rivers" });
    assert.deepEqual(
      sourceLayersForQueryRefresh(query, [source, query, other]).map((layer) => layer.id),
      ["source", "other"],
    );
  });
});

describe("refreshSqlQueryLayer", () => {
  it("rejects a layer without a query definition before touching DuckDB", async () => {
    await assert.rejects(
      refreshSqlQueryLayer(makeLayer(), []),
      /does not carry a SQL query definition/,
    );
  });
});
