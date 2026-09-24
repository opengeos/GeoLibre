import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ARCGIS_GLYPHS_URL,
  attachArcgisSprite,
  generatedSpriteIds,
  hasSymbolLayers,
} from "../packages/map/src/arcgis-sprite";
import { registerGeneratedImage } from "../packages/map/src/generated-images";
import type { ArcgisSdk } from "../packages/map/src/arcgis-sdk";

// The sprite a vector tile style needs is baked from GeoLibre's generated
// images (canvas work covered in the browser); these tests cover which images
// a style asks for and what the style gains.

registerGeneratedImage("test-sprite-marker-a", () => null);
registerGeneratedImage("test-sprite-marker-b", () => null);
registerGeneratedImage("test-sprite-pattern", () => null);

const layers = [
  { type: "fill", paint: { "fill-pattern": "test-sprite-pattern" } },
  {
    type: "symbol",
    layout: {
      // A categorized marker picks between generated images.
      "icon-image": ["match", ["get", "kind"], "a", "test-sprite-marker-a", "test-sprite-marker-b"],
      "text-field": ["get", "name"],
    },
  },
  // A string that is no generated image (a field name) is not collected.
  { type: "line", paint: { "line-color": ["get", "colour"] } },
];

describe("ArcGIS vector tile sprites", () => {
  it("collects the generated images a style references, through expressions", () => {
    assert.deepEqual(generatedSpriteIds(layers).sort(), [
      "test-sprite-marker-a",
      "test-sprite-marker-b",
      "test-sprite-pattern",
    ]);
    assert.deepEqual(generatedSpriteIds([{ type: "fill", paint: { "fill-color": "red" } }]), []);
    assert.equal(hasSymbolLayers(layers), true);
    assert.equal(hasSymbolLayers(layers.slice(0, 1)), false);
  });
  it("gives symbol layers Esri's glyphs, and leaves other styles alone", () => {
    const sdk = { config: { request: { interceptors: [] as unknown[] } } } as unknown as ArcgisSdk;
    const text = attachArcgisSprite(sdk, {
      version: 8,
      layers: [{ type: "symbol", layout: { "text-field": "x" } }],
    });
    assert.equal(text.style.glyphs, ARCGIS_GLYPHS_URL);
    assert.equal(text.style.sprite, undefined);
    const plain = { version: 8, layers: [{ type: "line" }] };
    assert.equal(attachArcgisSprite(sdk, plain).style, plain);
    assert.equal(sdk.config.request.interceptors.length, 0);
  });
});
