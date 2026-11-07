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

  it("recovers a data-driven extrusion base property, scale, and offset", () => {
    const { style: result } = roundTrip(
      style({
        extrusionEnabled: true,
        extrusionBase: 2,
        extrusionBaseProperty: "level",
        extrusionBaseScale: 3.5,
      }),
      polygons(),
    );
    assert.equal(result.extrusionBase, 2);
    assert.equal(result.extrusionBaseProperty, "level");
    assert.equal(result.extrusionBaseScale, 3.5);
  });

  it("round-trips a floor height on a data-driven base", () => {
    const { style: result } = roundTrip(
      style({
        extrusionEnabled: true,
        extrusionBase: 5,
        extrusionBaseProperty: "level",
        extrusionBaseScale: 5,
        extrusionFloorHeight: 4,
      }),
      polygons(),
    );
    assert.equal(result.extrusionFloorHeight, 4);
    assert.equal(result.extrusionBaseProperty, "level");
    assert.equal(result.extrusionBaseScale, 5);
    assert.equal(result.extrusionBase, 5);
  });

  it("keeps base expressions that only resemble the exporter's shape", () => {
    const extrusion = (base: unknown) =>
      parseMapboxStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: "floors",
            type: "fill-extrusion",
            source: "s",
            paint: { "fill-extrusion-base": base },
          },
        ],
      }).style;
    // A non-zero fallback and an object-qualified `get` change the meaning,
    // so they stay expressions rather than becoming a base property.
    for (const base of [
      ["*", ["to-number", ["get", "level"], 10], 3],
      ["*", ["to-number", ["get", "level", ["properties"]], 0], 3],
    ]) {
      const result = extrusion(base);
      assert.equal(result.extrusionBaseProperty, "");
      assert.deepEqual(JSON.parse(result.extrusionBaseExpression ?? ""), base);
    }
    // The exporter's shape clears a competing advanced base; a flat base
    // clears both.
    const property = extrusion(["*", ["to-number", ["get", "level"], 0], 3]);
    assert.equal(property.extrusionBaseProperty, "level");
    assert.equal(property.extrusionBaseExpression, "");
    const flat = extrusion(4);
    assert.equal(flat.extrusionBase, 4);
    assert.equal(flat.extrusionBaseProperty, "");
    assert.equal(flat.extrusionBaseExpression, "");
  });

  it("does not wake dormant height or colour expressions for an advanced base", () => {
    const result = parseMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: "floors",
          type: "fill-extrusion",
          source: "s",
          paint: {
            "fill-extrusion-height": ["*", ["to-number", ["get", "top"], 0], 1],
            "fill-extrusion-base": ["match", ["get", "floor"], "B1", 0, 10],
          },
        },
      ],
    }).style;
    assert.equal(result.extrusionAdvancedStyleEnabled, true);
    assert.equal(result.extrusionHeightProperty, "top");
    assert.equal(result.extrusionHeightExpression, "");
    assert.equal(result.extrusionColorExpression, "");
  });

  it("round-trips an advanced extrusion base expression", () => {
    const expression = ["match", ["get", "floor"], "B1", 0, 10];
    const { style: result } = roundTrip(
      style({
        extrusionEnabled: true,
        extrusionAdvancedStyleEnabled: true,
        extrusionBaseExpression: JSON.stringify(expression),
      }),
      polygons(),
    );
    assert.equal(result.extrusionAdvancedStyleEnabled, true);
    assert.deepEqual(JSON.parse(result.extrusionBaseExpression ?? ""), expression);
    assert.equal(result.extrusionBaseProperty, "");
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

  it("imports line opacity, dashes and blur, and names the line paint the layer style cannot hold", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "rivers",
          type: "line",
          source: "s",
          paint: {
            "line-color": "#8be6ff",
            "line-width": 1.2,
            "line-opacity": 0.6,
            "line-dasharray": [2, 1],
            "line-blur": 3,
            "line-gap-width": 2,
            "line-offset": 4,
            "line-translate": [2, -2],
            "line-pattern": "hatch",
            "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "blue", 1, "red"],
          },
        },
      ],
    });
    assert.equal(result.style.strokeColor, "#8be6ff");
    assert.equal(result.style.strokeWidth, 1.2);
    assert.equal(result.style.strokeOpacity, 0.6);
    assert.deepEqual(result.style.strokeDash, [2, 1]);
    assert.equal(result.style.strokeBlur, 3);
    // The rest is reported, one note per property.
    assert.deepEqual(result.warnings, [
      "The line gap width (a casing around a gap) cannot be represented; the lines import as single strokes.",
      "The line offset cannot be represented; the lines import centered on the geometry.",
      "The line translation cannot be represented; the lines import in place on the geometry.",
      "The line pattern image cannot be represented; the lines import as a flat color.",
      "The line gradient cannot be represented; the lines import with a single flat color.",
    ]);
  });

  it("resets line opacity, dashes and blur a line layer leaves at the spec default", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [{ id: "rivers", type: "line", paint: { "line-color": "#8be6ff" } }],
    });
    const imported = applyMapboxStyleImport(
      style({ strokeOpacity: 0.3, strokeDash: [4, 2], strokeBlur: 5 }),
      result,
    );
    assert.equal(imported.strokeOpacity, 1);
    assert.deepEqual(imported.strokeDash, []);
    assert.equal(imported.strokeBlur, 0);
  });

  it("reads a literal-wrapped dash pattern and an empty one as solid", () => {
    const read = (dash: unknown) =>
      parseMapboxStyle({
        version: 8,
        layers: [{ id: "l", type: "line", paint: { "line-dasharray": dash } }],
      });
    assert.deepEqual(read(["literal", [3, 1, 1, 1]]).style.strokeDash, [3, 1, 1, 1]);
    assert.deepEqual(read([]).style.strokeDash, []);
    assert.deepEqual(read(["literal", []]).style.strokeDash, []);
  });

  it("reports a zoom-driven or malformed dash pattern and keeps the layer's own", () => {
    const zoomed = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "l",
          type: "line",
          paint: {
            "line-dasharray": ["step", ["zoom"], ["literal", [1, 1]], 10, ["literal", [3, 1]]],
          },
        },
      ],
    });
    assert.equal(zoomed.style.strokeDash, undefined);
    assert.deepEqual(zoomed.warnings, [
      "The line dash pattern changes with zoom, which the layer style cannot hold; the lines keep their current dash pattern.",
    ]);
    for (const dash of [[-1, 2], [0, 0], "2 1", ["literal", ["a"]]]) {
      const result = parseMapboxStyle({
        version: 8,
        layers: [{ id: "l", type: "line", paint: { "line-dasharray": dash } }],
      });
      assert.equal(result.style.strokeDash, undefined, JSON.stringify(dash));
      assert.deepEqual(result.warnings, [
        "The line dash pattern is not a list of non-negative lengths and was not applied.",
      ]);
    }
  });

  it("reports an expression-valued line translation", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "rivers",
          type: "line",
          paint: {
            "line-translate": [
              "interpolate",
              ["linear"],
              ["zoom"],
              5,
              ["literal", [0, 0]],
              10,
              ["literal", [3, 3]],
            ],
          },
        },
      ],
    });
    assert.deepEqual(result.warnings, [
      "The line translation cannot be represented; the lines import in place on the geometry.",
    ]);
  });

  it("does not report line paint left at its spec default", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "rivers",
          type: "line",
          source: "s",
          paint: {
            "line-color": "#8be6ff",
            "line-opacity": 1,
            "line-blur": 0,
            "line-gap-width": 0,
            "line-offset": 0,
            "line-translate": [0, 0],
          },
        },
      ],
    });
    assert.deepEqual(result.warnings, []);
  });

  it("does not report spec defaults wrapped in a literal", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "rivers",
          type: "line",
          paint: {
            "line-opacity": ["literal", 1],
            "line-blur": ["literal", 0],
            "line-gap-width": ["literal", 0],
            "line-offset": ["literal", 0],
            "line-translate": ["literal", [0, 0]],
          },
        },
      ],
    });
    assert.deepEqual(result.warnings, []);
  });

  it("reports a data-driven or negative line blur and reads the simplestyle line opacity", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "rivers",
          type: "line",
          source: "s",
          paint: {
            "line-color": "#8be6ff",
            // The shape the exporter writes for simplestyle `stroke-opacity`.
            "line-opacity": ["to-number", ["coalesce", ["get", "stroke-opacity"], 0.7], 0.7],
            "line-blur": ["get", "blur"],
          },
        },
      ],
    });
    assert.equal(result.style.strokeOpacity, 0.7);
    assert.equal(result.style.simpleStyleEnabled, true);
    assert.equal(result.style.strokeBlur, undefined);
    assert.deepEqual(result.warnings, [
      "The line blur varies by zoom or by feature, which the layer style cannot hold; the lines keep their current blur.",
    ]);
    const negative = parseMapboxStyle({
      version: 8,
      layers: [{ id: "l", type: "line", paint: { "line-blur": -1 } }],
    });
    assert.deepEqual(negative.warnings, ["The line blur is negative and was not applied."]);
  });

  it("round-trips an exported line layer without line paint warnings", () => {
    const { warnings } = roundTrip(style({ strokeColor: "#336699", strokeWidth: 3 }), lines());
    assert.deepEqual(warnings, []);
  });

  it("round-trips stroke opacity, dashes and blur through a Mapbox GL export", () => {
    for (const simpleStyleEnabled of [false, true]) {
      for (const [name, geojson] of [
        ["lines", lines()],
        ["polygons", polygons()],
        ["points", points()],
      ] as const) {
        const source = style({
          strokeOpacity: 0.4,
          strokeDash: [4, 2, 1, 2],
          strokeBlur: 2,
          simpleStyleEnabled,
        });
        const { style: imported, warnings } = roundTrip(source, geojson);
        const label = `${name}, simpleStyleEnabled=${simpleStyleEnabled}`;
        assert.deepEqual(warnings, [], label);
        assert.equal(imported.strokeOpacity, 0.4, label);
        // Circle strokes have no dash or blur, so only lines carry them.
        if (name !== "points") {
          assert.deepEqual(imported.strokeDash, [4, 2, 1, 2], label);
          assert.equal(imported.strokeBlur, 2, label);
        }
      }
    }
  });

  it("reports a zoom- or data-driven line opacity", () => {
    for (const lineOpacity of [
      {
        stops: [
          [0, 0.2],
          [10, 1],
        ],
      },
      ["interpolate", ["linear"], ["zoom"], 0, 0.2, 10, 1],
      ["get", "opacity"],
      // Author expressions that read `stroke-opacity` but are not the simplestyle lookup.
      ["case", ["has", "stroke-opacity"], ["get", "stroke-opacity"], 0.4],
      ["interpolate", ["linear"], ["get", "stroke-opacity"], 0, 0.2, 1, 1],
    ]) {
      const result = parseMapboxStyle({
        version: 8,
        layers: [{ id: "rivers", type: "line", paint: { "line-opacity": lineOpacity } }],
      });
      assert.equal(result.style.strokeOpacity, undefined);
      assert.deepEqual(result.warnings, [
        "The line opacity varies by zoom or by feature, which the layer style cannot hold; the lines keep their current stroke opacity.",
      ]);
    }
  });

  it("reads the layer opacity a semi-transparent line export folds in as the stroke opacity", () => {
    // The exporter folds the layer opacity into `line-opacity`, as it does into
    // `fill-opacity`; the import reads the product back into the layer style.
    for (const simpleStyleEnabled of [false, true]) {
      const exported = buildMapboxStyle(
        layer({
          style: style({ strokeColor: "#336699", strokeOpacity: 0.8, simpleStyleEnabled }),
          opacity: 0.5,
        }),
        lines(),
      );
      const { style: patch, warnings } = parseMapboxStyle(exported.style);
      assert.equal(patch.strokeOpacity, 0.4, `simpleStyleEnabled=${simpleStyleEnabled}`);
      assert.deepEqual(warnings, [], `simpleStyleEnabled=${simpleStyleEnabled}`);
    }
  });

  it("checks every drawn class of a combined line stack and names each property once", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "minor",
          type: "line",
          filter: ["==", ["get", "rank"], "minor"],
          paint: { "line-color": "#0b3a57", "line-width": 1, "line-blur": 2, "line-offset": 1 },
        },
        {
          id: "major",
          type: "line",
          filter: ["==", ["get", "rank"], "major"],
          paint: {
            "line-color": "#8be6ff",
            "line-width": 3,
            "line-blur": 1,
            "line-dasharray": [2, 1],
            "line-offset": 2,
          },
        },
        {
          id: "hidden",
          type: "line",
          filter: ["==", ["get", "rank"], "other"],
          layout: { visibility: "none" },
          paint: { "line-color": "#ffffff", "line-gap-width": 3 },
        },
      ],
    });
    // The stack became rules, so both drawn classes are read; the hidden one is not.
    assert.equal(result.style.vectorStyleMode, "rule-based");
    // Dash and blur come from the bottom-most class, and the difference is named.
    assert.deepEqual(result.style.strokeDash, []);
    assert.equal(result.style.strokeBlur, 2);
    const lineNotes = result.warnings.filter((warning) =>
      /^The (line|stacked line) /.test(warning),
    );
    assert.deepEqual(lineNotes, [
      "The stacked line layers use different dash patterns, which the layer style cannot hold; the lines import with the bottom-most layer's pattern.",
      "The stacked line layers use different blurs, which the layer style cannot hold; the lines import with the bottom-most layer's blur.",
      "The line offset cannot be represented; the lines import centered on the geometry.",
    ]);
  });

  it("checks only the line layer it imports when unfiltered layers are not combined", () => {
    // Without filters the layers do not combine into rules: only the first drawn line is
    // imported, so the second one's dashes neither apply nor are reported.
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "casing", type: "line", paint: { "line-color": "#0b3a57", "line-width": 6 } },
        {
          id: "stroke",
          type: "line",
          paint: { "line-color": "#8be6ff", "line-width": 1, "line-dasharray": [2, 1] },
        },
      ],
    });
    assert.equal(result.style.strokeColor, "#0b3a57");
    assert.deepEqual(result.style.strokeDash, []);
    assert.equal(
      result.warnings.some((warning) => warning.includes("dash")),
      false,
    );
  });

  it("reports a malformed or out-of-range line opacity as unreadable, not as zoom- or data-driven", () => {
    for (const lineOpacity of [
      "0.5",
      true,
      {},
      ["literal", "bad"],
      ["literal", []],
      // A bare array is not an expression: it has no operator name.
      [],
      [1, 2],
      1.2,
      -0.2,
      // The simplestyle lookup scaled by something that is not a number.
      ["*", ["to-number", ["coalesce", ["get", "stroke-opacity"], 1], 1], "0.5"],
    ]) {
      const result = parseMapboxStyle({
        version: 8,
        layers: [{ id: "rivers", type: "line", paint: { "line-opacity": lineOpacity } }],
      });
      assert.equal(result.style.strokeOpacity, undefined, JSON.stringify(lineOpacity));
      assert.deepEqual(result.warnings, [
        "The line opacity is not a valid number between 0 and 1 and was not applied; the lines keep their current stroke opacity.",
      ]);
    }
  });

  it("reads the line layer a hidden-only style imports, and skips hidden layers beside drawn ones", () => {
    const dashed = { "line-color": "#8be6ff", "line-dasharray": [2, 1] };
    // Every layer hidden: the importer still reads this line, dashes included.
    const hiddenOnly = parseMapboxStyle({
      version: 8,
      layers: [{ id: "rivers", type: "line", layout: { visibility: "none" }, paint: dashed }],
    });
    assert.deepEqual(hiddenOnly.style.strokeDash, [2, 1]);
    // A hidden dashed line beside a drawn solid one is not imported.
    const besideDrawn = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "solid", type: "line", paint: { "line-color": "#336699" } },
        { id: "rivers", type: "line", layout: { visibility: "none" }, paint: dashed },
      ],
    });
    assert.deepEqual(besideDrawn.style.strokeDash, []);
  });

  it("names the opacity once when stacked line classes differ, and keeps one shared value", () => {
    const opacityPaint = (color: string, opacity: unknown) =>
      opacity === undefined
        ? { "line-color": color }
        : { "line-color": color, "line-opacity": opacity };
    const stack = (first: unknown, second: unknown) =>
      parseMapboxStyle({
        version: 8,
        layers: [
          {
            id: "minor",
            type: "line",
            filter: ["==", ["get", "rank"], "minor"],
            paint: opacityPaint("#0b3a57", first),
          },
          {
            id: "major",
            type: "line",
            filter: ["==", ["get", "rank"], "major"],
            paint: opacityPaint("#8be6ff", second),
          },
        ],
      });
    const notes = (result: ReturnType<typeof stack>) =>
      result.warnings.filter((warning) => warning.includes("opacit"));
    const mixed = [
      "The stacked line layers use different opacities, which the layer style cannot hold; the lines import at the bottom-most layer's opacity.",
    ];
    assert.deepEqual(notes(stack(0.5, 0.6)), mixed);
    assert.equal(stack(0.5, 0.6).style.strokeOpacity, 0.5);
    // An opaque class beside a translucent one is mixed too, whether its opacity is 1 or unset.
    assert.deepEqual(notes(stack(1, 0.5)), mixed);
    assert.deepEqual(notes(stack(undefined, 0.5)), mixed);
    // A data-driven class beside a flat one keeps the more specific note.
    assert.deepEqual(notes(stack(["get", "alpha"], 0.5)), [
      "The line opacity varies by zoom or by feature, which the layer style cannot hold; the lines keep their current stroke opacity.",
    ]);
    // A shared translucent opacity imports with nothing to report.
    assert.deepEqual(notes(stack(0.5, 0.5)), []);
    assert.equal(stack(0.5, 0.5).style.strokeOpacity, 0.5);
  });

  it("does not report the line opacity the exporter writes for simplestyle", () => {
    const { warnings } = roundTrip(
      style({ strokeColor: "#336699", strokeWidth: 3, simpleStyleEnabled: true }),
      lines(),
    );
    assert.equal(
      warnings.some((warning) => warning.startsWith("The line opacity")),
      false,
    );
  });

  it("turns simplestyle on and reads the base values of a simplestyle export", () => {
    // The target layer has simplestyle off (DEFAULT_LAYER_STYLE), so without the
    // flag the per-feature colors, widths and opacities would not apply (#3351).
    const source = style({
      fillColor: "#aa3300",
      strokeColor: "#336699",
      strokeWidth: 3,
      fillOpacity: 0.4,
      simpleStyleEnabled: true,
    });
    for (const [name, geojson] of [
      ["points", points()],
      ["lines", lines()],
      ["polygons", polygons()],
    ] as const) {
      const { style: imported, warnings } = roundTrip(source, geojson);
      assert.equal(imported.simpleStyleEnabled, true, name);
      assert.deepEqual(warnings, [], name);
      assert.equal(imported.strokeWidth, 3, name);
      assert.equal(imported.strokeColor, "#336699", name);
      if (name !== "lines") {
        assert.equal(imported.fillColor, "#aa3300", name);
        assert.equal(imported.fillOpacity, 0.4, name);
      }
    }
  });

  it("folds the layer opacity into a simplestyle fill opacity like a flat one", () => {
    const exported = buildMapboxStyle(
      layer({ style: style({ fillOpacity: 0.8, simpleStyleEnabled: true }), opacity: 0.5 }),
      polygons(),
    );
    const { style: patch } = parseMapboxStyle(exported.style);
    assert.equal(patch.fillOpacity, 0.4);
  });

  it("does not turn simplestyle on for a style without simplestyle lookups", () => {
    const { style: imported } = roundTrip(style({ strokeColor: "#336699" }), lines());
    assert.equal(imported.simpleStyleEnabled, DEFAULT_LAYER_STYLE.simpleStyleEnabled);
    const external = parseMapboxStyle({
      version: 8,
      layers: [
        // A coalesce over a property that is not a simplestyle key.
        { id: "l", type: "line", paint: { "line-color": ["coalesce", ["get", "colour"], "#000"] } },
      ],
    });
    assert.equal(external.style.simpleStyleEnabled, undefined);
  });

  it("turns simplestyle on for a hidden-only style and ignores a hidden class beside drawn ones", () => {
    const lookup = ["coalesce", ["get", "stroke"], "#112233"];
    const hiddenOnly = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "l", type: "line", layout: { visibility: "none" }, paint: { "line-color": lookup } },
      ],
    });
    assert.equal(hiddenOnly.style.simpleStyleEnabled, true);
    const hiddenBesideDrawn = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "f", type: "fill", paint: { "fill-color": "#ffffff" } },
        { id: "l", type: "line", layout: { visibility: "none" }, paint: { "line-color": lookup } },
      ],
    });
    assert.equal(hiddenBesideDrawn.style.simpleStyleEnabled, undefined);
  });

  it("does not read an opacity fold on a width, and rejects a folded opacity above 1", () => {
    const lookup = (key: string, base: number) => [
      "to-number",
      ["coalesce", ["get", key], base],
      base,
    ];
    const width = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "l", type: "line", paint: { "line-width": ["*", lookup("stroke-width", 2), 1.5] } },
      ],
    });
    assert.equal(width.style.strokeWidth, undefined);
    assert.deepEqual(width.warnings, [
      "A line width expression could not be read; the layer keeps its current stroke width.",
    ]);
    const opacity = parseMapboxStyle({
      version: 8,
      layers: [
        { id: "f", type: "fill", paint: { "fill-opacity": ["*", lookup("fill-opacity", 1), 3] } },
      ],
    });
    assert.equal(opacity.style.fillOpacity, undefined);
    assert.deepEqual(opacity.warnings, [
      "The fill opacity is not between 0 and 1 and was not applied; the layer keeps its current fill opacity.",
    ]);
  });

  it("still warns about a lookup on a paint value the import reads flat", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "c",
          type: "circle",
          paint: { "circle-radius": ["to-number", ["coalesce", ["get", "stroke-width"], 3], 3] },
        },
      ],
    });
    assert.equal(result.style.circleRadius, undefined);
    assert.ok(
      result.warnings.includes(
        "The circle radius is data-driven in a way that could not be read; the layer keeps its current circle radius.",
      ),
      JSON.stringify(result.warnings),
    );
  });

  it("takes a flat fill opacity as written, as before", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [{ id: "f", type: "fill", paint: { "fill-opacity": 1.5 } }],
    });
    assert.equal(result.style.fillOpacity, 1.5);
  });

  it("recognizes every simplestyle lookup the exporter writes into paint the import reads", () => {
    // A drift guard for the importer's list of paint properties: each property
    // a simplestyle export wraps in a lookup, taken alone, turns the flag on.
    const unread = new Set<string>();
    const checked = new Set<string>();
    for (const geojson of [points(), lines(), polygons()]) {
      const exported = buildMapboxStyle(
        layer({ style: style({ simpleStyleEnabled: true }) }),
        geojson,
      );
      for (const styleLayer of exported.style.layers) {
        const paint = (styleLayer as { paint?: Record<string, unknown> }).paint ?? {};
        for (const [property, value] of Object.entries(paint)) {
          if (!JSON.stringify(value).includes('["get"')) continue;
          checked.add(property);
          const alone = parseMapboxStyle({
            version: 8,
            layers: [{ id: "x", type: styleLayer.type, paint: { [property]: value } }],
          });
          assert.equal(
            alone.style.simpleStyleEnabled,
            unread.has(property) ? undefined : true,
            `${styleLayer.type} ${property}`,
          );
        }
      }
    }
    assert.ok(checked.has("line-width") && checked.has("circle-color"), [...checked].join());
  });

  it("turns simplestyle on only for lookups in paint the import reads", () => {
    const blurOnly = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "l",
          type: "line",
          paint: {
            "line-color": "#112233",
            "line-blur": ["to-number", ["coalesce", ["get", "stroke-width"], 1], 1],
          },
        },
      ],
    });
    assert.equal(blurOnly.style.simpleStyleEnabled, undefined);
  });

  it("turns simplestyle on for a lookup in any drawn class of a combined stack", () => {
    const result = parseMapboxStyle({
      version: 8,
      layers: [
        {
          id: "minor",
          type: "line",
          filter: ["==", ["get", "rank"], "minor"],
          paint: { "line-color": "#0b3a57" },
        },
        {
          id: "major",
          type: "line",
          filter: ["==", ["get", "rank"], "major"],
          paint: {
            "line-color": "#8be6ff",
            "line-width": ["to-number", ["coalesce", ["get", "stroke-width"], 3], 3],
          },
        },
      ],
    });
    assert.equal(result.style.vectorStyleMode, "rule-based");
    assert.equal(result.style.simpleStyleEnabled, true);
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

  it("reads a constant extrusion height as a floor height above the base", () => {
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
    assert.equal(result.style.extrusionFloorHeight, 30);
    assert.ok(!result.warnings.some((w) => /constant extrusion height/.test(w)));
  });

  it("resets the base when a floor height comes from a style with no base", () => {
    const layer = style({
      extrusionEnabled: true,
      extrusionBase: 5,
      extrusionBaseProperty: "level",
      extrusionBaseScale: 5,
    });
    const result = applyMapboxStyleImport(
      layer,
      parseMapboxStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: "poly",
            type: "fill-extrusion",
            source: "s",
            paint: { "fill-extrusion-height": 30 },
          },
        ],
      }),
    );
    assert.equal(result.extrusionFloorHeight, 30);
    assert.equal(result.extrusionBase, 0);
    assert.equal(result.extrusionBaseProperty, "");
  });

  it("drops a kept base property when the imported style has no base", () => {
    const layer = style({
      extrusionEnabled: true,
      extrusionBaseProperty: "level",
      extrusionAdvancedStyleEnabled: true,
      extrusionBaseExpression: '["get", "z"]',
    });
    const result = applyMapboxStyleImport(
      layer,
      parseMapboxStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: "poly",
            type: "fill-extrusion",
            source: "s",
            paint: { "fill-extrusion-height": ["*", ["to-number", ["get", "h"], 0], 1] },
          },
        ],
      }),
    );
    assert.equal(result.extrusionHeightProperty, "h");
    assert.equal(result.extrusionBaseProperty, "");
    assert.equal(result.extrusionBaseExpression, "");
  });

  it("drops a kept floor height when the imported style has no height", () => {
    const result = applyMapboxStyleImport(
      style({ extrusionEnabled: true, extrusionFloorHeight: 4 }),
      parseMapboxStyle({
        version: 8,
        sources: {},
        layers: [
          {
            id: "poly",
            type: "fill-extrusion",
            source: "s",
            paint: { "fill-extrusion-color": "#888888" },
          },
        ],
      }),
    );
    assert.equal(result.extrusionFloorHeight, 0);
  });

  it("warns on a constant extrusion roof below a constant base", () => {
    const result = parseMapboxStyle({
      version: 8,
      sources: {},
      layers: [
        {
          id: "poly",
          type: "fill-extrusion",
          source: "s",
          paint: { "fill-extrusion-height": 30, "fill-extrusion-base": 40 },
        },
      ],
    });
    assert.equal(result.style.extrusionFloorHeight, 0);
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
    assert.ok(
      result.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
    );
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
    assert.ok(
      result.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
    );
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
    assert.ok(
      result.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
    );
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
    assert.ok(
      result.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
    );
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
    assert.ok(
      result.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
    );
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
        (v8[`paint_${type}`] as Record<string, { default?: unknown } | undefined>)[property]
          ?.default,
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

// A layer the publisher switched off must not decide what the imported layer looks like while a
// drawn one is available. `main` never read `layout.visibility` on this path at all.
describe("a style layer the publisher switched off", () => {
  const lineClass = (
    id: string,
    color: string,
    options: { hidden?: boolean; minzoom?: number; maxzoom?: number } = {},
  ) => ({
    id,
    type: "line",
    "source-layer": "f",
    ...(options.minzoom === undefined
      ? {}
      : { minzoom: options.minzoom, maxzoom: options.maxzoom }),
    ...(options.hidden ? { layout: { visibility: "none" } } : {}),
    paint: { "line-color": color },
    filter: ["==", ["get", "c"], id],
  });

  const read = (layers: unknown[]) =>
    applyMapboxStyleImport(DEFAULT_LAYER_STYLE, parseMapboxStyle({ layers } as never));

  it("imports a hidden class switched off", () => {
    const result = read([lineClass("a", "#00ff00"), lineClass("b", "#e60000", { hidden: true })]);

    assert.equal(result.vectorStyleMode, "rule-based");
    assert.deepEqual(
      result.vectorRules
        .filter((rule) => !rule.isElse)
        // Absent means enabled, which is how every other rule this importer builds reads.
        .map((rule) => [rule.label, rule.enabled ?? true]),
      [
        ["b", false],
        ["a", true],
      ],
      "the class nobody sees comes in unchecked, the drawn one checked",
    );
  });

  it("keeps a hidden class out of the zoom range", () => {
    const result = read([
      lineClass("a", "#00ff00", { minzoom: 4, maxzoom: 12 }),
      lineClass("b", "#e60000", { hidden: true, minzoom: 0, maxzoom: 22 }),
    ]);

    assert.equal(result.minZoom, 4);
    assert.equal(result.maxZoom, 12);
  });

  it("falls back to a single layer when every class is hidden", () => {
    const result = read([
      lineClass("a", "#00ff00", { hidden: true }),
      lineClass("b", "#e60000", { hidden: true }),
    ]);

    assert.notEqual(
      result.vectorStyleMode,
      "rule-based",
      "rules that are every one disabled would import the layer blank and report success",
    );
  });

  it("prefers a drawn layer over an earlier hidden one", () => {
    const result = read([
      {
        id: "h",
        type: "line",
        "source-layer": "f",
        layout: { visibility: "none" },
        paint: { "line-color": "#ff0000" },
      },
      { id: "d", type: "line", "source-layer": "f", paint: { "line-color": "#00ff00" } },
      // An expression colour on any entry disqualifies the stack, forcing the single-layer path.
      { id: "x", type: "line", "source-layer": "f", paint: { "line-color": ["get", "colour"] } },
    ]);

    assert.equal(result.strokeColor, "#00ff00");
  });

  it("does not let a hidden heatmap take the point renderer from a drawn circle", () => {
    const result = read([
      { id: "c", type: "circle", "source-layer": "f", paint: { "circle-color": "#00ff00" } },
      { id: "h", type: "heatmap", "source-layer": "f", layout: { visibility: "none" } },
    ]);

    assert.equal(result.pointRenderer, "single");
    assert.equal(result.fillColor, "#00ff00");
  });

  it("does not let a hidden extrusion take the layer from a drawn fill", () => {
    const result = read([
      { id: "f", type: "fill", "source-layer": "f", paint: { "fill-color": "#00ff00" } },
      {
        id: "e",
        type: "fill-extrusion",
        "source-layer": "f",
        layout: { visibility: "none" },
        paint: { "fill-extrusion-height": 10 },
      },
    ]);

    assert.equal(result.extrusionEnabled, false);
    assert.equal(result.fillColor, "#00ff00", "the drawn fill's colour survives");
  });

  // Two cases that are correct as they stand, guarded so the fix above does not take them with it.
  it("still lets a lone hidden layer donate its paint", () => {
    const result = read([
      {
        id: "h",
        type: "line",
        "source-layer": "f",
        layout: { visibility: "none" },
        paint: { "line-color": "#ff0000" },
      },
    ]);

    assert.equal(result.strokeColor, "#ff0000", "there is no drawn alternative to prefer");
  });

  it("drops a hidden heatmap even when nothing else claims the point renderer", () => {
    // One decision for the whole style, not one per contest: the question is whether the author
    // left the layer on, not whether another layer wants the same field.
    const style = parseMapboxStyle({
      layers: [
        { id: "f", type: "fill", "source-layer": "x", paint: { "fill-color": "#00ff00" } },
        { id: "h", type: "heatmap", "source-layer": "x", layout: { visibility: "none" } },
      ],
    } as never);

    assert.equal(style.style.pointRenderer, undefined);
    assert.deepEqual(style.warnings, ["The style's heatmap layer is hidden; it was not imported."]);
  });

  it("does not import labels from a symbol switched off beside drawn paint", () => {
    // A hand-authored style turning labels off. Distinct from the case below, where the whole
    // style is hidden because GeoLibre exported it from a hidden layer.
    const style = parseMapboxStyle({
      layers: [
        {
          id: "s",
          type: "symbol",
          "source-layer": "x",
          layout: { visibility: "none", "text-field": ["get", "name"] },
        },
        { id: "f", type: "fill", "source-layer": "x", paint: { "fill-color": "#00ff00" } },
      ],
    } as never);

    assert.equal(style.labels, null);
  });

  it("still imports labels from a hidden symbol layer", () => {
    // GeoLibre's exporter stamps the whole layer's `visible` flag onto every layer it emits, so
    // reading it as class state would switch labels off when re-importing an export taken from a
    // hidden layer.
    const result = read([
      {
        id: "s",
        type: "symbol",
        "source-layer": "f",
        layout: { visibility: "none", "text-field": ["get", "name"] },
        paint: { "text-color": "#111111" },
      },
    ]);

    assert.equal(result.labels.enabled, true);
    assert.equal(result.labels.field, "name");
  });
  // The contest is not only over which branch runs. Everything else a layer contributes is shared:
  // the colour renderer is claimed once, and stroke comes from whichever of line, fill outline or
  // circle stroke speaks last. `speaking` drops a hidden layer from all of it at once.
  const categorized = (a: string, b: string) => [
    "match",
    ["to-string", ["get", "k"]],
    "a",
    a,
    "b",
    b,
    "#000000",
  ];

  it("lets a drawn line claim the renderer over a hidden fill", () => {
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "fill-color": categorized("#111111", "#222222") },
      },
      {
        id: "l",
        type: "line",
        "source-layer": "x",
        paint: { "line-color": categorized("#00ff00", "#00aa00") },
      },
    ]);

    assert.deepEqual(
      result.vectorStyleStops.map((stop) => stop.color),
      ["#00ff00", "#00aa00"],
      "the renderer comes from the layer somebody can see",
    );
  });

  it("lets a drawn line claim the renderer over a hidden circle", () => {
    // The line branch defers to a circle, because line-color's fallback is the stroke and a point
    // export needs the circle's fallback in fillColor. A hidden circle has no claim to defer to.
    const result = read([
      {
        id: "c",
        type: "circle",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "circle-color": "#111111" },
      },
      {
        id: "l",
        type: "line",
        "source-layer": "x",
        paint: { "line-color": categorized("#00ff00", "#00aa00") },
      },
    ]);

    assert.equal(result.vectorStyleMode, "categorized");
  });

  it("does not let a hidden line take the stroke from a drawn fill", () => {
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        paint: { "fill-color": "#00ff00", "fill-outline-color": "#00aa00" },
      },
      {
        id: "l",
        type: "line",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "line-color": "#ff0000", "line-width": 9 },
      },
    ]);

    assert.equal(result.strokeColor, "#00aa00", "the fill's own outline survives");
    assert.notEqual(result.strokeWidth, 9, "and so does its width");
  });

  it("still reads a style whose every layer is hidden", () => {
    // Nothing drawn is contesting anything, so the old precedence stands and the style still
    // imports rather than coming back empty.
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "fill-color": categorized("#111111", "#222222") },
      },
      {
        id: "l",
        type: "line",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "line-color": "#ff0000" },
      },
    ]);

    assert.equal(result.vectorStyleMode, "categorized");
    assert.equal(result.strokeColor, "#ff0000");
  });
  // The contest is not only over the renderer and the stroke. A hidden layer stops being a
  // candidate outright, so it cannot reach opacity, width, or the extrusion flag either.
  it("does not let a hidden extrusion extrude a layer a drawn line describes", () => {
    const result = read([
      {
        id: "e",
        type: "fill-extrusion",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "fill-extrusion-height": 10 },
      },
      { id: "l", type: "line", "source-layer": "x", paint: { "line-color": "#00ff00" } },
    ]);

    assert.equal(result.extrusionEnabled, DEFAULT_LAYER_STYLE.extrusionEnabled);
  });

  it("does not take stroke width from a hidden circle", () => {
    const result = read([
      {
        id: "c",
        type: "circle",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "circle-stroke-color": "#ff0000", "circle-stroke-width": 7 },
      },
      {
        id: "l",
        type: "line",
        "source-layer": "x",
        paint: { "line-color": "#00ff00", "line-width": 2 },
      },
    ]);

    assert.equal(result.strokeWidth, 2, "the drawn line's width, not the hidden circle's");
  });

  it("does not take opacity from a hidden fill", () => {
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "fill-color": "#111111", "fill-opacity": 0.1 },
      },
      { id: "l", type: "line", "source-layer": "x", paint: { "line-color": "#00ff00" } },
    ]);

    assert.equal(result.fillOpacity, DEFAULT_LAYER_STYLE.fillOpacity);
  });
  it("does not take the stroke from a hidden fill's outline", () => {
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        layout: { visibility: "none" },
        paint: { "fill-color": "#111111", "fill-outline-color": "#ff0000" },
      },
      { id: "c", type: "circle", "source-layer": "x", paint: { "circle-color": "#00ff00" } },
    ]);

    assert.equal(result.strokeColor, DEFAULT_LAYER_STYLE.strokeColor);
  });

  it("still takes the stroke from a drawn fill's outline", () => {
    const result = read([
      {
        id: "f",
        type: "fill",
        "source-layer": "x",
        paint: { "fill-color": "#111111", "fill-outline-color": "#ff0000" },
      },
      { id: "c", type: "circle", "source-layer": "x", paint: { "circle-color": "#00ff00" } },
    ]);

    assert.equal(result.strokeColor, "#ff0000");
  });
  it("says so when a lone hidden layer of a type is dropped", () => {
    // The stack diagnostics below only fire for two or more layers of a type, so without this a
    // single hidden extrusion beside a drawn fill went unimported and unmentioned.
    const style = parseMapboxStyle({
      layers: [
        {
          id: "e",
          type: "fill-extrusion",
          "source-layer": "x",
          layout: { visibility: "none" },
          paint: { "fill-extrusion-height": 10 },
        },
        { id: "f", type: "fill", "source-layer": "x", paint: { "fill-color": "#00ff00" } },
      ],
    } as never);

    assert.deepEqual(style.warnings, [
      "The style's fill-extrusion layer is hidden; it was not imported.",
    ]);
  });

  it("says so when a hidden heatmap is dropped for a drawn circle", () => {
    // `heatmap` reaches the point renderer, so it needs the same report as the other types. It was
    // missing from the diagnostic list entirely.
    const style = parseMapboxStyle({
      layers: [
        { id: "h", type: "heatmap", "source-layer": "x", layout: { visibility: "none" } },
        { id: "c", type: "circle", "source-layer": "x", paint: { "circle-color": "#00ff00" } },
      ],
    } as never);

    assert.deepEqual(style.warnings, ["The style's heatmap layer is hidden; it was not imported."]);
  });

  it("says nothing about a drawn symbol layer", () => {
    // The diagnostic reads a type missing from its lookup as "stands aside", so a drawn symbol
    // layer has to be listed there or every label import reports itself hidden.
    const style = parseMapboxStyle({
      layers: [
        {
          id: "s",
          type: "symbol",
          "source-layer": "x",
          layout: { "text-field": ["get", "name"] },
          paint: { "text-color": "#111111" },
        },
      ],
    } as never);

    assert.deepEqual(style.warnings, []);
    assert.equal(style.labels?.enabled, true);
  });

  it("says nothing when the lone layer of a type is drawn", () => {
    const style = parseMapboxStyle({
      layers: [{ id: "f", type: "fill", "source-layer": "x", paint: { "fill-color": "#111111" } }],
    } as never);

    assert.deepEqual(style.warnings, []);
  });

  it("does not call the layer drawn when every layer in the style is hidden", () => {
    // Nothing is drawn anywhere, so nothing stands aside and a hidden line still speaks. The
    // report must not then claim the layer it picked was drawn.
    const style = parseMapboxStyle({
      layers: [
        {
          id: "a",
          type: "line",
          "source-layer": "f",
          layout: { visibility: "none" },
          paint: { "line-color": "#00ff00" },
        },
        {
          id: "b",
          type: "line",
          "source-layer": "f",
          layout: { visibility: "none" },
          paint: { "line-color": ["get", "colour"] },
        },
      ],
    } as never);

    assert.equal(style.style.strokeColor, "#00ff00");
    assert.ok(
      style.warnings.some((warning) =>
        /multiple line layers, all hidden; only the bottom-most one was imported/.test(warning),
      ),
      `got: ${style.warnings.join(" ")}`,
    );
    assert.ok(
      !style.warnings.some((warning) => /drawn layer was imported/.test(warning)),
      `got: ${style.warnings.join(" ")}`,
    );
  });

  it("says a type whose layers are all hidden was not imported", () => {
    const style = parseMapboxStyle({
      layers: [
        {
          id: "f1",
          type: "fill",
          "source-layer": "x",
          layout: { visibility: "none" },
          paint: { "fill-color": "#111111" },
        },
        {
          id: "f2",
          type: "fill",
          "source-layer": "x",
          layout: { visibility: "none" },
          paint: { "fill-color": "#222222" },
        },
        { id: "l", type: "line", "source-layer": "x", paint: { "line-color": "#00ff00" } },
      ],
    } as never);

    assert.ok(
      style.warnings.some((warning) => /fill layers are all hidden/.test(warning)),
      "none of them was imported, so the report must not say the first was",
    );
    assert.ok(
      !style.warnings.some((warning) =>
        /only the bottom-most drawn layer was imported/.test(warning),
      ),
      `got: ${style.warnings.join(" ")}`,
    );
  });
  it("still takes a drawn circle's colour beside a flat extrusion colour", () => {
    // A flat extrusion colour sets the mode but writes only `extrusionColor`. Claiming the
    // renderer there would silently drop the circle's own colour, which this importer read on
    // `main`.
    const result = applyMapboxStyleImport(
      DEFAULT_LAYER_STYLE,
      parseMapboxStyle({
        layers: [
          {
            id: "e",
            type: "fill-extrusion",
            "source-layer": "x",
            paint: { "fill-extrusion-color": "#00ff00" },
          },
          { id: "c", type: "circle", "source-layer": "x", paint: { "circle-color": "#0000ff" } },
        ],
      } as never),
    );

    assert.equal(result.vectorStyleMode, "single");
    assert.equal(result.extrusionColor, "#00ff00");
    assert.equal(result.fillColor, "#0000ff", "the circle's colour, not the base style's");
  });

  // Importing over a layer that already has a renderer, rather than over the default style, is
  // where a mode the importer forgot to set shows up.
  it("replaces a categorized renderer with a flat extrusion colour", () => {
    const base = {
      ...DEFAULT_LAYER_STYLE,
      vectorStyleMode: "categorized" as const,
      vectorStyleProperty: "old",
      vectorStyleStops: [{ value: "z", color: "#abcdef" }],
    };
    const result = applyMapboxStyleImport(
      base,
      parseMapboxStyle({
        layers: [
          {
            id: "e",
            type: "fill-extrusion",
            "source-layer": "x",
            paint: { "fill-extrusion-color": "#00ff00" },
          },
        ],
      } as never),
    );

    assert.equal(result.vectorStyleMode, "single");
    assert.equal(result.extrusionColor, "#00ff00");
  });

  it("leaves the renderer alone when an extrusion names no colour", () => {
    const base = { ...DEFAULT_LAYER_STYLE, vectorStyleMode: "categorized" as const };
    const result = applyMapboxStyleImport(
      base,
      parseMapboxStyle({
        layers: [
          {
            id: "e",
            type: "fill-extrusion",
            "source-layer": "x",
            paint: { "fill-extrusion-height": 10 },
          },
        ],
      } as never),
    );

    assert.equal(result.vectorStyleMode, "categorized", "the style said nothing about colour");
  });

  it("does not report an all-hidden stack as combined into rules", () => {
    const style = parseMapboxStyle({
      layers: [
        {
          id: "a",
          type: "fill",
          "source-layer": "f",
          layout: { visibility: "none" },
          paint: { "fill-color": "#111111" },
          filter: ["==", ["get", "c"], "a"],
        },
        {
          id: "b",
          type: "fill",
          "source-layer": "f",
          layout: { visibility: "none" },
          paint: { "fill-color": "#222222" },
          filter: ["==", ["get", "c"], "b"],
        },
      ],
    } as never);

    assert.equal(style.style.vectorStyleMode, "single");
    assert.equal(style.style.vectorRules, undefined, "a flat colour is not a set of rules");
    assert.equal(style.matchedLayerCount, 1, "one layer's worth of symbology was taken");
    assert.deepEqual(style.warnings, [
      "The style has multiple fill layers, all hidden; only the bottom-most one was imported.",
    ]);
  });

  it("replaces a categorized renderer when every hidden class omits its colour", () => {
    // Declining the stack outright used to throw away the spec default this path had already
    // resolved, leaving the old renderer in place through an import that replaces it.
    const base = {
      ...DEFAULT_LAYER_STYLE,
      vectorStyleMode: "categorized" as const,
      vectorStyleProperty: "old",
      vectorStyleStops: [{ value: "z", color: "#abcdef" }],
    };
    const result = applyMapboxStyleImport(
      base,
      parseMapboxStyle({
        layers: [
          {
            id: "a",
            type: "line",
            "source-layer": "f",
            layout: { visibility: "none" },
            paint: { "line-width": 2 },
            filter: ["==", ["get", "c"], "a"],
          },
          {
            id: "b",
            type: "line",
            "source-layer": "f",
            layout: { visibility: "none" },
            paint: { "line-width": 3 },
            filter: ["==", ["get", "c"], "b"],
          },
        ],
      } as never),
    );

    assert.equal(result.vectorStyleMode, "single");
  });

  it("replaces a categorized renderer when every line class is hidden", () => {
    const base = {
      ...DEFAULT_LAYER_STYLE,
      vectorStyleMode: "categorized" as const,
      vectorStyleProperty: "old",
      vectorStyleStops: [{ value: "z", color: "#abcdef" }],
    };
    const result = applyMapboxStyleImport(
      base,
      parseMapboxStyle({
        layers: [
          {
            id: "a",
            type: "line",
            "source-layer": "f",
            layout: { visibility: "none" },
            paint: { "line-color": "#00ff00" },
            filter: ["==", ["get", "c"], "a"],
          },
          {
            id: "b",
            type: "line",
            "source-layer": "f",
            layout: { visibility: "none" },
            paint: { "line-color": "#e60000" },
            filter: ["==", ["get", "c"], "b"],
          },
        ],
      } as never),
    );

    assert.equal(
      result.vectorStyleMode,
      "single",
      "the style describes one flat colour, so the old renderer must not survive it",
    );
  });
});
