import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { compileMapboxLayer, isInternalMapboxLayer } from "../packages/map/src/mapbox-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The Style panel's symbology on the Mapbox renderer, compiled the way
// MapLibre's layer-sync draws it (#2475, Tier 3).
const square: Geometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};
const line: Geometry = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [2, 2],
  ],
};
const feature = (geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  properties,
  geometry,
});

function layerOf(features: Feature[], style: Partial<GeoLibreLayer["style"]> = {}): GeoLibreLayer {
  const geojson: FeatureCollection = { type: "FeatureCollection", features };
  return geojsonLayer({ id: "sym", geojson, style: { ...DEFAULT_LAYER_STYLE, ...style } });
}

const byType = (layer: GeoLibreLayer) => compileMapboxLayer(layer).layers;

describe("Mapbox symbology compilation", () => {
  it("draws a marker icon from a generated sprite instead of a circle", () => {
    const layers = byType(
      layerOf([feature({ type: "Point", coordinates: [0, 0] })], {
        markerEnabled: true,
        markerShape: "star",
      }),
    );
    const marker = layers.find((spec) => spec.id.endsWith("-marker"));
    assert.ok(marker && marker.type === "symbol");
    assert.equal(
      typeof marker.layout?.["icon-image"] === "string" ||
        Array.isArray(marker.layout?.["icon-image"]),
      true,
    );
    assert.ok(!layers.some((spec) => spec.type === "circle"));
  });

  it("draws Geo Editor text markers as text and keeps them out of the circles", () => {
    const layers = byType(
      layerOf([
        feature(
          { type: "Point", coordinates: [0, 0] },
          { __gm_shape: "text_marker", __gm_text: "Hi" },
        ),
        feature({ type: "Point", coordinates: [1, 1] }),
      ]),
    );
    const text = layers.find((spec) => spec.id.endsWith("-text-markers"));
    assert.ok(text);
    assert.match(JSON.stringify(text.layout?.["text-field"]), /__gm_text/);
    const circle = layers.find((spec) => spec.type === "circle");
    assert.match(JSON.stringify(circle?.filter), /"!",\["any"/);
  });

  it("applies a fill pattern and line decorations", () => {
    const layers = byType(
      layerOf([feature(square), feature(line)], { fillPattern: "hatch", lineDecoration: "arrow" }),
    );
    const fill = layers.find((spec) => spec.type === "fill");
    assert.equal(typeof fill?.paint?.["fill-pattern"], "string");
    const decoration = layers.find((spec) => spec.id.endsWith("-line-decoration"));
    assert.equal(decoration?.layout?.["symbol-placement"], "line");
    assert.ok(decoration && isInternalMapboxLayer(decoration));
  });

  it("draws an inverted fill from a companion mask source", () => {
    const plan = compileMapboxLayer(layerOf([feature(square)], { invertedFillEnabled: true }));
    const inverted = plan.layers.find((spec) => spec.id.endsWith("-inverted"));
    assert.ok(inverted && isInternalMapboxLayer(inverted));
    const source = (inverted as { source: string }).source;
    assert.equal(plan.additionalSources?.[source]?.type, "geojson");
    // The features read as holes: no ordinary fill layer draws them.
    assert.equal(plan.layers.filter((spec) => spec.type === "fill").length, 1);
    // A filter disables the mask, which ignores filters, as on MapLibre.
    const filtered = compileMapboxLayer({
      ...layerOf([feature(square)], { invertedFillEnabled: true }),
      filterExpression: ["==", 1, 1],
    });
    assert.ok(!filtered.layers.some((spec) => spec.id.endsWith("-inverted")));
  });

  it("draws the geometry generator's shapes from a companion source", () => {
    const plan = compileMapboxLayer(layerOf([feature(square)], { geometryGenerator: "centroid" }));
    const circle = plan.layers.find((spec) => spec.id.endsWith("-generator-circle"));
    assert.ok(circle && isInternalMapboxLayer(circle));
    const source = (circle as { source: string }).source;
    const data = (plan.additionalSources?.[source] as { data: FeatureCollection }).data;
    assert.equal(data.features[0].geometry.type, "Point");
  });

  it("draws a flat fill below a zoom-stepped extrusion's cutoff", () => {
    const layers = byType(
      layerOf([feature(square)], {
        extrusionEnabled: true,
        extrusionAdvancedStyleEnabled: true,
        extrusionHeightExpression: '["step", ["zoom"], 0, 12, ["get", "h"]]',
      }),
    );
    const flat = layers.find((spec) => spec.id.endsWith("-flat"));
    assert.equal(flat?.type, "fill");
    assert.equal(flat?.maxzoom, 12);
    const extrusion = layers.find((spec) => spec.type === "fill-extrusion");
    assert.equal(extrusion?.minzoom, 12);
    // Under an extrusion, polygon outlines get no line layer.
    assert.ok(!layers.some((spec) => spec.type === "line"));
  });
});
