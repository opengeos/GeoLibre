/**
 * The `.lyrx` adapter: document unwrapping, labels, the warning each CIM issue becomes, and how
 * the result lands on an existing layer. How symbols, colours and renderers are read is tested
 * once, in `tests/arcgis-cim-renderer.test.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import { importStyleText } from "@geolibre/map/style-import";
import { isLyrxDocument, parseLyrx } from "../packages/map/src/lyrx-import";

const rgb = (r: number, g: number, b: number, a = 100) => ({
  type: "CIMRGBColor",
  values: [r, g, b, a],
});
const solidFill = (color: unknown = rgb(255, 136, 0, 50)) => ({
  type: "CIMSolidFill",
  enable: true,
  color,
});
const solidStroke = (color: unknown = rgb(17, 34, 51), width = 1.5, extra = {}) => ({
  type: "CIMSolidStroke",
  enable: true,
  width,
  color,
  ...extra,
});
const symbol = (type: string, symbolLayers: unknown[], extra = {}) => ({
  type: "CIMSymbolReference",
  symbol: { type, symbolLayers, ...extra },
});
const polygon = (...layers: unknown[]) =>
  symbol("CIMPolygonSymbol", layers.length ? layers : [solidStroke(), solidFill()]);
/** Pro writes a circle marker as one curve ring: its start point and one arc back to it. */
const circle = { curveRings: [[[0, 5], { a: [[0, 5], [0, 0], 0, 1] }]] };
const marker = (geometry: unknown = circle, layers: unknown[] = [solidFill(rgb(0, 128, 0))]) =>
  symbol("CIMPointSymbol", [
    {
      type: "CIMVectorMarker",
      enable: true,
      size: 12,
      markerGraphics: [
        { type: "CIMMarkerGraphic", geometry, symbol: symbol("CIMPolygonSymbol", layers).symbol },
      ],
    },
  ]);
const simple = (reference: unknown = polygon()) => ({
  type: "CIMSimpleRenderer",
  symbol: reference,
});
const zoning = (extra: Record<string, unknown> = {}) => ({
  type: "CIMUniqueValueRenderer",
  fields: ["ZONE"],
  groups: [
    {
      classes: [
        { label: "Res", visible: true, symbol: polygon(), values: [{ fieldValues: ["R"] }] },
        { label: "Com", visible: true, symbol: polygon(), values: [{ fieldValues: ["C"] }] },
      ],
    },
  ],
  ...extra,
});

function document(renderer: unknown, extra: Record<string, unknown> = {}, more: unknown[] = []) {
  return {
    type: "CIMLayerDocument",
    version: "3.1.0",
    layers: ["CIMPATH=map/parcels.json"],
    layerDefinitions: [{ type: "CIMFeatureLayer", name: "Parcels", renderer, ...extra }, ...more],
  };
}

const lyrx = (renderer: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify(document(renderer, extra));

const base = (): LayerStyle => structuredClone(DEFAULT_LAYER_STYLE);

/** Import onto a layer, failing the test if the import is refused. */
function applied(text: string, onto: LayerStyle = base()) {
  const result = importStyleText(text);
  assert.equal(result.ok, true, result.ok ? "" : result.warnings.join(" "));
  if (!result.ok) throw new Error("unreachable");
  return { style: result.apply(onto), warnings: result.warnings };
}

describe(".lyrx style import", () => {
  it("recognises a layer document and nothing else", () => {
    assert.equal(isLyrxDocument({ type: "CIMLayerDocument", layerDefinitions: [] }), true);
    assert.equal(isLyrxDocument({ version: 8, layers: [] }), false);
    assert.equal(isLyrxDocument(null), false);
    // Mapbox GL JSON still goes to the Mapbox reader.
    const { style } = applied(
      JSON.stringify({
        version: 8,
        layers: [{ id: "a", type: "fill", paint: { "fill-color": "#4ce600" } }],
      }),
    );
    assert.equal(style.fillColor, "#4ce600");
  });

  it("imports a single symbol with its fill, outline and field label, and nothing to report", () => {
    const { style, warnings } = applied(
      lyrx(simple(), {
        labelVisibility: true,
        labelClasses: [{ expression: "[OWNER]", visibility: true }],
      }),
      { ...base(), minZoom: 5, textSize: 20 },
    );
    assert.deepEqual(warnings, []);
    assert.equal(style.vectorStyleMode, "single");
    assert.equal(style.fillColor, "#ff8800");
    assert.equal(style.fillOpacity, 0.5);
    assert.equal(style.strokeColor, "#112233");
    // CIM widths are points; GeoLibre's are CSS pixels.
    assert.equal(style.strokeWidth, 2);
    assert.equal(style.labels.enabled, true);
    assert.equal(style.labels.field, "OWNER");
    // Fields the symbol does not describe keep the layer's values.
    assert.equal(style.minZoom, 5);
    assert.equal(style.textSize, 20);
  });

  it("treats the CIM symbol as the whole symbol, resetting what the layer had", () => {
    const { style, warnings } = applied(lyrx(simple(marker())), {
      ...base(),
      markerEnabled: true,
      pointRenderer: "heatmap",
      proportionalSizeEnabled: true,
      strokeDash: [3, 1],
      strokeOpacity: 0.5,
      strokeWidthUnit: "meters",
      fillPattern: "hatch",
      strokeBlur: 9,
      lineDecoration: "arrow",
      invertedFillEnabled: true,
    });
    assert.deepEqual(warnings, []);
    assert.equal(style.fillColor, "#008000");
    // 12 pt across is a 16 px circle, so an 8 px radius.
    assert.equal(style.circleRadius, 8);
    // No outline in the file means no outline, not the layer's.
    assert.equal(style.strokeWidth, 0);
    assert.equal(style.markerEnabled, false);
    assert.equal(style.pointRenderer, "single");
    assert.equal(style.proportionalSizeEnabled, false);
    assert.deepEqual(style.strokeDash, []);
    assert.equal(style.strokeOpacity, 1);
    assert.equal(style.strokeWidthUnit, "pixels");
    assert.equal(style.fillPattern, "none");
    assert.equal(style.strokeBlur, 0);
    assert.equal(style.lineDecoration, "none");
    assert.equal(style.invertedFillEnabled, false);
  });

  it("imports unique value and class breaks renderers as rules", () => {
    const unique = applied(lyrx(zoning())).style;
    assert.equal(unique.vectorStyleMode, "rule-based");
    assert.deepEqual(
      unique.vectorRules.map((rule) => rule.label),
      ["Res", "Com", ""],
    );
    const breaks = applied(
      lyrx({
        type: "CIMClassBreaksRenderer",
        classBreakType: "GraduatedColor",
        field: "POP",
        minimumBreak: 0,
        breaks: [
          { upperBound: 10, symbol: polygon() },
          { upperBound: 20, symbol: polygon() },
        ],
      }),
    ).style;
    assert.equal(breaks.vectorStyleMode, "rule-based");
    assert.equal(breaks.vectorRules.filter((rule) => !rule.isElse).length, 2);
  });

  it("reads a symbol layer without an `enable` flag as drawn", () => {
    const { style } = applied(
      lyrx(
        simple(
          symbol("CIMLineSymbol", [{ type: "CIMSolidStroke", width: 3, color: rgb(0, 0, 255) }]),
        ),
      ),
    );
    assert.equal(style.strokeColor, "#0000ff");
    assert.equal(style.strokeWidth, 4);
  });

  describe("refuses, by name, what it cannot import, and keeps the layer's style", () => {
    const hatchOnly = polygon({ type: "CIMHatchFill", enable: true });
    const cases: [string, unknown, RegExp][] = [
      ["a heat map", { type: "CIMHeatMapRenderer" }, /uses the heat map renderer/],
      [
        "proportional symbols",
        { type: "CIMProportionalRenderer" },
        /uses the proportional symbols renderer/,
      ],
      [
        "unclassed colours",
        { type: "CIMClassBreaksRenderer", classBreakType: "UnclassedColor", field: "P" },
        /uses the unclassed colours renderer/,
      ],
      ["a prototype key", { type: "constructor" }, /uses the constructor renderer/],
      ["another prototype key", { type: "__proto__" }, /uses the __proto__ renderer/],
      ["unique values on two fields", zoning({ fields: ["A", "B"] }), /not on exactly one field/],
      [
        "an Arcade expression",
        zoning({ valueExpressionInfo: { expression: "$feature.A" } }),
        /Arcade expression/,
      ],
      [
        "normalised breaks",
        { type: "CIMClassBreaksRenderer", field: "P", normalizationType: "ByField", breaks: [] },
        /normalised/,
      ],
      [
        "graduated symbols",
        {
          type: "CIMClassBreaksRenderer",
          field: "P",
          classBreakType: "GraduatedSymbol",
          breaks: [],
        },
        /graduated symbols/,
      ],
      [
        "an exclusion clause",
        {
          type: "CIMClassBreaksRenderer",
          field: "P",
          exclusionClause: "P < 0",
          breaks: [{ upperBound: 1, symbol: polygon() }],
        },
        /exclude values/,
      ],
      [
        "a symbol with nothing drawable",
        simple(hatchOnly),
        /polygon symbol has no fill, outline or marker/,
      ],
      ["no usable classes", zoning({ groups: [] }), /no classes GeoLibre can import/],
    ];
    for (const [label, renderer, warning] of cases) {
      it(label, () => {
        const result = importStyleText(lyrx(renderer));
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.reason, "no-match");
        assert.match(result.warnings[0], warning);
        assert.match(result.warnings[0], /the layer keeps its current style\.$/);
      });
    }

    it("a document without a feature layer or renderer", () => {
      for (const [text, warning] of [
        [
          JSON.stringify({
            type: "CIMLayerDocument",
            layerDefinitions: [{ type: "CIMRasterLayer" }],
          }),
          /no feature layer/,
        ],
        [lyrx(undefined), /has no renderer/],
      ] as const) {
        const result = importStyleText(text);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.warnings[0], warning);
      }
    });
  });

  describe("imports the rest and names what it left out", () => {
    const transparencies = zoning();
    transparencies.groups[0].classes[1].symbol = polygon(
      solidStroke(rgb(0, 0, 0, 50)),
      solidFill(),
    );
    const cases: [string, unknown, RegExp][] = [
      [
        "a hatch beside a fill",
        simple(polygon(solidStroke(), solidFill(), { type: "CIMHatchFill", enable: true })),
        /^A hatch fill in the \.lyrx style's symbols was not imported/,
      ],
      [
        "a fill colour it cannot read",
        simple(
          polygon(solidStroke(), solidFill({ type: "CIMHSLColor", values: [0, 100, 50, 100] })),
        ),
        /\(HSL colour\) could not be read/,
      ],
      [
        "a null colour channel",
        simple(
          polygon(solidStroke(), solidFill({ type: "CIMRGBColor", values: [null, 0, 0, 100] })),
        ),
        /\(RGB colour\) could not be read/,
      ],
      [
        "dashes",
        simple(
          symbol("CIMLineSymbol", [
            solidStroke(rgb(1, 2, 3), 1, {
              effects: [{ type: "CIMGeometricEffectDashes", dashTemplate: [4, 2] }],
            }),
          ]),
        ),
        /geometric effect in the \.lyrx style \(dashes\)/,
      ],
      [
        "a square marker",
        simple(
          marker({
            rings: [
              [
                [-5, -5],
                [-5, 5],
                [5, 5],
                [5, -5],
                [-5, -5],
              ],
            ],
          }),
        ),
        /vector marker is drawn as a circle/,
      ],
      [
        "a font glyph marker",
        simple(
          symbol("CIMPointSymbol", [
            {
              type: "CIMCharacterMarker",
              enable: true,
              size: 15,
              symbol: symbol("CIMPolygonSymbol", [solidFill(rgb(200, 0, 0))]).symbol,
            },
          ]),
        ),
        /character marker is drawn as a circle/,
      ],
      [
        "visual variables",
        { ...simple(), visualVariables: [{ type: "CIMSizeVisualVariable" }] },
        /visual variables/,
      ],
      [
        "per-class outline transparency",
        transparencies,
        /different line or outline transparencies/,
      ],
    ];
    for (const [label, renderer, warning] of cases) {
      it(label, () => {
        const { warnings } = applied(lyrx(renderer));
        assert.equal(warnings.length, 1, warnings.join(" | "));
        assert.match(warnings[0], warning);
      });
    }

    it("only the first of several feature layers", () => {
      const result = parseLyrx(
        document(simple(), {}, [{ type: "CIMFeatureLayer", name: "Roads", renderer: simple() }]),
      );
      assert.equal(result.matchedCount, 1);
      assert.match(result.warnings.join(" "), /holds 2 feature layers; only the first, "Parcels"/);
    });
  });

  describe("labels", () => {
    const labelled = (): LayerStyle => ({
      ...base(),
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: true,
        field: "OLD",
        size: 20,
        sizeExpression: '["get", "SIZE"]',
        colorExpression: '["get", "COLOUR"]',
        opacityExpression: "0",
        visibilityExpression: "false",
      },
    });
    const textLabel = (textSymbol: Record<string, unknown>) =>
      withLabels([
        {
          expression: "[NAME]",
          visibility: true,
          textSymbol: symbol("CIMTextSymbol", [], textSymbol),
        },
      ]);
    const fillSymbol = (color: unknown) => symbol("CIMPolygonSymbol", [solidFill(color)]).symbol;
    const withLabels = (labelClasses: unknown[], visibility = true) =>
      lyrx(simple(), { labelVisibility: visibility, labelClasses });

    it("reads a bare field in each expression language", () => {
      for (const expression of ["[NAME]", "[ NAME ]", "$feature.NAME", '$feature["NAME"]']) {
        const { style } = applied(withLabels([{ expression, visibility: true }]));
        assert.equal(style.labels.field, "NAME", expression);
        assert.equal(style.labels.expression, "");
      }
    });

    it("turns labels off when the file has them off, keeping the layer's label settings", () => {
      for (const text of [lyrx(simple()), withLabels([{ expression: "[NAME]" }])]) {
        const { style } = applied(text, labelled());
        assert.equal(style.labels.enabled, false);
        assert.equal(style.labels.field, "OLD");
      }
    });

    it("leaves labels alone and says so for a computed expression", () => {
      const { style, warnings } = applied(
        withLabels([{ expression: 'Round($feature.LEN, 1) + " FT"', visibility: true }]),
        labelled(),
      );
      assert.deepEqual(style.labels, labelled().labels);
      assert.match(warnings.join(" "), /label expression is not a single field/);
    });

    it("reads the text size, colour and halo, and names the font and filter", () => {
      const { style, warnings } = applied(
        withLabels([
          {
            expression: "[NAME]",
            visibility: true,
            whereClause: "POP > 1000",
            textSymbol: symbol("CIMTextSymbol", [], {
              height: 12,
              fontFamilyName: "Arial",
              haloSize: 1.5,
              symbol: symbol("CIMPolygonSymbol", [solidFill(rgb(255, 255, 255))]).symbol,
              haloSymbol: symbol("CIMPolygonSymbol", [solidFill(rgb(0, 77, 168))]).symbol,
            }),
          },
          { expression: "[CODE]", visibility: true },
        ]),
        labelled(),
      );
      assert.equal(style.labels.size, 16);
      assert.equal(style.labels.color, "#ffffff");
      assert.equal(style.labels.haloColor, "#004da8");
      assert.equal(style.labels.haloWidth, 2);
      // The layer's data-defined overrides would beat what the file says.
      assert.equal(style.labels.sizeExpression, "");
      assert.equal(style.labels.colorExpression, "");
      assert.equal(style.labels.opacityExpression, "");
      assert.equal(style.labels.visibilityExpression, "");
      const text = warnings.join(" ");
      assert.doesNotMatch(text, /transparency|halo colour/);
      assert.match(text, /2 visible label classes; only the first/);
      assert.match(text, /label filter \(where clause\) was not imported/);
      assert.match(text, /label font \(Arial\) was not imported/);
    });

    it("draws no halo when the file has none, and keeps the colour it cannot read", () => {
      const { style, warnings } = applied(
        withLabels([
          {
            expression: "[NAME]",
            visibility: true,
            textSymbol: symbol("CIMTextSymbol", [], {
              symbol: symbol("CIMPolygonSymbol", [solidFill({ type: "CIMSpotColor", values: [1] })])
                .symbol,
            }),
          },
        ]),
        labelled(),
      );
      assert.equal(style.labels.haloWidth, 0);
      assert.equal(style.labels.color, DEFAULT_LAYER_STYLE.labels.color);
      assert.equal(style.labels.size, 20);
      assert.match(warnings.join(" "), /label colour could not be read/);
      // The colour it could not read keeps the layer's data-defined colour too.
      assert.equal(style.labels.colorExpression, '["get", "COLOUR"]');
    });

    it("names an unreadable halo and transparent text, and drops a fully clear halo", () => {
      const spot = { type: "CIMSpotColor", values: [1] };
      for (const [textSymbol, haloWidth, warning] of [
        [
          { symbol: fillSymbol(rgb(0, 0, 0)), haloSize: 1, haloSymbol: fillSymbol(spot) },
          0,
          /halo colour could not be read/,
        ],
        [{ symbol: fillSymbol(rgb(0, 0, 0, 40)) }, 0, /label transparency was not imported/],
        [
          {
            symbol: fillSymbol(rgb(0, 0, 0)),
            haloSize: 1,
            haloSymbol: fillSymbol(rgb(255, 255, 255, 50)),
          },
          1.3333,
          /label transparency was not imported/,
        ],
        [
          {
            symbol: fillSymbol(rgb(0, 0, 0)),
            haloSize: 1,
            haloSymbol: fillSymbol(rgb(255, 255, 255, 0)),
          },
          0,
          null,
        ],
        [
          {
            symbol: fillSymbol(rgb(0, 0, 0)),
            haloSize: 1,
            haloSymbol: symbol("CIMPolygonSymbol", [solidStroke(rgb(0, 0, 255))]).symbol,
          },
          0,
          /label symbol was not imported: the halo outline\./,
        ],
        [
          {
            symbol: fillSymbol(rgb(0, 0, 0)),
            haloSize: 1,
            haloSymbol: symbol("CIMPolygonSymbol", [
              solidFill(rgb(255, 255, 255)),
              { type: "CIMHatchFill", enable: true },
            ]).symbol,
          },
          1.3333,
          /label symbol was not imported: the halo hatch fill\./,
        ],
        [
          { symbol: symbol("CIMPolygonSymbol", [solidStroke(), solidFill(rgb(0, 0, 0))]).symbol },
          0,
          /label symbol was not imported: the text outline\./,
        ],
      ] as const) {
        const { style, warnings } = applied(textLabel(textSymbol), labelled());
        assert.equal(style.labels.haloWidth, haloWidth);
        if (warning) assert.match(warnings.join(" "), warning);
        else assert.deepEqual(warnings, []);
      }
    });
  });
});
