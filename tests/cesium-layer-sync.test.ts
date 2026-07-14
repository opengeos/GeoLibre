import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import {
  CesiumLayerSync,
  isCesiumSupportedLayerType,
} from "../packages/map/src/cesium-layer-sync";

// Verifies the store → Cesium reconciler against a fake Cesium namespace + viewer
// (the real engine never loads here — its import in the module is type-only). It
// exercises the create path for each supported layer kind, live appearance
// updates, rebuild-on-source-change, removal, and skipping unsupported kinds.

// --- fakes ----------------------------------------------------------------
function makeFakes() {
  const calls = {
    imageryAdded: [] as unknown[],
    imageryRemoved: [] as unknown[],
    imageryStack: [] as { url?: string }[],
    raiseToTopCount: 0,
    dataSourcesAdded: [] as unknown[],
    dataSourcesRemoved: [] as unknown[],
    primitivesAdded: [] as unknown[],
    primitivesRemoved: [] as unknown[],
    urlProviders: [] as Record<string, unknown>[],
    wmsProviders: [] as Record<string, unknown>[],
    geojsonLoads: [] as { data: unknown; options: Record<string, unknown> }[],
    tilesetUrls: [] as unknown[],
  };

  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: {
        add: (p: unknown) => calls.primitivesAdded.push(p),
        remove: (p: unknown) => calls.primitivesRemoved.push(p),
      },
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        const layer = {
          kind: "imagery",
          provider,
          url: (provider as { url?: string }).url,
          show: true,
          alpha: 1,
        };
        calls.imageryAdded.push(layer);
        calls.imageryStack.push(layer);
        return layer;
      },
      remove: (layer: unknown, _destroy?: boolean) => {
        calls.imageryRemoved.push(layer);
        const i = calls.imageryStack.indexOf(layer as { url?: string });
        if (i >= 0) calls.imageryStack.splice(i, 1);
      },
      raiseToTop: (layer: unknown) => {
        calls.raiseToTopCount++;
        const i = calls.imageryStack.indexOf(layer as { url?: string });
        if (i >= 0) calls.imageryStack.push(...calls.imageryStack.splice(i, 1));
      },
    },
    dataSources: {
      add: (ds: unknown) => {
        calls.dataSourcesAdded.push(ds);
        return Promise.resolve(ds);
      },
      remove: (ds: unknown, _destroy?: boolean) =>
        calls.dataSourcesRemoved.push(ds),
    },
  };

  const Cesium = {
    UrlTemplateImageryProvider: class {
      url?: string;
      constructor(opts: Record<string, unknown>) {
        this.url = opts.url as string | undefined;
        calls.urlProviders.push(opts);
      }
    },
    WebMapServiceImageryProvider: class {
      url?: string;
      constructor(opts: Record<string, unknown>) {
        this.url = opts.url as string | undefined;
        calls.wmsProviders.push(opts);
      }
    },
    GeoJsonDataSource: {
      load: (data: unknown, options: Record<string, unknown>) => {
        calls.geojsonLoads.push({ data, options });
        return Promise.resolve({
          kind: "geojson",
          show: true,
          // One entity of each kind so in-place restyle (applyGeoJsonStyle) can
          // be checked for polygons, lines, and points.
          entities: {
            values: [
              { polygon: { material: options.fill } },
              { polyline: { material: options.stroke } },
              { billboard: { color: undefined } },
            ],
          },
        });
      },
    },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ConstantProperty: class {
      constructor(public value: unknown) {}
    },
    Cesium3DTileset: {
      fromUrl: (url: unknown) => {
        calls.tilesetUrls.push(url);
        return Promise.resolve({
          kind: "tileset",
          show: true,
          destroy: () => {},
          modelMatrix: null,
          boundingSphere: { center: {} },
        });
      },
    },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        withAlpha: (a: number) => ({ css, alpha: a }),
      }),
      WHITE: { withAlpha: (a: number) => ({ css: "WHITE", alpha: a }) },
    },
    Resource: class {
      constructor(public opts: Record<string, unknown>) {}
    },
  };

  // Flush the microtasks behind the async create paths (load → add / fromUrl).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  return { calls, viewer, Cesium, flush };
}

function mkLayer(over: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l1",
    name: "layer",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    ...over,
  } as GeoLibreLayer;
}

function newSync(f: ReturnType<typeof makeFakes>) {
  // The fakes stand in for the Cesium namespace + Viewer (cast through unknown).
  return new CesiumLayerSync(
    f.Cesium as unknown as typeof import("cesium"),
    f.viewer as unknown as import("cesium").Viewer,
  );
}

// --- tests -----------------------------------------------------------------
describe("CesiumLayerSync", () => {
  let f: ReturnType<typeof makeFakes>;
  beforeEach(() => {
    f = makeFakes();
  });

  it("renders a geojson layer as a draped GeoJsonDataSource", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    sync.sync([mkLayer({ type: "geojson", geojson: fc as never, visible: true })]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 1);
    assert.equal(f.calls.geojsonLoads[0].data, fc);
    assert.equal(f.calls.geojsonLoads[0].options.clampToGround, true);
    assert.equal(f.calls.dataSourcesAdded.length, 1);
  });

  it("skips a geojson layer with no features", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({ type: "geojson", geojson: { type: "FeatureCollection", features: [] } as never }),
    ]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 0);
  });

  it("restyles a geojson layer's fill opacity in place without reloading", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    const base = mkLayer({
      type: "geojson",
      geojson: fc as never,
      opacity: 1,
      style: { fillOpacity: 0.6 },
    });
    sync.sync([base]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 1);
    const ds = f.calls.dataSourcesAdded[0] as {
      entities: { values: { polygon: { material: { color?: { alpha: number } } } }[] };
    };

    // Change only the layer opacity: no reload, no teardown — the fill alpha is
    // updated on the existing entity (0.6 fill opacity × 0.3 layer opacity).
    sync.sync([{ ...base, opacity: 0.3 }]);
    assert.equal(f.calls.geojsonLoads.length, 1, "opacity change must not reload");
    assert.equal(f.calls.dataSourcesRemoved.length, 0, "opacity change must not tear down");
    const alpha = ds.entities.values[0].polygon.material.color?.alpha;
    assert.ok(alpha !== undefined && Math.abs(alpha - 0.18) < 1e-9);
  });

  it("fades polygon fill, line stroke, and point markers by layer opacity", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    sync.sync([
      mkLayer({
        type: "geojson",
        geojson: fc as never,
        opacity: 0.4,
        style: { fillOpacity: 0.5 },
      }),
    ]);
    await f.flush();
    const ds = f.calls.dataSourcesAdded[0] as {
      entities: {
        values: [
          { polygon: { material: { color: { alpha: number } } } },
          { polyline: { material: { color: { alpha: number } } } },
          { billboard: { color: { value: { alpha: number } } } },
        ];
      };
    };
    const v = ds.entities.values;
    // fill = 0.5 fill opacity × 0.4 layer opacity; stroke/markers = layer opacity.
    assert.ok(Math.abs(v[0].polygon.material.color.alpha - 0.2) < 1e-9);
    assert.ok(Math.abs(v[1].polyline.material.color.alpha - 0.4) < 1e-9);
    assert.ok(Math.abs(v[2].billboard.color.value.alpha - 0.4) < 1e-9);
  });

  it("renders xyz/raster tiles as an imagery layer with opacity + visibility", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "x",
        type: "xyz",
        source: { tiles: ["https://t/{z}/{x}/{y}.png"], maxzoom: 18 },
        opacity: 0.5,
        visible: false,
      }),
    ]);
    assert.equal(f.calls.urlProviders.length, 1);
    assert.equal(f.calls.urlProviders[0].url, "https://t/{z}/{x}/{y}.png");
    assert.equal(f.calls.imageryAdded.length, 1);
    const layer = f.calls.imageryAdded[0] as { alpha: number; show: boolean };
    assert.equal(layer.alpha, 0.5);
    assert.equal(layer.show, false);
  });

  it("renders a wms layer via WebMapServiceImageryProvider with its GetMap params", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "w",
        type: "wms",
        source: {
          url: "https://wms/service",
          layers: "topo",
          styles: "boundaries",
          format: "image/jpeg",
          transparent: false,
          version: "1.3.0",
          tiles: ["ignored{bbox-epsg-3857}"],
        },
      }),
    ]);
    assert.equal(f.calls.wmsProviders.length, 1);
    assert.equal(f.calls.wmsProviders[0].url, "https://wms/service");
    assert.equal(f.calls.wmsProviders[0].layers, "topo");
    // The user's chosen style/format/version/transparent must pass through so
    // the globe matches the 2D map (not silent defaults).
    const params = f.calls.wmsProviders[0].parameters as Record<string, unknown>;
    assert.equal(params.styles, "boundaries");
    assert.equal(params.format, "image/jpeg");
    assert.equal(params.version, "1.3.0");
    assert.equal(params.transparent, false);
    assert.equal(f.calls.urlProviders.length, 0);
  });

  it("re-asserts imagery stacking in store order after a middle-layer rebuild", () => {
    const sync = newSync(f);
    const A = mkLayer({ id: "a", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    const B = mkLayer({ id: "b", type: "xyz", source: { tiles: ["b/{z}/{x}/{y}"] } });
    const C = mkLayer({ id: "c", type: "xyz", source: { tiles: ["c/{z}/{x}/{y}"] } });
    sync.sync([A, B, C]);
    // Rebuild the middle layer (its handle re-appends to the top); the reorder
    // pass must restore [a, b2, c] bottom-to-top instead of leaving [a, c, b2].
    sync.sync([A, { ...B, source: { tiles: ["b2/{z}/{x}/{y}"] } }, C]);
    assert.deepEqual(
      f.calls.imageryStack.map((l) => l.url),
      ["a/{z}/{x}/{y}", "b2/{z}/{x}/{y}", "c/{z}/{x}/{y}"],
    );
  });

  it("rebuilds a wms layer when a GetMap param (e.g. styles) changes", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "w",
      type: "wms",
      source: { url: "https://wms/service", layers: "topo", styles: "a" },
    });
    sync.sync([base]);
    sync.sync([{ ...base, source: { ...base.source, styles: "b" } }]);
    assert.equal(f.calls.wmsProviders.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
    assert.equal((f.calls.wmsProviders[1].parameters as { styles: string }).styles, "b");
  });

  it("skips the imagery reorder pass when nothing affects stacking", () => {
    const sync = newSync(f);
    const A = mkLayer({ id: "a", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    const B = mkLayer({ id: "b", type: "xyz", source: { tiles: ["b/{z}/{x}/{y}"] } });
    sync.sync([A, B]);
    const afterCreate = f.calls.raiseToTopCount;
    assert.ok(afterCreate > 0, "creating imagery re-asserts order");
    // A pure opacity change reruns sync() but must not touch imagery stacking.
    sync.sync([{ ...A, opacity: 0.5 }, B]);
    assert.equal(f.calls.raiseToTopCount, afterCreate, "no redundant reorder");
  });

  it("renders a 3d-tiles layer as a primitive from its tileset url", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({ id: "t", type: "3d-tiles", source: { url: "https://tiles/root.json" } }),
    ]);
    await f.flush();
    assert.equal(f.calls.tilesetUrls[0], "https://tiles/root.json");
    assert.equal(f.calls.primitivesAdded.length, 1);
  });

  it("keeps the Google Maps API key header on a Google Photorealistic tileset", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "g",
        type: "3d-tiles",
        source: {
          url: "https://tile.googleapis.com/v1/3dtiles/root.json",
          // The 3D-tiles resolver keeps a real key present in the headers; this
          // asserts createTileset routes headers through it (a plain pass-through
          // would also work, but the store normally strips the key, so the
          // resolver's env fallback is what makes Google tiles load on the globe).
          requestHeaders: { "X-GOOG-API-KEY": "test-key" },
        },
      }),
    ]);
    await f.flush();
    const resource = f.calls.tilesetUrls[0] as {
      opts: { headers: Record<string, string> };
    };
    assert.equal(resource.opts.headers["X-GOOG-API-KEY"], "test-key");
  });

  it("updates visibility in place without recreating the imagery layer", () => {
    const sync = newSync(f);
    const base = mkLayer({ id: "x", type: "xyz", source: { tiles: ["u/{z}/{x}/{y}"] }, visible: true });
    sync.sync([base]);
    sync.sync([{ ...base, visible: false }]);
    assert.equal(f.calls.imageryAdded.length, 1); // created once
    assert.equal(f.calls.imageryRemoved.length, 0);
    assert.equal((f.calls.imageryAdded[0] as { show: boolean }).show, false);
  });

  it("rebuilds the imagery layer when the tile url changes", () => {
    const sync = newSync(f);
    const base = mkLayer({ id: "x", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    sync.sync([base]);
    sync.sync([{ ...base, source: { tiles: ["b/{z}/{x}/{y}"] } }]);
    assert.equal(f.calls.imageryAdded.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
  });

  it("forwards min/maxzoom and rebuilds an xyz layer when they change", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "x",
      type: "xyz",
      source: { tiles: ["u/{z}/{x}/{y}"], minzoom: 3, maxzoom: 18 },
    });
    sync.sync([base]);
    assert.equal(f.calls.urlProviders[0].minimumLevel, 3);
    assert.equal(f.calls.urlProviders[0].maximumLevel, 18);
    sync.sync([{ ...base, source: { ...base.source, maxzoom: 22 } }]);
    assert.equal(f.calls.imageryAdded.length, 2, "maxzoom change rebuilds");
    assert.equal(f.calls.urlProviders[1].maximumLevel, 22);
    sync.sync([
      { ...base, source: { ...base.source, minzoom: 5, maxzoom: 22 } },
    ]);
    assert.equal(f.calls.imageryAdded.length, 3, "minzoom change rebuilds");
    assert.equal(f.calls.urlProviders[2].minimumLevel, 5);
  });

  it("removes a layer's handle when it leaves the layer list", () => {
    const sync = newSync(f);
    sync.sync([mkLayer({ id: "x", type: "xyz", source: { tiles: ["u/{z}/{x}/{y}"] } })]);
    sync.sync([]);
    assert.equal(f.calls.imageryRemoved.length, 1);
  });

  it("classifies supported vs 2D-only layer kinds", () => {
    for (const type of ["geojson", "xyz", "raster", "wms", "wmts", "3d-tiles"] as const) {
      assert.equal(isCesiumSupportedLayerType(mkLayer({ type })), true, type);
    }
    for (const type of ["pmtiles", "mbtiles", "zarr", "lidar", "gaussian-splat", "deckgl-viz"] as const) {
      assert.equal(isCesiumSupportedLayerType(mkLayer({ type })), false, type);
    }
  });

  it("skips unsupported layer kinds", () => {
    const sync = newSync(f);
    const layers = [
      mkLayer({ id: "p", type: "pmtiles", source: { url: "x.pmtiles" } }),
      mkLayer({ id: "z", type: "zarr", source: {} }),
    ];
    sync.sync(layers);
    assert.equal(f.calls.imageryAdded.length, 0);
    assert.equal(f.calls.primitivesAdded.length, 0);
    // The kind-level predicate the UI uses to flag "2D only" layers agrees.
    assert.deepEqual(
      layers.filter((l) => !isCesiumSupportedLayerType(l)).map((l) => l.id),
      ["p", "z"],
    );
  });
});
