import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { importStyleText } from "@geolibre/map/style-import";
import { applyLyrxImport, isLyrxDocument, parseLyrx } from "../packages/map/src/lyrx-import";

function rgb(r: number, g: number, b: number, a = 100) {
  return { type: "CIMRGBColor", values: [r, g, b, a] };
}

function polygonSymbol(fill: number[], outline = [0, 0, 0], width = 0.75) {
  return {
    type: "CIMSymbolReference",
    symbol: {
      type: "CIMPolygonSymbol",
      symbolLayers: [
        {
          type: "CIMSolidStroke",
          enable: true,
          width,
          color: rgb(outline[0], outline[1], outline[2]),
        },
        {
          type: "CIMSolidFill",
          enable: true,
          color: rgb(fill[0], fill[1], fill[2], fill[3] ?? 100),
        },
      ],
    },
  };
}

function lyrxDocument(renderer: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "CIMLayerDocument",
    version: "3.1.0",
    layers: ["CIMPATH=map/parcels.json"],
    layerDefinitions: [
      {
        type: "CIMFeatureLayer",
        name: "Parcels",
        uRI: "CIMPATH=map/parcels.json",
        renderer,
        ...extra,
      },
    ],
  };
}

function lyrx(renderer: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify(lyrxDocument(renderer, extra));
}

describe("ArcGIS Pro layer file (.lyrx) style import", () => {
  it("recognises a layer file and nothing else", () => {
    assert.equal(isLyrxDocument({ type: "CIMLayerDocument", layerDefinitions: [] }), true);
    assert.equal(isLyrxDocument({ version: 8, layers: [] }), false);
    assert.equal(isLyrxDocument(null), false);
  });

  it("imports a simple renderer's fill, outline and field label", () => {
    const result = importStyleText(
      lyrx(
        { type: "CIMSimpleRenderer", symbol: polygonSymbol([255, 136, 0, 50], [17, 34, 51], 1.5) },
        { labelVisibility: true, labelClasses: [{ expression: "[OWNER]", visibility: true }] },
      ),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const style = result.apply(structuredClone(DEFAULT_LAYER_STYLE));
    assert.equal(style.vectorStyleMode, "single");
    assert.equal(style.fillColor, "#ff8800");
    assert.equal(style.fillOpacity, 0.5);
    assert.equal(style.strokeColor, "#112233");
    // CIM widths are points; GeoLibre's are CSS pixels.
    assert.equal(style.strokeWidth, 2);
    assert.equal(style.strokeWidthUnit, "pixels");
    assert.equal(style.fillPattern, "none");
    assert.equal(style.labels.enabled, true);
    assert.equal(style.labels.field, "OWNER");
    assert.deepEqual(result.warnings, []);
  });

  it("imports a point marker's colour and size", () => {
    const result = parseLyrx(
      lyrxDocument({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPointSymbol",
            symbolLayers: [
              {
                type: "CIMVectorMarker",
                enable: true,
                size: 12,
                markerGraphics: [
                  {
                    type: "CIMMarkerGraphic",
                    symbol: {
                      type: "CIMPolygonSymbol",
                      symbolLayers: [{ type: "CIMSolidFill", enable: true, color: rgb(0, 128, 0) }],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    assert.equal(result.matchedCount, 1);
    assert.equal(result.style.fillColor, "#008000");
    assert.equal(result.style.circleRadius, 8);
    // The marker has no outline, so the layer's own outline and icon must not show through.
    const style = applyLyrxImport(
      {
        ...structuredClone(DEFAULT_LAYER_STYLE),
        markerEnabled: true,
        pointRenderer: "heatmap",
        proportionalSizeEnabled: true,
      },
      result,
    );
    assert.equal(style.strokeOpacity, 0);
    assert.equal(style.markerEnabled, false);
    assert.equal(style.pointRenderer, "single");
    assert.equal(style.proportionalSizeEnabled, false);
  });

  it("refuses unique value and class breaks renderers by name for now", () => {
    for (const [renderer, name] of [
      [{ type: "CIMUniqueValueRenderer", fields: ["ZONE"], groups: [] }, /unique values/],
      [{ type: "CIMClassBreaksRenderer", field: "POP", breaks: [] }, /class breaks/],
    ] as const) {
      const result = importStyleText(lyrx(renderer));
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.equal(result.reason, "no-match");
      assert.match(result.warnings[0], name);
    }
  });

  it("reads a line symbol's stroke and an Arcade field label", () => {
    const result = parseLyrx(
      lyrxDocument(
        {
          type: "CIMSimpleRenderer",
          symbol: {
            type: "CIMSymbolReference",
            symbol: {
              type: "CIMLineSymbol",
              symbolLayers: [
                // Pro omits `enable` when it is false.
                { type: "CIMSolidStroke", width: 9, color: rgb(9, 9, 9) },
                { type: "CIMSolidStroke", enable: true, width: 3, color: rgb(0, 0, 255, 40) },
              ],
            },
          },
        },
        {
          labelVisibility: true,
          labelClasses: [{ expression: "$feature.NAME", visibility: true }],
        },
      ),
    );
    assert.equal(result.matchedCount, 1);
    assert.equal(result.style.strokeColor, "#0000ff");
    assert.equal(result.style.strokeOpacity, 0.4);
    assert.equal(result.style.strokeWidth, 4);
    assert.equal(result.style.fillColor, undefined);
    assert.deepEqual(result.labels, { enabled: true, field: "NAME", expression: "" });
    assert.deepEqual(result.style.strokeDash, []);
  });

  it("keeps the layer's dash and names it when the line is dashed, on the stroke or the symbol", () => {
    const stroke = { type: "CIMSolidStroke", enable: true, width: 1, color: rgb(1, 2, 3) };
    const dashes = [{ type: "CIMGeometricEffectDashes", dashTemplate: [4, 2] }];
    for (const symbol of [
      { type: "CIMLineSymbol", symbolLayers: [{ ...stroke, effects: dashes }] },
      { type: "CIMLineSymbol", effects: dashes, symbolLayers: [stroke] },
    ]) {
      const result = importStyleText(
        lyrx({ type: "CIMSimpleRenderer", symbol: { type: "CIMSymbolReference", symbol } }),
      );
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      const style = result.apply({ ...structuredClone(DEFAULT_LAYER_STYLE), strokeDash: [3, 1] });
      assert.deepEqual(style.strokeDash, [3, 1]);
      assert.equal(style.strokeColor, "#010203");
      assert.match(result.warnings.join(" "), /dash pattern/);
    }
  });

  it("keeps the layer's other style fields when merging", () => {
    const result = importStyleText(
      lyrx({ type: "CIMSimpleRenderer", symbol: polygonSymbol([1, 2, 3]) }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const base = { ...structuredClone(DEFAULT_LAYER_STYLE), minZoom: 5, textSize: 20 };
    const style = result.apply(base);
    assert.equal(style.minZoom, 5);
    assert.equal(style.textSize, 20);
    assert.deepEqual(style.labels, base.labels);
  });

  it("rejects an unsupported renderer by name rather than importing a partial style", () => {
    const result = importStyleText(lyrx({ type: "CIMHeatMapRenderer" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "no-match");
    assert.match(result.warnings[0], /heat map/i);
  });

  it("rejects a layer file without a feature layer", () => {
    const result = importStyleText(
      JSON.stringify({
        type: "CIMLayerDocument",
        layerDefinitions: [{ type: "CIMRasterLayer", name: "DEM" }],
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warnings[0], /no feature layer/i);
  });

  it("reports what it left behind: extra layers, picture fills and expression labels", () => {
    const text = JSON.stringify({
      type: "CIMLayerDocument",
      layerDefinitions: [
        {
          type: "CIMFeatureLayer",
          name: "First",
          labelVisibility: true,
          labelClasses: [{ expression: "[A] + ' ' + [B]", visibility: true }],
          renderer: {
            type: "CIMSimpleRenderer",
            symbol: {
              type: "CIMSymbolReference",
              symbol: {
                type: "CIMPolygonSymbol",
                symbolLayers: [
                  { type: "CIMPictureFill", enable: true },
                  { type: "CIMSolidStroke", enable: true, width: 1, color: rgb(1, 2, 3) },
                ],
              },
            },
          },
        },
        { type: "CIMFeatureLayer", name: "Second", renderer: { type: "CIMSimpleRenderer" } },
      ],
    });
    const result = importStyleText(text);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings.join("\n"), /only the first, "First"/);
    assert.match(result.warnings.join("\n"), /picture fill/i);
    assert.match(result.warnings.join("\n"), /label expression/i);
  });

  it("leads with the renderer refusal when the first of several layers is unsupported", () => {
    const result = importStyleText(
      JSON.stringify({
        type: "CIMLayerDocument",
        layerDefinitions: [
          { type: "CIMFeatureLayer", name: "Heat", renderer: { type: "CIMHeatMapRenderer" } },
          { type: "CIMFeatureLayer", name: "Other", renderer: { type: "CIMSimpleRenderer" } },
        ],
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /heat map/);
  });

  it("names the symbol it could not read when nothing else was readable", () => {
    const result = importStyleText(
      lyrx({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPolygonSymbol",
            symbolLayers: [{ type: "CIMPictureFill", enable: true }],
          },
        },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.warnings[0], /picture fill/);
  });

  it("names a renderer type that collides with an Object prototype key as itself", () => {
    for (const type of ["constructor", "__proto__", "toString"]) {
      const result = importStyleText(lyrx({ type }));
      assert.equal(result.ok, false);
      if (result.ok) continue;
      assert.match(result.warnings[0], new RegExp(`uses the ${type} renderer`));
    }
  });

  it("says the label's text style was not imported", () => {
    const result = parseLyrx(
      lyrxDocument(
        { type: "CIMSimpleRenderer", symbol: polygonSymbol([1, 2, 3]) },
        {
          labelVisibility: true,
          labelClasses: [
            {
              expression: "[NAME]",
              visibility: true,
              whereClause: "POP > 1000",
              textSymbol: {
                type: "CIMSymbolReference",
                symbol: { type: "CIMTextSymbol", height: 12 },
              },
            },
          ],
        },
      ),
    );
    assert.deepEqual(result.labels, { enabled: true, field: "NAME", expression: "" });
    assert.match(result.warnings.join(" "), /label font, size, colour and halo/);
    assert.match(result.warnings.join(" "), /label filter \(where clause\)/);
  });

  it("turns labels off when the layer file has them off", () => {
    const labelled = {
      ...structuredClone(DEFAULT_LAYER_STYLE),
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "OLD" },
    };
    for (const extra of [{}, { labelVisibility: true, labelClasses: [{ expression: "[NAME]" }] }]) {
      const result = importStyleText(
        lyrx({ type: "CIMSimpleRenderer", symbol: polygonSymbol([1, 2, 3]) }, extra),
      );
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      const style = result.apply(labelled);
      assert.equal(style.labels.enabled, false);
      assert.equal(style.labels.field, "OLD");
    }
  });

  it("reads a character marker's glyph colour and ignores markers decorating a line", () => {
    const glyph = parseLyrx(
      lyrxDocument({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPointSymbol",
            symbolLayers: [
              {
                type: "CIMCharacterMarker",
                enable: true,
                size: 15,
                // Per the CIM spec, a character marker's `symbol` is the glyph's polygon symbol.
                symbol: {
                  type: "CIMPolygonSymbol",
                  symbolLayers: [{ type: "CIMSolidFill", enable: true, color: rgb(200, 0, 0) }],
                },
              },
            ],
          },
        },
      }),
    );
    assert.equal(glyph.style.fillColor, "#c80000");
    assert.equal(glyph.style.circleRadius, 10);

    const arrowed = parseLyrx(
      lyrxDocument({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMLineSymbol",
            symbolLayers: [
              {
                type: "CIMVectorMarker",
                enable: true,
                size: 6,
                markerGraphics: [
                  {
                    type: "CIMMarkerGraphic",
                    symbol: {
                      type: "CIMPolygonSymbol",
                      symbolLayers: [
                        { type: "CIMSolidStroke", enable: true, width: 9, color: rgb(255, 0, 0) },
                      ],
                    },
                  },
                ],
              },
              { type: "CIMSolidStroke", enable: true, width: 1.5, color: rgb(0, 0, 255) },
            ],
          },
        },
      }),
    );
    assert.equal(arrowed.style.strokeColor, "#0000ff");
    assert.equal(arrowed.style.strokeWidth, 2);
    assert.equal(arrowed.style.circleRadius, undefined);
    assert.match(arrowed.warnings.join(" "), /markers along lines/);
  });

  it("names extra symbol layers and an empty symbol rather than dropping them silently", () => {
    const cased = parseLyrx(
      lyrxDocument({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMLineSymbol",
            symbolLayers: [
              { type: "CIMSolidStroke", enable: true, width: 1, color: rgb(255, 255, 255) },
              { type: "CIMSolidStroke", enable: true, width: 3, color: rgb(0, 0, 0) },
            ],
          },
        },
      }),
    );
    assert.equal(cased.style.strokeColor, "#ffffff");
    assert.match(cased.warnings.join(" "), /extra fill and outline layers/);

    const empty = importStyleText(
      lyrx({
        type: "CIMSimpleRenderer",
        symbol: { type: "CIMSymbolReference", symbol: { type: "CIMMeshSymbol" } },
      }),
    );
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.match(empty.warnings[0], /CIMMeshSymbol has no fill, outline or marker/);
  });

  it("keeps the layer's colour and says so when a colour type cannot be read", () => {
    const result = importStyleText(
      lyrx({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPolygonSymbol",
            symbolLayers: [
              { type: "CIMSolidStroke", enable: true, width: 1, color: rgb(1, 2, 3) },
              {
                type: "CIMSolidFill",
                enable: true,
                color: { type: "CIMSpotColor", values: [1, 2, 3] },
              },
            ],
          },
        },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const base = structuredClone(DEFAULT_LAYER_STYLE);
    const style = result.apply(base);
    assert.equal(style.fillOpacity, base.fillOpacity);
    assert.equal(style.fillColor, base.fillColor);
    assert.equal(style.strokeColor, "#010203");
    assert.match(result.warnings.join(" "), /colours GeoLibre cannot read/);
  });

  it("names a second point marker even when the first has no size", () => {
    const marker = (size: number | undefined, fill: number[]) => ({
      type: "CIMVectorMarker",
      enable: true,
      ...(size === undefined ? {} : { size }),
      markerGraphics: [
        {
          type: "CIMMarkerGraphic",
          symbol: {
            type: "CIMPolygonSymbol",
            symbolLayers: [
              { type: "CIMSolidFill", enable: true, color: rgb(fill[0], fill[1], fill[2]) },
            ],
          },
        },
      ],
    });
    const result = parseLyrx(
      lyrxDocument({
        type: "CIMSimpleRenderer",
        symbol: {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPointSymbol",
            symbolLayers: [marker(undefined, [0, 128, 0]), marker(24, [255, 0, 0])],
          },
        },
      }),
    );
    assert.equal(result.style.fillColor, "#008000");
    assert.equal(result.style.circleRadius, undefined);
    assert.match(result.warnings.join(" "), /extra point markers/);
  });

  it("leaves Mapbox GL JSON to the Mapbox reader", () => {
    const result = importStyleText(
      JSON.stringify({
        version: 8,
        layers: [{ id: "a", type: "fill", paint: { "fill-color": "#4ce600" } }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.apply(structuredClone(DEFAULT_LAYER_STYLE)).fillColor, "#4ce600");
  });
});
