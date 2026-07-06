import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildMapboxStyle,
  type ExportableLayer,
} from "../packages/map/src/mapbox-style-export";
import {
  applyMapboxStyleImport,
  parseMapboxStyle,
} from "../packages/map/src/mapbox-style-import";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(
  patch: Partial<ExportableLayer> & { style?: LayerStyle } = {},
): ExportableLayer {
  return {
    id: patch.id ?? "layer-1",
    name: patch.name ?? "My Layer",
    type: patch.type ?? "geojson",
    opacity: patch.opacity ?? 1,
    visible: patch.visible ?? true,
    style: patch.style ?? style(),
  };
}

function points(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { category: "a", value: 5 },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      {
        type: "Feature",
        properties: { category: "b", value: 40 },
        geometry: { type: "Point", coordinates: [1, 1] },
      },
    ],
  };
}

function polygons(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { category: "a" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  };
}

/**
 * Export a style to Mapbox GL and re-import it, returning the recovered
 * LayerStyle applied over the defaults so the represented symbology can be
 * compared to the original. Opacity is fixed at 1 so the style opacity is not
 * folded into the paint values, keeping the round-trip lossless.
 */
function roundTrip(
  input: LayerStyle,
  geojson: FeatureCollection,
): { style: LayerStyle; warnings: string[] } {
  const exported = buildMapboxStyle(layer({ style: input, opacity: 1 }), geojson);
  const imported = parseMapboxStyle(exported.style);
  return {
    style: applyMapboxStyleImport(DEFAULT_LAYER_STYLE, imported),
    warnings: imported.warnings,
  };
}

describe("parseMapboxStyle round-trips exported symbology", () => {
  it("recovers a single-symbol polygon fill and stroke", () => {
    const original = style({
      fillColor: "#123456",
      strokeColor: "#abcdef",
      strokeWidth: 3,
      fillOpacity: 0.42,
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.vectorStyleMode, "single");
    assert.equal(result.fillColor, "#123456");
    assert.equal(result.strokeColor, "#abcdef");
    assert.equal(result.strokeWidth, 3);
    assert.equal(result.strokeWidthUnit, "pixels");
    assert.equal(result.fillOpacity, 0.42);
    assert.equal(result.extrusionEnabled, false);
  });

  it("recovers a categorized renderer with its stops and fallback", () => {
    const original = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "category",
      fillColor: "#3b82f6",
      vectorStyleStops: [
        { value: "a", color: "#ff0000" },
        { value: "b", color: "#00ff00" },
      ],
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.vectorStyleMode, "categorized");
    assert.equal(result.vectorStyleProperty, "category");
    assert.equal(result.fillColor, "#3b82f6");
    assert.deepEqual(result.vectorStyleStops, [
      { value: "a", color: "#ff0000" },
      { value: "b", color: "#00ff00" },
    ]);
  });

  it("recovers a graduated renderer from a point circle color", () => {
    const original = style({
      vectorStyleMode: "graduated",
      vectorStyleProperty: "value",
      vectorStyleStops: [
        { value: 0, color: "#dbeafe" },
        { value: 50, color: "#2563eb" },
      ],
    });
    const { style: result } = roundTrip(original, points());
    assert.equal(result.vectorStyleMode, "graduated");
    assert.equal(result.vectorStyleProperty, "value");
    assert.deepEqual(result.vectorStyleStops, [
      { value: 0, color: "#dbeafe" },
      { value: 50, color: "#2563eb" },
    ]);
  });

  it("recovers a rule-based renderer's filters, colors, and else", () => {
    const original = style({
      vectorStyleMode: "rule-based",
      vectorRules: [
        {
          id: "r1",
          label: "Parks",
          filter: '["==",["get","category"],"a"]',
          color: "#00ff00",
          isElse: false,
        },
        {
          id: "r2",
          label: "Other",
          filter: "",
          color: "#888888",
          isElse: true,
        },
      ],
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.vectorStyleMode, "rule-based");
    // id/label are editor bookkeeping and are not carried by the style; compare
    // the represented filter/color/isElse triples.
    const shape = result.vectorRules.map((rule) => ({
      filter: rule.filter,
      color: rule.color,
      isElse: rule.isElse,
    }));
    assert.deepEqual(shape, [
      { filter: '["==",["get","category"],"a"]', color: "#00ff00", isElse: false },
      { filter: "", color: "#888888", isElse: true },
    ]);
  });

  it("preserves an unclassifiable color expression verbatim", () => {
    const original = style({
      vectorStyleMode: "expression",
      vectorStyleExpression: '["rgb",255,0,0]',
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.vectorStyleMode, "expression");
    assert.equal(result.vectorStyleExpression, '["rgb",255,0,0]');
  });

  it("recovers label styling from a symbol layer", () => {
    const original = style({
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: true,
        field: "category",
        size: 18,
        color: "#101010",
        haloColor: "#fefefe",
        haloWidth: 2.5,
        anchor: "top",
        offsetX: 1,
        offsetY: -2,
        rotation: 15,
        maxWidth: 8,
        transform: "uppercase",
        allowOverlap: true,
      },
    });
    const { style: result } = roundTrip(original, points());
    assert.equal(result.labels.enabled, true);
    assert.equal(result.labels.field, "category");
    assert.equal(result.labels.size, 18);
    assert.equal(result.labels.color, "#101010");
    assert.equal(result.labels.haloColor, "#fefefe");
    assert.equal(result.labels.haloWidth, 2.5);
    assert.equal(result.labels.anchor, "top");
    assert.equal(result.labels.offsetX, 1);
    assert.equal(result.labels.offsetY, -2);
    assert.equal(result.labels.rotation, 15);
    assert.equal(result.labels.maxWidth, 8);
    assert.equal(result.labels.transform, "uppercase");
    assert.equal(result.labels.allowOverlap, true);
  });

  it("recovers a heatmap point renderer", () => {
    const original = style({
      pointRenderer: "heatmap",
      heatmapRadius: 42,
      heatmapIntensity: 2,
    });
    const { style: result } = roundTrip(original, points());
    assert.equal(result.pointRenderer, "heatmap");
    assert.equal(result.heatmapRadius, 42);
    assert.equal(result.heatmapIntensity, 2);
  });

  it("recovers 3D extrusion", () => {
    const original = style({
      extrusionEnabled: true,
      extrusionColor: "#654321",
      extrusionOpacity: 0.7,
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.extrusionEnabled, true);
    assert.equal(result.extrusionColor, "#654321");
    assert.equal(result.extrusionOpacity, 0.7);
  });

  it("recovers a map-units (meters) stroke width", () => {
    const original = style({
      strokeWidthUnit: "meters",
      strokeWidth: 100,
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.strokeWidthUnit, "meters");
    assert.ok(
      Math.abs(result.strokeWidth - 100) < 1e-6,
      `expected ~100, got ${result.strokeWidth}`,
    );
  });

  it("recovers proportional (graduated) symbol sizing", () => {
    const original = style({
      proportionalSizeEnabled: true,
      proportionalSizeProperty: "value",
      proportionalSizeMinValue: 0,
      proportionalSizeMaxValue: 100,
      proportionalSizeMinRadius: 4,
      proportionalSizeMaxRadius: 24,
    });
    const { style: result } = roundTrip(original, points());
    assert.equal(result.proportionalSizeEnabled, true);
    assert.equal(result.proportionalSizeProperty, "value");
    assert.equal(result.proportionalSizeMinValue, 0);
    assert.equal(result.proportionalSizeMaxValue, 100);
    assert.equal(result.proportionalSizeMinRadius, 4);
    assert.equal(result.proportionalSizeMaxRadius, 24);
  });

  it("recovers a narrowed zoom range", () => {
    const original = style({ minZoom: 4, maxZoom: 12 });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.minZoom, 4);
    assert.equal(result.maxZoom, 12);
  });
});

describe("parseMapboxStyle imports hand-written styles", () => {
  it("reads a plain external fill/line style", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": "#ff8800",
            "fill-opacity": 0.5,
            "fill-outline-color": "#004400",
          },
        },
        {
          id: "poly-line",
          type: "line",
          source: "s",
          paint: { "line-color": "#004400", "line-width": 4 },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.matchedLayerCount, 2);
    assert.equal(result.style.fillColor, "#ff8800");
    assert.equal(result.style.fillOpacity, 0.5);
    assert.equal(result.style.strokeColor, "#004400");
    assert.equal(result.style.strokeWidth, 4);
    assert.equal(result.style.vectorStyleMode, "single");
  });

  it("warns and imports nothing when there is no layers array", () => {
    const result = parseMapboxStyle({ hello: "world" });
    assert.equal(result.matchedLayerCount, 0);
    assert.deepEqual(result.style, {});
    assert.equal(result.labels, null);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /not a Mapbox GL style/);
  });

  it("warns on a data-driven fill opacity it cannot flatten", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": "#ffffff",
            "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.1, 10, 0.9],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.fillColor, "#ffffff");
    assert.ok(result.style.fillOpacity === undefined);
    assert.ok(result.warnings.some((w) => /fill opacity is data-driven/.test(w)));
  });

  it("maps a Mapbox token text-field to a label field", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "labels",
          type: "symbol",
          source: "s",
          layout: { "text-field": "{name}", "symbol-placement": "line-center" },
          paint: { "text-color": "#000000" },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.matchedLayerCount, 1);
    assert.equal(result.labels?.enabled, true);
    assert.equal(result.labels?.field, "name");
    assert.equal(result.labels?.expression, "");
    // line-center is treated as line placement.
    assert.equal(result.labels?.placement, "line");
  });

  it("ignores an unsupported text-anchor and a literal text-field", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "labels",
          type: "symbol",
          source: "s",
          layout: { "text-field": "Static label", "text-anchor": "middle" },
          paint: {},
        },
      ],
    };
    const result = parseMapboxStyle(external);
    // Unknown anchor is dropped (base value kept), and a literal (non-token)
    // text-field is not stored as a field/expression.
    assert.equal(result.labels?.anchor, undefined);
    assert.equal(result.labels?.field, undefined);
    assert.equal(result.labels?.expression, undefined);
    assert.ok(result.warnings.some((w) => /no text field/.test(w)));
  });

  it("routes an extruded categorized fallback color to extrusionColor", () => {
    const original = style({
      extrusionEnabled: true,
      extrusionColor: "#654321",
      vectorStyleMode: "categorized",
      vectorStyleProperty: "category",
      vectorStyleStops: [
        { value: "a", color: "#ff0000" },
        { value: "b", color: "#00ff00" },
      ],
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.extrusionEnabled, true);
    assert.equal(result.vectorStyleMode, "categorized");
    // extrusionColorValue embeds extrusionColor as the match fallback on export,
    // so import must route that fallback back into extrusionColor (not only
    // fillColor) for extrusionColorValue to rebuild the same fallback.
    assert.equal(result.extrusionColor, "#654321");
  });

  it("does not fold layer opacity when opacity is 1 (round-trip is lossless)", () => {
    // A guard that the roundTrip helper's opacity=1 assumption holds: a distinct
    // fillOpacity survives export+import unchanged.
    const { style: result } = roundTrip(style({ fillOpacity: 0.33 }), polygons());
    assert.equal(result.fillOpacity, 0.33);
  });
});
