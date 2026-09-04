import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildMapboxStyle, type ExportableLayer } from "../packages/map/src/mapbox-style-export";
import { v8 } from "@maplibre/maplibre-gl-style-spec";
import {
  applyMapboxStyleImport,
  parseMapboxStyle,
  SPEC_DEFAULT_COLOR,
} from "../packages/map/src/mapbox-style-import";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(patch: Partial<ExportableLayer> & { style?: LayerStyle } = {}): ExportableLayer {
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

function lines(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { category: "a" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
    ],
  };
}

function lineAndPoint(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { category: "a" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      {
        type: "Feature",
        properties: { category: "b" },
        geometry: { type: "Point", coordinates: [2, 2] },
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

  it("reads a property-driven step color as a graduated renderer", () => {
    // The lowest class is not one of the step's pairs: it is the base output,
    // and its lower bound rides along as the input's `to-number` fallback.
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": [
              "step",
              ["to-number", ["get", "value"], 10],
              "#dbeafe",
              50,
              "#93c5fd",
              90,
              "#2563eb",
            ],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.vectorStyleMode, "graduated");
    assert.equal(result.style.vectorStyleProperty, "value");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: 10, color: "#dbeafe" },
      { value: 50, color: "#93c5fd" },
      { value: 90, color: "#2563eb" },
    ]);
  });

  it("still reads a legacy interpolate color as a graduated renderer", () => {
    // GeoLibre exported graduated layers as a continuous `interpolate` before
    // the renderer became discrete; those projects must keep their classes.
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": [
              "interpolate",
              ["linear"],
              ["to-number", ["get", "value"], 0],
              0,
              "#dbeafe",
              50,
              "#2563eb",
            ],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.vectorStyleMode, "graduated");
    assert.equal(result.style.vectorStyleProperty, "value");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: 0, color: "#dbeafe" },
      { value: 50, color: "#2563eb" },
    ]);
  });

  it("keeps a zoom-driven step color as a raw expression", () => {
    // `step` only means graduated when it steps over a feature property.
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: { "fill-color": ["step", ["zoom"], "#111111", 8, "#222222"] },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.vectorStyleMode, "expression");
    assert.equal(result.style.vectorStyleStops, undefined);
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
      heatmapColorRamp: "viridis",
      heatmapWeightProperty: "nb_ruches",
    });
    const { style: result, warnings } = roundTrip(original, points());
    assert.deepEqual(warnings, []);
    assert.equal(result.pointRenderer, "heatmap");
    assert.equal(result.heatmapRadius, 42);
    assert.equal(result.heatmapIntensity, 2);
    assert.equal(result.heatmapColorRamp, "viridis");
    assert.equal(result.heatmapWeightProperty, "nb_ruches");
  });

  it("recovers direct heatmap weight property expressions", () => {
    for (const weight of [
      ["get", "nb_ruches"],
      ["to-number", ["get", "nb_ruches"], 0],
    ]) {
      const result = parseMapboxStyle({
        layers: [{ id: "heat", type: "heatmap", paint: { "heatmap-weight": weight } }],
      });
      assert.equal(result.style.heatmapWeightProperty, "nb_ruches");
      assert.deepEqual(result.warnings, []);
    }
  });

  it("warns instead of throwing for a malformed clamped heatmap weight", () => {
    const result = parseMapboxStyle({
      layers: [{ id: "heat", type: "heatmap", paint: { "heatmap-weight": ["max", 0, null] } }],
    });
    assert.equal(result.style.heatmapWeightProperty, undefined);
    assert.ok(result.warnings.some((warning) => /heatmap weight expression/.test(warning)));
  });

  it("recovers 3D extrusion including height, scale, and base", () => {
    const original = style({
      extrusionEnabled: true,
      extrusionColor: "#654321",
      extrusionOpacity: 0.7,
      extrusionHeightProperty: "levels",
      extrusionHeightScale: 3,
      extrusionBase: 5,
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.extrusionEnabled, true);
    assert.equal(result.extrusionColor, "#654321");
    assert.equal(result.extrusionOpacity, 0.7);
    assert.equal(result.extrusionHeightProperty, "levels");
    assert.equal(result.extrusionHeightScale, 3);
    assert.equal(result.extrusionBase, 5);
  });

  it("does not write a line-only renderer's stroke fallback into fillColor", () => {
    const original = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "category",
      strokeColor: "#aa0000",
      vectorStyleStops: [
        { value: "a", color: "#ff0000" },
        { value: "b", color: "#0000ff" },
      ],
    });
    const { style: result } = roundTrip(original, lines());
    assert.equal(result.vectorStyleMode, "categorized");
    assert.equal(result.strokeColor, "#aa0000");
    // The line fallback (strokeColor) must not leak into fillColor.
    assert.equal(result.fillColor, DEFAULT_LAYER_STYLE.fillColor);
  });

  it("keeps the point fallback color on a mixed line+point categorized layer", () => {
    const original = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "category",
      fillColor: "#00aa00",
      strokeColor: "#aa0000",
      vectorStyleStops: [
        { value: "a", color: "#ff0000" },
        { value: "b", color: "#0000ff" },
      ],
    });
    const { style: result } = roundTrip(original, lineAndPoint());
    assert.equal(result.vectorStyleMode, "categorized");
    // The circle (point) fallback wins for fillColor; strokeColor comes from the
    // line-color's polygon-outline guard, so neither is set to the other.
    assert.equal(result.fillColor, "#00aa00");
    assert.equal(result.strokeColor, "#aa0000");
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

  it("expands a multi-value match arm into one stop per value", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": [
              "match",
              ["to-string", ["get", "region"]],
              ["east", "south"],
              "#ff0000",
              "west",
              "#0000ff",
              "#999999",
            ],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: "east", color: "#ff0000" },
      { value: "south", color: "#ff0000" },
      { value: "west", color: "#0000ff" },
    ]);
    assert.equal(result.style.fillColor, "#999999");
  });

  it("warns instead of misreading a zoom width that does not start at zoom 0", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "line",
          type: "line",
          source: "s",
          paint: {
            "line-color": "#000000",
            "line-width": ["interpolate", ["exponential", 2], ["zoom"], 5, 2, 10, 8],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    // A first stop of zoom 5 (not 0) is not a GeoLibre meters width.
    assert.equal(result.style.strokeWidthUnit, undefined);
    assert.equal(result.style.strokeWidth, undefined);
    assert.ok(result.warnings.some((w) => /line width/.test(w)));
  });

  it("warns on a data-driven circle radius it cannot flatten", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "pts",
          type: "circle",
          source: "s",
          paint: {
            "circle-color": "#123123",
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 0, 2, 10, 20],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.circleRadius, undefined);
    assert.ok(result.warnings.some((w) => /circle radius/.test(w)));
  });

  it("unwraps a simplestyle coalesce wrapper on fill and outline colors", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": ["coalesce", ["get", "fill"], "#abcdef"],
            "fill-outline-color": ["coalesce", ["get", "stroke"], "#123456"],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.fillColor, "#abcdef");
    assert.equal(result.style.strokeColor, "#123456");
  });

  it("preserves a coalesce color lookup instead of replacing it with its fallback", () => {
    const color = [
      "coalesce",
      [
        "get",
        ["coalesce", ["get", "unitsymbol"], ""],
        ["literal", { Qa: "#fdfced", Qb: "#9b86c5" }],
      ],
      "rgba(0,0,0,0)",
    ];
    const result = parseMapboxStyle({
      layers: [{ id: "units", type: "fill", paint: { "fill-color": color } }],
    });

    assert.equal(result.style.vectorStyleMode, "expression");
    assert.equal(result.style.vectorStyleExpression, JSON.stringify(color));
    assert.equal(result.style.fillColor, undefined);
    assert.deepEqual(result.warnings, []);
  });

  it("preserves a coalesce object lookup with a literal property key", () => {
    const color = ["coalesce", ["get", "Qa", ["literal", { Qa: "#fdfced" }]], "#000000"];
    const result = parseMapboxStyle({
      layers: [{ id: "units", type: "fill", paint: { "fill-color": color } }],
    });

    assert.equal(result.style.vectorStyleMode, "expression");
    assert.equal(result.style.vectorStyleExpression, JSON.stringify(color));
  });

  it("recovers fill opacity from a point layer's circle-opacity", () => {
    const { style: result } = roundTrip(style({ fillOpacity: 0.5 }), points());
    assert.equal(result.fillOpacity, 0.5);
  });

  it("normalizes an inverted zoom range", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          minzoom: 12,
          maxzoom: 4,
          paint: { "fill-color": "#ffffff" },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.minZoom, 4);
    assert.equal(result.style.maxZoom, 12);
  });

  it("lets a later layer claim color when fill-color is absent", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        { id: "poly", type: "fill", source: "s", paint: {} },
        {
          id: "pts",
          type: "circle",
          source: "s",
          paint: {
            "circle-color": ["match", ["to-string", ["get", "cat"]], "a", "#ff0000", "#000000"],
          },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    // The empty fill layer must not block the circle from claiming the renderer.
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.equal(result.style.vectorStyleProperty, "cat");
  });

  it("resets strokeWidthUnit to pixels for a circle stroke after a meters line", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "line",
          type: "line",
          source: "s",
          paint: {
            "line-color": "#000000",
            "line-width": ["interpolate", ["exponential", 2], ["zoom"], 0, 1, 24, 100],
          },
        },
        {
          id: "pts",
          type: "circle",
          source: "s",
          paint: { "circle-color": "#111111", "circle-stroke-width": 3 },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.strokeWidth, 3);
    assert.equal(result.style.strokeWidthUnit, "pixels");
  });

  it("warns on a constant extrusion height it cannot represent", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill-extrusion",
          source: "s",
          paint: { "fill-extrusion-color": "#888888", "fill-extrusion-height": 30 },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.extrusionHeightProperty, undefined);
    assert.ok(result.warnings.some((w) => /constant extrusion height/.test(w)));
  });

  it("combines filtered flat-color layers of one type into rules", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "class-a",
          type: "fill",
          source: "s",
          filter: ["==", ["get", "class"], "a"],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "class-b",
          type: "fill",
          source: "s",
          filter: ["==", ["get", "class"], "b"],
          paint: { "fill-color": "#222222" },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.matchedLayerCount, 2);
    assert.equal(result.style.vectorStyleMode, "rule-based");
    assert.deepEqual(
      result.style.vectorRules?.map(({ label, filter, color, isElse, enabled }) => ({
        label,
        filter,
        color,
        isElse,
        enabled,
      })),
      [
        {
          label: "class-b",
          filter: '["==",["get","class"],"b"]',
          color: "#222222",
          isElse: false,
          enabled: undefined,
        },
        {
          label: "class-a",
          filter: '["==",["get","class"],"a"]',
          color: "#111111",
          isElse: false,
          enabled: undefined,
        },
        {
          label: "",
          filter: "",
          color: DEFAULT_LAYER_STYLE.fillColor,
          isElse: true,
          enabled: false,
        },
      ],
    );
    assert.ok(result.warnings.some((w) => /combined as rules/.test(w)));
  });

  it("uses the union of stacked rule zoom ranges for the outer layer", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "low-zoom",
          type: "fill",
          minzoom: 0,
          maxzoom: 10,
          filter: ["==", ["get", "class"], "a"],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "high-zoom",
          type: "fill",
          minzoom: 10,
          maxzoom: 20,
          filter: ["==", ["get", "class"], "b"],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.style.minZoom, 0);
    assert.equal(result.style.maxZoom, 20);
    assert.deepEqual(
      result.style.vectorRules
        ?.filter((rule) => !rule.isElse)
        .map((rule) => [rule.minZoom, rule.maxZoom]),
      [
        [10, 20],
        [0, 10],
      ],
    );
  });

  it("warns when unfiltered same-type layers cannot be combined as rules", () => {
    const result = parseMapboxStyle({
      layers: [
        { id: "f1", type: "fill", paint: { "fill-color": "#111111" } },
        { id: "f2", type: "fill", paint: { "fill-color": "#222222" } },
      ],
    });
    assert.equal(result.style.fillColor, "#111111");
    assert.ok(result.warnings.some((warning) => /only the first was imported/.test(warning)));
  });

  it("does not combine legacy layer filters into expression rules", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "legacy-a",
          type: "fill",
          filter: ["==", "class", "a"],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "legacy-b",
          type: "fill",
          filter: ["==", "class", "b"],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.matchedLayerCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#111111");
    assert.ok(result.warnings.some((warning) => /only the first was imported/.test(warning)));
  });

  it("does not combine legacy !has filters into expression rules", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "missing-class",
          type: "fill",
          filter: ["!has", "class"],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "parks",
          type: "fill",
          filter: ["==", ["get", "class"], "park"],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.matchedLayerCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#111111");
    assert.ok(result.warnings.some((warning) => /only the first was imported/.test(warning)));
  });

  it("detects legacy comparisons nested under expression negation", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "not-a",
          type: "fill",
          filter: ["!", ["==", "class", "a"]],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "parks",
          type: "fill",
          filter: ["==", ["get", "class"], "park"],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.matchedLayerCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#111111");
    assert.ok(result.warnings.some((warning) => /only the first was imported/.test(warning)));
  });

  it("does not combine legacy none filters wrapping expression children", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "no-class",
          type: "fill",
          filter: ["none", ["has", "class"]],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "parks",
          type: "fill",
          filter: ["==", ["get", "class"], "park"],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.matchedLayerCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#111111");
    assert.ok(result.warnings.some((warning) => /only the first was imported/.test(warning)));
  });

  it("combines a modern in filter with a string needle", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "parks",
          type: "fill",
          filter: ["in", "park", ["get", "classes"]],
          paint: { "fill-color": "#111111" },
        },
        {
          id: "schools",
          type: "fill",
          filter: ["in", "school", ["get", "classes"]],
          paint: { "fill-color": "#222222" },
        },
      ],
    });

    assert.equal(result.matchedLayerCount, 2);
    assert.equal(result.style.vectorStyleMode, "rule-based");
    assert.ok(result.warnings.some((warning) => /combined as rules/.test(warning)));
  });

  it("does not report stacked line rules as combined when a circle claims color", () => {
    const result = parseMapboxStyle({
      layers: [
        {
          id: "line-a",
          type: "line",
          filter: ["==", ["get", "class"], "a"],
          paint: { "line-color": "#111111" },
        },
        {
          id: "line-b",
          type: "line",
          filter: ["==", ["get", "class"], "b"],
          paint: { "line-color": "#222222" },
        },
        { id: "points", type: "circle", paint: { "circle-color": "#333333" } },
      ],
    });

    assert.equal(result.matchedLayerCount, 2);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.ok(result.warnings.some((warning) => /multiple line layers/.test(warning)));
    assert.ok(result.warnings.every((warning) => !/combined as rules/.test(warning)));
  });

  it("recognizes a bare [get] match input and text-field", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill",
          source: "s",
          paint: {
            "fill-color": ["match", ["get", "region"], "east", "#ff0000", "#000000"],
          },
        },
        {
          id: "labels",
          type: "symbol",
          source: "s",
          layout: { "text-field": ["get", "name"] },
          paint: {},
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.equal(result.style.vectorStyleProperty, "region");
    assert.equal(result.labels?.field, "name");
  });

  it("warns when a style has both circle and heatmap point layers", () => {
    const external = {
      version: 8,
      sources: {},
      layers: [
        {
          id: "pts",
          type: "circle",
          source: "s",
          paint: { "circle-color": "#111111", "circle-radius": 5 },
        },
        {
          id: "heat",
          type: "heatmap",
          source: "s",
          paint: { "heatmap-radius": 20 },
        },
      ],
    };
    const result = parseMapboxStyle(external);
    assert.equal(result.style.pointRenderer, "heatmap");
    assert.ok(result.warnings.some((w) => /both circle and heatmap/.test(w)));
  });

  it("does not fold layer opacity when opacity is 1 (round-trip is lossless)", () => {
    // A guard that the roundTrip helper's opacity=1 assumption holds: a distinct
    // fillOpacity survives export+import unchanged.
    const { style: result } = roundTrip(style({ fillOpacity: 0.33 }), polygons());
    assert.equal(result.fillOpacity, 0.33);
  });
});

describe("switched-off else rule round-trip (#1312)", () => {
  it("recovers the hide-unmatched state as a disabled else record", () => {
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
          label: "",
          filter: "",
          color: "#888888",
          isElse: true,
          enabled: false,
        },
      ],
    });
    const { style: result } = roundTrip(original, polygons());
    assert.equal(result.vectorStyleMode, "rule-based");
    assert.equal(result.vectorRules.find((rule) => rule.isElse)?.enabled, false);
  });

  it("does not disable the else rule for an unrelated any filter", () => {
    const imported = parseMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: "fill",
          type: "fill",
          source: "s",
          filter: ["all", ["==", ["geometry-type"], "Polygon"], ["any", ["has", "x"]]],
          paint: {
            "fill-color": ["case", ["==", ["get", "category"], "a"], "#00ff00", "#888888"],
          },
        },
      ],
    } as never);
    const result = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, imported);
    assert.equal(result.vectorStyleMode, "rule-based");
    assert.equal(result.vectorRules.find((rule) => rule.isElse)?.enabled, undefined);
  });
});

// #2125: dropping the whole stack over one colourless class imported a sixteen-class fault style
// as a single colour.
describe("a stacked style whose class layer names no colour", () => {
  const stacked = (second: Record<string, unknown>) =>
    parseMapboxStyle({
      layers: [
        {
          id: "a",
          type: "line",
          "source-layer": "faults",
          paint: { "line-color": "#e60000" },
          filter: ["==", ["get", "class"], "a"],
        },
        {
          id: "b",
          type: "line",
          "source-layer": "faults",
          paint: second,
          filter: ["==", ["get", "class"], "b"],
        },
      ],
    } as never);

  it("gives it the spec's default and keeps the rest of the rules", () => {
    const result = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, stacked({ "line-width": 2 }));

    assert.equal(result.vectorStyleMode, "rule-based");
    assert.deepEqual(
      result.vectorRules.filter((rule) => !rule.isElse).map((rule) => [rule.label, rule.color]),
      [
        ["b", "#000000"],
        ["a", "#e60000"],
      ],
      "the colourless class is drawn black, and the coloured one keeps its colour",
    );
  });

  // An exporter writing `null` means the same thing as omitting the property — MapLibre reads both
  // as unset and paints the default — so it must not cost the stack its rules.
  it("treats an explicit null colour as naming none", () => {
    const result = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, stacked({ "line-color": null }));

    assert.equal(result.vectorStyleMode, "rule-based");
    assert.deepEqual(
      result.vectorRules.filter((rule) => !rule.isElse).map((rule) => [rule.label, rule.color]),
      [
        ["b", "#000000"],
        ["a", "#e60000"],
      ],
    );
  });

  // Absent is not the same as present-and-not-a-flat-colour: an expression is a colour this
  // renderer cannot carry, and flattening it to black would import the style wrong rather than
  // declining to import it as rules.
  for (const [label, paint] of [
    ["a data expression", { "line-color": ["get", "colour"] }],
    ["a zoom interpolation", { "line-color": ["interpolate", ["linear"], ["zoom"], 0, "#fff"] }],
  ] as const) {
    it(`still declines the stack when a class carries ${label}`, () => {
      const result = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, stacked(paint));

      assert.notEqual(result.vectorStyleMode, "rule-based");
    });
  }

  // The spec's default only applies where nothing else paints the feature: `line-color`'s `requires`
  // excludes `line-pattern`, and a gradient or a fill pattern takes over the same way. Reading these
  // as black would import an ArcGIS hatch class as a solid colour.
  for (const [label, paint] of [
    ["a line pattern", { "line-pattern": "hatch" }],
    [
      "a line gradient",
      { "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "#fff"] },
    ],
  ] as const) {
    it(`declines the stack when a colourless class carries ${label}`, () => {
      const result = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, stacked(paint));

      assert.equal(result.vectorStyleMode, "single", "the pattern is not imported as black");
      assert.equal(result.strokeColor, "#e60000", "and the first class is imported as before");
    });
  }

  // A class naming both keeps the colour it names: the pattern check only decides what an *absent*
  // colour means, so a style that combined before still does.
  it("still reads a colour that a class names alongside a pattern", () => {
    const result = applyMapboxStyleImport(
      DEFAULT_LAYER_STYLE,
      stacked({ "line-color": "#00ff00", "line-pattern": "hatch" }),
    );

    assert.equal(result.vectorStyleMode, "rule-based");
    assert.deepEqual(
      result.vectorRules.filter((rule) => !rule.isElse).map((rule) => [rule.label, rule.color]),
      [
        ["b", "#00ff00"],
        ["a", "#e60000"],
      ],
    );
  });
});

// The spec is a dependency here but not of `@geolibre/map`, so the mirrored constant is checked
// against it rather than trusted.
describe("the colour a layer with no colour of its own is drawn in", () => {
  it("is what the style spec says for every property this importer stacks", () => {
    for (const [type, property] of [
      ["fill", "fill-color"],
      ["line", "line-color"],
      ["circle", "circle-color"],
    ] as const) {
      assert.equal(
        v8[`paint_${type}`]?.[property]?.default,
        SPEC_DEFAULT_COLOR,
        `${property} still defaults to the colour mapbox-style-import assumes`,
      );
    }
  });

  it("is not what the spec says a patterned line is drawn in", () => {
    assert.deepEqual(
      v8.paint_line?.["line-color"]?.requires,
      [{ "!": "line-pattern" }],
      "line-pattern still overrides line-color, so COLOR_OVERRIDING_PAINT must still list it",
    );
  });
});
