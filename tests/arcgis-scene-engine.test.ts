import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer, MapViewState } from "../packages/core/src/index";
import { ArcGISSceneEngine } from "../packages/map/src/engine/arcgis-scene-engine";
import { ARC_GIS_FEATURE_INDEX } from "../packages/map/src/engine/arcgis-feature-query";
import { createArcGISSceneFakeRuntime } from "./arcgis-engine-fake";

const initialView: MapViewState = {
  center: [8.55, 47.37],
  zoom: 8,
  bearing: 10,
  pitch: 25,
};

function layer(id: string, type: GeoLibreLayer["type"]): GeoLibreLayer {
  return {
    id,
    name: id,
    type,
    source:
      type === "wms"
        ? { url: "https://example.test/wms" }
        : { tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"] },
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    ...(type === "geojson"
      ? { geojson: { type: "FeatureCollection" as const, features: [] } }
      : {}),
  } as GeoLibreLayer;
}

test("ArcGISSceneEngine lazy-loads SceneView, uses local assets, and reconciles core store layers", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  let loads = 0;
  const engine = new ArcGISSceneEngine({
    loadArcGIS: async () => {
      loads += 1;
      return runtime.modules;
    },
    assetsPath: () => "/app/arcgis-assets",
  });
  engine.syncLayers([
    layer("geo", "geojson"),
    layer("wms", "wms"),
    { ...layer("vector", "vector-tiles"), source: { url: "https://example.test/VectorTileServer" } },
    {
      ...layer("image", "image"),
      source: {
        url: "https://example.test/overlay.png",
        coordinates: [[8, 48], [9, 48], [9, 47], [8, 47]],
      },
    },
    {
      ...layer("video", "video"),
      source: {
        urls: ["https://example.test/overlay.mp4"],
        coordinates: [[8, 48], [9, 48], [9, 47], [8, 47]],
      },
    },
    layer("tiles", "3d-tiles"),
  ]);
  assert.equal(loads, 0);
  await engine.mount({} as HTMLElement, initialView);

  assert.equal(loads, 1);
  assert.equal(runtime.config.assetsPath, "/app/arcgis-assets");
  assert.deepEqual(runtime.layerOrders.at(-1), ["geolibre-geo", "geolibre-wms", "geolibre-vector", "geolibre-image", "geolibre-video"]);
  assert.equal(runtime.currentLayers[2]?.properties.url, "https://example.test/VectorTileServer");
  assert.equal(
    (runtime.currentLayers[3]?.properties.source as { readonly georeference?: { readonly type?: string } })
      .georeference?.type,
    "corners",
  );
  assert.equal(
    (runtime.currentLayers[4]?.properties.source as { readonly video?: string }).video,
    "https://example.test/overlay.mp4",
  );
  assert.equal(runtime.basemapLayers[0]?.properties.title, "OpenStreetMap");
  assert.equal(runtime.basemapLayers[0]?.properties.copyright, "© OpenStreetMap contributors");
  assert.equal(engine.supportsLayer(layer("tiles", "3d-tiles")), false);
  assert.equal(engine.layers.hasRenderTarget("tiles"), false);

  engine.configure({ basemapVisible: false, basemapOpacity: 0.4 });
  assert.equal(runtime.basemapLayers[0]?.visible, false);
  assert.equal(runtime.basemapLayers[0]?.opacity, 0.4);
  assert.equal(engine.layers.setRasterTiles("wms", ["https://example.test/new/{z}/{x}/{y}.png"]), false);
  assert.deepEqual(engine.controls.getBuiltInState("compass"), {
    visible: true,
    position: "top-right",
  });
  assert.equal(engine.controls.setBuiltInState("scale", { visible: false }), false);
  engine.destroy();
  assert.equal(runtime.destroyed.value, true);
});

test("ArcGISSceneEngine derives bounds from public projected view corners", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount(
    { getBoundingClientRect: () => ({ width: 120, height: 80 }) } as unknown as HTMLElement,
    initialView,
  );
  assert.deepEqual(engine.camera.readBounds(), [0, 0, 120, 80]);
});

test("ArcGISSceneEngine classifies explicit ArcGIS I3S layers before mounting", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const metadataUrls: string[] = [];
  const engine = new ArcGISSceneEngine({
    loadArcGIS: async () => runtime.modules,
    loadI3SMetadata: async (url) => {
      metadataUrls.push(url);
      return { layers: [{ layerType: "IntegratedMesh" }] };
    },
  });
  const i3s = {
    ...layer("mesh", "3d-tiles"),
    source: { url: "https://services.example.test/City/SceneServer/layers/0" },
    metadata: { sourceKind: "arcgis-i3s" },
  } as GeoLibreLayer;

  engine.syncLayers([layer("geo", "geojson"), i3s]);
  await engine.mount({} as HTMLElement, initialView);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(metadataUrls, ["https://services.example.test/City/SceneServer/layers/0"]);
  assert.equal(engine.supportsLayer(i3s), true);
  assert.deepEqual(runtime.layerOrders.at(-1), ["geolibre-geo", "geolibre-mesh"]);
  assert.equal(runtime.currentLayers[1]?.properties.arcgisLayerKind, "integrated-mesh");
});

test("ArcGISSceneEngine preserves 3D camera pitch and emits only user navigation", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount({} as HTMLElement, initialView);
  const events: Array<{ readonly zoom: number; readonly userDriven: boolean }> = [];
  engine.on("moveend", ({ view, userDriven }) => events.push({ zoom: view.zoom, userDriven }));

  engine.applyView({ ...initialView, pitch: 50 });
  assert.equal(engine.readView().pitch, 50);
  runtime.view?.emitUserMove();
  assert.deepEqual(events, [{ zoom: 9, userDriven: true }]);
  assert.deepEqual(engine.viewport.unproject({ x: 8, y: 47 }), [8, 47]);
  engine.destroy();
});

test("ArcGISSceneEngine resolves cancelable point and bounds gestures through public view events", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount({} as HTMLElement, initialView);
  const point = engine.interactions.pickPoint();
  runtime.view?.emitInput("click", { mapPoint: { longitude: 8.6, latitude: 47.4 } });
  assert.deepEqual(await point, [8.6, 47.4]);

  const previews: Array<readonly number[] | null> = [];
  const bounds = engine.interactions.drawBounds({
    aspectRatio: 2,
    onPreview: (value) => previews.push(value),
  });
  runtime.view?.emitInput("drag", {
    action: "start",
    button: 0,
    mapPoint: { longitude: 8, latitude: 47 },
  });
  runtime.view?.emitInput("drag", {
    action: "end",
    button: 0,
    mapPoint: { longitude: 10, latitude: 48 },
  });
  assert.deepEqual(await bounds, [8, 47, 10, 48]);
  assert.deepEqual(previews, [[8, 47, 10, 48], null]);

  const controller = new AbortController();
  const cancelled = engine.interactions.drawBounds({ signal: controller.signal });
  controller.abort();
  assert.equal(await cancelled, null);
});

test("ArcGISSceneEngine suspends public navigation actions and restores them exactly", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount({} as HTMLElement, initialView);
  engine.interactions.setDoubleClickZoomEnabled(false);
  let stopped = 0;
  runtime.view?.emitInput("double-click", { stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1);
  engine.interactions.setDoubleClickZoomEnabled(true);
  runtime.view?.emitInput("double-click", { stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 1);

  const restore = engine.interactions.suspendNavigation();
  assert.deepEqual(runtime.view?.navigation.actionMap, {
    dragPrimary: "none",
    dragSecondary: "none",
    dragTertiary: "none",
    mouseWheel: "none",
  });
  assert.equal(runtime.view?.navigation.browserTouchPanEnabled, false);
  assert.equal(runtime.view?.navigation.momentumEnabled, false);
  assert.equal(runtime.view?.navigation.gamepad.enabled, false);
  restore();
  assert.deepEqual(runtime.view?.navigation.actionMap, {
    dragPrimary: "pan",
    dragSecondary: "rotate",
    dragTertiary: "zoom",
    mouseWheel: "zoom",
  });
  assert.equal(runtime.view?.navigation.browserTouchPanEnabled, true);
  assert.equal(runtime.view?.navigation.momentumEnabled, true);
  assert.equal(runtime.view?.navigation.gamepad.enabled, true);
});

test("ArcGISSceneEngine owns DOM marker presentation without changing store layers", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const element = {
    style: {} as CSSStyleDeclaration,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    remove: () => undefined,
    setPointerCapture: () => undefined,
  } as unknown as HTMLElement;
  const container = {
    append: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLElement;
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount(container, initialView);
  const marker = engine.interactions.createMarker({
    lngLat: [8.55, 47.37],
    element,
    anchor: "bottom",
  });
  marker.setRotation(42);
  marker.setLngLat([9, 48]);

  assert.deepEqual(marker.getLngLat(), [9, 48]);
  assert.equal(element.style.left, "9px");
  assert.equal(element.style.top, "48px");
  assert.equal(element.style.transform, "translate(-50%, -100%) rotate(42deg)");
  assert.deepEqual(engine.layers.listRenderTargets().map((target) => target.id), []);
  marker.remove();
});

test("ArcGISSceneEngine identifies only store-backed GeoJSON features", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const geo = {
    ...layer("geo", "geojson"),
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          id: "zurich",
          properties: { name: "Zürich" },
          geometry: { type: "Point" as const, coordinates: [8.55, 47.37] },
        },
      ],
    },
  };
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  engine.syncLayers([geo]);
  await engine.mount({} as HTMLElement, initialView);
  runtime.hitTestResults = [
    {
      type: "graphic",
      layer: { id: "geolibre-geo" },
      graphic: { attributes: { [ARC_GIS_FEATURE_INDEX]: 0 } },
    },
  ];

  assert.equal(engine.supports("feature-query"), true);
  assert.deepEqual(await engine.hitTest({ x: 8.55, y: 47.37 }), [
    {
      layerId: "geo",
      featureId: "zurich",
      properties: { name: "Zürich" },
      geometry: { type: "Point", coordinates: [8.55, 47.37] },
    },
  ]);
  engine.destroy();
});

test("ArcGISSceneEngine owns one public View popup and reports closure", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount({} as HTMLElement, initialView);
  const content = {} as HTMLElement;
  let closed = 0;

  engine.interactions.showPopup({
    id: "reverse-geocode",
    lngLat: [8.55, 47.37],
    content,
    closeOnClick: false,
    onClose: () => {
      closed += 1;
    },
  });
  await Promise.resolve();
  assert.deepEqual(runtime.view?.popupOpenOptions?.location, { longitude: 8.55, latitude: 47.37 });
  assert.equal(runtime.view?.popupOpenOptions?.content, content);
  runtime.view?.closePopup();
  assert.equal(runtime.view?.closePopupCount, 1);
  assert.equal(closed, 1);
  engine.interactions.closePopup("reverse-geocode");
  assert.equal(closed, 1);
  engine.destroy();
});

test("ArcGISSceneEngine captures documented screenshot data without persisting hidden overlays", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  const context = { putImageData: () => undefined };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const container = {
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
    ownerDocument: { createElement: () => canvas },
  } as unknown as HTMLElement;
  await engine.mount(container, initialView);
  engine.interactions.upsertGeoJsonOverlay({
    id: "print-preview",
    data: { type: "FeatureCollection", features: [] },
  });

  const capture = await engine.viewport.capture({
    bounds: [0, 0, 20, 10],
    hideOverlayIds: ["print-preview"],
  });

  assert.equal(capture.canvas, canvas);
  assert.deepEqual([capture.width, capture.height], [200, 100]);
  assert.equal(capture.bearing, initialView.bearing);
  assert.ok(capture.metersPerPixel > 0);
  assert.deepEqual(runtime.view?.screenshotOptions, {
    area: { x: 0, y: 0, width: 20, height: 10 },
  });
  assert.equal(runtime.currentLayers.at(-1)?.visible, true);
});

test("ArcGISSceneEngine keeps transient overlays out of the store layer snapshot", async () => {
  const runtime = createArcGISSceneFakeRuntime();
  const geo = {
    ...layer("geo", "geojson"),
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          id: "zurich",
          properties: { name: "Zürich" },
          geometry: { type: "Point" as const, coordinates: [8.55, 47.37] },
        },
      ],
    },
  };
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  engine.syncLayers([geo]);
  await engine.mount({} as HTMLElement, initialView);

  engine.interactions.upsertGeoJsonOverlay({ id: "preview", data: geo.geojson, visible: true });
  assert.deepEqual(runtime.layerOrders.at(-1), ["geolibre-geo", "geolibre-overlay-preview"]);
  engine.interactions.setOverlayVisible("preview", false);
  assert.equal(runtime.currentLayers.at(-1)?.visible, false);
  engine.layers.setHighlight(geo, ["zurich"]);
  assert.equal(runtime.currentLayers.at(-1)?.id, "geolibre-overlay-geolibre-selection-highlight");
  engine.syncLayers([geo]);
  assert.deepEqual(runtime.layerOrders.at(-1), [
    "geolibre-geo",
    "geolibre-overlay-preview",
    "geolibre-overlay-geolibre-selection-highlight",
  ]);
  engine.interactions.removeOverlay("preview");
  engine.layers.clearHighlight();
  assert.deepEqual(runtime.currentLayers.map((nativeLayer) => nativeLayer.id), ["geolibre-geo"]);
  engine.destroy();
});
