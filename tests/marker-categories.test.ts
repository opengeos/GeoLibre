import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import { markerImageValue } from "../packages/map/src/markers";

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
});
