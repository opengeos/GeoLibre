import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import {
  MAX_POINT_CLOUD_POINTS,
  buildPointCloudCollection,
  isSplatTilesetUrl,
  loadCopcPointCloud,
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
      null,
      "an EPT manifest is JSON but not a tileset",
    );
    assert.equal(pointCloudSourceKind("https://x/EPT.json?token=1"), null);
    assert.equal(pointCloudSourceKind("https://x/plain.laz"), null);
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
function fakeCopc(options: { color?: boolean; scaleTo16Bit?: boolean } = {}): {
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
        wkt: "PROJCS[fake]",
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

describe("loadCopcPointCloud", () => {
  it("walks the octree breadth-first within the budget and reprojects", async () => {
    const fake = fakeCopc();
    const wkts: string[] = [];
    const cloud = await loadCopcPointCloud("https://x/a.copc.laz", {
      copc: fake.module,
      budget: 550,
      projector: async (wkt) => {
        wkts.push(wkt ?? "");
        return (x, y) => [x / 1000, y / 1000];
      },
      lazPerf: async () => ({}),
    });
    assert.deepEqual(wkts, ["PROJCS[fake]"], "the projector is built from the archive's WKT");
    // Root (100) + two depth-1 nodes (200 each) fit the 550 budget; the depth-2
    // node (300) would overshoot and stops the walk.
    assert.deepEqual(fake.loads, ["100", "200", "200"]);
    assert.equal(cloud.count, 500);
    assert.equal(cloud.truncated, true);
    assert.ok(Math.abs(cloud.positions[0] - 0.1) < 1e-12, "x reprojected");
    assert.ok(Math.abs(cloud.positions[1] - 0.2) < 1e-12, "y reprojected");
    assert.equal(cloud.positions[2], 10);
    assert.equal(cloud.zMin, 10);
    assert.equal(cloud.zMax, 14);
    assert.equal(cloud.colors, null);
  });

  it("loads sub-pages lazily when the walk reaches them and keeps 16-bit colour", async () => {
    const fake = fakeCopc({ color: true, scaleTo16Bit: true });
    const cloud = await loadCopcPointCloud("https://x/a.copc.laz", {
      copc: fake.module,
      budget: MAX_POINT_CLOUD_POINTS,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    assert.deepEqual(fake.loads, ["100", "200", "200", "300", "400"]);
    assert.equal(cloud.count, 1200);
    assert.equal(cloud.truncated, false);
    assert.ok(cloud.colors);
    assert.deepEqual(
      Array.from(cloud.colors!.subarray(0, 3)),
      [10, 20, 30],
      "16-bit colour scaled to 8-bit",
    );
    assert.equal(cloud.positions[0], 100, "identity projector: coordinates pass through");
  });

  it("treats a cloud whose nodes disagree on colour as colourless", async () => {
    const fake = fakeCopc({ color: true });
    let views = 0;
    const mixed: CopcModule = {
      Copc: {
        ...fake.module.Copc,
        loadPointDataView: async (source, copc, n, options) => {
          const view = await fake.module.Copc.loadPointDataView(source, copc, n, options);
          // The second node carries no RGB.
          if (views++ === 1) {
            const { Red: _r, Green: _g, Blue: _b, ...rest } = view.dimensions;
            return { ...view, dimensions: rest };
          }
          return view;
        },
      },
    };
    const cloud = await loadCopcPointCloud("https://x/a.copc.laz", {
      copc: mixed,
      budget: 550,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    assert.equal(cloud.count, 500);
    assert.equal(cloud.colors, null, "no point is left black");
  });

  it("reads only up to the budget from a first node bigger than the budget", async () => {
    const fake = fakeCopc();
    const budget = 60;
    const big = {
      Copc: {
        ...fake.module.Copc,
        loadHierarchyPage: async () => ({
          nodes: {
            "0-0-0-0": { pointCount: budget + 1000, pointDataOffset: 0, pointDataLength: 0 },
          },
          pages: {},
        }),
      },
    };
    const cloud = await loadCopcPointCloud("https://x/a.copc.laz", {
      copc: big,
      budget,
      projector: async () => identity,
      lazPerf: async () => ({}),
    });
    assert.equal(cloud.count, budget, "the primitive count never exceeds the budget");
    assert.equal(cloud.positions.length, budget * 3);
    assert.equal(cloud.truncated, true);
  });

  it("refuses an archive whose CRS cannot be used", async () => {
    const fake = fakeCopc();
    await assert.rejects(
      loadCopcPointCloud("https://x/a.copc.laz", {
        copc: fake.module,
        projector: async () => null,
        lazPerf: async () => ({}),
      }),
      /COPC archive has no usable CRS/,
    );
    assert.equal(fake.pages, 0, "nothing is walked without a CRS");
  });

  it("stops when aborted", async () => {
    const fake = fakeCopc();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      loadCopcPointCloud("https://x/a.copc.laz", {
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
      false,
    );
    assert.equal(
      isCesiumSupportedLayerType(layer({ type: "lidar", source: { url: "https://x/ept.json" } })),
      false,
      "EPT stays 2D-only",
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
        budget: 500,
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
    assert.equal(collection.length, 500);
    assert.equal(collection.get(0).color.alpha, 0.5);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });
    sync.sync([{ ...copc, opacity: 0.2 }]);
    assert.ok(Math.abs(collection.get(0).color.alpha - 0.2) < 1e-9);
    sync.sync([]);
    assert.equal(f.primitives.length, 0);
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
    setPointCloudOpacity(collection as never, 0.1);
    assert.ok(
      Math.abs((collection.get(0) as unknown as { color: { alpha: number } }).color.alpha - 0.1) <
        1e-9,
    );
  });
});
