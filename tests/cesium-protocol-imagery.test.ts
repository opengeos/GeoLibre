import assert from "node:assert/strict";
import { Credit, Event, Rectangle, WebMercatorTilingScheme } from "@cesium/engine";
import { addProtocol, removeProtocol } from "maplibre-gl";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import {
  autoRange,
  cogRenderBands,
  cogRenderOptions,
  cogRenderSignature,
  cogSourceUrl,
  createCogImageryProvider,
  type CogTilerModule,
} from "../packages/map/src/cesium-cog-imagery";
import {
  expandTileTemplate,
  hasRegisteredProtocol,
  ProtocolImageryProvider,
  protocolScheme,
  requestProtocolTile,
  type DecodedTile,
} from "../packages/map/src/cesium-protocol-imagery";

// The protocol-bridged imagery provider (issue #2283). Cesium's tiling scheme,
// rectangle, credit, and event classes are the real ones; the tile bytes come
// from injected loaders (or from a real `addProtocol` handler, for the
// registry path), and decoding is injected because Node has no
// `createImageBitmap`.

const Cesium = {
  WebMercatorTilingScheme,
  Event,
  Credit,
  Rectangle,
} as unknown as typeof import("@cesium/engine");

/** A stand-in for a decoded tile; only its identity matters here. */
function fakeTile(label: string): DecodedTile {
  return { label } as unknown as DecodedTile;
}

describe("expandTileTemplate", () => {
  it("fills z/x/y like MapLibre", () => {
    assert.equal(
      expandTileTemplate("geolibre-mbtiles://tile/{z}/{x}/{y}?path=%2Fa.mbtiles", 3, 5, 2),
      "geolibre-mbtiles://tile/3/5/2?path=%2Fa.mbtiles",
    );
  });

  it("flips y for a TMS template and fills {-y}", () => {
    assert.equal(expandTileTemplate("t://{z}/{x}/{y}", 3, 5, 2, "tms"), "t://3/5/5");
    assert.equal(expandTileTemplate("t://{z}/{x}/{-y}", 3, 5, 2), "t://3/5/5");
  });

  it("fills quadkey and the EPSG:3857 bbox", () => {
    // Bing quadkey for (x 5, y 2) at level 3: 1 (x bit), 2 (y bit), 1 (x bit).
    assert.equal(expandTileTemplate("t://{quadkey}", 3, 5, 2), "t://121");
    const bbox = expandTileTemplate("t://{bbox-epsg-3857}", 1, 1, 0)
      .slice(4)
      .split(",")
      .map(Number);
    assert.ok(Math.abs(bbox[0]) < 1e-6, "west edge at the meridian");
    assert.ok(Math.abs(bbox[1]) < 1e-6, "south edge at the equator");
    assert.ok(bbox[2] > 20037508 && bbox[3] > 20037508);
  });
});

describe("protocolScheme", () => {
  it("names a custom scheme and ignores the ones Cesium fetches itself", () => {
    assert.equal(protocolScheme("geolibre-xyz://https%3A%2F%2Fx/{z}/{x}/{y}"), "geolibre-xyz");
    assert.equal(protocolScheme("pmtiles://https://a/b.pmtiles/{z}/{x}/{y}"), "pmtiles");
    assert.equal(protocolScheme("https://tiles.example/{z}/{x}/{y}.png"), null);
    assert.equal(protocolScheme("http://localhost/{z}/{x}/{y}.png"), null);
    assert.equal(protocolScheme("blob:http://localhost/abc"), null);
    assert.equal(protocolScheme("/relative/{z}/{x}/{y}.png"), null);
  });
});

describe("requestProtocolTile", () => {
  afterEach(() => removeProtocol("test-bridge"));

  it("routes through the MapLibre registry and reports an empty response as null", async () => {
    const seen: string[] = [];
    addProtocol("test-bridge", async (params) => {
      seen.push(params.url);
      return {
        data: params.url.endsWith("/0/0/0") ? new Uint8Array([1, 2, 3]) : new ArrayBuffer(0),
      };
    });
    assert.equal(hasRegisteredProtocol("test-bridge"), true);
    const bytes = await requestProtocolTile("test-bridge://a/0/0/0", new AbortController().signal);
    assert.deepEqual(Array.from(new Uint8Array(bytes as ArrayBuffer)), [1, 2, 3]);
    assert.equal(
      await requestProtocolTile("test-bridge://a/1/0/0", new AbortController().signal),
      null,
    );
    assert.deepEqual(seen, ["test-bridge://a/0/0/0", "test-bridge://a/1/0/0"]);
  });

  it("refuses an unregistered scheme loudly", async () => {
    assert.equal(hasRegisteredProtocol("nope"), false);
    await assert.rejects(
      requestProtocolTile("nope://a/0/0/0", new AbortController().signal),
      /no MapLibre protocol handler/,
    );
  });
});

describe("ProtocolImageryProvider", () => {
  it("describes a Web Mercator tile set with the given bounds and credit", () => {
    const rectangle = Rectangle.fromDegrees(-10, -5, 20, 15);
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "t://{z}/{x}/{y}",
      rectangle,
      minimumLevel: 2,
      maximumLevel: 9,
      credit: "Test tiles",
    });
    assert.ok(provider.tilingScheme instanceof WebMercatorTilingScheme);
    assert.equal(provider.rectangle, rectangle);
    assert.equal(provider.minimumLevel, 2);
    assert.equal(provider.maximumLevel, 9);
    assert.equal(provider.tileWidth, 256);
    assert.equal(provider.hasAlphaChannel, true);
    assert.equal(provider.credit.html, "Test tiles");
    assert.equal(provider.tileUrl(3, 2, 5), "t://5/3/2");
  });

  it("loads, decodes, and draws an empty tile transparently", async () => {
    const decoded: string[] = [];
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "t://{z}/{x}/{y}",
      loadTile: async (url) => (url === "t://1/0/0" ? new Uint8Array([9]) : null),
      decodeTile: async (bytes) => {
        decoded.push(String((bytes as Uint8Array)[0]));
        return fakeTile("decoded");
      },
      emptyTile: () => fakeTile("blank"),
    });
    const tile = await provider.requestImage(0, 0, 1);
    assert.deepEqual(tile, fakeTile("decoded"));
    assert.deepEqual(decoded, ["9"]);
    const empty = await provider.requestImage(1, 1, 1);
    assert.deepEqual(empty, fakeTile("blank"), "an empty response is a transparent tile");
  });

  it("applies back-pressure past the concurrency cap and recovers", async () => {
    let release: (() => void) | null = null;
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "t://{z}/{x}/{y}",
      maxConcurrentRequests: 1,
      loadTile: () =>
        new Promise((resolve) => {
          release = () => resolve(new Uint8Array([1]));
        }),
      decodeTile: async () => fakeTile("ok"),
    });
    const first = provider.requestImage(0, 0, 0);
    assert.ok(first, "the first request is accepted");
    assert.equal(provider.requestImage(1, 0, 1), undefined, "the second is deferred");
    release!();
    assert.deepEqual(await first, fakeTile("ok"));
    assert.ok(provider.requestImage(1, 0, 1), "accepted again once the slot frees");
  });

  it("rejects in-flight tiles once destroyed", async () => {
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "t://{z}/{x}/{y}",
      loadTile: async () => new Uint8Array([1]),
      decodeTile: async () => fakeTile("late"),
    });
    const pending = provider.requestImage(0, 0, 0)!;
    provider.destroy();
    await assert.rejects(pending);
    assert.equal(provider.requestImage(0, 0, 0), undefined);
  });

  it("frees the slot when a loader throws synchronously", async () => {
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "t://{z}/{x}/{y}",
      maxConcurrentRequests: 1,
      // Not `async`, and the type does not require it: a throw here used to
      // escape before the finally that releases the slot was attached.
      loadImage: (() => {
        throw new Error("boom");
      }) as unknown as (url: string, signal: AbortSignal) => Promise<DecodedTile | null>,
    });
    await assert.rejects(provider.requestImage(0, 0, 0)!, /boom/);
    const second = provider.requestImage(0, 0, 0);
    assert.ok(second, "the slot is free again");
    await assert.rejects(second, /boom/);
  });

  it("uses a direct image loader when one is given", async () => {
    const provider = new ProtocolImageryProvider(Cesium, {
      template: "cog://layer/{z}/{x}/{y}",
      loadImage: async (url) => fakeTile(url),
    });
    assert.deepEqual(await provider.requestImage(2, 3, 4), fakeTile("cog://layer/4/2/3"));
  });
});

function cogLayer(patch: Partial<GeoLibreLayer> = {}, rasterState: unknown = {}): GeoLibreLayer {
  return {
    id: "cog-1",
    name: "COG",
    type: "cog",
    source: { type: "raster", url: "https://example.com/scene.tif" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "maplibre-gl-raster",
      externalNativeLayer: true,
      rasterState,
    },
    ...patch,
  };
}

describe("COG render options", () => {
  it("picks one band for a colormapped mode and three for RGB", () => {
    assert.deepEqual(cogRenderBands({ mode: "single", bands: [4, 3, 2] }), [4]);
    assert.deepEqual(cogRenderBands({ mode: "rgb", bands: [4, 3, 2, 1] }), [4, 3, 2]);
    assert.deepEqual(cogRenderBands({ mode: "rgb", bands: [] }), [1]);
  });

  it("takes the 2–98 percentile range, falling back to min/max", () => {
    assert.deepEqual(autoRange({ min: 0, max: 100, percentile_2: 5, percentile_98: 95 }), [5, 95]);
    assert.deepEqual(autoRange({ min: 0, max: 100 }), [0, 100]);
    assert.deepEqual(autoRange({ min: 7, max: 7 }), [7, 8], "a flat band still gets a span");
    assert.equal(autoRange(undefined), null);
  });

  it("mirrors the raster control's mapping of state onto tiler options", () => {
    const layer = cogLayer(
      {},
      {
        mode: "single",
        bands: [2],
        colormap: "viridis",
        reversed: true,
        stretch: "sqrt",
        gamma: 1.4,
        nodata: -9999,
      },
    );
    const options = cogRenderOptions(layer, { b2: { percentile_2: 10, percentile_98: 200 } });
    assert.deepEqual(options, {
      bidx: [2],
      stretch: "sqrt",
      gamma: 1.4,
      reversed: true,
      colormap: "viridis",
      rescale: [[10, 200]],
      nodata: -9999,
    });
  });

  it("keeps an explicit rescale, the GeoTIFF palette, and an RGB composite", () => {
    const explicit = cogRenderOptions(
      cogLayer({}, { mode: "rgb", bands: [1, 2, 3], rescale: [[0, 255]] }),
      null,
    );
    assert.deepEqual(explicit.rescale, [[0, 255]]);
    assert.deepEqual(explicit.bidx, [1, 2, 3]);
    assert.equal(explicit.colormap, undefined);
    const palette = cogRenderOptions(
      cogLayer({}, { mode: "index", bands: [1], colormap: "palette" }),
      null,
    );
    assert.equal(
      palette.colormap,
      undefined,
      "the GeoTIFF's own colour table is the tiler default",
    );
  });

  it("reads the remote URL or the session blob, and changes the signature with either", () => {
    assert.equal(cogSourceUrl(cogLayer()), "https://example.com/scene.tif");
    const local = cogLayer({ source: { type: "raster" } });
    local.metadata.localBytesUrl = "blob:http://localhost/abc";
    assert.equal(cogSourceUrl(local), "blob:http://localhost/abc");
    const pathOnly = cogLayer({ source: { type: "raster" } });
    pathOnly.metadata.localFilePath = "/data/scene.tif";
    assert.equal(cogSourceUrl(pathOnly), undefined, "a desktop path alone is not readable here");
    assert.notEqual(
      cogRenderSignature(cogLayer({}, { colormap: "viridis" })),
      cogRenderSignature(cogLayer({}, { colormap: "magma" })),
    );
  });

  // The tiler resolves an omitted nodata to the source's own declared value,
  // so "auto" is the omitted case and "off" has to be stated, or the globe
  // would mask pixels the 2D map draws.
  it("distinguishes the three nodata states the raster control persists", () => {
    const nodataFor = (state: unknown) => cogRenderOptions(cogLayer({}, state), null).nodata;
    assert.equal(nodataFor({ nodata: -9999 }), -9999);
    assert.equal(nodataFor({ nodata: "auto" }), undefined, "auto defers to the source");
    assert.ok(
      Number.isNaN(nodataFor({ nodata: "off" })),
      "off must say so: NaN is the tiler's no-masking sentinel",
    );
    assert.equal(nodataFor({}), undefined);
  });

  // bandCount arrives with the GeoTIFF header, after the layer is already in
  // the store, and it is what decides whether a short RGB state composites
  // [1, 2, 3] or falls back to one band.
  it("rebuilds when a late bandCount changes which bands composite", () => {
    const withBandCount = (bandCount: number | null) => {
      const layer = cogLayer({}, { mode: "rgb", bands: [] });
      layer.metadata.bandCount = bandCount;
      return layer;
    };
    assert.notEqual(cogRenderSignature(withBandCount(null)), cogRenderSignature(withBandCount(3)));
    assert.deepEqual(cogRenderOptions(withBandCount(null), null).bidx, [1]);
    assert.deepEqual(cogRenderOptions(withBandCount(3), null).bidx, [1, 2, 3]);
    // A bandCount that changes nothing about the composite must not churn.
    assert.equal(cogRenderSignature(withBandCount(3)), cogRenderSignature(withBandCount(4)));
  });
});

describe("createCogImageryProvider", () => {
  it("opens the source, resolves an automatic stretch, and renders tiles on demand", async () => {
    const renders: Array<[number, number, number, unknown]> = [];
    const tiler: CogTilerModule = {
      openCog: async (source) => {
        assert.equal(source, "https://example.com/scene.tif");
        return {
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({ b1: { percentile_2: 20, percentile_98: 220 } }),
          renderTileRGBA: async (z: number, x: number, y: number, opts: unknown) => {
            renders.push([z, x, y, opts]);
            return new Uint8Array(256 * 256 * 4).fill(z === 0 ? 0 : 255);
          },
        } as never;
      },
    };
    const provider = await createCogImageryProvider(
      Cesium,
      tiler,
      cogLayer({}, { mode: "single", bands: [1], colormap: "gray" }),
      async (rgba, size) => fakeTile(`${size}:${rgba[0]}`),
    );
    assert.equal(provider.template, "cog://cog-1/{z}/{x}/{y}");
    assert.ok(provider.rectangle.west < provider.rectangle.east, "bounded to the COG footprint");
    assert.ok(Math.abs(Rectangle.computeWidth(provider.rectangle) - (0.1 * Math.PI) / 180) < 1e-6);
    const tile = await provider.requestImage(3, 5, 12);
    assert.deepEqual(tile, fakeTile("256:255"));
    assert.deepEqual(renders[0], [12, 3, 5, { bidx: [1], colormap: "gray", rescale: [[20, 220]] }]);
  });

  it("discards a tile whose render outlived the provider without decoding it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let decoded = 0;
    const tiler: CogTilerModule = {
      openCog: async () =>
        ({
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({}),
          renderTileRGBA: async () => {
            // cog-tiler-wasm 0.3.5 cannot be interrupted, so the render runs
            // to completion; the provider must drop the result afterwards.
            await gate;
            return new Uint8Array(256 * 256 * 4).fill(255);
          },
        }) as never,
    };
    const provider = await createCogImageryProvider(
      Cesium,
      tiler,
      cogLayer({}, { mode: "single", bands: [1], colormap: "gray", rescale: [[0, 1]] }),
      async (rgba, size) => {
        decoded++;
        return fakeTile(`${size}:${rgba[0]}`);
      },
    );
    const pending = provider.requestImage(0, 0, 1) as Promise<unknown>;
    provider.destroy();
    release();
    await assert.rejects(pending);
    assert.equal(decoded, 0, "the abandoned render is not decoded into a bitmap");
  });

  it("parses tile coordinates whatever the layer id contains", async () => {
    const renders: number[][] = [];
    const tiler: CogTilerModule = {
      openCog: async () =>
        ({
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({}),
          renderTileRGBA: async (z: number, x: number, y: number) => {
            renders.push([z, x, y]);
            return new Uint8Array(256 * 256 * 4).fill(255);
          },
        }) as never,
    };
    const provider = await createCogImageryProvider(
      Cesium,
      tiler,
      cogLayer(
        { id: "group/cog:1" },
        { mode: "single", bands: [1], colormap: "gray", rescale: [[0, 1]] },
      ),
      async (rgba, size) => fakeTile(`${size}:${rgba[0]}`),
    );
    await provider.requestImage(3, 5, 12);
    assert.deepEqual(renders, [[12, 3, 5]]);
  });

  it("refuses a layer with nothing readable", async () => {
    const tiler: CogTilerModule = { openCog: async () => ({}) as never };
    await assert.rejects(
      createCogImageryProvider(Cesium, tiler, cogLayer({ source: { type: "raster" } })),
      /no readable source/,
    );
  });
});

// ---------------------------------------------------------------------------
// CesiumLayerSync routing: which layers reach the bridge, and what it is told.
// ---------------------------------------------------------------------------

import { addProtocol as registerProtocol, removeProtocol as unregisterProtocol } from "maplibre-gl";
import {
  CesiumLayerSync,
  imageryColorAdjustments,
  isCesiumSupportedLayerType,
} from "../packages/map/src/cesium-layer-sync";

/** A viewer whose imagery collection records what was added and removed. */
function makeViewer() {
  const added: Array<{
    imageryProvider: unknown;
    show: boolean;
    alpha: number;
    ready: boolean;
    brightness?: number;
    contrast?: number;
    saturation?: number;
    hue?: number;
  }> = [];
  const removed: unknown[] = [];
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {},
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: { add: () => {}, remove: () => {} },
      requestRender: () => {},
    },
    imageryLayers: {
      addImageryProvider: (imageryProvider: unknown) => {
        const layer = { imageryProvider, show: true, alpha: 1, ready: true };
        added.push(layer);
        return layer;
      },
      remove: (layer: unknown) => removed.push(layer),
      raiseToTop: () => {},
    },
    dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
  };
  return { viewer: viewer as never, added, removed };
}

const RoutingCesium = {
  ...Cesium,
  UrlTemplateImageryProvider: class {
    constructor(public options: Record<string, unknown>) {}
  },
  WebMapServiceImageryProvider: class {
    constructor(public options: Record<string, unknown>) {}
  },
} as unknown as typeof import("@cesium/engine");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rasterLayer(patch: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "r",
    name: "Raster",
    type: "raster",
    source: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

describe("isCesiumSupportedLayerType with the bridge", () => {
  it("accepts COGs and raster archives, and vector archives now that they are draped", () => {
    assert.equal(isCesiumSupportedLayerType(cogLayer()), true);
    assert.equal(
      isCesiumSupportedLayerType(
        rasterLayer({
          type: "mbtiles",
          metadata: { tileType: "raster" },
          source: { type: "raster", tiles: ["geolibre-mbtiles://tile/{z}/{x}/{y}?path=a"] },
        }),
      ),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(
        rasterLayer({
          type: "pmtiles",
          metadata: { tileType: "raster" },
          source: { type: "raster", url: "pmtiles://https://a/b.pmtiles" },
        }),
      ),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(
        rasterLayer({
          type: "pmtiles",
          metadata: { tileType: "vector" },
          source: { type: "vector", url: "pmtiles://https://a/b.pmtiles" },
        }),
      ),
      true,
      "vector archives go through the MapLibre drape (issue #2284)",
    );
  });
});

// Models of the two shaders' luminance paths, transcribed from
// maplibre-gl's raster.fragment.glsl and Cesium's sampleAndBlend. The point of
// imageryColorAdjustments is that these two agree, so the tests below compare
// them directly rather than pinning the intermediate factors.
function mapLibreLuma(input: number, min: number, max: number, contrast: number): number {
  // 1 / (1 - contrast) is +Infinity at contrast 1; the same floor the source
  // applies keeps this model comparable at that stop.
  const k = contrast > 0 ? 1 / Math.max(1e-4, 1 - contrast) : 1 + contrast;
  const contrasted = (input - 0.5) * k + 0.5;
  return min + contrasted * (max - min); // mix(min, max, rgb)
}

function cesiumLuma(input: number, brightness: number, contrast: number): number {
  const brightened = input * brightness; // mix(vec3(0.0), color, b)
  return 0.5 + (brightened - 0.5) * contrast; // mix(vec3(0.5), color, k)
}

const SAMPLE_INTENSITIES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

describe("imageryColorAdjustments", () => {
  it("is neutral for the default raster symbology", () => {
    assert.deepEqual(imageryColorAdjustments(DEFAULT_LAYER_STYLE), {
      brightness: 1,
      contrast: 1,
      saturation: 1,
      hue: 0,
    });
  });

  it("converts the hue rotation to radians", () => {
    const adjusted = imageryColorAdjustments({ ...DEFAULT_LAYER_STYLE, rasterHueRotate: 90 });
    assert.ok(Math.abs(adjusted.hue - Math.PI / 2) < 1e-9);
  });

  // MapLibre's saturation and contrast curves both bend above 0, so the globe
  // would read flatter than the 2D map if either were mapped as `1 + value`.
  it("mirrors MapLibre's saturation curve on both sides of neutral", () => {
    const saturationFor = (rasterSaturation: number) =>
      imageryColorAdjustments({ ...DEFAULT_LAYER_STYLE, rasterSaturation }).saturation;
    assert.equal(saturationFor(-0.5), 0.5);
    assert.equal(saturationFor(-1), 0);
    // MapLibre: rgb += (avg - rgb) * (1 - 1 / (1.001 - s)), so the multiplier
    // about the pivot is 1 / (1.001 - s), not 1 + s.
    assert.ok(Math.abs(saturationFor(0.5) - 1 / 0.501) < 1e-9);
    assert.ok(Math.abs(saturationFor(0.25) - 1 / 0.751) < 1e-9);
  });

  // Every reachable combination should land on MapLibre's own output exactly:
  // the brightness window is an affine remap, and Cesium's brightness and
  // contrast compose into one, so they are solved for as a pair.
  for (const [name, min, max, contrast] of [
    ["a darkened window", 0, 0.5, 0],
    ["a narrowed window (a flatten, not a boost)", 0.2, 0.8, 0],
    ["a lifted black point", 0.4, 1, 0],
    ["positive contrast alone", 0, 1, 0.5],
    ["negative contrast alone", 0, 1, -0.4],
    ["a window and positive contrast together", 0.2, 0.9, 0.25],
    // The slider's own stops. Contrast 1 puts MapLibre's 1 / (1 - contrast) at
    // Infinity, which used to reach Cesium as brightness NaN.
    ["contrast pinned to the top of the slider", 0, 1, 1],
    ["contrast pinned to the bottom of the slider", 0, 1, -1],
    ["a zero-width window", 0.3, 0.3, 0],
  ] as const) {
    it(`reproduces MapLibre's raster output for ${name}`, () => {
      const adjusted = imageryColorAdjustments({
        ...DEFAULT_LAYER_STYLE,
        rasterBrightnessMin: min,
        rasterBrightnessMax: max,
        rasterContrast: contrast,
      });
      assert.ok(
        Number.isFinite(adjusted.brightness) && Number.isFinite(adjusted.contrast),
        "both factors reach Cesium as finite shader uniforms",
      );
      for (const input of SAMPLE_INTENSITIES) {
        assert.ok(
          Math.abs(
            mapLibreLuma(input, min, max, contrast) -
              cesiumLuma(input, adjusted.brightness, adjusted.contrast),
          ) < 1e-9,
          `intensity ${input} diverged`,
        );
      }
    });
  }

  // A black point at or above mid-grey is the one shape Cesium's
  // brightness/contrast pair cannot express. The contrast floor keeps the
  // stretch exact there and lets only the lift drift.
  it("keeps the stretch exact when the black point is too high for Cesium", () => {
    const [min, max] = [0.6, 1];
    const adjusted = imageryColorAdjustments({
      ...DEFAULT_LAYER_STYLE,
      rasterBrightnessMin: min,
      rasterBrightnessMax: max,
    });
    const slopeOf = (f: (input: number) => number) => f(1) - f(0);
    assert.ok(
      Math.abs(
        slopeOf((input) => mapLibreLuma(input, min, max, 0)) -
          slopeOf((input) => cesiumLuma(input, adjusted.brightness, adjusted.contrast)),
      ) < 1e-9,
    );
    assert.ok(adjusted.contrast > 0, "contrast must not collapse to flat grey");
  });
});

describe("CesiumLayerSync raster bridge routing", () => {
  afterEach(() => unregisterProtocol("geolibre-test-mbtiles"));

  it("retries the tiler import after a failed load instead of caching the rejection", async () => {
    const { viewer, added } = makeViewer();
    const tiler: CogTilerModule = {
      openCog: async () =>
        ({
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({}),
          renderTileRGBA: async () => new Uint8Array(256 * 256 * 4),
        }) as never,
    };
    let loads = 0;
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      loadCogTiler: () =>
        ++loads === 1 ? Promise.reject(new Error("chunk failed")) : Promise.resolve(tiler),
    });
    sync.sync([cogLayer()]);
    await flush();
    await flush();
    assert.equal(added.length, 0);
    assert.match(sync.getRenderStatus().errors[0] ?? "", /chunk failed/);
    // A second COG (or the same one re-added) loads the module afresh.
    sync.sync([]);
    sync.sync([cogLayer({ id: "cog-2" })]);
    await flush();
    await flush();
    assert.equal(loads, 2);
    assert.equal(added.length, 1);
    sync.destroy();
  });

  it("keeps a COG on the tiler even when a collection is attached to it", async () => {
    const { viewer, added } = makeViewer();
    const tiler: CogTilerModule = {
      openCog: async () =>
        ({
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({}),
          renderTileRGBA: async () => new Uint8Array(256 * 256 * 4),
        }) as never,
    };
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      loadCogTiler: () => Promise.resolve(tiler),
    });
    sync.sync([cogLayer({ geojson: { type: "FeatureCollection", features: [] } })]);
    await flush();
    await flush();
    assert.equal(added.length, 1, "a hand-authored geojson on a cog layer does not divert it");
    sync.destroy();
  });

  it("renders a COG through the tiler and applies the raster symbology", async () => {
    const { viewer, added } = makeViewer();
    const tiler: CogTilerModule = {
      openCog: async () =>
        ({
          boundsLonLat: [-122.3, 37.8, -122.2, 37.9],
          statistics: async () => ({}),
          renderTileRGBA: async () => new Uint8Array(256 * 256 * 4),
        }) as never,
    };
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      loadCogTiler: () => Promise.resolve(tiler),
    });
    const layer = cogLayer({ style: { ...DEFAULT_LAYER_STYLE, rasterSaturation: 0.5 } });
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(added.length, 1);
    assert.ok(added[0].imageryProvider instanceof ProtocolImageryProvider);
    assert.equal(
      (added[0].imageryProvider as ProtocolImageryProvider).template,
      "cog://cog-1/{z}/{x}/{y}",
    );
    // MapLibre's own factor for rasterSaturation 0.5; the curve itself is
    // covered by the imageryColorAdjustments suite.
    assert.ok(Math.abs(added[0].saturation - 1 / 0.501) < 1e-9);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    // A symbology change (colormap) rebuilds; an opacity change restyles in place.
    const recoloured = {
      ...layer,
      metadata: {
        ...layer.metadata,
        rasterState: { mode: "single", bands: [1], colormap: "magma" },
      },
    };
    sync.sync([recoloured]);
    await flush();
    await flush();
    assert.equal(added.length, 2, "a render-state change rebuilds the provider");
    sync.sync([{ ...recoloured, opacity: 0.4 }]);
    assert.equal(added.length, 2);
    assert.equal(added[1].alpha, 0.4);
    sync.destroy();
  });

  it("renders a raster PMTiles archive bounded by its header", async () => {
    const { viewer, added } = makeViewer();
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      readPMTilesHeader: async (url) => {
        assert.equal(url, "pmtiles://https://a/b.pmtiles");
        return { minZoom: 2, maxZoom: 9, minLon: -10, minLat: -5, maxLon: 20, maxLat: 15 };
      },
    });
    sync.sync([
      rasterLayer({
        type: "pmtiles",
        metadata: { tileType: "raster", sourceKind: "pmtiles-url" },
        source: { type: "raster", url: "pmtiles://https://a/b.pmtiles", attribution: "Demo" },
      }),
    ]);
    await flush();
    await flush();
    assert.equal(added.length, 1);
    const provider = added[0].imageryProvider as ProtocolImageryProvider;
    assert.ok(provider instanceof ProtocolImageryProvider);
    assert.equal(provider.template, "pmtiles://https://a/b.pmtiles/{z}/{x}/{y}");
    assert.equal(provider.minimumLevel, 2);
    assert.equal(provider.maximumLevel, 9);
    assert.equal(provider.credit.html, "Demo");
    assert.ok(Math.abs(Rectangle.computeWidth(provider.rectangle) - (30 * Math.PI) / 180) < 1e-9);
    sync.destroy();
  });

  it("bridges a registered custom-protocol template and refuses an unregistered one", async () => {
    registerProtocol("geolibre-test-mbtiles", async () => ({ data: new ArrayBuffer(0) }));
    const { viewer, added, removed } = makeViewer();
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10);
    const mbtiles = rasterLayer({
      id: "m",
      type: "mbtiles",
      metadata: { tileType: "raster" },
      source: {
        type: "raster",
        tiles: ["geolibre-test-mbtiles://tile/{z}/{x}/{y}?path=a"],
        minzoom: 3,
        maxzoom: 12,
        scheme: "tms",
      },
    });
    const orphan = rasterLayer({
      id: "o",
      name: "Orphan",
      source: { type: "raster", tiles: ["geolibre-unregistered://tile/{z}/{x}/{y}"] },
    });
    const plain = rasterLayer({ id: "p" });
    sync.sync([mbtiles, orphan, plain]);
    await flush();
    await flush();
    const providers = added.map((l) => l.imageryProvider);
    assert.equal(providers.length, 2, "the orphan adds nothing");
    const bridged = providers.find(
      (p) => p instanceof ProtocolImageryProvider,
    ) as ProtocolImageryProvider;
    assert.ok(bridged, "the MBTiles template goes through the bridge");
    assert.equal(bridged.minimumLevel, 3);
    assert.equal(bridged.maximumLevel, 12);
    assert.equal(
      bridged.tileUrl(1, 0, 2),
      "geolibre-test-mbtiles://tile/2/1/3?path=a",
      "TMS flips y",
    );
    assert.ok(
      providers.some((p) => !(p instanceof ProtocolImageryProvider)),
      "an https template still uses Cesium's own provider",
    );
    const status = sync.getRenderStatus();
    assert.deepEqual(status.pending, []);
    assert.equal(status.errors.length, 1);
    assert.match(
      status.errors[0],
      /Orphan: no MapLibre protocol handler registered for "geolibre-unregistered:\/\/"/,
    );
    // Removing the layer stops the bridged provider's in-flight requests.
    sync.sync([orphan, plain]);
    assert.equal(removed.length, 1);
    assert.equal(bridged.requestImage(0, 0, 0), undefined, "destroyed providers accept nothing");
    sync.destroy();
  });
});

describe("review follow-ups", () => {
  it("clamps bounds to the Web Mercator tiling scheme", async () => {
    const { webMercatorRectangle } = await import("../packages/map/src/cesium-protocol-imagery");
    const rect = webMercatorRectangle(Cesium, [-200, -89, 200, 89]);
    assert.ok(Math.abs(rect.west + Math.PI) < 1e-9);
    assert.ok(Math.abs(rect.east - Math.PI) < 1e-9);
    assert.ok(rect.north < (85.1 * Math.PI) / 180 && rect.north > (85 * Math.PI) / 180);
  });

  it("falls back to an RGB composite only when the source has three bands", () => {
    assert.deepEqual(cogRenderBands({ mode: "rgb", bands: [] }, 4), [1, 2, 3]);
    assert.deepEqual(cogRenderBands({ mode: "rgb", bands: [] }, 1), [1]);
    assert.deepEqual(cogRenderBands({ mode: "rgb", bands: [2] }, null), [2]);
  });

  it("opens each COG once across rebuilds and forgets it with its last layer", async () => {
    let opens = 0;
    // The raw module: the sync wraps it in its own cache.
    const tiler: CogTilerModule = {
      openCog: async () => {
        opens++;
        return {
          boundsLonLat: [0, 0, 1, 1],
          statistics: async () => ({}),
          renderTileRGBA: async () => new Uint8Array(256 * 256 * 4),
        } as never;
      },
    };
    const { viewer, added } = makeViewer();
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      loadCogTiler: () => Promise.resolve(tiler),
    });
    const layer = cogLayer({}, { mode: "single", bands: [1], colormap: "gray" });
    sync.sync([layer]);
    await flush();
    await flush();
    sync.sync([
      {
        ...layer,
        metadata: {
          ...layer.metadata,
          rasterState: { mode: "single", bands: [1], colormap: "magma" },
        },
      },
    ]);
    await flush();
    await flush();
    assert.equal(added.length, 2, "the symbology edit rebuilt the provider");
    assert.equal(opens, 1, "but reused the opened source");
    sync.sync([]);
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(opens, 2, "removing the last layer forgets the source");
    // A source swap under the same id forgets the old URL as it rebuilds.
    sync.sync([{ ...layer, source: { ...layer.source, url: "https://example.com/other.tif" } }]);
    await flush();
    await flush();
    assert.equal(opens, 3, "the new URL is opened");
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(opens, 4, "the old URL was forgotten by the swap, so it is reopened");
    // Turning the layer into another imagery kind with the same URL forgets it too.
    sync.sync([{ ...layer, type: "xyz", metadata: { ...layer.metadata, sourceKind: "xyz-url" } }]);
    await flush();
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(opens, 5, "a type transition releases the source");
    sync.destroy();
  });

  it("bridges a WMS layer the desktop routed through its native fetcher", async () => {
    registerProtocol("geolibre-test-wms", async () => ({ data: new ArrayBuffer(0) }));
    try {
      const { viewer, added } = makeViewer();
      const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10);
      // What routeWmsLayerThroughNativeProtocol produces on desktop: the tiles
      // are rewritten to the custom protocol, while source.url keeps the plain
      // endpoint buildWmsLayer recorded.
      const routed = rasterLayer({
        id: "wms-native",
        type: "wms",
        source: {
          type: "raster",
          tiles: ["geolibre-test-wms://https%3A%2F%2Fwms.example%2Fows?bbox={bbox-epsg-3857}"],
          url: "https://wms.example/ows",
          layers: "topo",
        },
      });
      // The browser build, where the tiles are a plain https template.
      const direct = rasterLayer({
        id: "wms-web",
        type: "wms",
        source: {
          type: "raster",
          tiles: ["https://wms.example/ows?bbox={bbox-epsg-3857}"],
          url: "https://wms.example/ows",
          layers: "topo",
        },
      });
      sync.sync([routed, direct]);
      await flush();
      await flush();

      assert.deepEqual(sync.getRenderStatus().errors, []);
      assert.equal(added.length, 2);
      const bridged = added[0].imageryProvider as ProtocolImageryProvider;
      assert.ok(
        bridged instanceof ProtocolImageryProvider,
        "the native template must not be fetched straight from the webview",
      );
      assert.match(bridged.tileUrl(1, 0, 2), /^geolibre-test-wms:\/\//);
      assert.ok(
        !(added[1].imageryProvider instanceof ProtocolImageryProvider),
        "a plain endpoint still uses Cesium's own WMS provider",
      );
      sync.destroy();
    } finally {
      unregisterProtocol("geolibre-test-wms");
    }
  });

  it("forgets a COG removed while its tiler import was still in flight", async () => {
    let opens = 0;
    const tiler: CogTilerModule = {
      openCog: async () => {
        opens++;
        return {
          boundsLonLat: [0, 0, 1, 1],
          statistics: async () => ({}),
          renderTileRGBA: async () => new Uint8Array(256 * 256 * 4),
        } as never;
      },
    };
    // The tiler import is multiple megabytes in production, so a layer can come
    // and go before it lands, and the removal's forgetCogSource then runs
    // against a cache this URL has not reached yet. Pins the outcome rather
    // than the mechanism: whichever of the deferred forget and the open wins,
    // the source must not stay cached behind a layer that is gone.
    let landTiler: (() => void) | null = null;
    const { viewer } = makeViewer();
    const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10, {
      loadCogTiler: () =>
        new Promise((resolve) => {
          landTiler = () => resolve(tiler);
        }),
    });
    const layer = cogLayer({}, { mode: "single", bands: [1], colormap: "gray" });
    sync.sync([layer]);
    await flush();
    sync.sync([]); // removed before the import resolves
    await flush();
    landTiler!();
    await flush();
    await flush();

    // Whatever the open did behind the removal must not stay cached: adding the
    // same URL again has to reopen it.
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(opens, 2, "the cancelled open was forgotten, so the URL reopens");
    sync.destroy();
  });

  it("rebuilds a bridged template when its Y-axis scheme flips", async () => {
    registerProtocol("geolibre-test-mbtiles", async () => ({ data: new ArrayBuffer(0) }));
    try {
      const { viewer, added } = makeViewer();
      const sync = new CesiumLayerSync(RoutingCesium, viewer, () => 10);
      const layer = rasterLayer({
        type: "mbtiles",
        metadata: { tileType: "raster" },
        source: { type: "raster", tiles: ["geolibre-test-mbtiles://tile/{z}/{x}/{y}?path=a"] },
      });
      sync.sync([layer]);
      await flush();
      sync.sync([{ ...layer, source: { ...layer.source, scheme: "tms" } }]);
      await flush();
      assert.equal(added.length, 2);
      assert.equal(
        (added[1].imageryProvider as ProtocolImageryProvider).tileUrl(1, 0, 2),
        "geolibre-test-mbtiles://tile/2/1/3?path=a",
      );
      // A 512 px source keeps its tile size, so level selection matches the 2D map.
      sync.sync([{ ...layer, source: { ...layer.source, scheme: "tms", tileSize: 512 } }]);
      await flush();
      assert.equal(
        (added[added.length - 1].imageryProvider as ProtocolImageryProvider).tileWidth,
        512,
      );
      // The coverage rectangle bakes in too: new bounds rebuild, same bounds do not.
      const bounded = {
        ...layer,
        source: { ...layer.source, scheme: "tms", bounds: [-10, -5, 10, 5] },
      };
      sync.sync([bounded]);
      await flush();
      assert.equal(added.length, 4);
      assert.ok((added[3].imageryProvider as ProtocolImageryProvider).rectangle);
      sync.sync([{ ...bounded, source: { ...bounded.source, bounds: [-10, -5, 10, 5] } }]);
      await flush();
      assert.equal(added.length, 4, "equal bounds are not a rebuild");
      sync.destroy();
    } finally {
      unregisterProtocol("geolibre-test-mbtiles");
    }
  });
});
