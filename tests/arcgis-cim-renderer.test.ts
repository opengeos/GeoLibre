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
  translateCimRenderer,
  lineWidthValue,
  vectorFillColorValue,
  vectorStrokeWidthValue,
  vectorLineColorValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import { importArcgisProject } from "../apps/geolibre-desktop/src/lib/arcgis-project-import";

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

  it("reports what it cannot translate instead of flattening silently", () => {
    const multi = translateCimRenderer(zoning({ fields: ["ZONE", "SUB"] }));
    assert.equal(multi.translated, false);
    assert.deepEqual(multi.issues, [{ code: "multiple-fields" }]);
    // The default symbol still colours the layer.
    assert.equal(multi.style.vectorStyleMode, "single");
    assert.equal(multi.style.fillColor, "#c8c8c8");

    const arcade = translateCimRenderer(
      zoning({
        valueExpressionInfo: {
          type: "CIMExpressionInfo",
          expression: "$feature.ZONE",
        },
      }),
    );
    assert.deepEqual(arcade.issues, [{ code: "expression" }]);

    const picture = zoning();
    picture.groups[0].classes[0].symbol = {
      type: "CIMSymbolReference",
      symbol: {
        type: "CIMPolygonSymbol",
        symbolLayers: [{ type: "CIMPictureFill" }],
      },
    } as never;
    assert.deepEqual(translateCimRenderer(picture).issues, [
      { code: "symbol", cimType: "CIMPolygonSymbol" },
    ]);

    assert.deepEqual(translateCimRenderer({ type: "CIMHeatMapRenderer" }).issues, [
      { code: "renderer", cimType: "CIMHeatMapRenderer" },
    ]);
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

  it("refuses renderers whose classes it cannot reproduce", () => {
    const codes = (overrides: Record<string, unknown>) =>
      translateCimRenderer(density(overrides)).issues.map((issue) => issue.code);
    assert.deepEqual(codes({ classBreakType: "GraduatedSymbol" }), ["graduated-symbols"]);
    assert.deepEqual(codes({ normalizationType: "Field", normalizationField: "AREA" }), [
      "normalization",
    ]);
    assert.deepEqual(codes({ exclusionClause: "DENSITY < 0" }), ["exclusion"]);
    assert.deepEqual(codes({ breaks: [] }), ["no-classes"]);
    assert.deepEqual(codes({ normalizationType: "Nothing" }), []);
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

function polygonWith(layers: unknown[]) {
  return { type: "CIMSymbolReference", symbol: { type: "CIMPolygonSymbol", symbolLayers: layers } };
}

describe("CIM symbols and defaults as Pro writes them", () => {
  const fill = (r: number, g: number, b: number) => ({
    type: "CIMSolidFill",
    enable: true,
    color: rgb(r, g, b),
  });
  const stroke = (alpha: number) => ({
    type: "CIMSolidStroke",
    enable: true,
    width: 1.5,
    color: rgb(0, 0, 0, alpha),
  });
  const twoClasses = (first: unknown[], second: unknown[]) => ({
    type: "CIMUniqueValueRenderer",
    fields: ["K"],
    groups: [
      {
        classes: [
          {
            label: "a",
            visible: true,
            symbol: polygonWith(first),
            values: [{ fieldValues: ["a"] }],
          },
          {
            label: "b",
            visible: true,
            symbol: polygonWith(second),
            values: [{ fieldValues: ["b"] }],
          },
        ],
      },
    ],
  });

  it("draws no outline where a class has none or a transparent one", () => {
    const style = translatedStyle(
      twoClasses([stroke(0), fill(1, 1, 1)], [stroke(100), fill(2, 2, 2)]),
    );
    assert.equal(renderedOutlineWidth(style, { K: "a" }), 0);
    assert.equal(renderedOutlineWidth(style, { K: "b" }), 2);
    const fillOnly = translatedStyle(twoClasses([stroke(100), fill(1, 1, 1)], [fill(2, 2, 2)]));
    assert.equal(renderedOutlineWidth(fillOnly, { K: "a" }), 2);
    assert.equal(renderedOutlineWidth(fillOnly, { K: "b" }), 0);
  });

  it("reads an omitted upper bound as 0, as CIM leaves out defaults", () => {
    const renderer = density({ minimumBreak: -3 });
    renderer.breaks = [
      { type: "CIMClassBreak", label: "≤-1", upperBound: -1, symbol: polygon([1, 1, 1]) },
      { type: "CIMClassBreak", label: "≤0", symbol: polygon([2, 2, 2]) } as never,
      { type: "CIMClassBreak", label: "≤3", upperBound: 3, symbol: polygon([3, 3, 3]) },
    ];
    const style = translatedStyle(renderer);
    assert.equal(renderedFill(style, { DENSITY: -3 }), "#010101");
    assert.equal(renderedFill(style, { DENSITY: 0 }), "#020202");
    assert.equal(renderedFill(style, { DENSITY: 0.5 }), "#030303");
    assert.deepEqual(translateCimRenderer(density({ minimumBreak: 11 })).issues, [
      { code: "no-classes" },
    ]);
  });

  it("refuses a colour channel that is not a number instead of reading it as 0", () => {
    const broken = translateCimRenderer({
      type: "CIMSimpleRenderer",
      symbol: polygonWith([
        { type: "CIMSolidFill", color: { type: "CIMRGBColor", values: [null, 0, 0, 100] } },
      ]),
    });
    assert.equal(broken.translated, false);
    assert.equal(broken.style.fillColor, undefined);
  });

  it("reads CIELAB colours", () => {
    const lab = translateCimRenderer({
      type: "CIMSimpleRenderer",
      symbol: polygonWith([
        {
          type: "CIMSolidFill",
          color: { type: "CIMLABColor", values: [54.29, 80.82, 69.89, 100] },
        },
      ]),
    });
    // CSS lab(54.29 80.82 69.89), D50, is sRGB red.
    assert.equal(lab.style.fillColor, "#ff0000");
  });

  it("hides a class Pro saved unchecked by leaving out visible", () => {
    const renderer = twoClasses([fill(1, 1, 1)], [fill(2, 2, 2)]);
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

  it("notes symbol layers it does not draw, and names unclassed colours", () => {
    const hatched = translateCimRenderer(
      twoClasses([fill(1, 1, 1), { type: "CIMHatchFill", enable: true }], [fill(2, 2, 2)]),
    );
    assert.equal(hatched.translated, true);
    assert.deepEqual(hatched.issues, [{ code: "symbol-layers", cimType: "CIMHatchFill" }]);
    // A cased line draws only its top stroke, so the casing is reported.
    const cased = translateCimRenderer({
      type: "CIMSimpleRenderer",
      symbol: {
        type: "CIMSymbolReference",
        symbol: {
          type: "CIMLineSymbol",
          symbolLayers: [
            { type: "CIMSolidStroke", enable: true, width: 2.6, color: rgb(255, 255, 255) },
            { type: "CIMSolidStroke", enable: true, width: 3.4, color: rgb(0, 0, 0) },
          ],
        },
      },
    });
    assert.equal(cased.style.strokeColor, "#ffffff");
    assert.deepEqual(cased.issues, [{ code: "symbol-layers", cimType: "CIMSolidStroke" }]);
    assert.deepEqual(translateCimRenderer(density({ classBreakType: "UnclassedColor" })).issues, [
      { code: "renderer", cimType: "UnclassedColor" },
    ]);
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
});
