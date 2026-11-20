import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import { strToU8, zipSync } from "fflate";
import {
  DEFAULT_LAYER_STYLE,
  effectiveVectorRules,
  parseProject,
  serializeProject,
  ruleBasedVisibilityFilter,
  lineWidthValue,
  vectorFillColorValue,
  vectorStrokeWidthValue,
  vectorLineColorValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import {
  cimColor,
  cimSymbolLayerEnabled,
  translateCimRenderer,
  translateCimSymbol,
} from "@geolibre/map/style-import";
import { fillPaint } from "../packages/map/src/style-mapper";
import {
  dropArcgisImportLayers,
  importArcgisProject,
} from "../apps/geolibre-desktop/src/lib/arcgis-project-import";

const rgb = (r: number, g: number, b: number, a = 100) => ({
  type: "CIMRGBColor",
  values: [r, g, b, a],
});

function polygon(fill: [number, number, number], outline: [number, number, number] = [0, 0, 0]) {
  return {
    type: "CIMSymbolReference",
    symbol: {
      type: "CIMPolygonSymbol",
      symbolLayers: [
        {
          type: "CIMSolidStroke",
          enable: true,
          width: 0.75,
          color: rgb(...outline),
        },
        { type: "CIMSolidFill", enable: true, color: rgb(...fill) },
      ],
    },
  };
}

function line(color: [number, number, number], width = 1.5) {
  return {
    type: "CIMSymbolReference",
    symbol: {
      type: "CIMLineSymbol",
      symbolLayers: [{ type: "CIMSolidStroke", enable: true, width, color: rgb(...color) }],
    },
  };
}

/** A zoning renderer shaped like ArcGIS Pro writes one (values are strings). */
function zoning(overrides: Record<string, unknown> = {}) {
  return {
    type: "CIMUniqueValueRenderer",
    fields: ["ZONE"],
    useDefaultSymbol: true,
    defaultLabel: "Other zones",
    defaultSymbol: polygon([200, 200, 200]),
    groups: [
      {
        type: "CIMUniqueValueGroup",
        heading: "ZONE",
        classes: [
          {
            type: "CIMUniqueValueClass",
            label: "Residential",
            symbol: polygon([255, 255, 0]),
            values: [
              { type: "CIMUniqueValue", fieldValues: ["R1"] },
              { type: "CIMUniqueValue", fieldValues: ["R2"] },
            ],
            visible: true,
          },
          {
            type: "CIMUniqueValueClass",
            label: "Commercial",
            symbol: polygon([255, 0, 0], [80, 0, 0]),
            values: [{ type: "CIMUniqueValue", fieldValues: ["C"] }],
            visible: true,
          },
          {
            type: "CIMUniqueValueClass",
            label: "Zone 3",
            symbol: polygon([0, 0, 255]),
            values: [{ type: "CIMUniqueValue", fieldValues: ["3"] }],
            visible: true,
          },
          {
            type: "CIMUniqueValueClass",
            label: "Unzoned",
            symbol: polygon([0, 128, 0]),
            values: [{ type: "CIMUniqueValue", fieldValues: ["<Null>"] }],
            visible: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Population density breaks: 0–10, 10–20.5, 20.5–100. */
function density(overrides: Record<string, unknown> = {}) {
  return {
    type: "CIMClassBreaksRenderer",
    field: "DENSITY",
    classBreakType: "GraduatedColor",
    minimumBreak: 0,
    showInAscendingOrder: true,
    breaks: [
      {
        type: "CIMClassBreak",
        label: "0 – 10",
        upperBound: 10,
        symbol: polygon([255, 240, 200]),
      },
      {
        type: "CIMClassBreak",
        label: "10.1 – 20.5",
        upperBound: 20.5,
        symbol: polygon([250, 150, 80]),
      },
      {
        type: "CIMClassBreak",
        label: "20.6 – 100",
        upperBound: 100,
        symbol: polygon([180, 0, 0]),
      },
    ],
    ...overrides,
  };
}

function translatedStyle(renderer: unknown): LayerStyle {
  const result = translateCimRenderer(renderer);
  assert.equal(result.translated, true, JSON.stringify(result.issues));
  return { ...structuredClone(DEFAULT_LAYER_STYLE), ...result.style };
}

/**
 * The fill colour a polygon feature renders with, or null when the layer hides
 * it. Evaluated with MapLibre's own expression engine against the exact paint
 * value and filter the map layer sync builds, so these tests check what draws.
 */
function renderedFill(style: LayerStyle, properties: Record<string, unknown>): string | null {
  const feature = { type: 3, properties } as never;
  const visibility = ruleBasedVisibilityFilter(style);
  if (visibility) {
    const filter = featureFilter(visibility as never, "layers[0].filter");
    if (!filter.filter({ zoom: 10 }, feature, undefined as never)) return null;
  }
  return evaluateColor(vectorFillColorValue(style), feature);
}

function evaluateColor(value: unknown, feature: never): string {
  if (typeof value === "string") return value;
  const compiled = createExpression(value, {
    type: "color",
    "property-type": "data-driven",
    expression: { interpolated: false, parameters: ["zoom", "feature"] },
  } as never);
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  const color = (
    compiled.value as {
      evaluate: (g: unknown, f: unknown) => { toString(): string };
    }
  ).evaluate({ zoom: 10 }, feature);
  return toHex(color.toString());
}

function toHex(css: string): string {
  const match = css.match(/rgba?\(([^)]+)\)/);
  if (!match) return css;
  const [r, g, b] = match[1].split(",").map((part) => Number.parseFloat(part));
  return `#${[r, g, b]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("CIM unique value renderer", () => {
  it("keeps every class's colour, label and order, with the default last", () => {
    const style = translatedStyle(zoning());
    assert.equal(style.vectorStyleMode, "rule-based");
    const { rules, elseRule } = effectiveVectorRules(style);
    assert.deepEqual(
      rules.map((rule) => [rule.label, rule.color]),
      [
        ["Residential", "#ffff00"],
        ["Commercial", "#ff0000"],
        ["Zone 3", "#0000ff"],
        ["Unzoned", "#008000"],
      ],
    );
    assert.equal(elseRule?.label, "Other zones");
    assert.equal(elseRule?.color, "#c8c8c8");
    // A class whose outline differs from the first keeps it as an override.
    assert.equal(rules[1].strokeColor, "#500000");
    assert.equal(rules[0].strokeColor, undefined);
    assert.equal(style.strokeWidth, 1);
  });

  it("renders each feature in its category's colour", () => {
    const style = translatedStyle(zoning());
    assert.equal(renderedFill(style, { ZONE: "R1" }), "#ffff00");
    assert.equal(renderedFill(style, { ZONE: "R2" }), "#ffff00");
    assert.equal(renderedFill(style, { ZONE: "C" }), "#ff0000");
    // ArcGIS stores a numeric field's value as text; a numeric feature value matches it.
    assert.equal(renderedFill(style, { ZONE: 3 }), "#0000ff");
    assert.equal(renderedFill(style, { ZONE: "3" }), "#0000ff");
    // <Null> matches a null or missing value, and only that.
    assert.equal(renderedFill(style, { ZONE: null }), "#008000");
    assert.equal(renderedFill(style, {}), "#008000");
    // Matching is exact: no case folding, no trimming, no prefix matches.
    assert.equal(renderedFill(style, { ZONE: "r1" }), "#c8c8c8");
    assert.equal(renderedFill(style, { ZONE: "R1 " }), "#c8c8c8");
    assert.equal(renderedFill(style, { ZONE: "" }), "#c8c8c8");
    assert.equal(renderedFill(style, { ZONE: "I" }), "#c8c8c8");
  });

  it("hides unlisted values when 'all other values' is off", () => {
    const style = translatedStyle(zoning({ useDefaultSymbol: false }));
    assert.equal(effectiveVectorRules(style).elseRule, null);
    assert.equal(renderedFill(style, { ZONE: "C" }), "#ff0000");
    assert.equal(renderedFill(style, { ZONE: "I" }), null);
    assert.equal(renderedFill(style, { ZONE: 4 }), null);
  });

  it("hides unlisted values when the 'all other values' class is unchecked", () => {
    const style = translatedStyle(zoning({ isDefaultSymbolVisible: false }));
    assert.equal(renderedFill(style, { ZONE: "I" }), null);
    assert.equal(renderedFill(style, { ZONE: "R1" }), "#ffff00");
  });

  it("hides an unchecked class even while 'all other values' draws", () => {
    const renderer = zoning();
    (renderer.groups[0].classes[1] as { visible: boolean }).visible = false;
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { ZONE: "C" }), null);
    assert.equal(renderedFill(style, { ZONE: "I" }), "#c8c8c8");
    assert.equal(renderedFill(style, { ZONE: "R1" }), "#ffff00");
    const labels = effectiveVectorRules(style).rules.map((rule) => rule.label);
    assert.deepEqual(labels, ["Residential", "Zone 3", "Unzoned", "Other zones"]);
  });

  it("keeps an empty-text category apart from null", () => {
    const renderer = zoning({ useDefaultSymbol: false });
    renderer.groups[0].classes.push({
      type: "CIMUniqueValueClass",
      label: "Blank",
      symbol: polygon([1, 2, 3]),
      values: [{ type: "CIMUniqueValue", fieldValues: [""] }],
      visible: true,
    });
    renderer.groups[0].classes.splice(3, 1);
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { ZONE: "" }), "#010203");
    assert.equal(renderedFill(style, { ZONE: null }), null);
  });

  it("colours lines by their stroke", () => {
    const style = translatedStyle({
      type: "CIMUniqueValueRenderer",
      fields: ["KIND"],
      groups: [
        {
          classes: [
            {
              label: "Highway",
              symbol: line([255, 0, 0], 3),
              values: [{ fieldValues: ["hw"] }],
            },
            {
              label: "Street",
              symbol: line([0, 0, 255]),
              values: [{ fieldValues: ["st"] }],
            },
          ],
        },
      ],
    });
    const feature = (KIND: string) => ({ type: 2, properties: { KIND } }) as never;
    const value = vectorLineColorValue(style);
    assert.equal(evaluateColor(value, feature("hw")), "#ff0000");
    assert.equal(evaluateColor(value, feature("st")), "#0000ff");
    const { rules } = effectiveVectorRules(style);
    assert.equal(style.strokeWidth, 4);
    assert.equal(rules[1].strokeWidth, 2);
  });

  it("falls back to the default symbol's colour when it refuses a renderer", () => {
    const multi = translateCimRenderer(zoning({ fields: ["ZONE", "SUB"] }));
    assert.equal(multi.translated, false);
    assert.deepEqual(multi.issues, [{ code: "multiple-fields" }]);
    assert.equal(multi.style.vectorStyleMode, "single");
    assert.equal(multi.style.fillColor, "#c8c8c8");
  });
});

describe("CIM class breaks renderer", () => {
  const LIGHT = "#fff0c8";
  const MID = "#fa9650";
  const DARK = "#b40000";
  const GREY = "#c8c8c8";

  it("keeps each break's colour and label in order", () => {
    const { rules, elseRule } = effectiveVectorRules(translatedStyle(density()));
    assert.deepEqual(
      rules.map((rule) => [rule.label, rule.color]),
      [
        ["0 – 10", LIGHT],
        ["10.1 – 20.5", MID],
        ["20.6 – 100", DARK],
      ],
    );
    assert.equal(elseRule, null);
  });

  it("puts a value on a break in the lower class, and the minimum in the first", () => {
    const style = translatedStyle(density());
    const at = (DENSITY: unknown) => renderedFill(style, { DENSITY });
    assert.equal(at(0), LIGHT, "minimumBreak is inclusive");
    assert.equal(at(5), LIGHT);
    assert.equal(at(10), LIGHT, "an upper bound is inclusive");
    assert.equal(at(10.000001), MID, "the previous upper bound is exclusive");
    assert.equal(at(9.999999), LIGHT);
    assert.equal(at(20.5), MID);
    assert.equal(at(20.499999), MID);
    assert.equal(at(20.500001), DARK);
    assert.equal(at(100), DARK, "the last upper bound is inclusive");
  });

  it("does not draw nulls or out-of-range values without the default symbol", () => {
    const style = translatedStyle(density());
    const at = (DENSITY: unknown) => renderedFill(style, { DENSITY });
    assert.equal(at(-0.000001), null);
    assert.equal(at(100.000001), null);
    assert.equal(at(null), null, "null is not read as 0");
    assert.equal(renderedFill(style, {}), null);
    assert.equal(at("12"), null, "text is not classified");
  });

  it("draws nulls and out-of-range values with the default symbol when it is on", () => {
    const style = translatedStyle(
      density({
        useDefaultSymbol: true,
        defaultSymbol: polygon([200, 200, 200]),
      }),
    );
    const at = (DENSITY: unknown) => renderedFill(style, { DENSITY });
    assert.equal(at(-1), GREY);
    assert.equal(at(100.5), GREY);
    assert.equal(at(null), GREY);
    assert.equal(at(10), LIGHT);
  });

  it("treats an omitted minimumBreak as CIM's default of 0", () => {
    const style = translatedStyle(density({ minimumBreak: undefined }));
    assert.equal(renderedFill(style, { DENSITY: 0 }), LIGHT);
    assert.equal(renderedFill(style, { DENSITY: -1 }), null);
  });

  it("lists classes high to low when ArcGIS shows them descending", () => {
    const style = translatedStyle(density({ showInAscendingOrder: false }));
    assert.deepEqual(
      effectiveVectorRules(style).rules.map((rule) => rule.color),
      [DARK, MID, LIGHT],
    );
    assert.equal(renderedFill(style, { DENSITY: 10 }), LIGHT);
  });
});

/** The outline width a polygon feature renders with, from the map's own paint value. */
function renderedOutlineWidth(style: LayerStyle, properties: Record<string, unknown>): number {
  const value = vectorStrokeWidthValue(style, lineWidthValue(style));
  if (typeof value === "number") return value;
  const compiled = createExpression(value, {
    type: "number",
    "property-type": "data-driven",
    expression: { interpolated: false, parameters: ["zoom", "feature"] },
  } as never);
  assert.equal(compiled.result, "success", JSON.stringify(compiled.value));
  return (compiled.value as { evaluate: (g: unknown, f: unknown) => number }).evaluate(
    { zoom: 10 },
    { type: 3, properties },
  );
}

const symbolRef = (type: string, symbolLayers: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "CIMSymbolReference",
  symbol: { type, symbolLayers, ...extra },
});
const polygonWith = (layers: unknown[]) => symbolRef("CIMPolygonSymbol", layers);
const simple = (symbol: unknown) => ({ type: "CIMSimpleRenderer", symbol });
const fill = (color: unknown = rgb(1, 1, 1)) => ({
  type: "CIMSolidFill",
  enable: true,
  color,
});
const stroke = (
  color: unknown = rgb(0, 0, 0),
  width = 1.5,
  extra: Record<string, unknown> = {},
) => ({
  type: "CIMSolidStroke",
  enable: true,
  width,
  color,
  ...extra,
});
const hsl = { type: "CIMHSLColor", values: [0, 100, 50, 100] };
/** Pro writes a circle as one curve ring: its start point and one arc back to it. */
const circleRing = { curveRings: [[[0, 5], { a: [[0, 5], [0, 0], 0, 1] }]] };
/**
 * A point symbol with one vector marker drawing each of `graphics` (symbol
 * layer lists) as a circle.
 */
function marker(...graphics: unknown[][]) {
  return symbolRef("CIMPointSymbol", [
    {
      type: "CIMVectorMarker",
      enable: true,
      size: 6,
      markerGraphics: graphics.map((layers) => ({
        geometry: circleRing,
        symbol: { type: "CIMPolygonSymbol", symbolLayers: layers },
      })),
    },
  ]);
}
const twoClasses = (first: unknown, second: unknown) => ({
  type: "CIMUniqueValueRenderer",
  fields: ["K"],
  groups: [
    {
      classes: [
        {
          label: "a",
          visible: true,
          symbol: first,
          values: [{ fieldValues: ["a"] }],
        },
        {
          label: "b",
          visible: true,
          symbol: second,
          values: [{ fieldValues: ["b"] }],
        },
      ],
    },
  ],
});

describe("CIM renderer refusals", () => {
  const picture = zoning();
  picture.groups[0].classes[0].symbol = polygonWith([{ type: "CIMPictureFill" }]) as never;
  const brokenBound = (upperBound: unknown) => {
    const renderer = density({ minimumBreak: -5 });
    (renderer.breaks[0] as { upperBound: unknown }).upperBound = upperBound;
    return renderer;
  };
  const cases: [string, unknown, unknown[]][] = [
    [
      "unique values on several fields",
      zoning({ fields: ["ZONE", "SUB"] }),
      [{ code: "multiple-fields" }],
    ],
    ["unique values on no field", zoning({ fields: [] }), [{ code: "multiple-fields" }]],
    [
      "an Arcade expression",
      zoning({
        valueExpressionInfo: {
          type: "CIMExpressionInfo",
          expression: "$feature.ZONE",
        },
      }),
      [{ code: "expression" }],
    ],
    ["a class without a solid colour", picture, [{ code: "symbol", cimType: "CIMPolygonSymbol" }]],
    [
      "another renderer type",
      { type: "CIMHeatMapRenderer" },
      [{ code: "renderer", cimType: "CIMHeatMapRenderer" }],
    ],
    [
      "unclassed colours",
      density({ classBreakType: "UnclassedColor" }),
      [{ code: "renderer", cimType: "UnclassedColor" }],
    ],
    [
      "graduated symbols",
      density({ classBreakType: "GraduatedSymbol" }),
      [{ code: "graduated-symbols" }],
    ],
    [
      "normalised breaks",
      density({ normalizationType: "Field", normalizationField: "AREA" }),
      [{ code: "normalization" }],
    ],
    ["an exclusion clause", density({ exclusionClause: "DENSITY < 0" }), [{ code: "exclusion" }]],
    ["no breaks", density({ breaks: [] }), [{ code: "no-classes" }]],
    ["a minimum above the first break", density({ minimumBreak: 11 }), [{ code: "no-classes" }]],
    ["a null upper bound", brokenBound(null), [{ code: "no-classes" }]],
    ["a text upper bound", brokenBound("10"), [{ code: "no-classes" }]],
    ["a boolean upper bound", brokenBound(false), [{ code: "no-classes" }]],
    ["a text minimum", density({ minimumBreak: "0" }), [{ code: "no-classes" }]],
  ];
  for (const [name, renderer, issues] of cases) {
    it(`refuses ${name}`, () => {
      const result = translateCimRenderer(renderer);
      assert.equal(result.translated, false);
      assert.deepEqual(result.issues, issues);
    });
  }

  it("accepts normalisation of Nothing", () => {
    assert.deepEqual(translateCimRenderer(density({ normalizationType: "Nothing" })).issues, []);
  });

  it("refuses an unreadable fill whose outline would not draw either", () => {
    for (const outline of [stroke(rgb(255, 0, 0), 0), stroke(rgb(255, 0, 0, 0))]) {
      const result = translateCimRenderer(simple(polygonWith([outline, fill(hsl)])));
      assert.equal(result.translated, false);
      assert.deepEqual(result.issues, [{ code: "symbol", cimType: "CIMPolygonSymbol" }]);
    }
  });

  it("refuses a line or marker whose only visible part was left out", () => {
    const clearRed = fill(rgb(255, 0, 0, 0));
    const cases = [
      // A transparent or zero-width top stroke over an opaque casing.
      symbolRef("CIMLineSymbol", [stroke(rgb(0, 0, 0, 0)), stroke()]),
      symbolRef("CIMLineSymbol", [stroke(rgb(0, 0, 0), 0), stroke()]),
      // A hatch over a clear marker fill, a clear graphic over an opaque one,
      // and a clear fill under an unreadable outline.
      marker([{ type: "CIMHatchFill", enable: true }, clearRed]),
      marker([clearRed], [fill(rgb(0, 0, 255))]),
      marker([stroke(hsl), clearRed]),
    ];
    for (const symbol of cases) {
      const result = translateCimRenderer(simple(symbol));
      assert.equal(result.translated, false, JSON.stringify(symbol));
      assert.equal(result.issues[0].code, "symbol");
    }
    // A size-0 marker over a dropped second marker draws nothing either.
    const sized = (size: number) => ({
      type: "CIMVectorMarker",
      enable: true,
      size,
      markerGraphics: [{ symbol: { type: "CIMPolygonSymbol", symbolLayers: [fill()] } }],
    });
    const hidden = translateCimRenderer(simple(symbolRef("CIMPointSymbol", [sized(0), sized(8)])));
    assert.equal(hidden.translated, false);
    assert.equal(hidden.issues[0].code, "symbol");
    assert.equal(
      translateCimRenderer(simple(symbolRef("CIMPointSymbol", [sized(4), sized(8)]))).translated,
      true,
    );
    // Wholly supported transparent symbols stay as they are.
    for (const symbol of [
      symbolRef("CIMLineSymbol", [stroke(rgb(0, 0, 0, 0))]),
      marker([clearRed]),
    ]) {
      assert.equal(translateCimRenderer(simple(symbol)).translated, true);
    }
  });

  it("keeps a class whose only outline is invisible, as ArcGIS draws nothing for it", () => {
    const renderer = twoClasses(polygonWith([stroke(rgb(0, 0, 0, 0))]), polygonWith([fill()]));
    const style = translatedStyle(renderer);
    assert.equal(style.vectorRules.length, 3);
    assert.equal(renderedOutlineWidth(style, { K: "a" }), 0);
    assert.equal(style.fillOpacity, 0);
  });

  it("refuses a hatch over a clear background with no visible outline", () => {
    const hatch = { type: "CIMHatchFill", enable: true };
    for (const outline of [[], [stroke(rgb(0, 0, 0), 0)], [stroke(rgb(0, 0, 0, 0))]]) {
      const result = translateCimRenderer(
        simple(polygonWith([...outline, hatch, fill(rgb(255, 255, 255, 0))])),
      );
      assert.equal(result.translated, false);
      assert.deepEqual(result.issues, [{ code: "symbol", cimType: "CIMPolygonSymbol" }]);
    }
    // A transparent symbol made only of supported layers is carried as it is.
    const clear = translateCimRenderer(simple(polygonWith([fill(rgb(255, 255, 255, 0))])));
    assert.equal(clear.translated, true);
    assert.equal(clear.style.fillOpacity, 0);
    // With a visible outline, the hatch is reported and the outline kept.
    const outlined = translateCimRenderer(
      simple(polygonWith([stroke(), hatch, fill(rgb(255, 255, 255, 0))])),
    );
    assert.equal(outlined.translated, true);
    assert.deepEqual(outlined.issues, [{ code: "symbol-layers", cimType: "CIMHatchFill" }]);
  });

  it("refuses a symbol whose only colour cannot be read, and draws nothing invented", () => {
    for (const color of [{ type: "CIMRGBColor", values: [null, 0, 0, 100] }, hsl]) {
      const broken = translateCimRenderer(simple(polygonWith([fill(color)])));
      assert.equal(broken.translated, false);
      assert.equal(broken.style.fillColor, undefined);
    }
  });
});

describe("CIM symbols and defaults as Pro writes them", () => {
  it("draws no outline where a class has none or a transparent one", () => {
    const style = translatedStyle(
      twoClasses(polygonWith([stroke(rgb(0, 0, 0, 0)), fill()]), polygonWith([stroke(), fill()])),
    );
    assert.equal(renderedOutlineWidth(style, { K: "a" }), 0);
    assert.equal(renderedOutlineWidth(style, { K: "b" }), 2);
    const fillOnly = translatedStyle(
      twoClasses(polygonWith([stroke(), fill()]), polygonWith([fill()])),
    );
    assert.equal(renderedOutlineWidth(fillOnly, { K: "a" }), 2);
    assert.equal(renderedOutlineWidth(fillOnly, { K: "b" }), 0);
  });

  it("leaves no coloured hairline on a polygon without an outline", () => {
    // The fill's 1px hairline draws even at stroke width 0, so a polygon
    // without an outline must draw it in its own fill colour: the edge
    // MapLibre draws anyway. Checked against the real fill paint, per class.
    const red = fill(rgb(255, 0, 0));
    const hairline = (style: LayerStyle, K: string) => {
      const value = fillPaint(style, 1)["fill-outline-color"];
      assert.notEqual(value, undefined);
      return evaluateColor(value, { type: 3, properties: { K } } as never);
    };
    const plain = translatedStyle(simple(polygonWith([red])));
    assert.equal(hairline(plain, "a"), "#ff0000");
    // Mixed classes, either way round: only the outlined class keeps its
    // outline colour.
    const outlined = polygonWith([stroke(rgb(0, 0, 255)), fill()]);
    for (const [renderer, bare, edged] of [
      [twoClasses(outlined, polygonWith([red])), "b", "a"],
      [twoClasses(polygonWith([red]), outlined), "a", "b"],
    ] as const) {
      const style = translatedStyle(renderer);
      assert.equal(hairline(style, bare), "#ff0000");
      assert.equal(hairline(style, edged), "#0000ff");
      assert.equal(renderedOutlineWidth(style, { K: bare }), 0);
    }
    // A transparent outline counts as none.
    const clear = translatedStyle(simple(polygonWith([stroke(rgb(0, 0, 0, 0)), red])));
    assert.equal(hairline(clear, "a"), "#ff0000");
  });

  it("reads an omitted upper bound as 0, as CIM leaves out defaults", () => {
    const renderer = density({ minimumBreak: -3 });
    renderer.breaks = [
      {
        type: "CIMClassBreak",
        label: "≤-1",
        upperBound: -1,
        symbol: polygon([1, 1, 1]),
      },
      {
        type: "CIMClassBreak",
        label: "≤0",
        symbol: polygon([2, 2, 2]),
      } as never,
      {
        type: "CIMClassBreak",
        label: "≤3",
        upperBound: 3,
        symbol: polygon([3, 3, 3]),
      },
    ];
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { DENSITY: -3 }), "#010101");
    assert.equal(renderedFill(style, { DENSITY: 0 }), "#020202");
    assert.equal(renderedFill(style, { DENSITY: 0.5 }), "#030303");
  });

  it("hides a class Pro saved unchecked by leaving out visible", () => {
    const renderer = twoClasses(
      polygonWith([fill(rgb(1, 1, 1))]),
      polygonWith([fill(rgb(2, 2, 2))]),
    );
    delete (renderer.groups[0].classes[1] as { visible?: boolean }).visible;
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { K: "a" }), "#010101");
    assert.equal(renderedFill(style, { K: "b" }), null);
    // Files from before the property existed carry it on no class.
    for (const valueClass of renderer.groups[0].classes) {
      delete (valueClass as { visible?: boolean }).visible;
    }
    assert.equal(renderedFill(translatedStyle(renderer), { K: "b" }), "#020202");
  });

  it("keeps a switched-off default symbol's colour on the catch-all", () => {
    const style = translatedStyle(zoning({ useDefaultSymbol: false }));
    const elseRule = style.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.enabled, false);
    assert.equal(elseRule?.color, "#c8c8c8");
    assert.equal(elseRule?.label, "Other zones");
  });

  it("labels an unlabelled default rule like the legend's catch-all", () => {
    const renderer = zoning({ defaultLabel: "" });
    (renderer.groups[0].classes[1] as { visible: boolean }).visible = false;
    const labels = effectiveVectorRules(translatedStyle(renderer)).rules.map((rule) => rule.label);
    assert.equal(labels.at(-1), "Other");
  });

  it("labels an unlabelled break without floating-point noise", () => {
    const renderer = density();
    renderer.breaks[0].upperBound = 0.1 + 0.2;
    renderer.breaks[0].label = "";
    assert.equal(translatedStyle(renderer).vectorRules[0].label, "0 – 0.3");
  });

  it("matches numeric unique values by their text, as ArcGIS stores them", () => {
    const renderer = zoning();
    renderer.groups[0].classes[2].values = [{ type: "CIMUniqueValue", fieldValues: [3 as never] }];
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { ZONE: 3 }), "#0000ff");
    assert.equal(renderedFill(style, { ZONE: "3" }), "#0000ff");
  });

  it("matches a stored number however ArcGIS spelled it", () => {
    const renderer = zoning();
    renderer.groups[0].classes[2].values = [
      { type: "CIMUniqueValue", fieldValues: ["1.0"] },
      { type: "CIMUniqueValue", fieldValues: ["1E+21"] },
      { type: "CIMUniqueValue", fieldValues: ["-0"] },
    ];
    const style = translatedStyle(renderer);
    for (const value of [1, 1e21, 0, "1.0", "-0"]) {
      assert.equal(renderedFill(style, { ZONE: value }), "#0000ff", String(value));
    }
    // Text is still compared as text: "1" is not the stored text "1.0".
    assert.equal(renderedFill(style, { ZONE: "1" }), "#c8c8c8");
  });
});

describe("what a translated renderer reports leaving out", () => {
  const solidRed = fill(rgb(255, 0, 0));
  const casedLine = symbolRef("CIMLineSymbol", [
    stroke(rgb(255, 255, 255), 2.6),
    stroke(rgb(0, 0, 0), 3.4),
  ]);
  const outlined = (alpha: number) =>
    polygonWith([stroke(rgb(0, 0, 0, alpha), 1), fill(rgb(9, 9, 9))]);
  const transparencies = (...symbols: unknown[]) => {
    const renderer = zoning();
    symbols.forEach((symbol, index) => {
      if (index < 4) renderer.groups[0].classes[index].symbol = symbol as never;
      else renderer.defaultSymbol = symbol as never;
    });
    return renderer;
  };
  // A second graphic is reported even when it only adds a stroke.
  const markerWithStrokeGraphic = marker([solidRed], [stroke(rgb(0, 0, 255))]);
  const markerWithEffect = marker([solidRed]);
  const graphics = (
    markerWithEffect.symbol.symbolLayers[0] as { markerGraphics: { symbol: object }[] }
  ).markerGraphics;
  Object.assign(graphics[0].symbol, { effects: [{ type: "CIMGeometricEffectOffset", offset: 2 }] });
  const squareRing = {
    rings: [
      [
        [-5, -5],
        [-5, 5],
        [5, 5],
        [5, -5],
        [-5, -5],
      ],
    ],
  };
  const roundedRing = {
    curveRings: [[[0, 5], { a: [[5, 0], [0, 0], 0, 1] }, { a: [[0, 5], [0, 0], 0, 1] }]],
  };
  const shaped = (geometry: unknown) => {
    const symbol = marker([solidRed]);
    const [graphic] = (symbol.symbol.symbolLayers[0] as { markerGraphics: object[] })
      .markerGraphics;
    Object.assign(graphic, { geometry });
    return symbol;
  };

  const cases: [string, unknown, unknown[]][] = [
    [
      "a hatch beside a solid fill",
      twoClasses(
        polygonWith([fill(), { type: "CIMHatchFill", enable: true }]),
        polygonWith([fill()]),
      ),
      [{ code: "symbol-layers", cimType: "CIMHatchFill" }],
    ],
    [
      "a cased line's casing",
      simple(casedLine),
      [{ code: "symbol-layers", cimType: "CIMSolidStroke" }],
    ],
    [
      "a dash effect",
      simple(
        symbolRef("CIMLineSymbol", [
          stroke(rgb(0, 0, 0), 1, {
            effects: [{ type: "CIMGeometricEffectDashes", dashTemplate: [6, 3] }],
          }),
        ]),
      ),
      [{ code: "effects", cimType: "CIMGeometricEffectDashes" }],
    ],
    [
      "classes whose outlines differ only in transparency",
      transparencies(outlined(50), outlined(100)),
      [{ code: "transparency" }],
    ],
    [
      "an outline drawn at another class's transparency",
      transparencies(polygonWith([fill()]), outlined(50)),
      [{ code: "transparency" }],
    ],
    [
      "nothing when transparency is shared or outlines are absent",
      transparencies(outlined(50), outlined(50), outlined(50), outlined(0), outlined(50)),
      [],
    ],
    ["nothing for a marker drawn as Pro's circle", simple(marker([solidRed])), []],
    [
      "a marker graphic with no geometry, whose shape is unknown",
      simple(shaped(undefined)),
      [{ code: "marker-shape", cimType: "CIMVectorMarker" }],
    ],
    [
      "a vector marker drawn only by its own colour, with no drawing graphic",
      simple(
        symbolRef("CIMPointSymbol", [
          {
            type: "CIMVectorMarker",
            enable: true,
            size: 6,
            color: rgb(255, 0, 0),
            markerGraphics: [
              { geometry: circleRing, symbol: { type: "CIMPolygonSymbol", symbolLayers: [] } },
            ],
          },
        ]),
      ),
      [{ code: "marker-shape", cimType: "CIMVectorMarker" }],
    ],
    [
      "a square marker drawn as a circle",
      simple(shaped(squareRing)),
      [{ code: "marker-shape", cimType: "CIMVectorMarker" }],
    ],
    [
      "an ellipse written as one elliptic arc",
      simple(shaped({ curveRings: [[[0, 5], { a: [[0, 5], [0, 0], 0, 1, 0, 5, 0.5] }]] })),
      [{ code: "marker-shape", cimType: "CIMVectorMarker" }],
    ],
    [
      "a rounded shape that is not a single arc",
      simple(shaped(roundedRing)),
      [{ code: "marker-shape", cimType: "CIMVectorMarker" }],
    ],
    [
      "a character marker's glyph drawn as a circle",
      simple(
        symbolRef("CIMPointSymbol", [
          {
            type: "CIMCharacterMarker",
            enable: true,
            size: 10,
            characterIndex: 72,
            symbol: { type: "CIMPolygonSymbol", symbolLayers: [solidRed] },
          },
        ]),
      ),
      [{ code: "marker-shape", cimType: "CIMCharacterMarker" }],
    ],
    [
      "a hatch inside a marker graphic",
      simple(marker([{ type: "CIMHatchFill", enable: true }, solidRed])),
      [{ code: "symbol-layers", cimType: "CIMHatchFill" }],
    ],
    [
      "a second marker graphic",
      simple(markerWithStrokeGraphic),
      [{ code: "symbol-layers", cimType: "CIMMarkerGraphic" }],
    ],
    [
      "an effect inside a marker graphic",
      simple(markerWithEffect),
      [{ code: "effects", cimType: "CIMGeometricEffectOffset" }],
    ],
    [
      "an effect inside a marker placed along a line",
      simple(
        symbolRef("CIMLineSymbol", [
          stroke(),
          {
            type: "CIMVectorMarker",
            enable: true,
            markerPlacement: { type: "CIMMarkerPlacementAlongLineSameSize" },
            markerGraphics: [
              {
                symbol: {
                  type: "CIMPolygonSymbol",
                  effects: [{ type: "CIMGeometricEffectOffset", offset: 2 }],
                  symbolLayers: [solidRed],
                },
              },
            ],
          },
        ]),
      ),
      [
        { code: "symbol-layers", cimType: "CIMVectorMarker" },
        { code: "effects", cimType: "CIMGeometricEffectOffset" },
      ],
    ],
    [
      "an unreadable fill behind a readable outline",
      simple(polygonWith([stroke(rgb(255, 0, 0)), fill(hsl)])),
      [{ code: "color", cimType: "CIMHSLColor" }],
    ],
    [
      "an outline with a null channel",
      simple(polygonWith([stroke({ type: "CIMRGBColor", values: [0, null, 0, 100] }), fill()])),
      [{ code: "color", cimType: "CIMRGBColor" }],
    ],
    [
      "a fill layer with no colour at all",
      simple(polygonWith([stroke(), { type: "CIMSolidFill", enable: true }])),
      [{ code: "color", cimType: "CIMSolidFill" }],
    ],
    [
      "an unreadable marker outline",
      simple(marker([stroke(hsl), solidRed])),
      [{ code: "color", cimType: "CIMHSLColor" }],
    ],
    [
      "an unreadable outline in one class only",
      twoClasses(polygonWith([stroke(), fill()]), polygonWith([stroke(hsl), fill()])),
      [{ code: "color", cimType: "CIMHSLColor" }],
    ],
  ];
  for (const [name, renderer, issues] of cases) {
    it(`reports ${name}`, () => {
      const result = translateCimRenderer(renderer);
      assert.equal(result.translated, true, JSON.stringify(result.issues));
      assert.deepEqual(result.issues, issues);
    });
  }

  it("draws what it can of a symbol with an unreadable part", () => {
    const hollow = translateCimRenderer(simple(polygonWith([stroke(rgb(255, 0, 0)), fill(hsl)])));
    assert.equal(hollow.style.fillOpacity, 0);
    assert.equal(hollow.style.strokeColor, "#ff0000");
    const unoutlined = translateCimRenderer(simple(polygonWith([stroke(hsl), fill(rgb(1, 2, 3))])));
    assert.equal(unoutlined.style.fillColor, "#010203");
    assert.equal(unoutlined.style.strokeWidth, 0);
  });

  it("draws only the top stroke of a cased line and the first marker graphic", () => {
    assert.equal(translateCimRenderer(simple(casedLine)).style.strokeColor, "#ffffff");
    const style = translateCimRenderer(simple(markerWithStrokeGraphic)).style;
    assert.equal(style.fillColor, "#ff0000");
    assert.equal(style.strokeWidth, 0);
  });

  it("keeps the outline of a hatched polygon and reports the hatch", () => {
    const hatched = translateCimRenderer(
      simple(polygonWith([stroke(rgb(255, 0, 0)), { type: "CIMHatchFill", enable: true }])),
    );
    assert.equal(hatched.translated, true);
    assert.equal(hatched.style.strokeColor, "#ff0000");
    assert.equal(hatched.style.fillOpacity, 0);
    assert.deepEqual(hatched.issues, [{ code: "symbol-layers", cimType: "CIMHatchFill" }]);
  });

  it("refuses an outline-only marker graphic rather than drawing an empty ring", () => {
    const result = translateCimRenderer(simple(marker([stroke()], [solidRed])));
    assert.equal(result.translated, false);
    assert.deepEqual(result.issues, [{ code: "symbol", cimType: "CIMPointSymbol" }]);
  });
});

describe("shared CIM readers", () => {
  const colours: [string, unknown, { hex: string; opacity: number } | null][] = [
    [
      "RGB with alpha",
      { type: "CIMRGBColor", values: [255, 128, 0, 50] },
      { hex: "#ff8000", opacity: 0.5 },
    ],
    ["Gray", { type: "CIMGrayColor", values: [50] }, { hex: "#808080", opacity: 1 }],
    [
      "CMYK",
      { type: "CIMCMYKColor", values: [0, 100, 100, 0, 100] },
      { hex: "#ff0000", opacity: 1 },
    ],
    ["HSV", { type: "CIMHSVColor", values: [240, 100, 100, 100] }, { hex: "#0000ff", opacity: 1 }],
    [
      "LAB white",
      { type: "CIMLABColor", values: [100, 0, 0, 100] },
      { hex: "#ffffff", opacity: 1 },
    ],
    // CSS lab(54.29 80.82 69.89), D50, is sRGB red.
    [
      "LAB red",
      { type: "CIMLABColor", values: [54.29, 80.82, 69.89, 100] },
      { hex: "#ff0000", opacity: 1 },
    ],
    ["an unsupported subclass", hsl, null],
    ["a Spot colour", { type: "CIMSpotColor", values: [1, 2, 3] }, null],
    ["too few channels", { type: "CIMRGBColor", values: [1, 2] }, null],
    ...[null, "", true, Number.NaN, undefined].map((broken): [string, unknown, null] => [
      `a channel of ${typeof broken === "string" ? '""' : String(broken)}`,
      { type: "CIMRGBColor", values: [broken, 0, 0, 100] },
      null,
    ]),
  ];
  for (const [name, color, expected] of colours) {
    it(`reads ${name}`, () => assert.deepEqual(cimColor(color), expected));
  }

  it("switches a symbol layer off only for an explicit enable: false", () => {
    assert.equal(cimSymbolLayerEnabled({ type: "CIMSolidFill", enable: true }), true);
    assert.equal(cimSymbolLayerEnabled({ type: "CIMSolidFill", enable: false }), false);
    assert.equal(cimSymbolLayerEnabled({ type: "CIMSolidFill" }), true);
    assert.equal(cimSymbolLayerEnabled(null), false);
    // A Pro 2.6 export (Esri Japan's zoning layer) switches the outline off this way.
    const style = translatedStyle(
      simple(
        polygonWith([stroke(rgb(110, 110, 110), 0.7, { enable: false }), fill(rgb(254, 203, 252))]),
      ),
    );
    assert.equal(style.fillColor, "#fecbfc");
    assert.equal(style.strokeWidth, 0);
  });

  it("translates a lone symbol reference as a simple renderer would", () => {
    const symbol = polygonWith([stroke(rgb(255, 0, 0)), fill(hsl)]);
    assert.deepEqual(translateCimSymbol(symbol), translateCimRenderer(simple(symbol)));
    assert.deepEqual(translateCimSymbol(undefined).issues, [{ code: "symbol" }]);
  });
});

describe("ArcGIS Pro project import with thematic renderers", () => {
  function shapefileLayer(name: string, renderer: unknown) {
    return {
      type: "CIMFeatureLayer",
      name,
      uRI: `CIMPATH=Layers/${name}.json`,
      visibility: true,
      featureTable: {
        dataConnection: {
          type: "CIMStandardDataConnection",
          workspaceFactory: "Shapefile",
          workspaceConnectionString: "DATABASE=..\\data",
          dataset: name.toLowerCase(),
        },
      },
      renderer,
    };
  }

  function aprx(): Uint8Array {
    return zipSync({
      "GISProject.json": strToU8(
        JSON.stringify({
          projectItems: [{ itemType: "Map", catalogPath: "CIMPATH=Maps/Main.json" }],
        }),
      ),
      "Maps/Main.json": strToU8(
        JSON.stringify({
          type: "CIMMap",
          name: "Planning",
          layers: [
            "CIMPATH=Layers/Zoning.json",
            "CIMPATH=Layers/Density.json",
            "CIMPATH=Layers/Heat.json",
          ],
        }),
      ),
      "Layers/Zoning.json": strToU8(JSON.stringify(shapefileLayer("Zoning", zoning()))),
      "Layers/Density.json": strToU8(JSON.stringify(shapefileLayer("Density", density()))),
      "Layers/Heat.json": strToU8(
        JSON.stringify(
          shapefileLayer("Heat", {
            type: "CIMHeatMapRenderer",
            defaultSymbol: polygon([9, 9, 9]),
          }),
        ),
      ),
    });
  }

  /** Imported layers are bottom first, so tests find them by name. */
  function layerNamed(layers: readonly GeoLibreLayer[], name: string): GeoLibreLayer {
    const layer = layers.find((candidate) => candidate.name === name);
    assert.ok(layer, `no layer named ${name}`);
    return layer;
  }

  const zoningSamples = [{ ZONE: "R2" }, { ZONE: "C" }, { ZONE: 3 }, { ZONE: null }, { ZONE: "I" }];
  const densitySamples = [0, 10, 10.000001, 20.5, 100, 100.1, null].map((DENSITY) => ({ DENSITY }));

  it("draws the same colours and legend after import and after save and reopen", () => {
    const result = importArcgisProject(aprx(), "C:\\work\\planning.aprx");
    const zoningLayer = layerNamed(result.project.layers, "Zoning");
    const densityLayer = layerNamed(result.project.layers, "Density");
    assert.equal(zoningLayer.style.vectorStyleMode, "rule-based");
    assert.equal(densityLayer.style.vectorStyleMode, "rule-based");
    assert.deepEqual(
      zoningSamples.map((sample) => renderedFill(zoningLayer.style, sample)),
      ["#ffff00", "#ff0000", "#0000ff", "#008000", "#c8c8c8"],
    );
    assert.deepEqual(
      densitySamples.map((sample) => renderedFill(densityLayer.style, sample)),
      ["#fff0c8", "#fff0c8", "#fa9650", "#fa9650", "#b40000", null, null],
    );

    const reopened = parseProject(serializeProject(result.project));
    for (const [name, samples] of [
      ["Zoning", zoningSamples],
      ["Density", densitySamples],
    ] as const) {
      const before = layerNamed(result.project.layers, name).style;
      const after = layerNamed(reopened.layers, name).style;
      assert.deepEqual(
        samples.map((sample) => renderedFill(after, sample)),
        samples.map((sample) => renderedFill(before, sample)),
      );
      const legend = (style: LayerStyle) => {
        const { rules, elseRule } = effectiveVectorRules(style);
        return [...rules, ...(elseRule ? [elseRule] : [])].map((rule) => [rule.label, rule.color]);
      };
      assert.deepEqual(legend(after), legend(before));
    }
  });

  it("warns about a renderer it could not reproduce, without counting the layer as lost", () => {
    const result = importArcgisProject(aprx(), "C:\\work\\planning.aprx");
    assert.equal(result.project.layers.length, 3);
    const heat = layerNamed(result.project.layers, "Heat");
    assert.deepEqual(
      result.warnings.filter((warning) => warning.reason !== "map-extent"),
      [
        {
          layerName: "Heat",
          layerId: heat.id,
          reason: "symbology",
          symbologyIssue: "renderer",
          layerType: "CIMHeatMapRenderer",
        },
      ],
    );
    // The default symbol still colours the layer it could not classify.
    assert.equal(heat.style.fillColor, "#090909");
    assert.equal(heat.style.vectorStyleMode, "single");
  });

  it("drops a layer's symbology notes when the caller drops the layer", () => {
    const result = importArcgisProject(aprx(), "C:\\work\\planning.aprx");
    dropArcgisImportLayers(result, new Set([layerNamed(result.project.layers, "Heat").id]));
    assert.deepEqual(
      result.project.layers.map((layer) => layer.name),
      ["Density", "Zoning"],
    );
    assert.equal(
      result.warnings.some((warning) => warning.symbologyIssue),
      false,
    );
  });
});
