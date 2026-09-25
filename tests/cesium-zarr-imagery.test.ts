import assert from "node:assert/strict";
import { Color, Credit, Event, Rectangle, WebMercatorTilingScheme } from "@cesium/engine";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync } from "../packages/map/src/cesium-layer-sync";
import {
  applyZarrRender,
  createZarrImageryProvider,
  isZarrImageryProvider,
  zarrGlobeColors,
  zarrGlobeCrs,
  zarrGlobeScale,
  zarrGlobeSelectors,
  zarrOpenSignature,
  zarrRenderSignature,
  ZARR_DIMENSION_ALIASES,
  type ZarrCesiumModule,
} from "../packages/map/src/cesium-zarr-imagery";
import { registerZarrHeaders } from "../packages/map/src/zarr-source";

// Zarr layers on the globe (opengeos/GeoLibre#2261). zarr-cesium itself needs
// WebGL and a real store, so the provider is a stand-in that records what it
// was built and updated with; one test constructs the real class to pin the
// renderer internals the colour injection writes to.

const Cesium = {
  Color,
  Credit,
  Event,
  Rectangle,
  WebMercatorTilingScheme,
  ImageryLayer: class {
    show = true;
    alpha = 1;
    ready = true;
    constructor(public imageryProvider: unknown) {}
  },
} as unknown as typeof import("@cesium/engine");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function zarrLayer(patch: Partial<GeoLibreLayer["source"]> = {}, id = "z1"): GeoLibreLayer {
  return {
    id,
    name: "SST",
    type: "zarr",
    source: {
      type: "raster",
      url: "https://data.example/sst.zarr",
      variable: "sst",
      clim: [-2, 32],
      colormap: ["#000000", "#ffffff"],
      selector: { time: 3 },
      ...patch,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: { sourceKind: "zarr-url", externalNativeLayer: true },
  };
}

/** A zarr-cesium stand-in recording construction, updates, and teardown. */
function fakeZarrCesium(ready = true) {
  const built: FakeProvider[] = [];
  class FakeProvider {
    selectors: Record<string, unknown>;
    scale: [number, number] | undefined;
    destroyed = false;
    readonly source = {
      colorScale: { colors: [] as unknown },
      uploads: 0,
      updateColormapTexture() {
        this.uploads += 1;
      },
    };
    readonly readyPromise = Promise.resolve(ready);
    constructor(public options: Record<string, unknown>) {
      this.selectors = { ...(options.selectors as Record<string, unknown>) };
      this.scale = options.scale as [number, number] | undefined;
      built.push(this);
    }
    updateSelectors(next: Record<string, unknown>): boolean {
      let changed = false;
      for (const [key, value] of Object.entries(next)) {
        if (JSON.stringify(this.selectors[key]) !== JSON.stringify(value)) {
          this.selectors[key] = value;
          changed = true;
        }
      }
      return changed;
    }
    updateStyle({ scale }: { scale?: [number, number] }): boolean {
      if (!scale || JSON.stringify(scale) === JSON.stringify(this.scale)) return false;
      this.scale = scale;
      return true;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const module = { ZarrLayerProvider: FakeProvider } as unknown as ZarrCesiumModule;
  return { module, built };
}

/** A viewer whose imagery collection keeps a real stack, for the in-place swap. */
function makeViewer() {
  const stack: Array<{ imageryProvider: unknown; show: boolean; alpha: number; ready: boolean }> =
    [];
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
      addImageryProvider(imageryProvider: unknown) {
        const layer = { imageryProvider, show: true, alpha: 1, ready: true };
        stack.push(layer);
        return layer;
      },
      add(layer: (typeof stack)[number], index?: number) {
        if (index === undefined) stack.push(layer);
        else stack.splice(index, 0, layer);
      },
      indexOf: (layer: unknown) => stack.indexOf(layer as never),
      remove(layer: unknown) {
        const index = stack.indexOf(layer as never);
        if (index >= 0) stack.splice(index, 1);
        removed.push(layer);
        return true;
      },
      raiseToTop: () => {},
    },
    dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
  };
  return { viewer: viewer as never, stack, removed };
}

describe("zarr layer translation", () => {
  it("reads numbers as indices, strings as values, and passes explicit selectors", () => {
    assert.deepEqual(
      zarrGlobeSelectors({
        Time: 4,
        band: "prec",
        depth: { selected: 12.5, type: "value" },
        bad: null,
      }),
      {
        // Names zarr-cesium recognises are filed under its own keys.
        time: { selected: 4, type: "index" },
        band: { selected: "prec", type: "value" },
        elevation: { selected: 12.5, type: "value" },
      },
    );
  });

  it("falls back to [0, 1] for missing or inverted colour limits", () => {
    assert.deepEqual(zarrGlobeScale(zarrLayer({ clim: [5, 10] })), [5, 10]);
    assert.deepEqual(zarrGlobeScale(zarrLayer({ clim: [10, 5] })), [0, 1]);
    assert.deepEqual(zarrGlobeScale(zarrLayer({ clim: undefined })), [0, 1]);
  });

  it("accepts geographic and Web Mercator grids and refuses the rest", () => {
    assert.equal(zarrGlobeCrs(zarrLayer()), null);
    assert.equal(zarrGlobeCrs(zarrLayer({ crs: "EPSG:4326" })), "EPSG:4326");
    assert.equal(zarrGlobeCrs(zarrLayer({ crs: "3857" })), "EPSG:3857");
    assert.throws(() => zarrGlobeCrs(zarrLayer({ crs: "EPSG:32633" })), /EPSG:32633/);
    assert.throws(() => zarrGlobeCrs(zarrLayer({ proj4: "+proj=laea" })), /proj4/);
  });

  it("gives the ramp as unit floats, so a ramp opening on black is not misread as floats", () => {
    const colors = zarrGlobeColors(Cesium, zarrLayer({ colormap: ["#000000", "#ff8000"] }));
    assert.deepEqual(colors[0], [0, 0, 0]);
    assert.equal(colors[1][0], 1);
    assert.ok(Math.abs(colors[1][1] - 128 / 255) < 1e-6);
    // A named GeoLibre ramp is sampled; anything unusable falls back to viridis.
    assert.equal(zarrGlobeColors(Cesium, zarrLayer({ colormap: "magma" })).length, 256);
    assert.equal(zarrGlobeColors(Cesium, zarrLayer({ colormap: ["nope"] })).length, 256);
  });

  it("reopens only for what the store is opened with", () => {
    const base = zarrLayer();
    const stepped = zarrLayer({ selector: { time: 4 }, clim: [0, 30], colormap: ["#fff", "#000"] });
    assert.equal(zarrOpenSignature(base), zarrOpenSignature(stepped));
    assert.notEqual(zarrRenderSignature(base), zarrRenderSignature(stepped));
    assert.notEqual(zarrOpenSignature(base), zarrOpenSignature(zarrLayer({ variable: "anom" })));
    // A dimension zarr-cesium does not recognise is named at construction;
    // one it does (the first Time Slider step on an unselected layer) is not.
    assert.notEqual(
      zarrOpenSignature(base),
      zarrOpenSignature(zarrLayer({ selector: { time: 3, band: 0 } })),
    );
    assert.equal(zarrOpenSignature(zarrLayer({ selector: undefined })), zarrOpenSignature(base));
  });
});

describe("createZarrImageryProvider", () => {
  afterEach(() => registerZarrHeaders("z1", undefined));

  it("opens the store with the layer's selection, limits, ramp, and dimensions", async () => {
    const { module, built } = fakeZarrCesium();
    const provider = await createZarrImageryProvider(
      Cesium,
      module,
      zarrLayer({ spatialDimensions: { lat: "yc", lon: "xc" }, crs: "EPSG:4326" }),
    );
    assert.ok(isZarrImageryProvider(provider));
    const [fake] = built;
    assert.equal(fake.options.url, "https://data.example/sst.zarr");
    assert.equal(fake.options.variable, "sst");
    assert.equal(fake.options.crs, "EPSG:4326");
    assert.deepEqual(fake.options.scale, [-2, 32]);
    assert.deepEqual(fake.options.selectors, { time: { selected: 3, type: "index" } });
    assert.deepEqual(fake.options.dimensionNames, { lat: "yc", lon: "xc" });
    assert.equal(fake.options.requestOverrides, undefined);
    assert.deepEqual(fake.source.colorScale.colors, [
      [0, 0, 0],
      [1, 1, 1],
    ]);
    assert.equal(fake.source.uploads, 1);
  });

  it("sends session headers without following redirects, and only over HTTPS", async () => {
    const { module, built } = fakeZarrCesium();
    registerZarrHeaders("z1", { Authorization: "Bearer t" });
    await createZarrImageryProvider(Cesium, module, zarrLayer());
    assert.deepEqual(built[0].options.requestOverrides, {
      headers: { Authorization: "Bearer t" },
      redirect: "error",
    });
    await assert.rejects(
      createZarrImageryProvider(Cesium, module, zarrLayer({ url: "http://data.example/a.zarr" })),
    );
  });

  it("tears the provider down and reports when the store cannot be opened", async () => {
    const { module, built } = fakeZarrCesium(false);
    await assert.rejects(createZarrImageryProvider(Cesium, module, zarrLayer()), /"sst"/);
    assert.equal(built[0].destroyed, true);
  });

  it("applies only what changed to a live provider", async () => {
    const { module, built } = fakeZarrCesium();
    const layer = zarrLayer();
    const provider = await createZarrImageryProvider(Cesium, module, layer);
    const fake = built[0];
    assert.equal(applyZarrRender(Cesium, provider as never, layer, { ...layer }), false);
    const stepped = zarrLayer({ selector: { time: 4 } });
    assert.equal(applyZarrRender(Cesium, provider as never, layer, stepped), true);
    assert.deepEqual(fake.selectors.time, { selected: 4, type: "index" });
    assert.equal(fake.source.uploads, 1, "an unchanged ramp is not re-uploaded");
    // A dropped dimension returns to the default slice.
    const cleared = zarrLayer({ selector: {} });
    assert.equal(applyZarrRender(Cesium, provider as never, stepped, cleared), true);
    assert.deepEqual(fake.selectors.time, { selected: 0, type: "index" });
  });
});

describe("CesiumLayerSync with Zarr layers", () => {
  it("draws a Zarr layer and time-steps it without reopening the store", async () => {
    const { viewer, stack, removed } = makeViewer();
    const { module, built } = fakeZarrCesium();
    let loads = 0;
    const sync = new CesiumLayerSync(Cesium, viewer, () => 10, {
      loadZarrCesium: async () => {
        loads += 1;
        return module;
      },
    });
    const layer = zarrLayer();
    sync.sync([layer]);
    await flush();
    await flush();
    assert.equal(stack.length, 1);
    assert.equal(stack[0].imageryProvider, built[0]);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });

    // A Time Slider step swaps the imagery layer over the same provider.
    const first = stack[0];
    sync.sync([zarrLayer({ selector: { time: 4 } })]);
    assert.equal(built.length, 1, "the store is not reopened");
    assert.equal(stack.length, 1);
    assert.notEqual(stack[0], first);
    assert.equal(stack[0].imageryProvider, built[0]);
    assert.deepEqual(built[0].selectors.time, { selected: 4, type: "index" });
    assert.equal(built[0].destroyed, false);
    assert.ok(removed.includes(first));

    // Opacity alone restyles the live layer.
    const current = stack[0];
    sync.sync([{ ...zarrLayer({ selector: { time: 4 } }), opacity: 0.4 }]);
    assert.equal(stack[0], current);
    assert.equal(stack[0].alpha, 0.4);

    // A new variable reopens; removal destroys the provider.
    sync.sync([zarrLayer({ variable: "anom", selector: { time: 4 } })]);
    await flush();
    await flush();
    assert.equal(built.length, 2);
    assert.equal(built[0].destroyed, true);
    sync.sync([]);
    assert.equal(built[1].destroyed, true);
    assert.equal(stack.length, 0);
    assert.equal(loads, 1, "the module is imported once");
    sync.destroy();
  });

  it("applies a step taken while the store was still opening", async () => {
    const { viewer, stack } = makeViewer();
    const { module, built } = fakeZarrCesium();
    const sync = new CesiumLayerSync(Cesium, viewer, () => 10, {
      loadZarrCesium: async () => module,
    });
    sync.sync([zarrLayer()]);
    sync.sync([zarrLayer({ selector: { time: 7 } })]);
    await flush();
    await flush();
    assert.equal(stack.length, 1);
    assert.deepEqual(built[0].selectors.time, { selected: 7, type: "index" });
    sync.destroy();
  });

  it("reports a CRS the globe cannot place as a layer error", async () => {
    const { viewer, stack } = makeViewer();
    const { module } = fakeZarrCesium();
    const sync = new CesiumLayerSync(Cesium, viewer, () => 10, {
      loadZarrCesium: async () => module,
    });
    sync.sync([zarrLayer({ crs: "EPSG:32633" })]);
    await flush();
    await flush();
    assert.equal(stack.length, 0);
    assert.match(sync.getRenderStatus().errors[0] ?? "", /EPSG:32633/);
    sync.destroy();
  });
});

describe("zarr-cesium internals", () => {
  it("still recognises the dimension names the selector keys mirror", async () => {
    const { DIMENSION_ALIASES_DEFAULT } = await import("zarr-cesium");
    assert.deepEqual(DIMENSION_ALIASES_DEFAULT.time, ZARR_DIMENSION_ALIASES.time);
    assert.deepEqual(DIMENSION_ALIASES_DEFAULT.elevation, ZARR_DIMENSION_ALIASES.elevation);
  });

  it("still keeps the ramp where the colour injection writes it", async () => {
    // The injection targets members zarr-cesium does not type publicly (see
    // TileRendererInternals); a rename should fail here, not draw the default
    // ramp silently. The constructor wants a canvas, which Node lacks.
    const { ZarrLayerProvider } = await import("zarr-cesium");
    const globals = globalThis as { document?: unknown };
    globals.document = { createElement: () => ({ getContext: () => null }) };
    const quiet = console.error;
    console.error = () => {};
    try {
      const provider = new ZarrLayerProvider({
        store: { get: async () => undefined } as never,
        variable: "v",
      });
      const renderer = (provider as unknown as { source?: Record<string, unknown> }).source;
      assert.equal(typeof renderer?.colorScale, "object");
      assert.ok(Array.isArray((renderer?.colorScale as { colors?: unknown }).colors));
      assert.equal(typeof renderer?.updateColormapTexture, "function");
      assert.equal(await provider.readyPromise, false);
      provider.destroy();
    } finally {
      delete globals.document;
      console.error = quiet;
    }
  });
});
