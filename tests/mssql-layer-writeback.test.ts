import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
// The harness must evaluate first: the module reads browser storage at import time.
import "./helpers/dom";
import { isMssqlEditableLayer } from "../apps/geolibre-desktop/src/components/panels/layer-panel/layer-panel-utils";

function layer(metadata: Record<string, unknown>, type = "geojson"): GeoLibreLayer {
  return { type, metadata } as unknown as GeoLibreLayer;
}

describe("MSSQL editable layers", () => {
  const valid = {
    sourceKind: "mssql-table",
    mssqlTable: "parcels",
    mssqlPrimaryKey: "parcel_id",
    mssqlConnectionId: "profile-id",
  };

  it("accepts a GeoJSON SQL Server table layer with a primary key and saved connection", () => {
    assert.equal(isMssqlEditableLayer(layer(valid)), true);
  });

  it("rejects the wrong layer type or source kind", () => {
    assert.equal(isMssqlEditableLayer(layer(valid, "vector")), false);
    assert.equal(isMssqlEditableLayer(layer({ ...valid, sourceKind: "postgis-table" })), false);
  });

  it("rejects a layer missing its table, primary key, or saved connection id", () => {
    assert.equal(isMssqlEditableLayer(layer({ ...valid, mssqlTable: undefined })), false);
    assert.equal(isMssqlEditableLayer(layer({ ...valid, mssqlPrimaryKey: null })), false);
    assert.equal(isMssqlEditableLayer(layer({ ...valid, mssqlConnectionId: undefined })), false);
  });
});
