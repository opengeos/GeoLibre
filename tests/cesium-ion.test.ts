import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CESIUM_ION_QUICK_PICKS,
  CESIUM_ION_SOURCE_KIND,
  CESIUM_OSM_BUILDINGS_ASSET_ID,
  cesiumIonAssetId,
  cesiumIonAssetKind,
  createCesiumIonLayer,
  isCesiumIonLayer,
  isCesiumOnlyLayer,
  parseCesiumIonAssetId,
} from "../packages/core/src/cesium-ion";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";

// Cesium Ion assets (issue #2290). The layer builder and the id parser are
// real; the globe is a fake viewer plus a fake Cesium namespace that records
// which Ion factories were called with which token.

describe("cesium-ion layer builder", () => {
  it("parses asset ids from form input and rejects everything else", () => {
    assert.equal(parseCesiumIonAssetId("96188"), 96188);
    assert.equal(parseCesiumIonAssetId(" 2 "), 2);
    assert.equal(parseCesiumIonAssetId(2), 2);
    assert.equal(parseCesiumIonAssetId("0"), null);
    assert.equal(parseCesiumIonAssetId("-3"), null);
    assert.equal(parseCesiumIonAssetId("1.5"), null);
    assert.equal(parseCesiumIonAssetId(""), null);
    assert.equal(parseCesiumIonAssetId(undefined), null);
  });

  it("builds a tileset layer the 2D deck.gl control leaves alone", () => {
    const layer = createCesiumIonLayer({
      name: "Buildings",
      assetId: CESIUM_OSM_BUILDINGS_ASSET_ID,
      kind: "3d-tiles",
      altitudeOffset: 5,
    });
    assert.equal(layer.type, "3d-tiles");
    assert.equal(layer.source.ionAssetId, 96188);
    assert.equal(layer.source.altitudeOffset, 5);
    assert.equal(layer.source.url, undefined, "no tileset URL: the globe resolves the asset");
    assert.equal(layer.metadata.sourceKind, CESIUM_ION_SOURCE_KIND);
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.identifiable, false);
    assert.deepEqual(layer.metadata.nativeLayerIds, [layer.id]);
    assert.equal(cesiumIonAssetId(layer), 96188);
    assert.equal(cesiumIonAssetKind(layer), "3d-tiles");
    assert.equal(isCesiumIonLayer(layer), true);
    assert.equal(isCesiumOnlyLayer(layer), true);
    assert.equal(isCesiumSupportedLayerType(layer), true);
  });

  it("builds an imagery layer as an external raster with no tiles", () => {
    const layer = createCesiumIonLayer({ id: "img", name: "Aerial", assetId: 2, kind: "imagery" });
    assert.equal(layer.id, "img");
    assert.equal(layer.type, "raster");
    assert.equal(layer.source.type, "raster");
    assert.equal(layer.source.tiles, undefined);
    assert.equal("altitudeOffset" in layer.source, false);
    assert.equal(cesiumIonAssetKind(layer), "imagery");
    assert.equal(isCesiumSupportedLayerType(layer), true);
  });

  it("does not mistake an ordinary layer for an Ion asset", () => {
    const plain: GeoLibreLayer = {
      id: "x",
      name: "x",
      type: "3d-tiles",
      source: { type: "3d-tiles", url: "https://a/tileset.json", ionAssetId: 5 },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { sourceKind: "3d-tiles-url" },
    };
    assert.equal(cesiumIonAssetId(plain), null, "the source kind is the contract, not the field");
    assert.equal(isCesiumOnlyLayer(plain), false);
    assert.ok(CESIUM_ION_QUICK_PICKS.some((p) => p.assetId === CESIUM_OSM_BUILDINGS_ASSET_ID));
  });
});

function makeGlobe() {
  const calls = {
    ionResources: [] as Array<{ assetId: number; token?: string }>,
    ionImagery: [] as Array<{ assetId: number; token?: string }>,
    tilesetUrls: [] as unknown[],
    primitives: [] as unknown[],
    imagery: [] as Array<{ provider: unknown; show: boolean; alpha: number }>,
  };
  const Cesium = {
    IonResource: {
      fromAssetId: async (assetId: number, options?: { accessToken?: string }) => {
        calls.ionResources.push({ assetId, token: options?.accessToken });
        return { ion: assetId };
      },
    },
    IonImageryProvider: {
      fromAssetId: async (assetId: number, options?: { accessToken?: string }) => {
        calls.ionImagery.push({ assetId, token: options?.accessToken });
        return { kind: "ion-imagery", assetId };
      },
    },
    Cesium3DTileset: {
      fromUrl: async (url: unknown) => {
        calls.tilesetUrls.push(url);
        return {
          kind: "tileset",
          show: true,
          tilesLoaded: true,
          destroy: () => {},
          boundingSphere: { center: {} },
        };
      },
    },
    Cartographic: { fromCartesian: () => ({ longitude: 0, latitude: 0 }) },
    Cartesian3: Object.assign(class {}, {
      fromRadians: () => ({}),
      subtract: () => ({}),
    }),
    Matrix4: { fromTranslation: () => ({}) },
    Event: class {
      addEventListener() {
        return () => {};
      }
    },
  };
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: { moveEnd: new Cesium.Event(), changed: new Cesium.Event() },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: {
        add: (p: unknown) => calls.primitives.push(p),
        remove: (p: unknown) => calls.primitives.splice(calls.primitives.indexOf(p), 1),
      },
      requestRender: () => {},
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        const layer = { provider, show: true, alpha: 1 };
        calls.imagery.push(layer);
        return layer;
      },
      remove: (layer: { provider: unknown }) =>
        calls.imagery.splice(calls.imagery.indexOf(layer), 1),
      raiseToTop: () => {},
    },
    dataSources: { add: async (ds: unknown) => ds, remove: () => {} },
  };
  return { Cesium, viewer, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CesiumLayerSync with Ion assets", () => {
  it("loads a tileset through an IonResource carrying the app token", async () => {
    const g = makeGlobe();
    const sync = new CesiumLayerSync(g.Cesium as never, g.viewer as never, () => 10, {
      ionToken: () => "tok-123",
    });
    const layer = createCesiumIonLayer({ id: "b", name: "B", assetId: 96188, kind: "3d-tiles" });
    sync.sync([layer]);
    for (let i = 0; i < 4; i++) await flush();
    assert.deepEqual(g.calls.ionResources, [{ assetId: 96188, token: "tok-123" }]);
    assert.deepEqual(g.calls.tilesetUrls, [{ ion: 96188 }]);
    assert.equal(g.calls.primitives.length, 1);
    assert.deepEqual(sync.getRenderStatus(), { pending: [], errors: [] });

    // A different asset id is a rebuild; a rename is not.
    sync.sync([{ ...layer, name: "renamed" }]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(g.calls.ionResources.length, 1);
    sync.sync([{ ...layer, source: { ...layer.source, ionAssetId: 3 } }]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(g.calls.ionResources.length, 2);
    assert.equal(g.calls.ionResources[1].assetId, 3);
    assert.equal(g.calls.primitives.length, 1, "the old tileset was removed");
    sync.destroy();
  });

  it("loads imagery through IonImageryProvider and honours visibility/opacity", async () => {
    const g = makeGlobe();
    const sync = new CesiumLayerSync(g.Cesium as never, g.viewer as never, () => 10, {
      ionToken: () => "tok-abc",
    });
    const layer = createCesiumIonLayer({ id: "i", name: "I", assetId: 2, kind: "imagery" });
    sync.sync([{ ...layer, opacity: 0.4, visible: false }]);
    for (let i = 0; i < 4; i++) await flush();
    assert.deepEqual(g.calls.ionImagery, [{ assetId: 2, token: "tok-abc" }]);
    assert.equal(g.calls.imagery.length, 1);
    assert.equal(g.calls.imagery[0].show, false);
    assert.equal(g.calls.imagery[0].alpha, 0.4);
    sync.destroy();
  });

  it("reports a missing token as a layer error rather than loading with none", async () => {
    const g = makeGlobe();
    const sync = new CesiumLayerSync(g.Cesium as never, g.viewer as never, () => 10, {
      ionToken: () => undefined,
    });
    sync.sync([
      createCesiumIonLayer({ id: "b", name: "Buildings", assetId: 96188, kind: "3d-tiles" }),
      createCesiumIonLayer({ id: "i", name: "Aerial", assetId: 2, kind: "imagery" }),
    ]);
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(g.calls.ionResources.length, 0);
    assert.equal(g.calls.ionImagery.length, 0);
    const status = sync.getRenderStatus();
    assert.equal(status.errors.length, 2);
    assert.match(status.errors[0], /Ion token is not configured/);
    sync.destroy();
  });
});
