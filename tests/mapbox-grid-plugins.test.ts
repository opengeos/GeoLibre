import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { maplibreElevationProfilePlugin } from "../packages/plugins/src/plugins/elevation-profile";
import { maplibreGraticulePlugin } from "../packages/plugins/src/plugins/maplibre-graticule";
import { maplibreH3Plugin } from "../packages/plugins/src/plugins/maplibre-h3";
import {
  getActiveTimelapseControl,
  maplibreTimelapsePlugin,
  TIMELAPSE_SOURCE_KIND,
} from "../packages/plugins/src/plugins/maplibre-timelapse";
import {
  enforceEngineSupport,
  maplibreTimeSliderPlugin,
} from "../packages/plugins/src/plugins/maplibre-time-slider";
import { getStyleMap } from "../packages/plugins/src/plugins/style-map";
import { isPluginEngineSupported, type GeoLibreAppAPI } from "../packages/plugins/src/types";

// The grid, timeline and profile plugins used to reach the map only through
// `app.getMap()`, which the Mapbox engine deliberately leaves null, so they
// silently no-oped there and the Plugins menu greyed them out. These drive
// each of them against a host that exposes a Mapbox map alone and check that
// they draw their native sources and layers on it through the Style Spec
// surface both engines share.

type Listener = (event?: unknown) => void;

/** A recording fake of the shared style surface a mapbox-gl map exposes. */
function fakeMapboxMap() {
  const sources = new Map<string, { type: string; data?: unknown; setData?: Listener }>();
  const layers = new Map<string, { id: string; type: string; layout?: Record<string, unknown> }>();
  const listeners = new Map<string, Set<Listener>>();
  const paint: Array<[string, string, unknown]> = [];
  const layout: Array<[string, string, unknown]> = [];
  const map = {
    sources,
    layers,
    listeners,
    paint,
    layout,
    fire: (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    on: (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off: (event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    },
    once: (event: string, listener: Listener) => {
      const wrapped: Listener = (payload) => {
        listeners.get(event)?.delete(wrapped);
        listener(payload);
      };
      map.on(event, wrapped);
    },
    isStyleLoaded: () => true,
    isSourceLoaded: () => true,
    // Mapbox Standard keeps its basemap in style imports, so the root style has
    // no symbol layer to borrow a font from: the plugins must fall back.
    getStyle: () => ({ layers: [] }),
    getZoom: () => 8,
    getBounds: () => ({
      getWest: () => -96,
      getSouth: () => 37,
      getEast: () => -94,
      getNorth: () => 39,
    }),
    addSource: (id: string, spec: { type: string; data?: unknown }) => {
      const source = {
        ...spec,
        setData: (data: unknown) => void (source.data = data),
      };
      sources.set(id, source);
    },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => void sources.delete(id),
    addLayer: (spec: { id: string; type: string; layout?: Record<string, unknown> }) =>
      void layers.set(spec.id, spec),
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => void layers.delete(id),
    setPaintProperty: (id: string, name: string, value: unknown) =>
      void paint.push([id, name, value]),
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      layout.push([id, name, value]);
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    },
    setLayerZoomRange: () => {},
    triggerRepaint: () => {},
    getCanvas: () => ({ style: {} }),
    getContainer: () => ({ querySelector: () => null }),
  };
  return map;
}

type FakeMap = ReturnType<typeof fakeMapboxMap>;

/** A host that only has a Mapbox map, the way the Mapbox renderer's app API answers. */
function mapboxOnlyHost(map: FakeMap) {
  const controls: unknown[] = [];
  const panels: string[] = [];
  const host = {
    controls,
    panels,
    getMap: () => null,
    getMapboxMap: () => map,
    getMapRenderer: () => "mapbox" as const,
    addMapControl: (control: unknown) => {
      controls.push(control);
      return true;
    },
    removeMapControl: (control: unknown) => {
      controls.splice(controls.indexOf(control), 1);
    },
    onBasemapChange: () => () => {},
    registerRightPanel: (panel: { id: string }) => {
      panels.push(panel.id);
      return () => {};
    },
    openRightPanel: () => true,
    closeRightPanel: () => {},
    registerFloatingPanel: () => () => {},
    openFloatingPanel: () => true,
    closeFloatingPanel: () => {},
    getActiveBasemap: () => "mapbox://styles/mapbox/standard",
  };
  return host as unknown as GeoLibreAppAPI & typeof host;
}

describe("getStyleMap", () => {
  it("hands back the MapLibre map first and the Mapbox map otherwise", () => {
    const maplibre = {};
    const mapbox = {};
    assert.equal(getStyleMap(null), null);
    assert.equal(getStyleMap({} as GeoLibreAppAPI), null);
    assert.equal(
      getStyleMap({
        getMap: () => maplibre,
        getMapboxMap: () => mapbox,
      } as unknown as GeoLibreAppAPI),
      maplibre,
    );
    assert.equal(
      getStyleMap({
        getMap: () => null,
        getMapboxMap: () => mapbox,
      } as unknown as GeoLibreAppAPI),
      mapbox,
    );
  });
});

describe("grid, timeline and profile plugins on a Mapbox-only host", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });
  afterEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("declares Mapbox support alongside MapLibre", () => {
    for (const plugin of [
      maplibreGraticulePlugin,
      maplibreH3Plugin,
      maplibreTimeSliderPlugin,
      maplibreTimelapsePlugin,
      maplibreElevationProfilePlugin,
    ]) {
      assert.equal(isPluginEngineSupported(plugin, "mapbox"), true, plugin.id);
      assert.equal(isPluginEngineSupported(plugin, "maplibre"), true, plugin.id);
    }
    // The globe adapter is the profile's own; the grids have none.
    assert.equal(isPluginEngineSupported(maplibreElevationProfilePlugin, "cesium"), true);
    assert.equal(isPluginEngineSupported(maplibreGraticulePlugin, "cesium"), false);
  });

  it("draws the graticule's lines and labels on the Mapbox map and tears them down", () => {
    const map = fakeMapboxMap();
    const host = mapboxOnlyHost(map);
    assert.notEqual(maplibreGraticulePlugin.activate(host), false);
    const lineSource = [...map.sources.keys()].find(
      (id) => /graticule/.test(id) && /line/.test(id),
    );
    assert.ok(lineSource, `expected a graticule line source, got ${[...map.sources.keys()]}`);
    assert.ok(map.layers.size >= 2, "line and label layers");
    const label = [...map.layers.values()].find((layer) => layer.type === "symbol");
    assert.ok(label, "a symbol layer carries the coordinate labels");
    // With no basemap font to borrow, the label falls back to a stack Mapbox's
    // glyph service serves rather than to nothing.
    const font = map.layout.find(([id, name]) => id === label.id && name === "text-font")?.[2];
    assert.ok(Array.isArray(font) && font.length > 0, "text-font set on the label layer");
    assert.ok(map.listeners.get("moveend")?.size, "pans refresh the geometry");
    assert.equal(host.controls.length, 1, "the corner control is mounted through addMapControl");
    maplibreGraticulePlugin.deactivate(host);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.size, 0);
    assert.equal(map.listeners.get("moveend")?.size ?? 0, 0);
  });

  it("fills the viewport with H3 cells on the Mapbox map and follows the camera", () => {
    const map = fakeMapboxMap();
    const host = mapboxOnlyHost(map);
    assert.notEqual(maplibreH3Plugin.activate(host), false);
    const grid = [...map.sources.values()].find(
      (source) =>
        source.type === "geojson" &&
        (source.data as { features?: unknown[] } | undefined)?.features?.length,
    );
    assert.ok(grid, "the grid source holds the cells covering the fake bounds");
    const cells = (grid.data as { features: { properties: { h3: string } }[] }).features;
    assert.ok(cells.every((cell) => typeof cell.properties.h3 === "string"));
    assert.ok([...map.layers.values()].some((layer) => layer.type === "fill"));
    assert.ok([...map.layers.values()].some((layer) => layer.type === "line"));
    // A pan re-reads getBounds on the Mapbox map; the refresh is scheduled, so
    // only the subscription itself is asserted here.
    assert.ok(map.listeners.get("moveend")?.size, "moveend refreshes the grid");
    assert.ok(map.listeners.get("click")?.size, "clicks identify a cell");
    maplibreH3Plugin.deactivate(host);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.size, 0);
  });

  it("builds the Timelapse frame stack on the Mapbox map and mirrors it as a plugin-owned layer", () => {
    maplibreTimelapsePlugin.applyProjectState?.(mapboxOnlyHost(fakeMapboxMap()), null);
    const map = fakeMapboxMap();
    const host = mapboxOnlyHost(map);
    try {
      assert.notEqual(maplibreTimelapsePlugin.activate(host), false);
      assert.ok(map.sources.size > 1, "one raster source per frame");
      assert.equal(map.layers.size, map.sources.size, "one raster layer per frame");
      assert.ok([...map.layers.values()].every((layer) => layer.type === "raster"));
      const mirror = useAppStore
        .getState()
        .layers.find((layer) => layer.metadata.sourceKind === TIMELAPSE_SOURCE_KIND);
      assert.ok(mirror, "the store mirror exists");
      assert.equal(mirror.metadata.externalNativeLayer, true);
      assert.deepEqual(mirror.metadata.nativeLayerIds, [...map.layers.keys()]);
    } finally {
      if (getActiveTimelapseControl()) maplibreTimelapsePlugin.deactivate(host);
    }
    assert.equal(map.layers.size, 0, "deactivation removes the frame layers");
  });

  it("keeps Time Slider COGs on TiTiler and drops mosaics on Mapbox", () => {
    const host = mapboxOnlyHost(fakeMapboxMap());
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => void warnings.push(String(message));
    // The real control registers its sources only once it is on a map, and its
    // onAdd builds DOM, so the reconciliation runs against a recording stand-in
    // holding what the library reports for a COG on the gpu/wasm engines: the
    // adapter rewrites the spec to a mosaic while the URL is still a GeoTIFF.
    const sources: Array<Record<string, unknown>> = [
      {
        id: "landsat",
        name: "Landsat",
        type: "mosaic",
        engine: "wasm",
        url: "https://example.com/landsat/{date:YYYY}.tif",
        opacity: 0.7,
      },
      {
        id: "manifest",
        type: "mosaic",
        url: "https://example.com/{date:YYYY}/mosaic.json",
      },
      {
        id: "gibs",
        type: "xyz",
        tiles: "https://example.com/{YYYY}/{z}/{x}/{y}.png",
      },
    ];
    const control = {
      getSources: () => [...sources],
      removeSource: (id: string) => {
        const index = sources.findIndex((source) => source.id === id);
        if (index >= 0) sources.splice(index, 1);
      },
      addSource: (spec: Record<string, unknown>) => {
        sources.push(spec);
        return spec.id as string;
      },
    };
    try {
      // Off Mapbox every source keeps the engine the user chose.
      enforceEngineSupport(control as never);
      assert.equal(sources.length, 3);
      assert.notEqual(maplibreTimeSliderPlugin.activate(host), false);
      enforceEngineSupport(control as never);
      const landsat = sources.find((source) => source.id === "landsat");
      assert.ok(landsat, "the COG stays in the dock");
      assert.equal(landsat.type, "cog");
      assert.equal(landsat.engine, "titiler");
      assert.equal(landsat.url, "https://example.com/landsat/{date:YYYY}.tif");
      assert.equal(landsat.opacity, 0.7);
      assert.equal(landsat.name, "Landsat");
      assert.equal(
        sources.some((source) => source.id === "manifest"),
        false,
        "a real mosaic manifest has no Mapbox path and is dropped",
      );
      assert.ok(warnings.some((message) => /manifest/.test(message)));
      assert.ok(
        sources.some((source) => source.id === "gibs"),
        "XYZ sources are untouched",
      );
    } finally {
      console.warn = warn;
      maplibreTimeSliderPlugin.deactivate(host);
    }
  });

  it("mounts the Time Slider dock and the Elevation Profile through addMapControl on Mapbox", () => {
    const map = fakeMapboxMap();
    const host = mapboxOnlyHost(map);
    assert.notEqual(maplibreTimeSliderPlugin.activate(host), false);
    assert.equal(host.controls.length, 1, "the dock is a map control on Mapbox too");
    maplibreTimeSliderPlugin.deactivate(host);
    assert.equal(host.controls.length, 0);

    assert.notEqual(maplibreElevationProfilePlugin.activate(host), false);
    assert.equal(host.controls.length, 1, "the profile control mounts on the Mapbox map");
    maplibreElevationProfilePlugin.deactivate(host);
    assert.equal(host.controls.length, 0);
  });
});
