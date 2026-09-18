import type { GeoLibreLayer } from "@geolibre/core";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignTableNames } from "../apps/geolibre-desktop/src/lib/sql-table-names";

function geojsonLayer(id: string, name: string): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    geojson: { type: "FeatureCollection", features: [] },
  } as unknown as GeoLibreLayer;
}

function tableName(name: string, id = "layer-id"): string {
  return assignTableNames([geojsonLayer(id, name)])[0].tableName;
}

describe("assignTableNames", () => {
  it("collapses separators and trims the resulting underscores", () => {
    assert.equal(tableName("  --US___Cities--  "), "us_cities");
  });

  it("prefixes names that cannot be bare SQL identifiers", () => {
    assert.equal(tableName("2026 census"), "t_2026_census");
    assert.equal(tableName("Group"), "t_group");
  });

  it("falls back to the layer id when the name has no alphanumeric characters", () => {
    assert.equal(tableName(" --- ", "layer id"), "layer_layer_id");
  });

  it("adds a suffix when sanitized names collide", () => {
    const assigned = assignTableNames([
      geojsonLayer("first", "US Cities"),
      geojsonLayer("second", "US-Cities"),
    ]);
    assert.deepEqual(
      assigned.map(({ tableName: assignedName }) => assignedName),
      ["us_cities", "us_cities_2"],
    );
  });
});
