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
  it("bakes the referenced images into a sheet served through the interceptor", async () => {
    // Just enough DOM for the baking: canvases that record their draws, and
    // images whose decode resolves.
    const draws: number[][] = [];
    const canvas = () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_image: unknown, ...args: number[]) => draws.push(args),
      }),
      toDataURL: () => "data:image/png;base64,",
    });
    class FakeImage {
      src = "";
      decode() {
        return Promise.resolve();
      }
    }
    const previous = { document: globalThis.document, Image: globalThis.Image };
    Object.assign(globalThis, {
      document: { createElement: () => canvas() },
      Image: FakeImage,
    });
    try {
      // A 2x marker, 20 x 10 device pixels, and one that fails to draw.
      registerGeneratedImage("test-sheet-a", () => ({
        image: { width: 20, height: 10 } as never,
        pixelRatio: 2,
      }));
      registerGeneratedImage("test-sheet-broken", () => null);
      const interceptors: { urls: string; before(args: { url: string }): Promise<unknown> }[] = [];
      const sdk = { config: { request: { interceptors } } } as unknown as ArcgisSdk;
      const sprite = attachArcgisSprite(sdk, {
        version: 8,
        layers: [
          {
            type: "symbol",
            layout: { "icon-image": ["coalesce", "test-sheet-a", "test-sheet-broken"] },
          },
        ],
      });
      const prefix = sprite.style.sprite!;
      assert.equal(interceptors.length, 1);
      assert.equal(interceptors[0].urls, prefix);
      const serve = (suffix: string) => interceptors[0].before({ url: prefix + suffix });
      // At 1x the 2x marker is drawn at half its device size.
      assert.deepEqual(await serve(".json"), {
        "test-sheet-a": { x: 0, y: 0, width: 10, height: 5, pixelRatio: 1 },
      });
      assert.deepEqual(await serve("@2x.json?v=1"), {
        "test-sheet-a": { x: 0, y: 0, width: 20, height: 10, pixelRatio: 2 },
      });
      // The sheet is an image element, never null (the SDK would fetch the URL).
      assert.ok((await serve(".png")) instanceof FakeImage);
      assert.ok(draws.some((args) => args.join() === "0,0,10,5"));
      await assert.rejects(serve(".txt"), /Invalid sprite request/);
      sprite.dispose();
      assert.equal(interceptors.length, 0);
      // Nothing drawable still answers an (empty) image.
      const empty = attachArcgisSprite(sdk, {
        version: 8,
        layers: [{ type: "fill", paint: { "fill-pattern": "test-sheet-broken" } }],
      });
      assert.deepEqual(await interceptors[0].before({ url: empty.style.sprite + ".json" }), {});
      assert.ok(
        (await interceptors[0].before({ url: empty.style.sprite + ".png" })) instanceof FakeImage,
      );
      empty.dispose();
    } finally {
      Object.assign(globalThis, previous);
    }
  });
});
