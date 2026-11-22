import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { ARCGIS_CAPABILITIES } from "../packages/map/src/arcgis-engine";
import { compileArcgisLayer } from "../packages/map/src/arcgis-layers";
import { ArcgisControlHost } from "../packages/map/src/arcgis-control-host";
import { MAPBOX_CAPABILITIES } from "../packages/map/src/mapbox-engine";
import {
  pngBytesToDataUrl,
  registerMapboxCogDem,
  transformMapboxCogDemRequest,
} from "../packages/map/src/mapbox-cog-terrain";
import {
  CESIUM_SUPPORTED_LAYER_KINDS,
  CesiumLayerSync,
  isCesiumSupportedLayerType,
} from "../packages/map/src/cesium-layer-sync";
import type { CogDemSourceRegistration } from "../packages/map/src/cog-dem-source";

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: overrides.id ?? "test-layer",
    name: overrides.name ?? "Test Layer",
    type: overrides.type ?? "geojson",
    source: overrides.source ?? { type: "geojson" },
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 1,
    style: { ...DEFAULT_LAYER_STYLE, ...(overrides.style ?? {}) },
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

describe("PR 5b: ArcGIS parity (measureTool + native 3D SceneView layers)", () => {
  it("enables measureTool on ArcGIS and forwards double-click events in ArcgisControlHost", () => {
    assert.equal(ARCGIS_CAPABILITIES.measureTool, true);

    const listeners = new Map<string, (ev: unknown) => void>();
    const fakeView = {
      type: "2d",
      container: null,
      map: null,
      stationary: true,
      extent: {},
      rotation: 0,
      ui: { add() {}, remove() {} },
      on(name: string, fn: (ev: unknown) => void) {
        listeners.set(name, fn);
        return { remove() {} };
      },
    };
    const fakeEngine = {
      readView: () => ({ center: [-84, 36] as [number, number], zoom: 10, bearing: 0, pitch: 0 }),
      readProjection: () => "mercator",
      getViewBounds: () => [-85, 35, -83, 37],
      applyView() {},
      easeToView() {},
      fitBounds() {},
      getRenderSurface: () => ({
        getCanvas: () => null,
        getContainer: () => null,
        getBearing: () => 0,
        project: () => ({ x: 10, y: 20 }),
        unproject: () => ({ lng: -83.9, lat: 35.95 }),
        redraw() {},
      }),
    };
    const fakeSdk = {
      reactiveUtils: { watch: () => ({ remove() {} }) },
      layers: { GraphicsLayer: class {} },
      Graphic: class {},
    };
    const host = new ArcgisControlHost(fakeEngine as never, fakeView as never, fakeSdk as never);
    let dblClickFired = false;
    host.getControlMap().on("dblclick", (ev: { lngLat: { lng: number; lat: number } }) => {
      dblClickFired = true;
      assert.equal(ev.lngLat.lng, -83.9);
      assert.equal(ev.lngLat.lat, 35.95);
    });
    const handler = listeners.get("double-click");
    assert.ok(handler, "ArcgisControlHost must subscribe to view double-click");
    handler({ x: 42, y: 84, stopPropagation() {} });
    assert.equal(dblClickFired, true);
    host.destroy();
  });

  it("compiles I3S SceneServer, OGC 3D Tiles, and PointCloud SceneServer to native SceneView plans", () => {
    const i3s = makeLayer({
      id: "i3s-1",
      type: "3d-tiles",
      source: {
        type: "3d-tiles",
        url: "https://tiles.arcgis.com/tiles/x/arcgis/rest/services/Buildings/SceneServer",
      },
      metadata: { sourceKind: "arcgis-i3s" },
    });
    const i3sPlan = compileArcgisLayer(i3s, { scene: true });
    assert.equal(i3sPlan.kind, "scene-layer");

    const ogc3d = makeLayer({
      id: "ogc-1",
      type: "3d-tiles",
      source: { type: "3d-tiles", url: "https://example.com/tiles/tileset.json" },
      metadata: { sourceKind: "3d-tiles-url" },
    });
    const ogcPlan = compileArcgisLayer(ogc3d, { scene: true });
    assert.equal(ogcPlan.kind, "integrated-mesh-3d-tiles");

    const pc = makeLayer({
      id: "pc-1",
      type: "lidar",
      source: {
        type: "lidar",
        url: "https://tiles.arcgis.com/tiles/x/arcgis/rest/services/Lidar/SceneServer",
      },
    });
    const pcPlan = compileArcgisLayer(pc, { scene: true });
    assert.equal(pcPlan.kind, "point-cloud-layer");

    const arcgisScene = makeLayer({
      id: "scene-1",
      type: "arcgis",
      source: {
        type: "arcgis",
        url: "https://tiles.arcgis.com/tiles/x/arcgis/rest/services/City/SceneServer",
      },
    });
    assert.equal(compileArcgisLayer(arcgisScene, { scene: true }).kind, "scene-layer");
    assert.throws(() => compileArcgisLayer(arcgisScene, { scene: false }), /SceneView/);
  });
});

describe("PR 5b: Mapbox custom COG DEM terrain", () => {
  it("enables terrainSource and intercepts synthetic COG DEM tiles into PNG data URLs", async () => {
    assert.equal(MAPBOX_CAPABILITIES.terrainSource, true);

    // Non-COG URLs pass through synchronously.
    const passthrough = transformMapboxCogDemRequest("https://api.mapbox.com/v4/tiles/0/0/0.png");
    assert.deepEqual(passthrough, { url: "https://api.mapbox.com/v4/tiles/0/0/0.png" });

    let lastRequested: [number, number, number] | null = null;
    const fakeReg: CogDemSourceRegistration = {
      tiles: ["cog-dem://1/{z}/{x}/{y}"],
      bounds: [-84, 35, -83, 36],
      renderTile: async (z, x, y) => {
        lastRequested = [z, x, y];
        return new Uint8ClampedArray(4);
      },
      dispose() {},
    };
    const fakePng = new Uint8Array([137, 80, 78, 71]).buffer;
    const binding = registerMapboxCogDem(fakeReg, async () => fakePng);
    try {
      const tileUrl = binding.tileUrlTemplate
        .replace("{z}", "12")
        .replace("{x}", "1095")
        .replace("{y}", "1610");
      const transformed = await transformMapboxCogDemRequest(tileUrl);
      assert.deepEqual(lastRequested, [12, 1095, 1610]);
      assert.equal(transformed.url, pngBytesToDataUrl(fakePng));
      assert.ok(transformed.url.startsWith("data:image/png;base64,"));
    } finally {
      binding.unregister();
    }
    const staleUrl = binding.tileUrlTemplate
      .replace("{z}", "0")
      .replace("{x}", "0")
      .replace("{y}", "0");
    await assert.rejects(
      () => Promise.resolve(transformMapboxCogDemRequest(staleUrl)),
      /no longer available/,
    );
  });
});

describe("PR 5b: Cesium video overlay and DuckDB query parity", () => {
  it("reports video and duckdb-query as supported and syncs both onto Cesium", async () => {
    assert.equal(CESIUM_SUPPORTED_LAYER_KINDS.video, "native");
    assert.equal(CESIUM_SUPPORTED_LAYER_KINDS["duckdb-query"], "plugin");

    const videoLayer = makeLayer({
      id: "vid-1",
      name: "Drone Video",
      type: "video",
      source: {
        type: "video",
        urls: ["https://example.com/drone.mp4"],
        coordinates: [
          [-84.0, 36.0],
          [-83.9, 36.0],
          [-83.9, 35.9],
          [-84.0, 35.9],
        ],
      },
    });
    assert.equal(isCesiumSupportedLayerType(videoLayer), true);

    const duckdbLayer = makeLayer({
      id: "duck-1",
      name: "DuckDB Query",
      type: "duckdb-query",
      metadata: { sourceKind: "duckdb-query" },
    });
    assert.equal(isCesiumSupportedLayerType(duckdbLayer), true);

    const addedDataSources: unknown[] = [];
    const removedDataSources: unknown[] = [];
    let geoJsonLoads = 0;
    let videoPaused = false;
    let videoPlayed = false;
    const fakeVideo = {
      crossOrigin: "",
      muted: false,
      loop: false,
      playsInline: false,
      autoplay: false,
      src: "",
      firstChild: null,
      play() {
        videoPlayed = true;
        return Promise.resolve();
      },
      pause() {
        videoPaused = true;
      },
      removeAttribute(attr: string) {
        if (attr === "src") this.src = "";
      },
      load() {},
    };

    class FakeCustomDataSource {
      show = true;
      entities = {
        values: [] as unknown[],
        add(spec: Record<string, unknown>) {
          const entity = { ...spec };
          this.values.push(entity);
          return entity;
        },
      };
      constructor(public name: string) {}
    }

    class FakeImageMaterialProperty {
      color: unknown;
      image: unknown;
      constructor(opts: { image: unknown; color: unknown }) {
        this.image = opts.image;
        this.color = opts.color;
      }
    }

    const fakeCesium = {
      CustomDataSource: FakeCustomDataSource,
      ImageMaterialProperty: FakeImageMaterialProperty,
      ClassificationType: { BOTH: 2 },
      Cartesian3: { fromDegreesArray: (coords: number[]) => coords },
      Color: {
        WHITE: { withAlpha: (a: number) => ({ alpha: a }) },
        fromCssColorString: (s: string) => ({ css: s, withAlpha: (a: number) => ({ css: s, a }) }),
      },
      GeoJsonDataSource: {
        load: async () => {
          geoJsonLoads += 1;
          return { show: true, entities: { values: [] } };
        },
      },
    };
    const fakeViewer = {
      dataSources: {
        add: async (ds: unknown) => {
          addedDataSources.push(ds);
          return ds;
        },
        remove: (ds: unknown) => {
          removedDataSources.push(ds);
          return true;
        },
      },
      imageryLayers: { addImageryProvider: () => ({}), remove() {}, raiseToTop() {} },
      scene: {
        primitives: { add() {}, remove() {} },
        requestRender() {},
        canvas: { clientWidth: 800, clientHeight: 600 },
        mode: 3,
      },
      camera: { moveEnd: { addEventListener: () => () => {} } },
    };

    const sync = new CesiumLayerSync(fakeCesium as never, fakeViewer as never, () => 1, {
      createVideoElement: () => fakeVideo as unknown as HTMLVideoElement,
      getDuckDBGeoJson: (id) =>
        id === "duck-1"
          ? {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: { name: "Knoxville" },
                  geometry: { type: "Point", coordinates: [-83.92, 35.96] },
                },
              ],
            }
          : null,
    });

    sync.sync([videoLayer, duckdbLayer]);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(addedDataSources.length, 2, "Expected both video and duckdb-query data sources");
    assert.equal(geoJsonLoads, 1, "Expected duckdb-query to materialize through GeoJSON pipeline");
    assert.equal(fakeVideo.src, "https://example.com/drone.mp4");
    assert.equal(fakeVideo.muted, true);
    assert.equal(fakeVideo.loop, true);
    assert.equal(videoPlayed, true);

    // Tear down both layers cleanly and confirm video is paused & src cleared.
    sync.sync([]);
    assert.equal(videoPaused, true);
    assert.equal(fakeVideo.src, "");
    assert.equal(removedDataSources.length, 2);
  });
});
