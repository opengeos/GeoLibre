import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import type {
  GeoLibreAppAPI,
  GeoLibreFloatingPanelRegistration,
  GeoLibreRightPanelRegistration,
} from "../packages/plugins/src/types";
import { isPluginEngineSupported } from "../packages/plugins/src/types";
import {
  mountMapControlInPanel,
  unmountMapControlFromPanel,
} from "../packages/plugins/src/plugins/dockable-map-control";
import { getStyleMap } from "../packages/plugins/src/plugins/style-map";
import { maplibreFemaWmsPlugin } from "../packages/plugins/src/plugins/maplibre-fema-wms";
import { maplibreMapillaryPlugin } from "../packages/plugins/src/plugins/maplibre-mapillary";
import { maplibreUsgsNldiPlugin } from "../packages/plugins/src/plugins/maplibre-usgs-nldi";
import { maplibreUsgsLidarPlugin } from "../packages/plugins/src/plugins/maplibre-usgs-lidar";
import { maplibreEsriWaybackPlugin } from "../packages/plugins/src/plugins/maplibre-esri-wayback";
import { maplibreOpenAerialMapPlugin } from "../packages/plugins/src/plugins/maplibre-openaerialmap";
import { maplibreEarthdataGisPlugin } from "../packages/plugins/src/plugins/maplibre-earthdata-gis";
import { maplibreHuggingFacePlugin } from "../packages/plugins/src/plugins/maplibre-huggingface";
import { maplibreGeoLensPlugin } from "../packages/plugins/src/plugins/maplibre-geolens";
import { maplibreVantorPlugin } from "../packages/plugins/src/plugins/maplibre-vantor";
import { maplibreNasaEarthdataPlugin } from "../packages/plugins/src/plugins/maplibre-nasa-earthdata";
import { maplibreEnviroAtlasPlugin } from "../packages/plugins/src/plugins/maplibre-enviroatlas";
import { maplibreNationalMapPlugin } from "../packages/plugins/src/plugins/maplibre-national-map";
import { maplibreArcGisHubPlugin } from "../packages/plugins/src/plugins/maplibre-arcgis-hub";
import { maplibreTennesseeGisPlugin } from "../packages/plugins/src/plugins/maplibre-tennessee-gis";
import {
  maplibreNaturalEarthPlugin,
  maplibreSourceCoopPlugin,
} from "../packages/plugins/src/plugins/maplibre-source-coop";
import { maplibreStreetViewPlugin } from "../packages/plugins/src/plugins/maplibre-streetview";
import { maplibreOvertureMapsPlugin } from "../packages/plugins/src/plugins/maplibre-overture-maps";
import { isMapboxPluginLayer } from "../packages/map/src/mapbox-layers";

// The Web Services and service-browser plugins used to reach the primary map
// only through `app.getMap()`, which the Mapbox engine deliberately leaves
// null, so every one of them refused to activate there. These drive the
// representative ones against a host that exposes a Mapbox map alone: a docked
// web-service panel (FEMA NFHL), a plugin that draws GeoJSON results natively
// (USGS NLDI) and one that registers plugin-owned vector-tile layers
// (Mapillary), asserting the effects on the map and the store rather than the
// activation result alone.

type Handler = (event?: unknown) => void;

/** The Style Spec surface both 2D engines share, as a mapbox-gl-shaped fake. */
function fakeMapboxMap(document: Document) {
  const sources = new Map<string, Record<string, unknown>>();
  const layers: Record<string, unknown>[] = [];
  const handlers = new Map<string, Set<Handler>>();
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  const key = (type: string, layerId?: string) => (layerId ? `${type}:${layerId}` : type);
  const map = {
    sources,
    layers,
    handlers,
    on: (type: string, a: unknown, b?: unknown) => {
      const [layerId, handler] =
        typeof a === "string" ? [a, b as Handler] : [undefined, a as Handler];
      const k = key(type, layerId);
      if (!handlers.has(k)) handlers.set(k, new Set());
      handlers.get(k)!.add(handler);
    },
    off: (type: string, a: unknown, b?: unknown) => {
      const [layerId, handler] =
        typeof a === "string" ? [a, b as Handler] : [undefined, a as Handler];
      handlers.get(key(type, layerId))?.delete(handler);
    },
    once: (type: string, handler: Handler) => {
      const wrapped: Handler = (event) => {
        handlers.get(type)?.delete(wrapped);
        handler(event);
      };
      map.on(type, wrapped);
    },
    fire: (type: string, event?: unknown) => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
    isStyleLoaded: () => true,
    loaded: () => true,
    getContainer: () => container,
    getCanvas: () => canvas,
    getCanvasContainer: () => container,
    getStyle: () => ({ sources: Object.fromEntries(sources), layers }),
    getSource: (id: string) => {
      const source = sources.get(id);
      if (!source) return undefined;
      return {
        ...source,
        setData: (data: unknown) => {
          source.data = data;
        },
        setTiles: (tiles: string[]) => {
          source.tiles = tiles;
        },
      };
    },
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, { ...spec });
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    addLayer: (spec: Record<string, unknown>, beforeId?: string) => {
      const index = beforeId ? layers.findIndex((layer) => layer.id === beforeId) : -1;
      if (index >= 0) layers.splice(index, 0, { ...spec });
      else layers.push({ ...spec });
    },
    removeLayer: (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    moveLayer: () => {},
    setPaintProperty: (id: string, name: string, value: unknown) => {
      const layer = map.getLayer(id);
      if (layer) layer.paint = { ...(layer.paint as object), [name]: value };
    },
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const layer = map.getLayer(id);
      if (layer) layer.layout = { ...(layer.layout as object), [name]: value };
    },
    setFilter: () => {},
    setLayerZoomRange: () => {},
    getZoom: () => 4,
    getBearing: () => 0,
    getPitch: () => 0,
    getCenter: () => ({ lng: -95, lat: 38 }),
    getBounds: () => ({
      getWest: () => -100,
      getSouth: () => 30,
      getEast: () => -90,
      getNorth: () => 45,
    }),
    getProjection: () => ({ name: "mercator" }),
    project: (position: [number, number]) => ({ x: position[0], y: position[1] }),
    unproject: (point: [number, number]) => ({ lng: point[0], lat: point[1] }),
    queryRenderedFeatures: () => [],
    fitBounds: () => {},
    easeTo: () => {},
    jumpTo: () => {},
    addControl: () => {},
    removeControl: () => {},
    triggerRepaint: () => {},
  };
  return map;
}

type FakeMap = ReturnType<typeof fakeMapboxMap>;

/** A host that only exposes a Mapbox map, with dockable and floating panels. */
function mapboxOnlyHost(map: FakeMap, document: Document) {
  const panels = new Map<string, GeoLibreRightPanelRegistration>();
  const floating = new Map<string, GeoLibreFloatingPanelRegistration>();
  const containers = new Map<string, HTMLElement>();
  const cleanups = new Map<string, () => void>();
  const controls: unknown[] = [];
  const app = {
    getMap: () => null,
    getMapboxMap: () => map,
    getMapRenderer: () => "mapbox",
    registerRightPanel: (registration: GeoLibreRightPanelRegistration) => {
      panels.set(registration.id, registration);
      return () => {
        panels.delete(registration.id);
      };
    },
    openRightPanel: (id: string) => {
      const registration = panels.get(id);
      if (!registration) return false;
      const container = document.createElement("div");
      containers.set(id, container);
      const cleanup = registration.render(container);
      if (typeof cleanup === "function") cleanups.set(id, cleanup);
      registration.onOpen?.();
      return true;
    },
    closeRightPanel: (id: string) => {
      cleanups.get(id)?.();
      cleanups.delete(id);
      containers.delete(id);
    },
    registerFloatingPanel: (registration: GeoLibreFloatingPanelRegistration) => {
      floating.set(registration.id, registration);
      return () => {
        floating.delete(registration.id);
      };
    },
    openFloatingPanel: (id: string) => floating.has(id),
    addMapControl: (control: { onAdd: (map: unknown) => HTMLElement }) => {
      controls.push(control);
      control.onAdd(map);
      return true;
    },
    removeMapControl: (control: { onRemove: (map: unknown) => void }) => {
      controls.splice(controls.indexOf(control), 1);
      control.onRemove(map);
    },
    onBasemapChange: () => () => {},
    onLocaleChange: () => () => {},
    translate: (_key: string, fallback: string) => fallback,
    registerExternalNativeLayer: (registration: {
      id: string;
      name: string;
      type: string;
      nativeLayerIds: string[];
      sourceIds: string[];
      opacity?: number;
      style?: Record<string, unknown>;
    }) => {
      const state = useAppStore.getState();
      if (state.layers.some((layer) => layer.id === registration.id)) return;
      state.addLayer({
        id: registration.id,
        name: registration.name,
        type: registration.type,
        source: { type: "vector", sourceId: registration.sourceIds[0] },
        visible: true,
        opacity: registration.opacity ?? 1,
        style: registration.style ?? {},
        metadata: {
          externalNativeLayer: true,
          nativeLayerIds: registration.nativeLayerIds,
          sourceIds: registration.sourceIds,
        },
      } as unknown as Parameters<typeof state.addLayer>[0]);
    },
    unregisterExternalNativeLayer: (id: string) => {
      useAppStore.getState().removeLayer(id);
    },
  };
  return { app: app as unknown as GeoLibreAppAPI, panels, floating, containers, controls };
}

describe("Web Services and service browsers on the Mapbox renderer", () => {
  let document: Document;
  let restoreGlobals: () => void;
  let fetchCalls: string[];

  beforeEach(() => {
    const dom = parseHTML("<html><body></body></html>");
    document = dom.document;
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      HTMLElement: globalThis.HTMLElement,
      Event: globalThis.Event,
      Option: globalThis.Option,
      ResizeObserver: globalThis.ResizeObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
      fetch: globalThis.fetch,
      localStorage: globalThis.localStorage,
      CSS: globalThis.CSS,
    };
    fetchCalls = [];
    const storage = new Map<string, string>();
    // linkedom has no <select> value setter and no Option constructor; the
    // upstream panels use both while building their forms.
    const selectProto = (dom.window as unknown as { HTMLSelectElement: { prototype: object } })
      .HTMLSelectElement.prototype;
    const valueDescriptor = Object.getOwnPropertyDescriptor(selectProto, "value");
    Object.defineProperty(selectProto, "value", {
      configurable: true,
      get(this: Element) {
        return this.getAttribute("data-test-value") ?? valueDescriptor?.get?.call(this) ?? "";
      },
      set(this: Element, value: unknown) {
        this.setAttribute("data-test-value", String(value));
      },
    });
    class TestOption {
      constructor(text = "", value = "") {
        const option = document.createElement("option");
        option.textContent = text;
        option.setAttribute("value", value);
        return option;
      }
    }
    class TestResizeObserver {
      observe() {}
      disconnect() {}
    }
    Object.assign(globalThis, {
      document,
      window: dom.window,
      HTMLElement: dom.window.HTMLElement,
      Event: dom.window.Event,
      Option: TestOption,
      ResizeObserver: TestResizeObserver,
      requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      CSS: { escape: (value: string) => value },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      // No service is reached from a unit test: every request fails fast and
      // the plugins are expected to surface that in their own status lines.
      fetch: async (input: string | URL | Request) => {
        fetchCalls.push(String(input instanceof Request ? input.url : input));
        throw new Error("offline");
      },
    });
    restoreGlobals = () => Object.assign(globalThis, previous);
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    restoreGlobals();
    useAppStore.setState({ layers: [] });
  });

  it("declares Mapbox on every plugin of the group that only needs the shared surface", () => {
    for (const plugin of [
      maplibreFemaWmsPlugin,
      maplibreNasaEarthdataPlugin,
      maplibreEnviroAtlasPlugin,
      maplibreNationalMapPlugin,
      maplibreUsgsNldiPlugin,
      maplibreVantorPlugin,
      maplibreEarthdataGisPlugin,
      maplibreOpenAerialMapPlugin,
      maplibreArcGisHubPlugin,
      maplibreTennesseeGisPlugin,
      maplibreSourceCoopPlugin,
      maplibreNaturalEarthPlugin,
      maplibreHuggingFacePlugin,
      maplibreGeoLensPlugin,
      maplibreEsriWaybackPlugin,
      maplibreUsgsLidarPlugin,
      maplibreMapillaryPlugin,
    ]) {
      assert.equal(isPluginEngineSupported(plugin, "mapbox"), true, `${plugin.id} on mapbox`);
      assert.equal(isPluginEngineSupported(plugin, "maplibre"), true, `${plugin.id} on maplibre`);
    }
    // Engine-neutral catalogs keep the globe they already had.
    for (const plugin of [
      maplibreArcGisHubPlugin,
      maplibreTennesseeGisPlugin,
      maplibreSourceCoopPlugin,
    ]) {
      assert.equal(isPluginEngineSupported(plugin, "cesium"), true, `${plugin.id} on cesium`);
    }
  });

  it("runs Street View on both 2D engines now that its marker is supplied", () => {
    // The one MapLibre class the control built itself — the location `Marker`,
    // whose update path reads `_camera.transform` — comes from
    // maplibre-gl-streetview's `createMarker` option, fed mapbox-gl's own.
    assert.equal(isPluginEngineSupported(maplibreStreetViewPlugin, "mapbox"), true);
    assert.equal(isPluginEngineSupported(maplibreStreetViewPlugin, "maplibre"), true);
  });

  it("runs GeoAgent on both 2D engines now that its tools follow the host", () => {
    // Its four engine-specific tools (the marker, both projection tools, and
    // the script runner) take the engine from `mapEngine`. The module pulls the
    // Earth Engine client in at import time, which needs a browser window, so
    // its declaration is read off the source rather than imported.
    const geoagent = readFileSync(
      new URL("../packages/plugins/src/plugins/maplibre-geoagent.ts", import.meta.url),
      "utf8",
    );
    assert.match(geoagent, /engines:\s*\["maplibre",\s*"mapbox"\]/);
  });

  it("resolves the shared map to the Mapbox map when MapLibre is absent", () => {
    const map = fakeMapboxMap(document);
    const { app } = mapboxOnlyHost(map, document);
    assert.equal(getStyleMap(app), map as unknown);
    assert.equal(getStyleMap({ getMap: () => null } as unknown as GeoLibreAppAPI), null);
    assert.equal(getStyleMap(null), null);
  });

  it("docks a control's panel content on a Mapbox-only host", () => {
    const map = fakeMapboxMap(document);
    const { app } = mapboxOnlyHost(map, document);
    let boundTo: unknown = null;
    let removedFrom: unknown = null;
    const control = {
      onAdd: (target: unknown) => {
        boundTo = target;
        const button = document.createElement("button");
        const panel = document.createElement("div");
        panel.className = "vantor-panel";
        panel.textContent = "panel";
        button.appendChild(panel);
        return button;
      },
      onRemove: (target: unknown) => {
        removedFrom = target;
      },
    };
    const container = document.createElement("div");
    const cleanup = mountMapControlInPanel(app, control as never, container);
    assert.ok(cleanup, "the bridge mounts against the Mapbox map");
    assert.equal(boundTo, map);
    assert.equal(container.querySelector(".vantor-panel")?.textContent, "panel");
    assert.ok(map.handlers.get("remove")?.size, "participates in map teardown");
    unmountMapControlFromPanel(control as never);
    assert.equal(removedFrom, map);
    assert.equal(container.children.length, 0);
    assert.equal(map.handlers.get("remove")?.size ?? 0, 0);
  });

  it("activates the FEMA NFHL panel on Mapbox and mirrors its raster layer into the store", async () => {
    const map = fakeMapboxMap(document);
    const { app, containers } = mapboxOnlyHost(map, document);
    const result = maplibreFemaWmsPlugin.activate(app);
    assert.notEqual(result, false, "activation must not refuse a Mapbox host");
    const container = containers.get("fema-wms-panel");
    assert.ok(container, "the panel opened");
    assert.ok(container.children.length > 0, "the control's panel content is docked");
    // The control lists its layers from a GetCapabilities request it cannot
    // make here; the store sync only needs its own state, so adopt a layer the
    // way a reopened project does and let the control draw it natively.
    useAppStore.getState().addLayer({
      id: "fema-wms-28",
      name: "FEMA NFHL Flood Hazard Zones",
      type: "wms",
      source: { type: "raster", sourceId: "fema-wms-28", tiles: ["https://example.test/wms"] },
      visible: true,
      opacity: 0.6,
      style: {},
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["fema-wms-28"],
        sourceId: "fema-wms-28",
        sourceIds: ["fema-wms-28"],
        sourceKind: "fema-wms",
        femaLayerName: "28",
      },
    } as unknown as Parameters<ReturnType<typeof useAppStore.getState>["addLayer"]>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(
      map.getSource("fema-wms-28"),
      "the control added its native source to the Mapbox map",
    );
    assert.ok(map.getLayer("fema-wms-28"), "and its native raster layer");
    // The engine would adopt those ids rather than compile a second copy.
    const stored = useAppStore.getState().layers.find((layer) => layer.id === "fema-wms-28");
    assert.ok(stored);
    assert.equal(isMapboxPluginLayer(stored), false, "raster tiles go through the compiler");
    maplibreFemaWmsPlugin.deactivate(app);
    assert.equal(containers.has("fema-wms-panel"), false);
  });

  it("refuses to activate a docked panel with no 2D map at all", () => {
    const map = fakeMapboxMap(document);
    const { app } = mapboxOnlyHost(map, document);
    const noMap = { ...app, getMap: () => null, getMapboxMap: () => null } as GeoLibreAppAPI;
    assert.equal(maplibreFemaWmsPlugin.activate(noMap), false);
    assert.equal(maplibreVantorPlugin.activate(noMap), false);
    assert.equal(maplibreUsgsNldiPlugin.activate(noMap), false);
  });

  it("binds USGS NLDI's click tracing to the Mapbox map", async () => {
    const map = fakeMapboxMap(document);
    const { app } = mapboxOnlyHost(map, document);
    assert.notEqual(maplibreUsgsNldiPlugin.activate(app), false);
    assert.equal(map.handlers.get("click")?.size, 1, "the click listener is on the Mapbox map");
    assert.equal(map.getCanvas().style.cursor, "crosshair");
    map.fire("click", { lngLat: { lng: -95.3, lat: 29.7 }, point: { x: 10, y: 10 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      fetchCalls.some((url) => url.includes("nldi")),
      "a click reaches the NLDI service from the Mapbox map",
    );
    maplibreUsgsNldiPlugin.deactivate(app);
    assert.equal(map.handlers.get("click")?.size ?? 0, 0);
    assert.equal(map.getCanvas().style.cursor, "");
  });

  it("runs Overture Maps on Mapbox with plain PMTiles URLs and a mapbox-gl popup", async () => {
    // mapbox-gl 3.30+ reads `.pmtiles` archives through its own tile provider
    // but never sees `maplibregl.addProtocol`, so on a Mapbox host the plugin
    // asks the control for plain https archive URLs (`nativePmtiles`) and for
    // an inspection popup built from mapbox-gl's `Popup` (`createPopup`).
    const popups: { options: unknown; addedTo: unknown }[] = [];
    class FakePopup {
      record = { options: null as unknown, addedTo: null as unknown };
      constructor(options: unknown) {
        this.record.options = options;
        popups.push(this.record);
      }
      setLngLat() {
        return this;
      }
      setDOMContent() {
        return this;
      }
      addTo(target: unknown) {
        this.record.addedTo = target;
        return this;
      }
      remove() {
        return this;
      }
    }
    const map = fakeMapboxMap(document);
    const { app, controls } = mapboxOnlyHost(map, document);
    (app as { getMapboxGl?: () => unknown }).getMapboxGl = () => ({ Popup: FakePopup });
    assert.equal(isPluginEngineSupported(maplibreOvertureMapsPlugin, "mapbox"), true);
    assert.notEqual(maplibreOvertureMapsPlugin.activate(app), false);
    assert.equal(controls.length, 1, "the control is mounted on the Mapbox map");
    // The release list is fetched (and fails here), then the fallback release
    // is applied, which adds the theme sources and layers.
    const deadline = Date.now() + 5000;
    while (!map.getSource("overture-buildings") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const source = map.getSource("overture-buildings") as { url?: string } | undefined;
    assert.ok(source, "buildings source on the Mapbox map");
    assert.match(source.url ?? "", /^https:\/\/.+\/buildings\.pmtiles$/, "plain archive URL");
    assert.ok(map.getLayer("overture-buildings-building-fill"), "buildings fill layer");
    const stored = useAppStore
      .getState()
      .layers.filter((layer) => layer.id.startsWith("overture-maps-buildings-"));
    assert.ok(stored.length > 0, "Layers-panel mirrors");
    for (const layer of stored) {
      assert.equal(isMapboxPluginLayer(layer), true, `${layer.id} is plugin-owned on Mapbox`);
      assert.doesNotMatch(layer.sourcePath ?? "", /^pmtiles:\/\//, layer.id);
    }
    // A click on a rendered feature opens mapbox-gl's popup, not MapLibre's.
    map.queryRenderedFeatures = () =>
      [{ sourceLayer: "building", properties: { height: 10 } }] as never;
    map.fire("click", { point: { x: 1, y: 1 }, lngLat: { lng: -73.9, lat: 40.7 } });
    assert.equal(popups.length, 1, "one popup constructed");
    assert.deepEqual(popups[0].options, { maxWidth: "320px", className: "overture-popup" });
    assert.equal(popups[0].addedTo, map);
    maplibreOvertureMapsPlugin.deactivate(app);
    assert.equal(controls.length, 0);
    assert.equal(
      useAppStore.getState().layers.filter((layer) => layer.id.startsWith("overture-maps-")).length,
      0,
    );
  });

  it("refuses Overture Maps on a Mapbox host that hides the mapbox-gl namespace", () => {
    // Without mapbox-gl's Popup the control would open MapLibre popups on the
    // Mapbox map, which throw on their first update.
    const map = fakeMapboxMap(document);
    const { app, controls } = mapboxOnlyHost(map, document);
    assert.equal(maplibreOvertureMapsPlugin.activate(app), false);
    assert.equal(controls.length, 0);
  });

  it("draws Mapillary's coverage on Mapbox as plugin-owned native layers", () => {
    localStorage.setItem("geolibre:mapillary-access-token", "MLY|test");
    const map = fakeMapboxMap(document);
    const { app, floating } = mapboxOnlyHost(map, document);
    assert.notEqual(maplibreMapillaryPlugin.activate(app), false);
    assert.ok(
      map.getSource("geolibre-mapillary-coverage"),
      "vector coverage source on the Mapbox map",
    );
    assert.ok(map.getLayer("geolibre-mapillary-sequence"), "sequence lines");
    assert.ok(map.getLayer("geolibre-mapillary-image"), "image points");
    assert.ok(floating.size > 0, "the viewer panel is registered");
    const stored = useAppStore
      .getState()
      .layers.filter((layer) => layer.id.startsWith("geolibre-mapillary"));
    assert.equal(stored.length, 2, "two Layers-panel entries");
    // Their store records carry no drawable source, so the engine leaves the
    // drawing to the plugin and only mirrors visibility/opacity.
    for (const layer of stored) assert.equal(isMapboxPluginLayer(layer), true, layer.id);
    maplibreMapillaryPlugin.deactivate(app);
    assert.equal(map.getSource("geolibre-mapillary-coverage"), undefined);
    assert.equal(
      useAppStore.getState().layers.filter((layer) => layer.id.startsWith("geolibre-mapillary"))
        .length,
      0,
    );
  });
});
