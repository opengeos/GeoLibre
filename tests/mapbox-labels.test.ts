import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LabelStyle } from "@geolibre/core";
import { compileMapboxLayer } from "../packages/map/src/mapbox-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Attribute labels on the Mapbox renderer, compiled like MapLibre's
// layer-sync builds them (#2475, Tier 3 labels).
function labelled(
  labels: Partial<LabelStyle>,
  features: FeatureCollection["features"] = [
    {
      type: "Feature",
      properties: { name: "A", pop: 5 },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
    {
      type: "Feature",
      properties: { name: "B", pop: 9 },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
  ],
  style: Partial<GeoLibreLayer["style"]> = {},
): GeoLibreLayer {
  return geojsonLayer({
    id: "lbl",
    geojson: { type: "FeatureCollection", features },
    style: {
      ...DEFAULT_LAYER_STYLE,
      ...style,
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name", ...labels },
    },
  });
}

const labelSpec = (layer: GeoLibreLayer) =>
  compileMapboxLayer(layer).layers.find(
    (spec) => spec.type === "symbol" && spec.id.endsWith("-labels"),
  );

describe("Mapbox label compilation", () => {
  it("applies the data-defined overrides and clamps", () => {
    const spec = labelSpec(
      labelled({
        size: 0,
        maxWidth: -3,
        haloWidth: -1,
        allowOverlap: true,
        sizeExpression: '["get", "pop"]',
        colorExpression: '["case", [">", ["get", "pop"], 6], "#ff0000", "#0000ff"]',
        opacityExpression: '["interpolate", ["linear"], ["zoom"], 0, 0.5, 10, 1]',
        priorityExpression: '["get", "pop"]',
        visibilityExpression: '[">", ["get", "pop"], 6]',
      }),
    )!;
    assert.deepEqual(spec.layout?.["text-size"], ["get", "pop"]);
    assert.equal(spec.layout?.["text-max-width"], 1);
    assert.equal(spec.layout?.["text-ignore-placement"], true);
    assert.deepEqual(spec.layout?.["symbol-sort-key"], ["get", "pop"]);
    assert.match(JSON.stringify(spec.paint?.["text-color"]), /#ff0000/);
    assert.equal((spec.paint?.["text-opacity"] as unknown[])[0], "interpolate");
    assert.equal(spec.paint?.["text-halo-width"], 0);
    // Text markers are excluded and the visibility override gates each label.
    assert.match(JSON.stringify(spec.filter), /text_marker/);
    assert.match(JSON.stringify(spec.filter), /\[">",\["get","pop"\],6\]/);
  });

  it("falls back to the literal control for an invalid override", () => {
    const spec = labelSpec(labelled({ size: 14, sizeExpression: '"not a number"' }))!;
    assert.equal(spec.layout?.["text-size"], 14);
    assert.equal(spec.layout?.["symbol-sort-key"], undefined);
  });

  it("reads deduplicated labels from an aggregated companion source", () => {
    const layer = labelled({ dedupe: "concatenate" });
    const plan = compileMapboxLayer(layer);
    const spec = plan.layers.find((s) => s.id.endsWith("-labels"))!;
    const sourceId = (spec as { source: string }).source;
    assert.notEqual(sourceId, plan.sourceId);
    const companion = plan.additionalSources?.[sourceId];
    assert.equal(companion?.type, "geojson");
    const data = (companion as { data: FeatureCollection }).data;
    assert.equal(data.features.length, 1);
    assert.deepEqual(spec.layout?.["text-field"], ["get", "__geolibre_label"]);
    assert.equal(spec.filter, undefined);
    // A filter disables dedupe, as on MapLibre: the aggregate ignores filters.
    const filtered = compileMapboxLayer({ ...layer, filterExpression: ["==", ["get", "pop"], 5] });
    assert.equal(filtered.additionalSources, undefined);
  });

  it("draws no labels under extrusion or the heatmap renderer", () => {
    assert.equal(labelSpec(labelled({}, undefined, { pointRenderer: "heatmap" })), undefined);
    assert.equal(labelSpec(labelled({}, undefined, { extrusionEnabled: true })), undefined);
  });

  it("treats an empty embed filter as no filter", () => {
    const layer = { ...labelled({ dedupe: "unique" }), embedFilter: [] };
    const plan = compileMapboxLayer(layer);
    // Dedupe stays on, and no empty array lands in any layer's filter.
    assert.ok(plan.additionalSources);
    assert.doesNotMatch(JSON.stringify(plan.layers.map((spec) => spec.filter)), /\[\]/);
  });

  it("leaves Geo Editor text markers out of the deduplicated labels", () => {
    const plan = compileMapboxLayer(
      labelled({ dedupe: "unique" }, [
        {
          type: "Feature",
          properties: { name: "A" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
        {
          type: "Feature",
          properties: { name: "Note", __gm_shape: "text_marker" },
          geometry: { type: "Point", coordinates: [5, 5] },
        },
      ]),
    );
    const companion = Object.values(plan.additionalSources ?? {})[0] as { data: FeatureCollection };
    assert.equal(companion.data.features.length, 1);
  });
});
