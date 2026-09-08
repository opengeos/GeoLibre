import assert from "node:assert/strict";
import { Credit, Event, Rectangle, WebMercatorTilingScheme } from "@cesium/engine";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import {
  drapeSignature,
  isDrapedLayer,
  MapLibreDrape,
  isTransientDrapeError,
  observeDrapeErrors,
  tileCenter,
  type DrapeHost,
  type DrapeMap,
} from "../packages/map/src/cesium-drape";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import {
  ProtocolImageryProvider,
  type DecodedTile,
} from "../packages/map/src/cesium-protocol-imagery";

// The MapLibre drape (issue #2284). The hidden map is faked at the boundary
// the drape drives (jumpTo / idle / canvas); the tile maths, the serialised
// render queue, the generation guard, the provider, and the layer-sync
// integration are real.

function fakeTile(label: string): DecodedTile {
  return { label } as unknown as DecodedTile;
}

/** A map that goes idle on the next tick after every jump and records the jumps. */
function makeHost(options: { idle?: boolean } = {}) {
  const jumps: Array<{ center: [number, number]; zoom: number }> = [];
  const synced: GeoLibreLayer[][] = [];
  let idleListener: (() => void) | null = null;
  let disposed = false;
  const map: DrapeMap = {
    jumpTo(o) {
      jumps.push(o);
      if (options.idle !== false) setTimeout(() => idleListener?.(), 0);
    },
    on() {},
    once(type, listener) {
      if (type === "idle") idleListener = listener;
    },
    off(type) {
      if (type === "idle") idleListener = null;
    },
    isStyleLoaded: () => true,
    getCanvas: () => ({ jumps: jumps.length }) as unknown as HTMLCanvasElement,
    remove: () => {},
  };
  const host: DrapeHost = {
    map,
    layerSync: { sync: (layers) => synced.push(layers), dispose: () => {} },
    ready: Promise.resolve(),
    dispose: () => {
      disposed = true;
    },
  };
  return { host, jumps, synced, isDisposed: () => disposed };
}

function vectorTiles(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vt",
    name: "Vector tiles",
    type: "vector-tiles",
    source: { type: "vector", tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

describe("isDrapedLayer", () => {
  it("drapes tile-backed vector kinds and leaves raster archives and controls alone", () => {
    assert.equal(isDrapedLayer(vectorTiles()), true);
    assert.equal(isDrapedLayer(vectorTiles({ source: { type: "vector" } })), false, "no source");
    assert.equal(
      isDrapedLayer(
        vectorTiles({
          type: "pmtiles",
          source: { type: "vector", url: "pmtiles://https://a/b.pmtiles" },
          metadata: { tileType: "vector" },
        }),
      ),
      true,
    );
    assert.equal(
      isDrapedLayer(
        vectorTiles({
          type: "pmtiles",
          source: { type: "raster", url: "pmtiles://https://a/b.pmtiles" },
          metadata: { tileType: "raster" },
        }),
      ),
      false,
      "raster archives take the imagery bridge",
    );
    assert.equal(
      isDrapedLayer(
        vectorTiles({
          type: "mbtiles",
          source: { type: "vector", tiles: ["geolibre-mbtiles://tile/{z}/{x}/{y}?path=a"] },
        }),
      ),
      true,
    );
    assert.equal(isDrapedLayer(vectorTiles({ type: "arcgis" })), false);
    assert.equal(isCesiumSupportedLayerType(vectorTiles()), true);
    // A hand-authored project can omit `source` altogether: not draped, no throw.
    for (const type of ["vector-tiles", "pmtiles", "mbtiles"] as const) {
      assert.equal(
        isDrapedLayer(vectorTiles({ type, source: undefined as never })),
        false,
        `${type} without a source`,
      );
    }
  });

  it("changes the signature for style, order, visibility, and filter edits", () => {
    const a = vectorTiles();
    const b = vectorTiles({ id: "b" });
    assert.notEqual(drapeSignature([a, b]), drapeSignature([b, a]));
    assert.notEqual(drapeSignature([a]), drapeSignature([{ ...a, visible: false }]));
    assert.notEqual(
      drapeSignature([a]),
      drapeSignature([{ ...a, style: { ...a.style, fillColor: "#ff0000" } }]),
    );
    assert.equal(drapeSignature([a]), drapeSignature([{ ...a }]));
  });

  it("serialises an unchanged layer record once", () => {
    const a = vectorTiles();
    const nested = a.style as { fillColor?: string };
    const first = drapeSignature([a]);
    // Mutating the record in place is not how the store changes a layer (it
    // replaces the record), so the memoised signature is returned as is.
    nested.fillColor = "#123456";
    assert.equal(drapeSignature([a]), first);
    assert.notEqual(drapeSignature([{ ...a }]), first, "a new record is serialised afresh");
  });
});

describe("observeDrapeErrors", () => {
  it("swallows cancelled tile fetches and warns about anything else", () => {
    assert.equal(isTransientDrapeError(new Error("Failed to fetch")), true);
    assert.equal(isTransientDrapeError(new Error("AbortError: The user aborted a request.")), true);
    assert.equal(isTransientDrapeError(new Error("Unimplemented type: 5")), false);
    assert.equal(isTransientDrapeError(undefined), false);
    let listener: ((event: { error?: Error }) => void) | null = null;
    observeDrapeErrors({ on: (_type, l) => (listener = l) });
    assert.ok(listener, "an error listener keeps MapLibre from logging on its own");
    const warned: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      listener!({ error: new Error("Failed to fetch") });
      assert.equal(warned.length, 0);
      listener!({ error: new Error("style is not done loading") });
      assert.equal(warned.length, 1);
    } finally {
      console.warn = original;
    }
  });
});

describe("tileCenter", () => {
  it("is the origin for the root tile and the tile's middle elsewhere", () => {
    const [lng0, lat0] = tileCenter(0, 0, 0);
    assert.ok(Math.abs(lng0) < 1e-9 && Math.abs(lat0) < 1e-9);
    const [lng, lat] = tileCenter(1, 0, 0);
    assert.equal(lng, -90);
    assert.ok(lat > 66 && lat < 67, `north-west quadrant centre at ${lat}`);
  });
});

const Cesium = {
  WebMercatorTilingScheme,
  Event,
  Credit,
  Rectangle,
} as unknown as typeof import("@cesium/engine");

describe("MapLibreDrape", () => {
  it("renders tiles one after another at the tile's centre and zoom", async () => {
    const { host, jumps } = makeHost();
    let snaps = 0;
    const drape = new MapLibreDrape(host, async () => fakeTile(`snap-${++snaps}`));
    const [a, b] = await Promise.all([drape.requestTile(1, 0, 1), drape.requestTile(0, 1, 1)]);
    assert.deepEqual(a, fakeTile("snap-1"));
    assert.deepEqual(b, fakeTile("snap-2"));
    assert.deepEqual(
      jumps.map((j) => j.zoom),
      [1, 1],
    );
    assert.equal(jumps[0].center[0], 90, "tile x=1 of 2 at z=1 is centred east");
    assert.equal(drape.pending, 0);
  });

  it("drops tiles that were queued before a re-sync or a destroy", async () => {
    const { host, synced, isDisposed } = makeHost();
    const drape = new MapLibreDrape(host, async () => fakeTile("late"));
    const stale = drape.requestTile(0, 0, 0);
    drape.sync([vectorTiles()]);
    await Promise.resolve();
    assert.equal(synced.length, 1, "layers reach the hidden map's layer sync");
    assert.equal(await stale, null, "a tile from before the sync is discarded");
    const fresh = drape.requestTile(0, 0, 0);
    assert.deepEqual(await fresh, fakeTile("late"));
    const afterDestroy = drape.requestTile(0, 0, 0);
    drape.destroy();
    assert.equal(await afterDestroy, null);
    assert.equal(isDisposed(), true);
  });

  it("settles an aborted tile at once so the next provider's tile is not held up", async () => {
    // The map never goes idle on its own: a tile waits for the 8 s timeout
    // unless something ends the wait early.
    const { host, jumps } = makeHost({ idle: false });
    const drape = new MapLibreDrape(host, async () => fakeTile("tile"));
    const controller = new AbortController();
    const stale = drape.requestTile(0, 0, 1, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(jumps.length, 1, "the stale tile is being rendered");
    // A rebuild: the old provider is aborted and the new one asks for a tile.
    drape.sync([vectorTiles()]);
    const freshController = new AbortController();
    const fresh = drape.requestTile(1, 0, 1, freshController.signal);
    controller.abort();
    assert.equal(await stale, null, "the aborted tile never reaches the globe");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(jumps.length, 2, "the fresh tile started without waiting for idle");
    assert.equal(drape.pending, 1, "the fresh tile is still waiting for idle");
    freshController.abort();
    assert.equal(await fresh, null);
    assert.equal(drape.pending, 0);
    drape.destroy();
  });

  it("reports a layer the hidden map rejects instead of leaving the rejection unhandled", async () => {
    const { host } = makeHost();
    host.layerSync.sync = () => {
      throw new Error("layers.vt: filter is not an expression");
    };
    const drape = new MapLibreDrape(host, async () => fakeTile("tile"));
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      drape.sync([vectorTiles()]);
      assert.equal(drape.ready, false);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.warn = warn;
    }
    assert.equal(drape.ready, true, "the sync settled even though it failed");
    assert.match(drape.error ?? "", /filter is not an expression/);
    assert.equal(warnings.length, 1);
    host.layerSync.sync = () => {};
    drape.sync([vectorTiles()]);
    assert.equal(drape.error, null, "a new sync clears the last error");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(drape.ready, true);
  });

  it("hands Cesium a 512-px provider that routes back into the render queue", async () => {
    const { host, jumps } = makeHost();
    const drape = new MapLibreDrape(host, async () => fakeTile("tile"));
    const provider = drape.createProvider(Cesium);
    assert.ok(provider instanceof ProtocolImageryProvider);
    assert.equal(provider.tileWidth, 512);
    const tile = await provider.requestImage(3, 5, 4);
    assert.deepEqual(tile, fakeTile("tile"));
    assert.deepEqual(jumps[0], { center: tileCenter(4, 3, 5), zoom: 4 });
  });
});

function makeViewer() {
  const imagery: Array<{ provider: unknown }> = [];
  const order: unknown[] = [];
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {},
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: { add: () => {}, remove: () => {} },
      requestRender: () => {},
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        const layer = { provider, show: true, alpha: 1, ready: true };
        imagery.push(layer);
        return layer;
      },
      remove: (layer: { provider: unknown }) => imagery.splice(imagery.indexOf(layer), 1),
      raiseToTop: (layer: unknown) => order.push(layer),
    },
    dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
  };
  return { viewer, imagery, order };
}

describe("CesiumLayerSync drape integration", () => {
  it("drapes tile-backed vector layers on one shared imagery layer and rebuilds on change", async () => {
    const f = makeViewer();
    const { host, synced } = makeHost();
    const drape = new MapLibreDrape(host, async () => fakeTile("t"));
    const created: MapLibreDrape[] = [];
    const sync = new CesiumLayerSync(
      { ...Cesium, UrlTemplateImageryProvider: class {} } as never,
      f.viewer as never,
      () => 10,
      { createDrape: () => (created.push(drape), drape) },
    );
    const a = vectorTiles({ id: "a" });
    const b = vectorTiles({
      id: "b",
      type: "pmtiles",
      source: { type: "vector", url: "pmtiles://https://x/y.pmtiles" },
      metadata: { tileType: "vector" },
    });
    sync.sync([a, b]);
    await Promise.resolve();
    assert.equal(created.length, 1, "one drape for the whole sync");
    assert.equal(f.imagery.length, 1, "both layers share one imagery layer");
    assert.ok(
      (f.imagery[0].provider as ProtocolImageryProvider).template.startsWith("geolibre-drape://"),
    );
    assert.equal(synced.length, 1);
    assert.deepEqual(
      synced[0].map((l) => l.id),
      ["a", "b"],
    );
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });

    // An unrelated sync leaves the drape alone; a style edit rebuilds it.
    sync.sync([a, b]);
    assert.equal(f.imagery.length, 1);
    assert.equal(synced.length, 1);
    const previous = f.imagery[0].provider;
    sync.sync([a, { ...b, opacity: 0.5 }]);
    await Promise.resolve();
    assert.equal(synced.length, 2, "the drape re-synced the layers");
    assert.equal(f.imagery.length, 1, "the old imagery layer was replaced");
    assert.notEqual(f.imagery[0].provider, previous);

    // Removing every draped layer tears the drape down.
    sync.sync([]);
    assert.equal(f.imagery.length, 0);
    assert.equal(drape.pending, 0);
  });

  it("keeps draped layers pending until the hidden map has applied them", async () => {
    const f = makeViewer();
    const { host } = makeHost();
    let markReady = () => {};
    host.ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const drape = new MapLibreDrape(host, async () => fakeTile("t"));
    const sync = new CesiumLayerSync(
      { ...Cesium, UrlTemplateImageryProvider: class {} } as never,
      f.viewer as never,
      () => 10,
      { createDrape: () => drape },
    );
    sync.sync([vectorTiles()]);
    await Promise.resolve();
    assert.equal(drape.pending, 0, "no tile has been requested yet");
    assert.deepEqual(
      sync.getRenderStatus(),
      { pending: ["Vector tiles"], errors: [] },
      "the hidden map has not loaded, so the layer cannot be settled",
    );
    markReady();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });

    // A layer the hidden map rejects surfaces as that layer's error.
    host.layerSync.sync = () => {
      throw new Error("bad paint");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      sync.sync([vectorTiles({ opacity: 0.5 })]);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(sync.getRenderStatus(), {
      pending: [],
      errors: ["Vector tiles: bad paint"],
    });
  });

  it("reports draped layers as errors when no drape can be created, and retries on change", async () => {
    const f = makeViewer();
    let attempts = 0;
    const { host } = makeHost();
    const sync = new CesiumLayerSync(
      { ...Cesium, UrlTemplateImageryProvider: class {} } as never,
      f.viewer as never,
      () => 10,
      {
        createDrape: () =>
          ++attempts === 1 ? null : new MapLibreDrape(host, async () => fakeTile("t")),
      },
    );
    const layer = vectorTiles();
    sync.sync([layer]);
    assert.equal(f.imagery.length, 0);
    const status = sync.getRenderStatus();
    assert.equal(status.errors.length, 1);
    assert.match(status.errors[0], /could not start a MapLibre drape/);
    // An unrelated sync does not retry; a change to the draped layer does.
    sync.sync([layer]);
    assert.equal(attempts, 1);
    sync.sync([{ ...layer, opacity: 0.5 }]);
    await Promise.resolve();
    assert.equal(attempts, 2);
    assert.equal(f.imagery.length, 1);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
  });

  it("tears down a native entry whose layer switched to a draped kind", async () => {
    const f = makeViewer();
    const { host } = makeHost();
    const sync = new CesiumLayerSync(
      { ...Cesium, UrlTemplateImageryProvider: class {} } as never,
      f.viewer as never,
      () => 10,
      { createDrape: () => new MapLibreDrape(host, async () => fakeTile("t")) },
    );
    const asRaster = vectorTiles({
      id: "same",
      type: "xyz",
      source: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
    });
    sync.sync([asRaster]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.imagery.length, 1);
    assert.ok(!(f.imagery[0].provider instanceof ProtocolImageryProvider), "a native entry");
    // A source switch keeps the id and turns the layer into vector tiles.
    sync.sync([vectorTiles({ id: "same" })]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.imagery.length, 1, "the native layer is destroyed, not leaked");
    assert.ok(f.imagery[0].provider instanceof ProtocolImageryProvider, "the drape draws it now");
  });

  it("re-stacks the drape when it moves relative to native imagery", async () => {
    const f = makeViewer();
    const { host } = makeHost();
    const drape = new MapLibreDrape(host, async () => fakeTile("t"));
    const sync = new CesiumLayerSync(
      { ...Cesium, UrlTemplateImageryProvider: class {} } as never,
      f.viewer as never,
      () => 10,
      { createDrape: () => drape },
    );
    const raster = vectorTiles({
      id: "img",
      type: "xyz",
      source: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"] },
    });
    const draped = vectorTiles({ id: "vt" });
    sync.sync([raster, draped]);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(f.imagery.length, 2);
    const before = f.order.length;
    // Same members, the drape now below the raster: neither the drape
    // signature nor the native-imagery order changed, but the stack did.
    sync.sync([draped, raster]);
    assert.ok(f.order.length > before, "reorderImagery ran for the swap");
    const rasterLayer = f.imagery.find((l) => !(l.provider instanceof ProtocolImageryProvider));
    assert.equal(
      f.order[f.order.length - 1],
      rasterLayer,
      "the raster is raised last, above the drape",
    );
  });
});
