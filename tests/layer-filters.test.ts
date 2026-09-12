import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeLayerFilterExpression,
  compileLayerFilters,
  hasActiveLayerFilter,
  type GeoLibreLayer,
} from "@geolibre/core";

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "places",
    name: "Places",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    ...patch,
  };
}

describe("persistent layer filters", () => {
  it("returns the persisted expression when one is active", () => {
    const expression = [">=", ["get", "population"], 100_000];
    const filtered = layer({ filterExpression: expression });

    assert.equal(activeLayerFilterExpression(filtered), expression);
    assert.equal(hasActiveLayerFilter(filtered), true);
    assert.equal(compileLayerFilters(filtered), expression);
  });

  it("combines an expression filter with Quick Filter controls", () => {
    const expression = ["==", ["get", "status"], "open"];
    assert.deepEqual(
      compileLayerFilters(
        layer({
          filterExpression: expression,
          quickFilters: [{ id: "score", field: "score", kind: "range", min: 10, max: null }],
        }),
      ),
      ["all", expression, ["all", ["has", "score"], [">=", ["to-number", ["get", "score"]], 10]]],
    );
  });

  it("ignores an absent or empty expression", () => {
    assert.equal(compileLayerFilters(layer()), null);
    assert.equal(compileLayerFilters(layer({ filterExpression: [] })), null);
    assert.equal(hasActiveLayerFilter(layer({ filterExpression: [] })), false);
  });
});
