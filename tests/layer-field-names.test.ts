import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src";
import { fieldNamesByLayer } from "../apps/geolibre-desktop/src/lib/layer-field-names";

const point = { type: "Point" as const, coordinates: [0, 0] };

function geojsonLayer(id: string, properties: Record<string, unknown>[]): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    geojson: {
      type: "FeatureCollection",
      features: properties.map((props) => ({
        type: "Feature",
        properties: props,
        geometry: point,
      })),
    },
  } as unknown as GeoLibreLayer;
}

describe("fieldNamesByLayer", () => {
  it("collects every column across features, in first-seen order", () => {
    const map = fieldNamesByLayer([
      geojsonLayer("a", [
        { id: 1, name: "x" },
        { id: 2, area: 3 },
      ]),
    ]);
    assert.deepEqual(map.get("a"), ["id", "name", "area"]);
  });

  it("scans only the first `sample` features of a schemaless layer", () => {
    const map = fieldNamesByLayer([geojsonLayer("a", [{ first: 1 }, { late: 2 }])], 1);
    assert.deepEqual(map.get("a"), ["first"]);
  });

  it("skips layers whose features are not held in the store", () => {
    const raster = { id: "r", name: "r", type: "raster" } as unknown as GeoLibreLayer;
    const map = fieldNamesByLayer([raster, geojsonLayer("a", [{ id: 1 }])]);
    assert.equal(map.has("r"), false);
    assert.deepEqual(map.get("a"), ["id"]);
  });
});
