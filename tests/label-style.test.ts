import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { getDedupedLabelFeatures } from "../packages/map/src/label-style";

// getDedupedLabelFeatures feeds the aggregated label source on both renderers
// (MapLibre's layer-sync and the Mapbox compiler), so its text-marker rule is
// pinned here once for both (#2475).
describe("getDedupedLabelFeatures", () => {
  it("leaves Geo Editor text markers out of the aggregated labels", () => {
    const point = (name: string, properties: Record<string, unknown> = {}) => ({
      type: "Feature" as const,
      properties: { name, ...properties },
      geometry: { type: "Point" as const, coordinates: [1, 1] },
    });
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        point("A"),
        point("Note", { __gm_shape: "text_marker" }),
        point("Memo", { shape: "text_marker" }),
      ],
    };
    const labels = {
      ...DEFAULT_LAYER_STYLE.labels,
      enabled: true,
      field: "name",
      dedupe: "concatenate" as const,
    };
    const result = getDedupedLabelFeatures(collection, labels)!;
    assert.equal(result.features.length, 1);
    assert.deepEqual(result.features[0].properties, { __geolibre_label: "A" });
  });
});
