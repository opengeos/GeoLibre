import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import {
  MAX_LAS_FILE_BYTES,
  eptCrs,
  heightRange,
  openEptSource,
  type LasModule,
  MAX_POINT_CLOUD_POINTS,
  buildPointCloudCollection,
  horizontalWkt,
  proj4LinearUnit,
  loadLasPointCloud,
  parseGeoKeyDirectory,
  wktHeightScale,
  isSplatTilesetUrl,
  openCopcSource,
  pointCloudColor,
  pointCloudSourceKind,
  rampColor,
  setPointCloudOpacity,
  type CopcModule,
} from "../packages/map/src/cesium-point-cloud";

// Native I3S, point clouds, and splat tilesets on the globe (issue #2285).
// The COPC decoder and Cesium are faked at their boundaries; the octree walk,
// the budget, the reprojection hook, the colouring, and the layer-sync routing
// are the real code.

/** A projector for archives whose coordinates already are degrees. */
const identity = (x: number, y: number): [number, number] => [x, y];

describe("pointCloudSourceKind", () => {
  it("tells tilesets, COPC archives, and unsupported sources apart", () => {
    assert.equal(pointCloudSourceKind("https://x/cloud/tileset.json"), "tileset");
    assert.equal(pointCloudSourceKind("https://x/cloud/tileset.json?v=2"), "tileset");
    assert.equal(pointCloudSourceKind("https://s3/autzen-classified.copc.laz"), "copc");
    assert.equal(
      pointCloudSourceKind("https://x/ept.json"),
      "ept",
      "an EPT manifest is JSON but not a tileset",
    );
    assert.equal(pointCloudSourceKind("https://x/EPT.json?token=1"), "ept");
    assert.equal(pointCloudSourceKind("https://x/plain.laz"), "las");
    assert.equal(pointCloudSourceKind("https://x/PLAIN.LAS?sig=1"), "las");
    assert.equal(pointCloudSourceKind(undefined), null);
    assert.equal(isSplatTilesetUrl("https://x/splats/tileset.json"), true);
    assert.equal(isSplatTilesetUrl("https://x/scene.ply"), false);
  });
});

describe("ramp and point colours", () => {
  it("interpolates a hex ramp and clamps outside [0, 1]", () => {
    const ramp = ["#000000", "#ffffff"];
    assert.deepEqual(rampColor(ramp, 0), [0, 0, 0]);
    assert.deepEqual(rampColor(ramp, 0.5), [128, 128, 128]);
    assert.deepEqual(rampColor(ramp, 2), [255, 255, 255]);
    assert.deepEqual(rampColor([], 0.3), [128, 128, 128]);
  });

  it("prefers the point's own RGB and otherwise colours by height", () => {
    const cloud = {
      positions: new Float64Array([0, 0, 10, 0, 0, 20]),
      colors: null,
      count: 2,
      zMin: 10,
      zMax: 20,
      truncated: false,
    };
    const ramp = ["#000000", "#ffffff"];
    assert.deepEqual(pointCloudColor(cloud, 0, ramp), [0, 0, 0]);
    assert.deepEqual(pointCloudColor(cloud, 1, ramp), [255, 255, 255]);
    const coloured = { ...cloud, colors: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    assert.deepEqual(pointCloudColor(coloured, 1, ramp), [4, 5, 6]);
  });
});

/** A fake COPC archive: a root page with one node per depth, plus a sub-page. */
function fakeCopc(options: { color?: boolean; scaleTo16Bit?: boolean; wkt?: string } = {}): {
  module: CopcModule;
  loads: string[];
  pages: number;
} {
  const loads: string[] = [];
  let pages = 0;
  const node = (points: number) => ({ pointCount: points, pointDataOffset: 0, pointDataLength: 0 });
  const module: CopcModule = {
    Copc: {
      create: async () => ({
        header: {
          scale: [0.01, 0.01, 0.01],
          offset: [0, 0, 0],
          pointCount: 1000,
          min: [0, 0, 0],
          max: [1, 1, 1],
        },
        info: { rootHierarchyPage: { pageOffset: 0, pageLength: 0 } },
        wkt: options.wkt ?? "PROJCS[fake]",
      }),
      loadHierarchyPage: async (_source, page) => {
        pages++;
        if (page.pageOffset === 0) {
          return {
            nodes: {
              "0-0-0-0": node(100),
              "1-0-0-0": node(200),
              "1-1-0-0": node(200),
              "2-0-0-0": undefined,
            },
            pages: { "2-0-0-0": { pageOffset: 999, pageLength: 1 } },
          };
        }
        return { nodes: { "2-0-0-0": node(300), "3-0-0-0": node(400) }, pages: {} };
      },
      loadPointDataView: async (_source, _copc, n) => {
        const key = Object.entries({ a: n }).length ? String(n.pointCount) : "";
        loads.push(key);
        const dimensions: Record<string, unknown> = { X: {}, Y: {}, Z: {} };
        if (options.color) Object.assign(dimensions, { Red: {}, Green: {}, Blue: {} });
        return {
          pointCount: n.pointCount,
          dimensions,
          getter: (name: string) => (i: number) => {
            if (name === "X") return 100 + i;
            if (name === "Y") return 200 + i;
            if (name === "Z") return 10 + (i % 5);
            const base = name === "Red" ? 10 : name === "Green" ? 20 : 30;
            return options.scaleTo16Bit ? base << 8 : base;
          },
        };
      },
    },
  };
  return { module, loads, pages };
}

describe("openCopcSource", () => {
  it("builds the projector from the archive's WKT and reprojects a node", async () => {
    const fake = fakeCopc();
    const wkts: string[] = [];
    const source = await openCopcSource("https://x/a.copc.laz", {
      copc: fake.module,
      projector: async (wkt) => {
        wkts.push(wkt ?? "");
        return (x, y) => [x / 1000, y / 1000];
      },
      lazPerf: async () => ({}),
    });
    assert.deepEqual(wkts, ["PROJCS[fake]"], "the projector is built from the archive's WKT");
    assert.equal(source.counts.get("0-0-0-0"), 100);
    assert.equal(source.counts.get("2-0-0-0"), -1, "a key in a sub-page reads as unread");
    const root = await source.loadNode("0-0-0-0");
    assert.deepEqual(fake.loads, ["100"], "only the requested node is decoded");
    assert.equal(root.count, 100);
    assert.ok(Math.abs(root.positions[0] - 0.1) < 1e-12, "x reprojected");
    assert.ok(Math.abs(root.positions[1] - 0.2) < 1e-12, "y reprojected");
    assert.equal(root.positions[2], 10);
    assert.equal(root.colors, null);
  });

  it("reads sub-pages on request and keeps 16-bit colour", async () => {
    const fake = fakeCopc({ color: true, scaleTo16Bit: true });
    const source = await openCopcSource("https://x/a.copc.laz", {
      copc: fake.module,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    await source.loadSubtree("2-0-0-0");
    assert.equal(source.counts.get("2-0-0-0"), 300);
    assert.equal(source.counts.get("3-0-0-0"), 400);
    const node = await source.loadNode("2-0-0-0");
    assert.ok(node.colors);
    assert.deepEqual(
      Array.from(node.colors!.subarray(0, 3)),
      [10, 20, 30],
      "16-bit scaled to 8-bit",
    );
    assert.equal(node.positions[0], 100, "identity projector: coordinates pass through");
  });

  it("reads a sub-page the root only points at", async () => {
    const fake = fakeCopc();
    const rootless: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        loadHierarchyPage: async (source, page) => {
          if (page.pageOffset === 0) {
            // A root page with no nodes of its own: every key lives in a sub-page.
            return { nodes: {}, pages: { "0-0-0-0": { pageOffset: 999, pageLength: 1 } } };
          }
          return fake.module.Copc.loadHierarchyPage(source, page);
        },
      },
    };
    const source = await openCopcSource("https://x/a.copc.laz", {
      copc: rootless,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    assert.equal(source.counts.get("0-0-0-0"), -1);
    await source.loadSubtree("0-0-0-0");
    assert.equal(source.counts.get("2-0-0-0"), 300);
    assert.equal(
      source.counts.get("0-0-0-0"),
      0,
      "a sub-page without its root leaves a structural node the walk descends through",
    );
  });

  it("keeps a sub-page whose read failed, so a later refresh retries it", async () => {
    const fake = fakeCopc();
    let fail = true;
    const flaky: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        loadHierarchyPage: async (source, page) => {
          if (page.pageOffset !== 0 && fail) throw new Error("page 503");
          return fake.module.Copc.loadHierarchyPage(source, page);
        },
      },
    };
    const source = await openCopcSource("https://x/a.copc.laz", {
      copc: flaky,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    await assert.rejects(source.loadSubtree("2-0-0-0"), /page 503/);
    assert.equal(source.counts.get("2-0-0-0"), -1, "still unread after the failure");
    fail = false;
    await source.loadSubtree("2-0-0-0");
    assert.equal(source.counts.get("2-0-0-0"), 300);
  });

  it("takes the octree cube and span from the COPC info, else the header", async () => {
    const fake = fakeCopc();
    const withInfo: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        create: async (source) => {
          const copc = await fake.module.Copc.create(source);
          return {
            ...copc,
            info: { ...copc.info, cube: [0, 0, 0, 1280, 1280, 1280], spacing: 10 },
          };
        },
      },
    };
    const open = (copc: CopcModule) =>
      openCopcSource("https://x/a.copc.laz", {
        copc,
        projector: async () => identity,
        lazPerf: async () => ({}),
      });
    const a = await open(withInfo);
    assert.deepEqual(a.cube, [0, 0, 0, 1280, 1280, 1280]);
    assert.equal(a.span, 128);
    const b = await open(fake.module);
    assert.deepEqual(b.cube, [0, 0, 0, 1, 1, 1], "header bounds without a cube");
    assert.equal(b.span, 128, "the EPT default without a spacing");
  });

  it("refuses an archive whose CRS cannot be used", async () => {
    const fake = fakeCopc();
    await assert.rejects(
      openCopcSource("https://x/a.copc.laz", {
        copc: fake.module,
        projector: async () => null,
        lazPerf: async () => ({}),
      }),
      /COPC archive has no usable CRS/,
    );
    assert.equal(fake.pages, 0, "nothing is read without a CRS");
  });

  it("stops when aborted", async () => {
    const fake = fakeCopc();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      openCopcSource("https://x/a.copc.laz", {
        copc: fake.module,
        signal: controller.signal,
        projector: async () => identity,
        lazPerf: async () => ({}),
      }),
    );
  });
});

/** A Cesium namespace with the primitive and tileset classes the routing constructs. */
function makeCesium(calls: { tilesets: unknown[]; i3s: unknown[] }) {
  class PointPrimitiveCollection {
    show = true;
    points: Array<{ color: { alpha: number; withAlpha(a: number): unknown }; show: boolean }> = [];
    get length() {
      return this.points.length;
    }
    add(options: Record<string, unknown>) {
      const primitive = { show: true, ...options } as never;
      this.points.push(primitive);
      return primitive;
    }
    get(index: number) {
      return this.points[index];
    }
    remove(primitive: unknown) {
      const i = this.points.indexOf(primitive as never);
      if (i >= 0) this.points.splice(i, 1);
      return i >= 0;
    }
  }
  class Color {
    constructor(
      public red: number,
      public green: number,
      public blue: number,
      public alpha: number,
    ) {}
    withAlpha(alpha: number) {
      return new Color(this.red, this.green, this.blue, alpha);
    }
    static fromCssColorString(css: string) {
      return { css, alpha: 1, withAlpha: (alpha: number) => ({ css, alpha }) };
    }
  }
  return {
    PointPrimitiveCollection,
    Color,
    Math: { toDegrees: (r: number) => r },
    Cartesian3: class {
      static fromDegrees = (lng: number, lat: number, z: number) => ({ lng, lat, z });
      static fromRadians = (lng: number, lat: number, z: number) => ({ lng, lat, z });
      static subtract = (a: { z: number }, b: { z: number }) => ({ z: a.z - b.z });
    },
    Cartographic: { fromCartesian: () => ({ longitude: 0, latitude: 0 }) },
    Matrix4: { fromTranslation: (t: unknown) => ({ translation: t }) },
    Cesium3DTileset: {
      fromUrl: async (url: unknown) => {
        const tileset = {
          url,
          show: true,
          tilesLoaded: true,
          pointCloudShading: {} as Record<string, unknown>,
          destroy: () => {},
          modelMatrix: null,
          boundingSphere: { center: {} },
        };
        calls.tilesets.push(tileset);
        return tileset;
      },
    },
    I3SDataProvider: {
      fromUrl: async (url: unknown, options: unknown) => {
        // Cesium flattens a Building Scene Layer's nested sublayers into
        // `layers`, so the fake carries two entries the way a BSL would.
        const provider = {
          url,
          options,
          show: true,
          layers: [
            { tileset: { tilesLoaded: true, modelMatrix: null, boundingSphere: { center: {} } } },
            { tileset: { tilesLoaded: true, modelMatrix: null, boundingSphere: { center: {} } } },
          ],
          destroy: () => {},
        };
        calls.i3s.push(provider);
        return provider;
      },
    },
    Resource: class {
      constructor(public opts: Record<string, unknown>) {}
    },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    Rectangle: { fromDegrees: () => ({}) },
    JulianDate: { fromDate: (d: Date) => d },
  };
}

function makeViewer() {
  const primitives: unknown[] = [];
  return {
    primitives,
    viewer: {
      clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
      camera: {},
      scene: {
        canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
        primitives: {
          add: (p: unknown) => primitives.push(p),
          remove: (p: unknown) => primitives.splice(primitives.indexOf(p), 1),
        },
        requestRender: () => {},
      },
      imageryLayers: { addImageryProvider: () => ({}), remove: () => {}, raiseToTop: () => {} },
      dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
    },
  };
}

function layer(patch: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l",
    name: "Layer",
    type: "3d-tiles",
    source: {},
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CesiumLayerSync native 3D routing", () => {
  it("reports which 3D kinds the globe can draw", () => {
    assert.equal(
      isCesiumSupportedLayerType(
        layer({
          type: "3d-tiles",
          metadata: { sourceKind: "arcgis-i3s" },
          source: { url: "https://x/SceneServer/layers/0" },
        }),
      ),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(
        layer({ type: "gaussian-splat", source: { url: "https://x/splat/tileset.json" } }),
      ),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(
        layer({ type: "gaussian-splat", source: { url: "https://x/scene.spz" } }),
      ),
      false,
    );
    assert.equal(
      isCesiumSupportedLayerType(layer({ type: "lidar", source: { url: "https://x/a.copc.laz" } })),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(
        layer({ type: "lidar", source: { url: "https://x/cloud/tileset.json" } }),
      ),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType(layer({ type: "lidar", source: { url: "https://x/plain.laz" } })),
      true,
      "a plain LAZ is downloaded and decoded whole",
    );
    assert.equal(
      isCesiumSupportedLayerType(layer({ type: "lidar", source: { url: "https://x/ept.json" } })),
      true,
      "an EPT dataset is walked and decoded like COPC",
    );
    assert.equal(isCesiumSupportedLayerType(layer({ type: "deckgl-viz" })), false);
  });

  it("loads an I3S scene layer through Cesium's provider and tracks its tilesets", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10);
    sync.sync([
      layer({
        metadata: { sourceKind: "arcgis-i3s" },
        source: { url: "https://x/SceneServer/layers/0", type: "arcgis-i3s" },
      }),
    ]);
    await flush();
    await flush();
    assert.equal(calls.i3s.length, 1);
    assert.equal(calls.tilesets.length, 0, "no plain tileset attempt on a scene service");
    assert.equal(f.primitives.length, 1);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    // Every tileset the provider drives — a building sublayer's included —
    // counts toward readiness.
    const provider = calls.i3s[0] as { layers: Array<{ tileset: { tilesLoaded: boolean } }> };
    provider.layers[1].tileset.tilesLoaded = false;
    assert.deepEqual(sync.getRenderStatus().pending, ["Layer"]);
    provider.layers[1].tileset.tilesLoaded = true;
    sync.sync([]);
    assert.equal(f.primitives.length, 0);
  });

  it("offsets every I3S tileset, sublayers included", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10);
    sync.sync([
      layer({
        metadata: { sourceKind: "arcgis-i3s" },
        source: { url: "https://x/SceneServer/layers/0", type: "arcgis-i3s", altitudeOffset: 25 },
      }),
    ]);
    await flush();
    await flush();
    const provider = calls.i3s[0] as { layers: Array<{ tileset: { modelMatrix: unknown } }> };
    assert.equal(provider.layers.length, 2);
    for (const { tileset } of provider.layers) {
      assert.ok(tileset.modelMatrix, "the altitude offset reached this tileset");
    }
  });

  it("loads a splat tileset and a point-cloud tileset as 3D Tiles with shading", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10);
    sync.sync([
      layer({ id: "s", type: "gaussian-splat", source: { url: "https://x/splat/tileset.json" } }),
      layer({ id: "p", type: "lidar", source: { url: "https://x/cloud/tileset.json" } }),
      layer({ id: "raw", type: "gaussian-splat", source: { url: "https://x/scene.ply" } }),
    ]);
    await flush();
    await flush();
    assert.equal(calls.tilesets.length, 2, "the raw splat file has no globe loader");
    const cloud = calls.tilesets[1] as { pointCloudShading: Record<string, unknown> };
    assert.equal(cloud.pointCloudShading.eyeDomeLighting, true);
    assert.equal(cloud.pointCloudShading.attenuation, true);
    assert.equal(f.primitives.length, 2);
  });

  it("decodes a COPC layer into primitives, fades it in place, and aborts on removal", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const fake = fakeCopc({ color: true });
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10, {
      copcOptions: {
        copc: fake.module,
        projector: async () => identity,
        lazPerf: async () => ({}),
      },
    });
    const copc = layer({
      id: "c",
      type: "lidar",
      opacity: 0.5,
      source: { url: "https://x/a.copc.laz" },
    });
    sync.sync([copc]);
    assert.deepEqual(sync.getRenderStatus().pending, ["Layer"], "pending while decoding");
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(f.primitives.length, 1);
    const collection = f.primitives[0] as {
      length: number;
      get(i: number): { color: { alpha: number } };
    };
    // No camera view to stream by: the root node is shown as the outline.
    assert.equal(collection.length, 100);
    assert.equal(collection.get(0).color.alpha, 0.5);
    assert.equal(
      (collection.get(0) as unknown as { position: { z: number } }).position.z,
      10,
      "no offset: the decoded height is used as is",
    );
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    sync.sync([{ ...copc, opacity: 0.2 }]);
    assert.ok(Math.abs(collection.get(0).color.alpha - 0.2) < 1e-9);
    // An altitude offset rebuilds the cloud with every point lifted.
    sync.sync([{ ...copc, source: { ...copc.source, altitudeOffset: 10 } }]);
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(f.primitives.length, 1);
    const lifted = f.primitives[0] as { get(i: number): { position: { z: number } } };
    assert.notEqual(lifted, collection, "the offset rebuilds the collection");
    assert.equal(lifted.get(0).position.z, 20);
    sync.sync([]);
    assert.equal(f.primitives.length, 0);
  });

  it("streams a COPC layer's sub-page and child nodes when the camera moves in", async () => {
    const fake = fakeCopc();
    let pageReads = 0;
    const counted: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        loadHierarchyPage: async (source, page) => {
          pageReads++;
          return fake.module.Copc.loadHierarchyPage(source, page);
        },
      },
    };
    const f = makeViewer();
    const listeners: (() => void)[] = [];
    let rect: { west: number; south: number; east: number; north: number } | undefined;
    f.viewer.camera = {
      moveEnd: {
        addEventListener: (fn: () => void) => listeners.push(fn),
        removeEventListener: (fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
      },
      computeViewRectangle: () => rect,
      get positionCartographic() {
        return rect
          ? { longitude: rect.west, latitude: rect.south, height: 1e-6 }
          : { longitude: 0, latitude: 0, height: 1e9 };
      },
      frustum: { fovy: Math.PI / 3 },
      pitch: -Math.PI / 2,
    } as never;
    // Identity in both directions: the fake archive's coordinates are degrees.
    const projector = Object.assign((x: number, y: number) => [x, y] as [number, number], {
      inverse: (lng: number, lat: number) => [lng, lat] as [number, number],
      metresPerUnit: 1,
    });
    const sync = new CesiumLayerSync(
      makeCesium({ tilesets: [], i3s: [] }) as never,
      f.viewer as never,
      () => 10,
      {
        copcOptions: { copc: counted, projector: async () => projector, lazPerf: async () => ({}) },
      },
    );
    sync.sync([layer({ id: "c", type: "lidar", source: { url: "https://x/a.copc.laz" } })]);
    for (let i = 0; i < 10; i++) await flush();
    assert.deepEqual(fake.loads, ["100"], "from afar only the root outline loads");
    const readsBefore = pageReads;

    // Close over the corner the sub-page covers.
    rect = { west: 0, south: 0, east: 0.1, north: 0.1 };
    listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 10; i++) await flush();
    assert.ok(pageReads > readsBefore, "the sub-page under the view is read");
    assert.ok(fake.loads.includes("300"), `child node loaded (loads: ${fake.loads.join(",")})`);
    sync.sync([]);
    assert.equal(listeners.length, 0, "the streamer stops following the camera");
  });

  it("keeps a slow decode from landing after its layer was removed", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeCopc();
    const slow: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        create: async (source) => {
          await gate;
          return fake.module.Copc.create(source);
        },
      },
    };
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10, {
      copcOptions: { copc: slow, projector: async () => identity, lazPerf: async () => ({}) },
    });
    sync.sync([layer({ id: "c", type: "lidar", source: { url: "https://x/a.copc.laz" } })]);
    sync.sync([]);
    release();
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(fake.pages, 0, "aborted decode does not load hierarchy");
    assert.equal(f.primitives.length, 0, "the removed layer's primitives never reach the scene");
  });

  it("surfaces a missing CRS as a layer error", async () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const fake = fakeCopc();
    const f = makeViewer();
    const sync = new CesiumLayerSync(makeCesium(calls) as never, f.viewer as never, () => 10, {
      copcOptions: { copc: fake.module, projector: async () => null, lazPerf: async () => ({}) },
    });
    sync.sync([layer({ id: "c", type: "lidar", source: { url: "https://x/a.copc.laz" } })]);
    for (let i = 0; i < 8; i++) await flush();
    assert.equal(f.primitives.length, 0);
    const status = sync.getRenderStatus();
    assert.deepEqual(status.pending, []);
    assert.equal(status.errors.length, 1);
    assert.match(status.errors[0], /no usable CRS/);
  });
});

describe("buildPointCloudCollection", () => {
  it("creates one coloured primitive per point and re-alphas in place", () => {
    const calls = { tilesets: [] as unknown[], i3s: [] as unknown[] };
    const Cesium = makeCesium(calls);
    const cloud = {
      positions: new Float64Array([1, 2, 3, 4, 5, 6]),
      colors: new Uint8Array([255, 0, 0, 0, 0, 255]),
      count: 2,
      zMin: 3,
      zMax: 6,
      truncated: false,
    };
    const collection = buildPointCloudCollection(
      Cesium as never,
      cloud,
      0.75,
    ) as unknown as InstanceType<typeof Cesium.PointPrimitiveCollection>;
    assert.equal(collection.length, 2);
    const first = collection.get(0) as unknown as {
      color: { red: number; blue: number; alpha: number };
      position: unknown;
    };
    assert.equal(first.color.red, 1);
    assert.equal(first.color.blue, 0);
    assert.equal(first.color.alpha, 0.75);
    assert.deepEqual(first.position, { lng: 1, lat: 2, z: 3 });
    const lifted = buildPointCloudCollection(Cesium as never, cloud, 1, 10) as unknown as {
      get(i: number): { position: { z: number } };
    };
    assert.equal(lifted.get(1).position.z, 16, "the altitude offset lifts every point");
    setPointCloudOpacity(collection as never, 0.1);
    assert.ok(
      Math.abs((collection.get(0) as unknown as { color: { alpha: number } }).color.alpha - 0.1) <
        1e-9,
    );
  });
});

// --- Plain LAS / LAZ (issue #2261) -----------------------------------------

/**
 * A real LAS 1.2 file, point format 2 (RGB), with an optional GeoKey
 * directory naming a projected EPSG code, so the loader runs the actual
 * `copc` reader, GeoKey decoding, and proj4.
 */
function makeLas(points: number[][], options: { epsg?: number; wkt?: string } = {}): Uint8Array {
  const vlrs: { recordId: number; body: Uint8Array }[] = [];
  if (options.epsg) {
    const keys = new Uint16Array([1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, options.epsg]);
    vlrs.push({ recordId: 34735, body: new Uint8Array(keys.buffer) });
  }
  if (options.wkt)
    vlrs.push({ recordId: 2112, body: new TextEncoder().encode(`${options.wkt}\0`) });
  // `copc` reads a 375-byte header block whatever the version; a real file is
  // never that small, so pad a tiny one with a record nothing reads.
  vlrs.push({ recordId: 1, body: new Uint8Array(160) });
  const headerSize = 227;
  const vlrBytes = vlrs.reduce((n, v) => n + 54 + v.body.byteLength, 0);
  const recordLength = 26;
  const offset = headerSize + vlrBytes;
  const out = new Uint8Array(offset + points.length * recordLength);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("LASF"), 0);
  dv.setUint8(24, 1);
  dv.setUint8(25, 2);
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, offset, true);
  dv.setUint32(100, vlrs.length, true);
  dv.setUint8(104, 2);
  dv.setUint16(105, recordLength, true);
  dv.setUint32(107, points.length, true);
  const scale = 0.01;
  for (const at of [131, 139, 147]) dv.setFloat64(at, scale, true);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const zs = points.map((p) => p[2]);
  dv.setFloat64(179, Math.max(...xs), true);
  dv.setFloat64(187, Math.min(...xs), true);
  dv.setFloat64(195, Math.max(...ys), true);
  dv.setFloat64(203, Math.min(...ys), true);
  dv.setFloat64(211, Math.max(...zs), true);
  dv.setFloat64(219, Math.min(...zs), true);
  let at = headerSize;
  for (const vlr of vlrs) {
    out.set(new TextEncoder().encode("LASF_Projection"), at + 2);
    dv.setUint16(at + 18, vlr.recordId, true);
    dv.setUint16(at + 20, vlr.body.byteLength, true);
    out.set(vlr.body, at + 54);
    at += 54 + vlr.body.byteLength;
  }
  points.forEach(([x, y, z, r = 0, g = 0, b = 0, classification = 0], i) => {
    const p = offset + i * recordLength;
    dv.setUint8(p + 15, classification);
    dv.setInt32(p, Math.round(x / scale), true);
    dv.setInt32(p + 4, Math.round(y / scale), true);
    dv.setInt32(p + 8, Math.round(z / scale), true);
    dv.setUint16(p + 20, r, true);
    dv.setUint16(p + 22, g, true);
    dv.setUint16(p + 24, b, true);
  });
  return out;
}

const bytes = (file: Uint8Array) => async () => file;

describe("loadLasPointCloud", () => {
  it("decodes a LAS file through its GeoKeys, keeping 16-bit colour", async () => {
    // UTM 10N, metres: 500 000 E on the central meridian (-123°).
    const file = makeLas(
      [
        [500000, 4877000, 120, 65535, 0, 0],
        [500100, 4877100, 130, 0, 32768, 0],
      ],
      { epsg: 32610 },
    );
    const cloud = await loadLasPointCloud("https://x/a.las", { fetchBytes: bytes(file) });
    assert.equal(cloud.count, 2);
    assert.equal(cloud.truncated, false);
    assert.ok(Math.abs(cloud.positions[0] + 123) < 1e-6, `lng ${cloud.positions[0]}`);
    assert.ok(Math.abs(cloud.positions[1] - 44.04) < 0.01, `lat ${cloud.positions[1]}`);
    assert.equal(cloud.positions[2], 120);
    assert.deepEqual(Array.from(cloud.colors ?? []), [255, 0, 0, 0, 128, 0]);
    assert.deepEqual([cloud.zMin, cloud.zMax], [120, 130]);
  });

  it("scales heights by the projected unit when no vertical unit is given", async () => {
    // EPSG:2992 is Oregon Lambert in international feet, like Autzen.
    const file = makeLas([[1312336, 0, 400]], { epsg: 2992 });
    const cloud = await loadLasPointCloud("https://x/a.las", { fetchBytes: bytes(file) });
    assert.ok(Math.abs(cloud.positions[2] - 400 * 0.3048) < 1e-6, `z ${cloud.positions[2]}`);
  });

  it("thins a cloud over the budget to every n-th point", async () => {
    const points = Array.from({ length: 10 }, (_, i) => [500000 + i, 4877000, i]);
    const cloud = await loadLasPointCloud("https://x/a.las", {
      fetchBytes: bytes(makeLas(points, { epsg: 32610 })),
      budget: 4,
    });
    assert.equal(cloud.truncated, true);
    assert.equal(cloud.count, 4);
    assert.deepEqual(
      [0, 1, 2, 3].map((i) => cloud.positions[i * 3 + 2]),
      [0, 3, 6, 9],
    );
  });

  it("falls back to the WKT the 2D control recorded", async () => {
    const wkt =
      'PROJCS["WGS 84 / UTM zone 10N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
    const cloud = await loadLasPointCloud("https://x/a.las", {
      fetchBytes: bytes(makeLas([[500000, 4877000, 5]])),
      fallbackWkt: wkt,
    });
    assert.ok(Math.abs(cloud.positions[0] + 123) < 1e-6);
  });

  it("drops points classified as noise", async () => {
    const file = makeLas(
      [
        [500000, 4877000, 120, 0, 0, 0, 2],
        [500001, 4877000, 9000, 0, 0, 0, 7],
        [500002, 4877000, -500, 0, 0, 0, 18],
        [500003, 4877000, 125, 0, 0, 0, 1],
      ],
      { epsg: 32610 },
    );
    const cloud = await loadLasPointCloud("https://x/a.las", { fetchBytes: bytes(file) });
    assert.equal(cloud.count, 2);
    assert.deepEqual([cloud.positions[2], cloud.positions[5]], [120, 125]);
  });

  it("refuses a truncated file with a clear message", async () => {
    const file = makeLas(
      [
        [500000, 4877000, 1],
        [500001, 4877000, 2],
      ],
      { epsg: 32610 },
    );
    await assert.rejects(
      loadLasPointCloud("https://x/a.las", {
        fetchBytes: bytes(file.subarray(0, file.length - 10)),
      }),
      /truncated/,
    );
  });

  it("stops a download that has no length once it passes the cap", async () => {
    const realFetch = globalThis.fetch;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024 * 1024);
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch;
    try {
      await assert.rejects(loadLasPointCloud("https://x/huge.laz"), /too large to preview/);
      assert.equal(cancelled, true, "the stream is cancelled, not drained");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a file with no CRS rather than reading metres as degrees", async () => {
    await assert.rejects(
      loadLasPointCloud("https://x/a.las", { fetchBytes: bytes(makeLas([[1, 2, 3]])) }),
      /no usable CRS/,
    );
  });

  it("refuses a file too large to preview", async () => {
    const huge = makeLas([[500000, 4877000, 1]], { epsg: 32610 });
    // Claim more points than fit in the cap; the header alone decides.
    new DataView(huge.buffer).setUint32(107, Math.ceil(MAX_LAS_FILE_BYTES / 26) + 1, true);
    await assert.rejects(
      loadLasPointCloud("https://x/a.las", { fetchBytes: bytes(huge) }),
      /too large to preview/,
    );
  });

  it("stops when aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      loadLasPointCloud("https://x/a.las", {
        fetchBytes: bytes(makeLas([[500000, 4877000, 1]], { epsg: 32610 })),
        signal: abort.signal,
      }),
    );
  });
});

describe("COPC heights", () => {
  it("converts heights in feet to metres from the WKT", async () => {
    const fake = fakeCopc({ wkt: 'PROJCS["x (ft)",UNIT["foot",0.3048]]' });
    const open = (copc: CopcModule) =>
      openCopcSource("https://x/a.copc.laz", {
        copc,
        projector: async () => identity,
        lazPerf: async () => ({}),
      }).then((source) => source.loadNode("0-0-0-0"));
    const cloud = await open(fake.module);
    const plain = await open(fakeCopc().module);
    assert.ok(plain.positions[2] !== 0, "the fixture has non-zero heights");
    assert.ok(Math.abs(cloud.positions[2] - plain.positions[2] * 0.3048) < 1e-9);
  });
});

describe("point cloud CRS helpers", () => {
  const AUTZEN =
    'COMPD_CS["NAD83 / Oregon GIC Lambert (ft) + NAVD88 height (ftUS)",PROJCS["NAD83 / Oregon GIC Lambert (ft)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["latitude_of_origin",41.75],PARAMETER["central_meridian",-120.5],PARAMETER["standard_parallel_1",43],PARAMETER["standard_parallel_2",45.5],PARAMETER["false_easting",1312335.958],PARAMETER["false_northing",0],UNIT["foot",0.3048]],VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],UNIT["US survey foot",0.304800609601219]]]';

  it("extracts the horizontal CRS from a compound WKT", () => {
    const horizontal = horizontalWkt(AUTZEN);
    assert.ok(horizontal.startsWith('PROJCS["NAD83 / Oregon GIC Lambert (ft)"'));
    assert.ok(horizontal.endsWith('UNIT["foot",0.3048]]'));
    assert.equal(horizontalWkt('PROJCS["x",UNIT["metre",1]]'), 'PROJCS["x",UNIT["metre",1]]');
  });

  it("reads the height unit from the vertical CRS, else the projected one", () => {
    assert.equal(wktHeightScale(AUTZEN), 0.304800609601219);
    assert.equal(wktHeightScale(horizontalWkt(AUTZEN)), 0.3048);
    assert.equal(wktHeightScale('GEOGCS["WGS 84",UNIT["degree",0.0174532925199433]]'), 1);
    assert.equal(wktHeightScale(undefined), 1);
  });

  it("reads a proj4 string's linear unit", () => {
    assert.equal(proj4LinearUnit("+proj=lcc +to_meter=0.3048 +no_defs"), 0.3048);
    assert.equal(proj4LinearUnit("+proj=lcc +units=us-ft"), 1200 / 3937);
    assert.equal(proj4LinearUnit("+proj=tmerc +units=m"), 1);
    assert.equal(proj4LinearUnit("+proj=tmerc"), 1);
  });

  it("decodes GeoKeys with short, double, and ASCII values", () => {
    const directory = new Uint16Array([
      1, 1, 0, 3, 1024, 0, 1, 1, 3088, 34736, 1, 0, 1026, 34737, 5, 0,
    ]);
    const doubles = new Float64Array([41.75]);
    const keys = parseGeoKeyDirectory(
      new Uint8Array(directory.buffer),
      new Uint8Array(doubles.buffer),
      new TextEncoder().encode("Test|"),
      { 1024: "GTModelTypeGeoKey", 3088: "ProjNatOriginLatGeoKey", 1026: "GTCitationGeoKey" },
    );
    assert.deepEqual(keys, {
      GTModelTypeGeoKey: 1,
      ProjNatOriginLatGeoKey: 41.75,
      GTCitationGeoKey: "Test",
    });
  });
});

describe("heightRange", () => {
  it("is the exact span for a small cloud and ignores outliers in a large one", () => {
    const pack = (hs: number[]) => {
      const out = new Float64Array(hs.length * 3);
      hs.forEach((h, i) => (out[i * 3 + 2] = h));
      return out;
    };
    assert.deepEqual(heightRange(pack([5, 1, 3]), 3), { zMin: 1, zMax: 5 });
    assert.deepEqual(heightRange(new Float64Array(0), 0), { zMin: 0, zMax: 0 });
    const hs = Array.from({ length: 1000 }, (_, i) => 100 + (i % 50));
    hs[0] = -5000;
    hs[1] = 9000;
    const range = heightRange(pack(hs), hs.length);
    assert.equal(range.zMin, 100);
    assert.equal(range.zMax, 149);
  });
});

// --- Entwine Point Tiles (issue #2261) -------------------------------------

/**
 * A fake EPT dataset: JSON documents by path, and a `copc` LAS module whose
 * "LAZ" nodes are tagged buffers decoded into points by key.
 */
function fakeEpt(
  docs: Record<string, unknown>,
  nodes: Record<string, number[][]>,
): {
  las: LasModule;
  fetchJson: (url: string) => Promise<unknown>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  fetched: string[];
} {
  const fetched: string[] = [];
  const keyOf = (url: string) =>
    new URL(url).pathname
      .split("/")
      .pop()!
      .replace(/\.(laz|json)$/, "");
  const las = {
    Las: {
      Header: { parse: (file: Uint8Array) => ({ key: new TextDecoder().decode(file) }) },
      Vlr: { walk: async () => [] },
      PointData: { decompressFile: async (file: Uint8Array) => file },
      View: {
        create: (file: Uint8Array) => {
          const points = nodes[new TextDecoder().decode(file)] ?? [];
          return {
            pointCount: points.length,
            dimensions: { X: {}, Y: {}, Z: {} },
            getter: (name: string) => (i: number) => points[i]["XYZ".indexOf(name)],
          };
        },
      },
    },
  } as unknown as LasModule;
  return {
    las,
    fetched,
    fetchJson: async (url) => {
      fetched.push(url);
      const path = new URL(url).pathname.replace(/^\/data\//, "");
      if (!(path in docs)) throw new Error(`404 ${path}`);
      return docs[path];
    },
    fetchBytes: async (url) => {
      fetched.push(url);
      return new TextEncoder().encode(keyOf(url));
    },
  };
}

const metresProjector = async () => (x: number, y: number, z: number) =>
  [x, y, z] as [number, number, number];

describe("openEptSource", () => {
  const manifest = { dataType: "laszip", hierarchyType: "json", srs: { wkt: "PROJCS[x]" } };
  const nodePoints = (n: number, z: number) => Array.from({ length: n }, () => [1, 2, z]);

  it("reads subtree files and nodes with the manifest's query string", async () => {
    const fake = fakeEpt(
      {
        "ept.json": manifest,
        "ept-hierarchy/0-0-0-0.json": { "0-0-0-0": 3, "1-0-0-0": 2, "1-1-0-0": -1 },
        "ept-hierarchy/1-1-0-0.json": { "1-1-0-0": 2, "2-2-0-0": 5 },
      },
      { "0-0-0-0": nodePoints(3, 10), "1-0-0-0": nodePoints(2, 20), "1-1-0-0": nodePoints(2, 30) },
    );
    const source = await openEptSource("https://h/data/ept.json?sig=abc", {
      las: fake.las,
      fetchJson: fake.fetchJson,
      fetchBytes: fake.fetchBytes,
      projector: metresProjector,
      lazPerf: async () => ({}),
    });
    assert.equal(source.counts.get("1-1-0-0"), -1, "the subtree is unread at first");
    await source.loadSubtree("1-1-0-0");
    assert.equal(source.counts.get("1-1-0-0"), 2);
    assert.equal(source.counts.get("2-2-0-0"), 5);
    assert.ok(fake.fetched.includes("https://h/data/ept-hierarchy/1-1-0-0.json?sig=abc"));
    const node = await source.loadNode("1-1-0-0");
    assert.ok(fake.fetched.includes("https://h/data/ept-data/1-1-0-0.laz?sig=abc"));
    assert.equal(node.count, 2);
    assert.deepEqual([node.zMin, node.zMax], [30, 30]);
  });

  it("ignores hierarchy keys that are not octree keys", async () => {
    const fake = fakeEpt(
      {
        "ept.json": manifest,
        "ept-hierarchy/0-0-0-0.json": { "0-0-0-0": 1, "../../secret": 5, "1-0-0-0/x": 5 },
      },
      { "0-0-0-0": nodePoints(1, 10) },
    );
    const source = await openEptSource("https://h/data/ept.json", {
      las: fake.las,
      fetchJson: fake.fetchJson,
      fetchBytes: fake.fetchBytes,
      projector: metresProjector,
      lazPerf: async () => ({}),
    });
    assert.deepEqual([...source.counts.keys()], ["0-0-0-0"]);
  });

  it("refuses a node too large to decode", async () => {
    const fake = fakeEpt(
      { "ept.json": manifest, "ept-hierarchy/0-0-0-0.json": { "0-0-0-0": 1 } },
      { "0-0-0-0": nodePoints(1, 10) },
    );
    const huge = {
      Las: {
        ...fake.las.Las,
        Header: { parse: () => ({ pointCount: 1e9, pointDataRecordLength: 34 }) },
      },
    } as unknown as LasModule;
    const source = await openEptSource("https://h/data/ept.json", {
      las: huge,
      fetchJson: fake.fetchJson,
      fetchBytes: fake.fetchBytes,
      projector: metresProjector,
      lazPerf: async () => ({}),
    });
    await assert.rejects(source.loadNode("0-0-0-0"), /too large to decode/);
  });

  it("reads a geographic EPSG code through the default projector", async () => {
    const fake = fakeEpt(
      {
        "ept.json": { ...manifest, srs: { authority: "EPSG", horizontal: "4326" } },
        "ept-hierarchy/0-0-0-0.json": { "0-0-0-0": 1 },
      },
      { "0-0-0-0": [[-95.5, 41.25, 300]] },
    );
    const source = await openEptSource("https://h/data/ept.json", {
      las: fake.las,
      fetchJson: fake.fetchJson,
      fetchBytes: fake.fetchBytes,
      lazPerf: async () => ({}),
    });
    const cloud = await source.loadNode("0-0-0-0");
    assert.ok(Math.abs(cloud.positions[0] + 95.5) < 1e-9, `lng ${cloud.positions[0]}`);
    assert.ok(Math.abs(cloud.positions[1] - 41.25) < 1e-9, `lat ${cloud.positions[1]}`);
    assert.equal(cloud.positions[2], 300);
  });

  it("streams an EPT layer on the globe and tears it down on removal", async () => {
    const fake = fakeEpt(
      { "ept.json": manifest, "ept-hierarchy/0-0-0-0.json": { "0-0-0-0": 2 } },
      { "0-0-0-0": nodePoints(2, 10) },
    );
    const f = makeViewer();
    const sync = new CesiumLayerSync(
      makeCesium({ tilesets: [], i3s: [] }) as never,
      f.viewer as never,
      () => 10,
      {
        eptOptions: {
          las: fake.las,
          fetchJson: fake.fetchJson,
          fetchBytes: fake.fetchBytes,
          projector: metresProjector,
          lazPerf: async () => ({}),
        },
      },
    );
    const ept = layer({ id: "e", type: "lidar", source: { url: "https://h/data/ept.json" } });
    sync.sync([ept]);
    assert.deepEqual(sync.getRenderStatus().pending, ["Layer"], "pending while the root loads");
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(f.primitives.length, 1);
    assert.equal((f.primitives[0] as { length: number }).length, 2, "the root node is shown");
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    sync.sync([]);
    assert.equal(f.primitives.length, 0);
  });

  it("refuses data types it cannot decode", async () => {
    const fake = fakeEpt({ "ept.json": { ...manifest, dataType: "binary" } }, {});
    await assert.rejects(
      openEptSource("https://h/data/ept.json", { fetchJson: fake.fetchJson, las: fake.las }),
      /data type "binary" is not supported/,
    );
  });

  it("refuses a dataset with no usable CRS", async () => {
    const fake = fakeEpt({ "ept.json": { ...manifest, srs: {} } }, {});
    await assert.rejects(
      openEptSource("https://h/data/ept.json", { fetchJson: fake.fetchJson, las: fake.las }),
      /no usable CRS/,
    );
  });

  it("takes the CRS from the EPSG code first, the WKT second", () => {
    assert.deepEqual(eptCrs({ authority: "EPSG", horizontal: "3857", wkt: "W" }), {
      geoKeys: { GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 3857 },
      wkt: "W",
    });
    assert.deepEqual(eptCrs({ wkt: "W" }), { wkt: "W" });
    assert.deepEqual(eptCrs(undefined), {});
  });
});
