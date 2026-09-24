import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { createAnnotationMarker } from "../packages/plugins/src/plugins/annotation-marker";
import { maplibreAnnotationsPlugin } from "../packages/plugins/src/plugins/maplibre-annotations";
import {
  buildDates,
  getCloudsAnimationState,
  maplibreCloudsPlugin,
  nasaTileUrl,
  setCloudsFrame,
} from "../packages/plugins/src/plugins/maplibre-clouds";
import { maplibreDimensionsPlugin } from "../packages/plugins/src/plugins/maplibre-dimensions";
import {
  maplibreEffectsPlugin,
  restoreEffects,
} from "../packages/plugins/src/plugins/maplibre-effects";
import { maplibrePrecipitationPlugin } from "../packages/plugins/src/plugins/maplibre-precipitation";
import {
  closeRouteAnimationPanel,
  maplibreRouteAnimationPlugin,
  openRouteAnimationPanel,
  reattachRouteAnimation,
  setRouteAnimationProgress,
  setRouteAnimationRoute,
} from "../packages/plugins/src/plugins/maplibre-route-animation";
import {
  closeSunPanel,
  maplibreSunPlugin,
  openSunPanel,
  reattachSun,
} from "../packages/plugins/src/plugins/maplibre-sun";
import { getStyleMap } from "../packages/plugins/src/plugins/style-map";
import { registerRightPanel } from "../packages/plugins/src/right-panel-registry";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { isPluginEngineSupported } from "../packages/plugins/src/types";

// The drawing and environment plugins used to reach the map only through
// `app.getMap()`, which the Mapbox engine deliberately leaves null. These
// drive each of them against a host that exposes a Mapbox map alone — the
// shape the plugin manager hands a plugin on the Mapbox renderer — and check
// that they draw through the Style Spec surface both engines share, that the
// 2D branch (not the Cesium one) is taken, and that teardown survives the map
// being removed under them on a renderer swap.

type Handler = (payload?: unknown) => void;

/** A mapbox-gl map reduced to the surface these plugins touch. */
function makeMapboxMap(canvasContainer: HTMLElement, controlContainer: HTMLElement) {
  const sources = new Map<string, Record<string, unknown>>();
  const layers: Record<string, unknown>[] = [];
  const images = new Map<string, unknown>();
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  let styleLoaded = true;
  let removed = false;
  let light: Record<string, unknown> = { anchor: "viewport", position: [1.15, 210, 30] };
  const canvas = canvasContainer.ownerDocument.createElement("canvas");
  canvas.className = "mapboxgl-canvas";
  canvasContainer.appendChild(canvas);
  const mapRoot = canvasContainer.parentElement!;
  const assertLive = () => {
    // mapbox-gl's style-reading methods throw on a removed map (its `style`
    // is gone), which is what a renderer swap looks like to a plugin.
    if (removed) throw new TypeError("Cannot read properties of undefined (reading 'getOwnLayer')");
  };
  const map = {
    sources,
    layers,
    images,
    calls,
    setStyleLoaded: (value: boolean) => {
      styleLoaded = value;
    },
    remove: () => {
      removed = true;
    },
    fire: (event: string, payload?: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    once: (event: string, handler: Handler) => {
      const wrapped: Handler = (payload) => {
        handlers.get(event)?.delete(wrapped);
        handler(payload);
      };
      map.on(event, wrapped);
    },
    isStyleLoaded: () => styleLoaded,
    loaded: () => styleLoaded,
    getStyle: () => ({ layers: [...layers], sources: Object.fromEntries(sources) }),
    getCanvas: () => (removed ? undefined : canvas),
    getCanvasContainer: () => canvasContainer,
    getContainer: () => mapRoot,
    dragPan: removed ? undefined : { enable: () => calls.push("dragPan.enable") },
    project: (position: [number, number] | { lng: number; lat: number }) => {
      const [lng, lat] = Array.isArray(position) ? position : [position.lng, position.lat];
      return { x: lng * 2 + 500, y: 300 - lat * 2 };
    },
    unproject: (point: [number, number]) => ({ lng: point[0], lat: point[1] }),
    getBounds: () => ({
      getWest: () => -10,
      getEast: () => 10,
      getSouth: () => -5,
      getNorth: () => 5,
    }),
    getCenter: () => ({ lng: 0, lat: 0 }),
    getZoom: () => 4,
    getBearing: () => 0,
    getPitch: () => 0,
    // mapbox-gl's shape, not MapLibre's `{ type }`.
    getProjection: () => ({ name: "mercator" }),
    jumpTo: (options: unknown) => calls.push(`jumpTo:${JSON.stringify(options)}`),
    triggerRepaint: () => {},
    addSource: (id: string, source: Record<string, unknown>) => {
      assertLive();
      const record = {
        ...source,
        setData: (data: unknown) => {
          record.data = data;
        },
        setTiles: (tiles: string[]) => {
          record.tiles = tiles;
        },
        serialize: () => ({ ...source, tiles: record.tiles, data: record.data }),
      } as Record<string, unknown>;
      sources.set(id, record);
    },
    removeSource: (id: string) => {
      assertLive();
      sources.delete(id);
    },
    getSource: (id: string) => {
      assertLive();
      return sources.get(id);
    },
    addLayer: (layer: Record<string, unknown>) => {
      assertLive();
      layers.push({ ...layer, layout: { ...((layer.layout as object) ?? {}) } });
    },
    removeLayer: (id: string) => {
      assertLive();
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    getLayer: (id: string) => {
      assertLive();
      return layers.find((layer) => layer.id === id);
    },
    moveLayer: () => {},
    setFilter: () => {},
    setPaintProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.find((candidate) => candidate.id === id);
      if (layer) (layer.paint as Record<string, unknown>)[key] = value;
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.find((candidate) => candidate.id === id);
      if (layer) (layer.layout as Record<string, unknown>)[key] = value;
    },
    addImage: (id: string, image: unknown) => {
      assertLive();
      images.set(id, image);
    },
    hasImage: (id: string) => {
      assertLive();
      return images.has(id);
    },
    removeImage: (id: string) => {
      assertLive();
      images.delete(id);
    },
    updateImage: (id: string, image: unknown) => images.set(id, image),
    getLight: () => light,
    setLight: (next: Record<string, unknown>) => {
      light = next;
      calls.push(`setLight:${next.anchor}`);
    },
  };
  return map;
}

/** A host that only exposes a Mapbox map; the globe accessor must stay untouched. */
function makeApp(map: unknown) {
  const controls: unknown[] = [];
  let cesiumReads = 0;
  const app = {
    getMap: () => null,
    getMapboxMap: () => map,
    getMapRenderer: () => "mapbox",
    getCesiumScene: () => {
      cesiumReads += 1;
      return null;
    },
    addMapControl: (control: unknown) => {
      controls.push(control);
      return true;
    },
    removeMapControl: (control: unknown) => {
      const index = controls.indexOf(control);
      if (index >= 0) controls.splice(index, 1);
    },
    registerRightPanel,
    openRightPanel: () => true,
    closeRightPanel: () => {},
    onBasemapChange: () => () => {},
    addTileLayer: (options: Record<string, unknown>) => {
      const store = useAppStore.getState();
      const id = `tile-${store.layers.length + 1}`;
      store.addLayer({
        id,
        name: String(options.name ?? id),
        type: "xyz",
        source: { type: "raster", tiles: options.tiles, tileSize: 256 },
        visible: true,
        opacity: typeof options.opacity === "number" ? options.opacity : 1,
        style: {},
        metadata: { ...((options.metadata as object) ?? {}) },
      } as unknown as GeoLibreLayer);
      return id;
    },
    updateLayer: (id: string, patch: Partial<GeoLibreLayer>) =>
      useAppStore.getState().updateLayer(id, patch),
    removeLayer: (id: string) => useAppStore.getState().removeLayer(id),
  } as unknown as GeoLibreAppAPI;
  return { app, controls, cesiumReads: () => cesiumReads };
}

/** A canvas 2D context that accepts every call, for the engines that paint. */
function stubCanvasContext(document: Document): void {
  const proto = Object.getPrototypeOf(document.createElement("canvas")) as {
    getContext?: unknown;
  };
  proto.getContext = function (this: HTMLCanvasElement) {
    const canvas = this;
    return new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "canvas"
            ? canvas
            : key === "createImageData"
              ? (width: number, height: number) => ({
                  width,
                  height,
                  data: new Uint8ClampedArray(width * height * 4),
                })
              : key === "getImageData"
                ? () => ({ data: new Uint8ClampedArray(4) })
                : () => undefined,
      },
    );
  };
}

describe("drawing and environment plugins on a Mapbox-only host", () => {
  let restoreGlobals: () => void;
  let document: Document;
  let canvasContainer: HTMLElement;
  let controlContainer: HTMLElement;

  beforeEach(() => {
    const dom = parseHTML(
      '<html><body><div class="mapboxgl-map"><div class="mapboxgl-canvas-container"></div><div class="mapboxgl-control-container"></div></div></body></html>',
    );
    document = dom.document as unknown as Document;
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    const window = Object.assign(dom.window, {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      devicePixelRatio: 1,
    });
    Object.assign(globalThis, {
      document,
      window,
      // The effects engine type-checks its injected <style> element.
      HTMLStyleElement: (dom.window as unknown as { HTMLStyleElement: unknown }).HTMLStyleElement,
    });
    stubCanvasContext(document);
    canvasContainer = document.querySelector(".mapboxgl-canvas-container") as HTMLElement;
    controlContainer = document.querySelector(".mapboxgl-control-container") as HTMLElement;
    useAppStore.setState({ layers: [] });
    const previousStyleElement = (globalThis as { HTMLStyleElement?: unknown }).HTMLStyleElement;
    restoreGlobals = () => {
      Object.assign(globalThis, {
        document: previousDocument,
        window: previousWindow,
        HTMLStyleElement: previousStyleElement,
      });
    };
  });

  afterEach(() => {
    restoreGlobals();
  });

  it("declares Mapbox alongside the engines each plugin already had", () => {
    for (const plugin of [
      maplibreAnnotationsPlugin,
      maplibreDimensionsPlugin,
      maplibreRouteAnimationPlugin,
    ]) {
      assert.deepEqual(plugin.engines, ["maplibre", "mapbox"], plugin.id);
    }
    for (const plugin of [maplibreEffectsPlugin, maplibreSunPlugin]) {
      assert.deepEqual(plugin.engines, ["maplibre", "cesium", "mapbox"], plugin.id);
      assert.equal(isPluginEngineSupported(plugin, "mapbox"), true);
    }
    // The weather overlays are store tile layers, which ArcGIS draws too (#2477).
    for (const plugin of [maplibreCloudsPlugin, maplibrePrecipitationPlugin]) {
      assert.deepEqual(plugin.engines, ["maplibre", "cesium", "mapbox", "arcgis"], plugin.id);
      assert.equal(isPluginEngineSupported(plugin, "mapbox"), true);
    }
  });

  it("getStyleMap hands back the Mapbox map when there is no MapLibre one", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app } = makeApp(map);
    assert.equal(getStyleMap(app), map);
    assert.equal(getStyleMap({ getMap: () => null } as unknown as GeoLibreAppAPI), null);
  });

  it("pins annotation markers to the Mapbox map through project()", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app, controls } = makeApp(map);
    useAppStore.getState().addLayer({
      id: "annotations",
      name: "Annotations",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { sourceKind: "annotation" },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { annotationId: "pin-1", __annotation: "pin", title: "Pin", visible: true },
            geometry: { type: "Point", coordinates: [10, 20] },
          },
        ],
      },
    } as unknown as GeoLibreLayer);

    assert.notEqual(maplibreAnnotationsPlugin.activate(app), false);
    assert.equal(controls.length, 1, "the toolbar mounts through addMapControl");
    const marker = canvasContainer.querySelector(".geolibre-pin-marker") as HTMLElement;
    assert.ok(marker, "the pin is a DOM element in the Mapbox canvas container");
    assert.ok(marker.classList.contains("mapboxgl-marker"));
    // project([10, 20]) → (520, 260); bottom-anchored.
    assert.equal(marker.style.transform, "translate(-50%, -100%) translate(520px, 260px)");

    // The marker follows the camera.
    map.project = () => ({ x: 42, y: 7 });
    map.fire("move");
    assert.equal(marker.style.transform, "translate(-50%, -100%) translate(42px, 7px)");

    // Removing the feature removes the element.
    useAppStore.getState().updateLayer("annotations", {
      geojson: { type: "FeatureCollection", features: [] },
    });
    assert.equal(canvasContainer.querySelector(".geolibre-pin-marker"), null);

    // Deactivation after the map was torn down (a renderer swap) must not throw.
    map.remove();
    map.dragPan = undefined;
    assert.doesNotThrow(() => maplibreAnnotationsPlugin.deactivate(app));
    assert.equal(controls.length, 0);
  });

  it("createAnnotationMarker takes the projected path for a non-MapLibre map", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const element = document.createElement("div");
    const marker = createAnnotationMarker(map as never, { element, anchor: "center" }).setLngLat([
      0, 0,
    ]);
    assert.equal(element.parentElement, canvasContainer);
    assert.equal(element.style.transform, "translate(-50%, -50%) translate(500px, 300px)");
    marker.remove();
    assert.equal(element.parentElement, null);
    map.fire("move");
    assert.equal(element.style.transform, "translate(-50%, -50%) translate(500px, 300px)");
  });

  it("mounts the Dimensions toolbar and survives a removed map on deactivate", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app, controls } = makeApp(map);
    assert.notEqual(maplibreDimensionsPlugin.activate(app), false);
    assert.equal(controls.length, 1);
    map.remove();
    assert.doesNotThrow(() => maplibreDimensionsPlugin.deactivate(app));
    assert.equal(controls.length, 0);
  });

  it("draws the route animation marker and trail on the Mapbox map", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app } = makeApp(map);
    openRouteAnimationPanel(app);
    setRouteAnimationRoute([
      [0, 0],
      [1, 0],
    ]);
    setRouteAnimationProgress(0.5);
    assert.ok(map.getSource("geolibre-route-anim-marker-source"));
    assert.ok(map.getSource("geolibre-route-anim-trail-source"));
    assert.ok(
      map.hasImage("geolibre-route-anim-arrow"),
      "the arrow sprite is added through addImage",
    );
    assert.deepEqual(
      map.layers.map((layer) => layer.type),
      ["line", "circle", "symbol"],
    );
    const marker = map.getSource("geolibre-route-anim-marker-source")!.data as {
      geometry: { coordinates: [number, number] };
    };
    assert.ok(Math.abs(marker.geometry.coordinates[0] - 0.5) < 0.01, "marker sits halfway");

    // A swap tears the map down before the host rebinds; the stale engine's
    // teardown must not take the app down with it.
    map.remove();
    assert.doesNotThrow(() => reattachRouteAnimation(app));
    closeRouteAnimationPanel();
  });

  it("adds the route layers once a pending source finishes loading, not only on idle", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    map.setStyleLoaded(false);
    const { app } = makeApp(map);
    openRouteAnimationPanel(app);
    assert.equal(map.getSource("geolibre-route-anim-marker-source"), undefined);
    map.setStyleLoaded(true);
    // mapbox-gl reports a source's own completion; no later `styledata` comes.
    map.fire("sourcedata", { sourceId: "x", sourceDataType: "content", isSourceLoaded: true });
    assert.ok(map.getSource("geolibre-route-anim-marker-source"));
    closeRouteAnimationPanel();
  });

  it("swaps Clouds frames through the Mapbox raster source", async () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app } = makeApp(map);
    await maplibreCloudsPlugin.activate(app);
    const layer = useAppStore.getState().layers.find((candidate) => candidate.metadata.cloudsLayer);
    assert.ok(layer, "the overlay is a store tile layer");
    const state = getCloudsAnimationState();
    assert.ok(state.labels.length > 1 && state.index === state.labels.length - 1);
    setCloudsFrame(0);
    // The frame lands in the store layer's tiles, which the Mapbox engine
    // compiles into its raster source (the instant `setTiles` shortcut targets
    // MapLibre's source id and is a no-op here).
    const swapped = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
    assert.deepEqual(swapped?.source.tiles, [nasaTileUrl(buildDates()[0])]);
    assert.equal(getCloudsAnimationState().index, 0);
    maplibreCloudsPlugin.deactivate(app);
  });

  it("overlays the effects on the Mapbox canvas container and keeps the controls above them", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app, cesiumReads } = makeApp(map);
    restoreEffects(app, true);
    assert.equal(canvasContainer.querySelectorAll(".geolibre-effects-canvas").length, 4);
    assert.equal(map.getCanvas()!.style.zIndex, "4");
    assert.equal(controlContainer.style.zIndex, "5", "mapbox-gl's control container is lifted too");
    assert.equal(cesiumReads(), 0, "the globe branch is never consulted");
    restoreEffects(app, false);
    assert.equal(canvasContainer.querySelectorAll(".geolibre-effects-canvas").length, 0);
    assert.equal(controlContainer.style.zIndex, "");
  });

  it("shades the night side and lights the Mapbox map from the sun", () => {
    const map = makeMapboxMap(canvasContainer, controlContainer);
    const { app, cesiumReads } = makeApp(map);
    openSunPanel(app);
    assert.equal(map.getSource("geolibre-sun-night-source")?.type, "canvas");
    assert.equal(map.getLayer("geolibre-sun-night-layer")?.type, "raster");
    assert.ok(
      map.calls.some((call) => call.startsWith("setLight:map")),
      "setLight drives the flat light",
    );
    assert.equal(cesiumReads(), 0);
    // Reattaching to the same map is a no-op; to a removed one it must not throw.
    reattachSun(app);
    map.remove();
    assert.doesNotThrow(() => closeSunPanel());
  });
});
