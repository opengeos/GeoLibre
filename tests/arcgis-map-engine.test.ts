import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer, MapViewState } from "../packages/core/src/index";
import { ArcGISMapEngine } from "../packages/map/src/engine/arcgis-map-engine";
import { ARC_GIS_FEATURE_INDEX } from "../packages/map/src/engine/arcgis-feature-query";
import { MapEngineCapabilityError } from "../packages/map/src/engine/types";
import { createArcGISFakeRuntime } from "./arcgis-engine-fake";

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

test("ArcGISMapEngine lazy-loads MapView, uses local assets, and reconciles store layers", async () => {
  const runtime = createArcGISFakeRuntime();
  let loads = 0;
  const engine = new ArcGISMapEngine({
    loadArcGIS: async () => {
      loads += 1;
      return runtime.modules;
    },
    assetsPath: () => "/app/arcgis-assets",
  });

  engine.syncLayers([
    layer("geo", "geojson"),
    layer("wms", "wms"),
    layer("vector", "vector-tiles"),
  ]);
  assert.equal(loads, 0);
  await engine.mount({} as HTMLElement, initialView);

  assert.equal(loads, 1);
  assert.equal(runtime.config.assetsPath, "/app/arcgis-assets");
  assert.deepEqual(runtime.layerOrders.at(-1), ["geolibre-geo", "geolibre-wms"]);
  assert.equal(runtime.basemapLayers[0]?.properties.title, "OpenStreetMap");
  assert.equal(runtime.basemapLayers[0]?.properties.copyright, "© OpenStreetMap contributors");
  assert.equal(engine.layers.hasRenderTarget("vector"), false);

  engine.configure({ basemapVisible: false, basemapOpacity: 0.4 });
  assert.equal(runtime.basemapLayers[0]?.visible, false);
  assert.equal(runtime.basemapLayers[0]?.opacity, 0.4);
  assert.doesNotThrow(() => engine.invoke("viewport.resize", undefined));
  assert.equal(runtime.resizeCount.value, 0);
  assert.equal(
    engine.layers.setRasterTiles("wms", ["https://example.test/new/{z}/{x}/{y}.png"]),
    false,
  );
  assert.throws(
    () => engine.controls.getBuiltInState("compass"),
    (error) => error instanceof MapEngineCapabilityError && error.engineId === "arcgis",
  );

  engine.destroy();
  assert.equal(runtime.destroyed.value, true);
});

test("ArcGISMapEngine ignores store camera echoes and emits user navigation", async () => {
  const runtime = createArcGISFakeRuntime();
  const engine = new ArcGISMapEngine({ loadArcGIS: async () => runtime.modules });
  await engine.mount({} as HTMLElement, initialView);
  const events: Array<{ readonly zoom: number; readonly userDriven: boolean }> = [];
  engine.on("moveend", ({ view, userDriven }) => events.push({ zoom: view.zoom, userDriven }));

  engine.applyView({ ...initialView, zoom: 10 });
  runtime.view?.emitUserMove();

  assert.deepEqual(events, [{ zoom: 11, userDriven: true }]);
  assert.equal(engine.viewport.project([8, 47])?.x, 8);
  assert.deepEqual(engine.viewport.unproject({ x: 8, y: 47 }), [8, 47]);
  engine.destroy();
});

test("ArcGISMapEngine identifies only store-backed GeoJSON features", async () => {
  const runtime = createArcGISFakeRuntime();
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
  const engine = new ArcGISMapEngine({ loadArcGIS: async () => runtime.modules });
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
  assert.deepEqual(await engine.layers.queryAtLngLat([8.55, 47.37], "geo"), [
    {
      layerId: "geo",
      featureId: "zurich",
      properties: { name: "Zürich" },
      geometry: { type: "Point", coordinates: [8.55, 47.37] },
    },
  ]);
  engine.destroy();
});

test("ArcGISMapEngine owns one public View popup and reports closure", async () => {
  const runtime = createArcGISFakeRuntime();
  const engine = new ArcGISMapEngine({ loadArcGIS: async () => runtime.modules });
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

test("ArcGISMapEngine keeps transient overlays out of the store layer snapshot", async () => {
  const runtime = createArcGISFakeRuntime();
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
  const engine = new ArcGISMapEngine({ loadArcGIS: async () => runtime.modules });
  engine.syncLayers([geo]);
  await engine.mount({} as HTMLElement, initialView);

  engine.interactions.upsertGeoJsonOverlay({
    id: "preview",
    data: geo.geojson,
    visible: true,
  });
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
