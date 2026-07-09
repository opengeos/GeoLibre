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
        const layer = { kind: "imagery", provider, show: true, alpha: 1 };
        calls.imageryAdded.push(layer);
        return layer;
      },
      remove: (layer: unknown, _destroy?: boolean) =>
        calls.imageryRemoved.push(layer),
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
      constructor(opts: Record<string, unknown>) {
        calls.urlProviders.push(opts);
      }
    },
    WebMapServiceImageryProvider: class {
      constructor(opts: Record<string, unknown>) {
        calls.wmsProviders.push(opts);
      }
    },
    GeoJsonDataSource: {
      load: (data: unknown, options: Record<string, unknown>) => {
        calls.geojsonLoads.push({ data, options });
        return Promise.resolve({
          kind: "geojson",
          show: true,
          // One polygon entity so in-place restyle (applyGeoJsonStyle) has
          // something to update; its material starts as the load-time fill.
          entities: { values: [{ polygon: { material: options.fill } }] },
        });
      },
    },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
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

  it("renders a wms layer via WebMapServiceImageryProvider", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "w",
        type: "wms",
        source: { url: "https://wms/service", layers: "topo", tiles: ["ignored{bbox-epsg-3857}"] },
      }),
    ]);
    assert.equal(f.calls.wmsProviders.length, 1);
    assert.equal(f.calls.wmsProviders[0].url, "https://wms/service");
    assert.equal(f.calls.wmsProviders[0].layers, "topo");
    assert.equal(f.calls.urlProviders.length, 0);
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

  it("skips unsupported layer kinds and reports them", () => {
    const sync = newSync(f);
    const layers = [
      mkLayer({ id: "p", type: "pmtiles", source: { url: "x.pmtiles" } }),
      mkLayer({ id: "z", type: "zarr", source: {} }),
    ];
    sync.sync(layers);
    assert.equal(f.calls.imageryAdded.length, 0);
    assert.equal(f.calls.primitivesAdded.length, 0);
    assert.deepEqual(
      sync.unsupported(layers).map((l) => l.id),
      ["p", "z"],
    );
  });
});
