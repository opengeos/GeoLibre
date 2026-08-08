import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import {
  KML_ICON_URL_PROPERTY,
  markerImageValue,
  prepareKmlFeatureIcons,
} from "../packages/map/src/markers";

function categorizedMarker(patch: Partial<LayerStyle> = {}): LayerStyle {
  return {
    ...DEFAULT_LAYER_STYLE,
    markerEnabled: true,
    markerShape: "circle",
    markerColor: "#3b82f6",
    markerSize: 18,
    vectorStyleMode: "categorized",
    vectorStyleProperty: "status",
    vectorStyleStops: [
      { value: "good", color: "#339084" },
      { value: "bad", color: "#fde725" },
    ],
    ...patch,
  };
}

describe("markerImageValue", () => {
  it("selects a separately colored built-in marker for each category", () => {
    assert.deepEqual(markerImageValue(categorizedMarker()), [
      "match",
      ["to-string", ["get", "status"]],
      "good",
      "geolibre-marker-circle-339084-18",
      "bad",
      "geolibre-marker-circle-fde725-18",
      "geolibre-marker-circle-3b82f6-18",
    ]);
  });

  it("creates distinct parameterized SVG sprites for category colors", () => {
    const value = markerImageValue(
      categorizedMarker({
        markerShape: "custom",
        markerSvg:
          '<svg xmlns="http://www.w3.org/2000/svg"><path fill="param(fill)" d="M0 0h10v10z"/></svg>',
      }),
    );

    assert.ok(Array.isArray(value));
    const imageIds = [value[3], value[5], value[6]];
    assert.ok(
      imageIds.every((id) => typeof id === "string" && id.startsWith("geolibre-marker-svg-")),
    );
    assert.equal(new Set(imageIds).size, 3);
  });

  it("creates distinct category sprites when the SVG is supplied by URL", () => {
    const value = markerImageValue(
      categorizedMarker({
        markerShape: "custom",
        markerSvg: "https://example.com/tree.svg",
      }),
    );

    assert.ok(Array.isArray(value));
    assert.equal(new Set([value[3], value[5], value[6]]).size, 3);
  });

  it("uses the base marker for invalid expression color outputs", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "expression",
        vectorStyleExpression: '["match",["get","status"],"good","red","#fde725"]',
      }),
    );

    assert.ok(Array.isArray(value));
    assert.equal(value[3], "geolibre-marker-circle-3b82f6-18");
    assert.equal(value[4], "geolibre-marker-circle-fde725-18");
  });

  it("recursively converts colors in zoom-scoped rule expressions", () => {
    const value = markerImageValue(
      categorizedMarker({
        vectorStyleMode: "expression",
        vectorStyleExpression:
          '["step",["zoom"],["case",["get","selected"],"#339084","#fde725"],10,["case",["get","selected"],"#fde725","#339084"]]',
      }),
    );

    assert.deepEqual(value, [
      "step",
      ["zoom"],
      [
        "case",
        ["get", "selected"],
        "geolibre-marker-circle-339084-18",
        "geolibre-marker-circle-fde725-18",
      ],
      10,
      [
        "case",
        ["get", "selected"],
        "geolibre-marker-circle-fde725-18",
        "geolibre-marker-circle-339084-18",
      ],
    ]);
  });

  it("keeps categorized marker fallback inside a mixed KML icon expression", () => {
    const markerImage = markerImageValue(categorizedMarker());
    const value = prepareKmlFeatureIcons(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { [KML_ICON_URL_PROPERTY]: "data:image/png;base64,AA==" },
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [1, 1] },
            properties: { status: "good" },
          },
        ],
      },
      markerImage,
    );

    assert.ok(Array.isArray(value));
    assert.deepEqual(value[value.length - 1], markerImage);
  });
});
