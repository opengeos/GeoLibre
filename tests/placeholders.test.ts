import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src";
import { isPlaceholderLayer, placeholderMessage } from "../packages/map/src/placeholders";

function duckDbLayer(metadata: Record<string, unknown>): GeoLibreLayer {
  return {
    id: "q1",
    name: "Query",
    type: "duckdb-query",
    source: {},
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata,
  } as GeoLibreLayer;
}

describe("placeholder layers", () => {
  it("does not treat a DuckDB plugin query layer as a placeholder", () => {
    const layer = duckDbLayer({ sourceKind: "duckdb-query", externalDeckLayer: true });
    assert.equal(isPlaceholderLayer(layer), false);
  });

  it("explains an undrawn DuckDB query layer without a stale roadmap promise", () => {
    const layer = duckDbLayer({});
    assert.equal(isPlaceholderLayer(layer), true);
    const message = placeholderMessage(layer);
    assert.match(message, /DuckDB query layer could not be displayed/);
    assert.doesNotMatch(message, /planned|v0\.4/);
  });
});
