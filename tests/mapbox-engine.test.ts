import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type * as mapboxgl from "mapbox-gl";
import type { Geometry } from "geojson";
import { useAppStore, type MapPreferences } from "@geolibre/core";
import { MapboxEngine, redactMapboxError } from "../packages/map/src/mapbox-engine";
import { isMapboxSupportedLayer } from "../packages/map/src/mapbox-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The Mapbox engine never loads mapbox-gl here (its import in the module under
// test is type-only), so the map is a fake that records the style-spec calls
// the engine makes. What is exercised is the engine's own state diffing: which
// sources and layers it adds, updates and removes on successive syncLayers
// calls, how it keeps the error record honest, how it resolves queried
// features back to the app's feature identity, and which camera and
// preference writes it forwards.

type Handler = (event?: unknown) => void;

/** A minimal mapbox-gl `Map`: just what the engine touches. */
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers: Record<string, unknown>[] = [];
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  const controls: unknown[] = [];
  const controlPositions = new Map<unknown, string | undefined>();
  let styleLoaded = true;
  let center: [number, number] = [0, 0];
  let zoom = 2;
  let bearing = 0;
  let pitch = 0;
  let queried: Record<string, unknown>[] = [];
  const map = {
    // Test hooks.
    sources,
    layers,
    calls,
    controls,
    controlPositions,
    setStyleLoaded: (value: boolean) => {
      styleLoaded = value;
    },
    setQueried: (features: Record<string, unknown>[]) => {
      queried = features;
    },
    fire: (event: string, payload?: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    // mapbox-gl surface.
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
    loaded: () => true,
    areTilesLoaded: () => true,
    getStyle: () => ({ layers: [{ id: "background", type: "background" }] }),
    getCanvas: () => ({}) as HTMLCanvasElement,
    getContainer: () => ({ querySelector: () => null }) as unknown as HTMLElement,
    project: (p: [number, number]) => ({ x: p[0], y: p[1] }),
    unproject: (p: [number, number]) => ({ lng: p[0], lat: p[1] }),
    triggerRepaint: () => {},
    addControl: (control: unknown, position?: string) => {
      controls.push(control);
      controlPositions.set(control, position);
    },
    removeControl: (control: unknown) => {
      controls.splice(controls.indexOf(control), 1);
      controlPositions.delete(control);
    },
    hasControl: (control: unknown) => controls.includes(control),
    getSource: (id: string) =>
      sources.has(id)
        ? {
            setData: (data: unknown) => {
              calls.push(`setData:${id}`);
              sources.set(id, { ...sources.get(id)!, data });
            },
          }
        : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      calls.push(`addSource:${id}`);
      sources.set(id, spec);
    },
    removeSource: (id: string) => {
      calls.push(`removeSource:${id}`);
      sources.delete(id);
    },
    getLayer: (id: string) => layers.find((l) => l.id === id),
    addLayer: (spec: Record<string, unknown>) => {
      calls.push(`addLayer:${spec.id}`);
      layers.push(spec);
    },
    removeLayer: (id: string) => {
      calls.push(`removeLayer:${id}`);
      layers.splice(
        layers.findIndex((l) => l.id === id),
        1,
      );
    },
    moveLayer: (id: string, beforeId?: string) => {
      const index = layers.findIndex((l) => l.id === id);
      const [layer] = layers.splice(index, 1);
      const beforeIndex = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
      if (beforeIndex >= 0) layers.splice(beforeIndex, 0, layer);
      else layers.push(layer);
    },
    setPaintProperty: (id: string, key: string, value: unknown) => {
      calls.push(`setPaintProperty:${id}:${key}`);
      const layer = layers.find((l) => l.id === id)!;
      layer.paint = {
        ...(layer.paint as Record<string, unknown>),
        [key]: value,
      };
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      calls.push(`setLayoutProperty:${id}:${key}`);
      const layer = layers.find((l) => l.id === id)!;
      layer.layout = {
        ...(layer.layout as Record<string, unknown>),
        [key]: value,
      };
    },
    getPaintProperty: (id: string, key: string) =>
      (layers.find((l) => l.id === id)?.paint as Record<string, unknown> | undefined)?.[key],
    getLayoutProperty: (id: string, key: string) =>
      (layers.find((l) => l.id === id)?.layout as Record<string, unknown> | undefined)?.[key],
    setFilter: (id: string) => {
      calls.push(`setFilter:${id}`);
    },
    setLayerZoomRange: (id: string) => {
      calls.push(`setLayerZoomRange:${id}`);
    },
    queryRenderedFeatures: () => queried,
    getCenter: () => ({ toArray: () => center }),
    getZoom: () => zoom,
    getBearing: () => bearing,
    getPitch: () => pitch,
    getBounds: () => ({
      getWest: () => -10,
      getSouth: () => -5,
      getEast: () => 10,
      getNorth: () => 5,
    }),
    jumpTo: (view: { center: [number, number]; zoom: number; bearing: number; pitch: number }) => {
      calls.push("jumpTo");
      ({ center, zoom, bearing, pitch } = view);
    },
    flyTo: (view: { center: [number, number]; zoom: number; pitch?: number }) => {
      calls.push(`flyTo:${JSON.stringify(view)}`);
      center = view.center;
      zoom = view.zoom;
      if (view.pitch !== undefined) pitch = view.pitch;
    },
    setMinZoom: (v: number) => calls.push(`setMinZoom:${v}`),
    setMaxZoom: (v: number) => calls.push(`setMaxZoom:${v}`),
    getMaxZoom: () => 18,
    setMaxPitch: (v: number) => calls.push(`setMaxPitch:${v}`),
    setMaxBounds: (v: unknown) => calls.push(`setMaxBounds:${JSON.stringify(v ?? null)}`),
    setRenderWorldCopies: (v: boolean) => calls.push(`setRenderWorldCopies:${v}`),
    getProjection: () => ({ name: "mercator" }),
    setProjection: (v: string) => calls.push(`setProjection:${v}`),
    setTerrain: (v: unknown) => calls.push(`setTerrain:${JSON.stringify(v)}`),
    stop: () => {},
    remove: () => calls.push("remove"),
  };
  return map;
}

/** Records its constructor options and the `ScaleControl.setUnit` calls. */
class FakeControl {
  unit: unknown;
  constructor(public options?: Record<string, unknown>) {
    this.unit = options?.unit;
  }
  setUnit(unit: unknown) {
    this.unit = unit;
  }
}
class FakeNavigationControl extends FakeControl {}
class FakeFullscreenControl extends FakeControl {}
class FakeGeolocateControl extends FakeControl {}
class FakeScaleControl extends FakeControl {}
class FakeAttributionControl extends FakeControl {}
const gl = {
  NavigationControl: FakeNavigationControl,
  FullscreenControl: FakeFullscreenControl,
  GeolocateControl: FakeGeolocateControl,
  ScaleControl: FakeScaleControl,
  AttributionControl: FakeAttributionControl,
} as unknown as typeof mapboxgl.default;

/** A readable name for each mounted control, in mount order. */
function controlNames(map: ReturnType<typeof makeMap>): string[] {
  return map.controls.map((control) => {
    if (control instanceof FakeControl) return control.constructor.name.replace("Fake", "");
    // The compass is a ResetBearingControl behind the engine's Mapbox adapter
    // (a plain object), the globe is MapboxGlobeControl, and the layer
    // control is the host's own adapter, also a plain object.
    return control?.constructor?.name === "Object" ? "Adapter" : control!.constructor.name;
  });
}

const SOURCE = "geolibre-mapbox-layer-a";
const FILL = `${SOURCE}-geojson-fill`;
const LINE = `${SOURCE}-geojson-line`;
const CIRCLE = `${SOURCE}-geojson-circle`;

function makeEngine(map = makeMap()) {
  const engine = new MapboxEngine(map as unknown as mapboxgl.Map, gl);
  return { engine, map };
}

describe("MapboxEngine construction", () => {
  it("lets plugin panels locate their Mapbox control corner", () => {
    const { engine, map } = makeEngine();
    const { document } = parseHTML(
      '<div id="map"><div class="mapboxgl-ctrl-top-left"></div></div>',
    );
    const container = document.getElementById("map")!;
    map.getContainer = () => container;
    const element = document.createElement("div");
    const control = {
      onAdd() {
        // The plugin's position detector runs during its mount lifecycle.
        assert.ok(container.querySelector(".maplibregl-ctrl-top-left"));
        return element;
      },
      onRemove() {},
    };
    assert.equal(engine.addControl(control, "top-left"), true);
    const adapter = map.controls.at(-1) as mapboxgl.IControl;
    assert.equal(adapter.onAdd(map as unknown as mapboxgl.Map), element);
    assert.ok(element.classList.contains("mapboxgl-ctrl"));
    engine.addControl(control, "top-left");
    assert.equal(map.controls.filter((c) => c === adapter).length, 1);
    engine.removeControl(control);
    assert.ok(!map.controls.includes(adapter));
  });
  it("hands a second map the token, and nothing at all when there is none", () => {
    // The Layer Swipe comparison pane builds its own mapbox-gl map and has to
    // pass the token along, because GeoLibre sets it per map rather than on the
    // global mapbox-gl reads by default. A blank one is not a token: forwarding
    // `""` would put an empty `accessToken` in that map's options instead of
    // leaving the key out, so the accessor reports absence as `null`.
    const map = makeMap();
    assert.equal(
      new MapboxEngine(map as unknown as mapboxgl.Map, gl, "pk.test").getMapboxAccessToken(),
      "pk.test",
    );
    assert.equal(makeEngine().engine.getMapboxAccessToken(), null);
  });
  it("mounts MapLibre's default controls, in MapLibre's order, and takes the style's layers as the basemap", () => {
    const { engine, map } = makeEngine();
    // Fullscreen, the compass under it, then the globe toggle (MapController
    // inserts them in this order and both engines stack by insertion), the
    // scale bar and attribution, plus the layer control that mounts once the
    // style has loaded (the fake reports it loaded up front). Navigation,
    // geolocate and terrain are hidden by default, as on MapLibre.
    assert.deepEqual(controlNames(map), [
      "FullscreenControl",
      "Adapter",
      "MapboxGlobeControl",
      "ScaleControl",
      "AttributionControl",
      "Adapter",
    ]);
    assert.deepEqual(
      map.controls.map((control) => map.controlPositions.get(control)),
      ["top-right", "top-right", "top-right", "bottom-left", "bottom-right", "top-right"],
    );
    assert.deepEqual(engine.getBasemapStyleLayerIds(), ["background"]);
    assert.equal(engine.getMap(), null);
    assert.equal(engine.getMapboxMap(), map as unknown as mapboxgl.Map);
  });
  it("mounts the same default set on a split pane, minus the layer control", () => {
    const map = makeMap();
    new MapboxEngine(map as unknown as mapboxgl.Map, gl, "", {
      controlVisibility: { "layer-control": false, globe: false },
    });
    assert.deepEqual(controlNames(map), [
      "FullscreenControl",
      "Adapter",
      "ScaleControl",
      "AttributionControl",
    ]);
  });
  it("applies constructor overrides through the same rules as the control API", () => {
    const map = makeMap();
    map.setStyleLoaded(false);
    const engine = new MapboxEngine(map as unknown as mapboxgl.Map, gl, "", {
      controlVisibility: {
        attribution: false,
        terrain: true,
        "layer-control": false,
      },
    });
    // Attribution cannot be hidden by an override either.
    assert.ok(controlNames(map).includes("AttributionControl"));
    // Terrain is remembered while the style loads and applied once it is in.
    assert.equal(engine.isTerrainEnabled(), true);
    assert.ok(!map.calls.some((call) => call.startsWith("setTerrain:{")));
    map.setStyleLoaded(true);
    map.fire("style.load");
    assert.ok(map.calls.some((call) => call.startsWith("setTerrain:{")));
  });
  it("keeps the attribution control mounted", () => {
    const { engine, map } = makeEngine();
    assert.equal(engine.setBuiltInControlVisible("attribution", false), false);
    assert.equal(map.controls.length, 6);
    assert.equal(engine.setBuiltInControlVisible("scale", false), true);
    assert.equal(map.controls.length, 5);
    assert.equal(engine.setBuiltInControlVisible("scale", true), true);
    assert.equal(map.controls.length, 6);
  });
  it("shows and hides the compass, globe and navigation controls from the Controls menu", () => {
    const { engine, map } = makeEngine();
    assert.equal(engine.setBuiltInControlVisible("navigation", true), true);
    assert.equal(controlNames(map).at(-1), "NavigationControl");
    // Showing an already-visible control settles instead of stacking a copy.
    assert.equal(engine.setBuiltInControlVisible("navigation", true), true);
    assert.equal(controlNames(map).filter((n) => n === "NavigationControl").length, 1);
    assert.equal(engine.setBuiltInControlVisible("navigation", false), true);
    assert.ok(!controlNames(map).includes("NavigationControl"));
    assert.equal(engine.setBuiltInControlVisible("globe", false), true);
    assert.ok(!controlNames(map).includes("MapboxGlobeControl"));
    assert.equal(engine.setBuiltInControlVisible("compass", false), true);
    assert.equal(map.controls.length, 4);
    assert.equal(engine.setBuiltInControlVisible("compass", true), true);
    assert.equal(engine.setBuiltInControlVisible("globe", true), true);
    assert.equal(engine.setBuiltInControlVisible("geolocate", true), true);
    assert.deepEqual(controlNames(map).slice(-3), [
      "Adapter",
      "MapboxGlobeControl",
      "GeolocateControl",
    ]);
  });
  it("repositions a built-in control and remembers the corner while it is hidden", () => {
    const { engine, map } = makeEngine();
    const globe = map.controls[2];
    assert.equal(engine.getBuiltInControlPosition("globe"), "top-right");
    assert.equal(engine.setBuiltInControlPosition("globe", "top-left"), true);
    assert.equal(engine.getBuiltInControlPosition("globe"), "top-left");
    const moved = map.controls.at(-1);
    assert.notEqual(moved, globe);
    assert.equal(map.controlPositions.get(moved), "top-left");
    assert.equal(map.controls.length, 6);
    // A hidden control keeps the corner it is given for when it comes back.
    engine.setBuiltInControlVisible("navigation", false);
    assert.equal(engine.setBuiltInControlPosition("navigation", "bottom-right"), true);
    engine.setBuiltInControlVisible("navigation", true);
    assert.equal(map.controlPositions.get(map.controls.at(-1)), "bottom-right");
  });
  it("refuses the controls Mapbox cannot host and treats terrain as a scene setting", () => {
    const { engine, map } = makeEngine();
    for (const id of ["logo", "maptoolkit-logo"] as const) {
      assert.equal(engine.setBuiltInControlVisible(id, true), false);
      assert.equal(engine.setBuiltInControlPosition(id, "top-left"), false);
    }
    assert.equal(map.controls.length, 6);
    // Terrain has no button on Mapbox (as on Cesium), but the Controls menu
    // and project restore must still reach the scene.
    map.calls.length = 0;
    assert.equal(engine.setBuiltInControlVisible("terrain", true), true);
    assert.equal(engine.isTerrainEnabled(), true);
    assert.ok(map.calls.some((call) => call.startsWith("setTerrain:{")));
    assert.equal(engine.setBuiltInControlVisible("terrain", false), true);
    assert.equal(engine.isTerrainEnabled(), false);
    assert.equal(engine.setBuiltInControlPosition("terrain", "top-left"), false);
    assert.equal(map.controls.length, 6);
  });
  it("forwards the translated compass label, including to a compass re-added later", () => {
    const { engine, map } = makeEngine();
    const { document, window } = parseHTML("<html><body></body></html>");
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
    };
    Object.assign(globalThis, { document, window });
    try {
      const compassMap = {
        getBearing: () => 0,
        getPitch: () => 0,
        on: () => {},
        off: () => {},
        getContainer: () => document.createElement("div"),
      } as unknown as mapboxgl.Map;
      const mount = (control: unknown) =>
        (control as mapboxgl.IControl).onAdd(compassMap).querySelector("button")!;
      engine.setCompassLabel("Réinitialiser");
      assert.equal(mount(map.controls[1]).title, "Réinitialiser");
      engine.setBuiltInControlVisible("compass", false);
      engine.setBuiltInControlVisible("compass", true);
      const button = mount(map.controls.at(-1));
      assert.equal(button.title, "Réinitialiser");
      assert.ok(button.closest(".geolibre-reset-bearing-ctrl.mapboxgl-ctrl"));
    } finally {
      Object.assign(globalThis, previous);
    }
  });
  it("follows the scale-unit preference on the scale bar", () => {
    const { engine, map } = makeEngine();
    const scale = () => map.controls.find((c) => c instanceof FakeScaleControl) as FakeControl;
    assert.equal(scale().options?.maxWidth, 120);
    assert.equal(scale().unit, "metric");
    engine.applyMapPreferences({
      scaleUnit: "imperial",
      bounds: [0, 0, 1, 1],
    } as MapPreferences);
    assert.equal(scale().unit, "imperial");
    // A scale bar re-added later is built with the remembered unit.
    engine.setBuiltInControlVisible("scale", false);
    engine.setBuiltInControlVisible("scale", true);
    assert.equal(scale().unit, "imperial");
  });
  it("detaches every listener on destroy", () => {
    const { engine, map } = makeEngine();
    engine.destroy();
    assert.ok(map.calls.includes("remove"));
    map.setStyleLoaded(true);
    // A late style.load must not reach a destroyed engine.
    map.fire("style.load");
    assert.equal(engine.getRenderSurface(), null);
  });
});

describe("MapboxEngine.syncLayers", () => {
  let engine: MapboxEngine;
  let map: ReturnType<typeof makeMap>;
  beforeEach(() => {
    ({ engine, map } = makeEngine());
    map.calls.length = 0;
  });

  it("adds a GeoJSON source and its fill, line and circle layers", () => {
    engine.syncLayers([geojsonLayer()]);
    assert.ok(map.sources.has(SOURCE));
    assert.deepEqual(
      map.layers.map((l) => l.id),
      [FILL, LINE, CIRCLE],
    );
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });

  /**
   * Run `body` with a DOM installed, and hand it the names the engine
   * published on the window. The label bridge is a window global because the
   * rewrite it feeds happens in the app's DOM, outside the engine.
   */
  const withPublishedLabels = (body: (labels: () => Record<string, string>) => void): void => {
    // The engine names style layers off the live style, so the fake has to
    // report the ones it was given rather than the fixed background-only stub.
    map.getStyle = () => ({
      sources: {},
      layers: map.layers as { id: string; type: string }[],
    });
    const { document, window } = parseHTML("<html><body></body></html>");
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
    };
    Object.assign(globalThis, { document, window });
    try {
      body(
        () =>
          (
            window as unknown as {
              __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
            }
          ).__GEOLIBRE_LAYER_LABELS__ ?? {},
      );
    } finally {
      Object.assign(globalThis, previous);
    }
  };

  it("publishes friendly names for the style layers it compiles", () => {
    // The Layer Swipe panel drives its sides by style layer id and would
    // otherwise list `geolibre-mapbox-layer-a-geojson-fill`. MapLibre's
    // controller publishes the same bridge for its own id scheme, so a layer
    // has to read the same whichever engine is drawing it.
    withPublishedLabels((labels) => {
      engine.syncLayers([geojsonLayer()]);
      assert.equal(labels()[FILL], "Layer A Polygons");
      assert.equal(labels()[LINE], "Layer A Lines");
      assert.equal(labels()[CIRCLE], "Layer A Points");
      // The swipe panel's grouped basemap row, as the Layers panel names it.
      assert.equal(labels().__basemap__, "Background");
    });
  });

  it("does not let one layer claim a same-prefixed neighbour's rows", () => {
    // `geolibre-mapbox-a-` is a prefix of `geolibre-mapbox-a-b-`, so matching
    // ids by prefix would hand "A" its neighbour's three rows as well. The
    // visible consequence is the qualifier: a layer drawing through one style
    // layer is named bare, and four would wrongly make it "A Raster".
    withPublishedLabels((labels) => {
      engine.syncLayers([
        geojsonLayer({
          id: "a",
          name: "A",
          type: "xyz",
          source: {
            type: "raster",
            tiles: ["https://tiles.test/{z}/{x}/{y}.png"],
          },
          geojson: undefined,
        }),
        geojsonLayer({ id: "a-b", name: "A B" }),
      ]);
      assert.equal(labels()["geolibre-mapbox-a-raster"], "A");
      assert.equal(labels()["geolibre-mapbox-a-b-geojson-fill"], "A B Polygons");
    });
  });

  it("distinguishes the rows of a layer whose ids the engine did not choose", () => {
    // ArcGIS (and every plugin that hands the engine `nativeLayerIds`) names
    // its own style layers, so they carry no `geolibre-mapbox-<id>-` prefix.
    // The kind is still the id's last segment, and taking it from there is
    // what keeps the two rows apart — without it both are named "Parcels" and
    // the swipe panel offers the user the same row twice.
    withPublishedLabels((labels) => {
      const layer = geojsonLayer({ id: "parcels", name: "Parcels" });
      layer.type = "arcgis";
      delete layer.geojson;
      layer.source = {
        arcgisSources: {
          parcels: {
            type: "vector",
            tiles: ["https://tiles.test/{z}/{x}/{y}.pbf"],
          },
        },
        arcgisLayers: [
          {
            id: "parcels-fill",
            type: "fill",
            source: "parcels",
            "source-layer": "parcels",
          },
          {
            id: "parcels-line",
            type: "line",
            source: "parcels",
            "source-layer": "parcels",
          },
        ],
      };
      layer.metadata = { nativeLayerIds: ["parcels-fill", "parcels-line"] };
      engine.syncLayers([layer]);
      assert.equal(labels()["parcels-fill"], "Parcels Polygons");
      assert.equal(labels()["parcels-line"], "Parcels Lines");
    });
  });

  it("names a single-style-layer row without a geometry qualifier", () => {
    withPublishedLabels((labels) => {
      engine.syncLayers([
        geojsonLayer({
          id: "raster-a",
          name: "Imagery",
          type: "xyz",
          source: {
            type: "raster",
            tiles: ["https://tiles.test/{z}/{x}/{y}.png"],
          },
          geojson: undefined,
        }),
      ]);
      // One style layer, so no "Imagery Raster" — just the layer's own name.
      assert.deepEqual(
        Object.entries(labels()).filter(([id]) => id.includes("raster-a")),
        [["geolibre-mapbox-raster-a-raster", "Imagery"]],
      );
    });
  });

  it("leaves the bridge to the primary pane", () => {
    // The bridge is one window global. A split/grid pane draws the same layers
    // under the same style-layer ids but filtered by its own visibility, so
    // publishing from there would republish a subset — changing the sibling
    // count and so the qualifiers — and clearing on teardown would wipe the
    // primary's names until its next sync, leaving the swipe panel on raw ids.
    withPublishedLabels((labels) => {
      engine.syncLayers([geojsonLayer()]);
      assert.equal(labels()[FILL], "Layer A Polygons");

      const paneMap = makeMap();
      paneMap.getStyle = () => ({
        sources: {},
        layers: paneMap.layers as { id: string; type: string }[],
      });
      const pane = new MapboxEngine(paneMap as unknown as mapboxgl.Map, gl, "", {
        ownsLayerLabels: false,
      });
      pane.syncLayers([geojsonLayer({ id: "layer-a", name: "Renamed In The Pane" })]);
      assert.equal(labels()[FILL], "Layer A Polygons");
      pane.destroy();
      assert.equal(labels()[FILL], "Layer A Polygons");
    });
  });

  it("carries the translated basemap label into the bridge", () => {
    withPublishedLabels((labels) => {
      engine.syncLayers([geojsonLayer()]);
      engine.setBackgroundLabel("Hintergrund");
      assert.equal(labels().__basemap__, "Hintergrund");
      // The layer names survive the republish.
      assert.equal(labels()[FILL], "Layer A Polygons");
    });
  });

  it("defers the sync until the style has loaded and flushes on idle", () => {
    map.setStyleLoaded(false);
    engine.syncLayers([geojsonLayer()]);
    assert.equal(map.sources.size, 0);
    map.setStyleLoaded(true);
    map.fire("idle");
    assert.ok(map.sources.has(SOURCE));
    map.calls.length = 0;
    // Nothing is pending any more, so the next idle is a no-op.
    map.fire("idle");
    assert.deepEqual(map.calls, []);
  });

  it("updates changed paint in place instead of rebuilding the layer", () => {
    const layer = geojsonLayer();
    engine.syncLayers([layer]);
    map.calls.length = 0;
    engine.syncLayers([{ ...layer, style: { ...layer.style, fillColor: "#ff0000" } }]);
    assert.ok(map.calls.some((c) => c === `setPaintProperty:${FILL}:fill-color`));
    assert.ok(!map.calls.some((c) => c.startsWith("addLayer:")));
    assert.ok(!map.calls.some((c) => c.startsWith("setData:")));
  });

  it("pushes new GeoJSON through setData rather than recreating the source", () => {
    const layer = geojsonLayer();
    engine.syncLayers([layer]);
    map.calls.length = 0;
    engine.syncLayers([
      {
        ...layer,
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [1, 2] },
            },
          ],
        },
      },
    ]);
    assert.deepEqual(
      map.calls.filter((c) => c.startsWith("setData:") || c.includes("Source:")),
      [`setData:${SOURCE}`],
    );
  });

  it("orders the map layers to match the store, topmost first", () => {
    const a = geojsonLayer({ id: "a" });
    const b = geojsonLayer({ id: "b" });
    engine.syncLayers([a, b]);
    const order = () => map.layers.map((l) => String(l.id).replace(/-geojson-.*$/, ""));
    // The store lists `a` on top, so `b` is added first (below).
    assert.deepEqual(order().slice(0, 3), Array(3).fill("geolibre-mapbox-b"));
    engine.syncLayers([b, a]);
    assert.deepEqual(order().slice(0, 3), Array(3).fill("geolibre-mapbox-a"));
  });

  it("keeps selection overlays above project layers and adds a polygon fill", () => {
    map.getStyle = () => ({
      sources: {},
      layers: map.layers as { id: string; type: string }[],
    });
    const layer = geojsonLayer({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "polygon",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    });
    engine.syncLayers([layer]);
    engine.highlightFeature(layer, ["polygon"]);
    assert.deepEqual(
      map.layers.slice(-3).map((entry) => entry.id),
      [
        "geolibre-mapbox-highlight-fill",
        "geolibre-mapbox-highlight-line",
        "geolibre-mapbox-highlight-point",
      ],
    );

    engine.syncLayers([{ ...layer, style: { ...layer.style, fillColor: "#ef4444" } }]);
    assert.deepEqual(
      map.layers.slice(-3).map((entry) => entry.id),
      [
        "geolibre-mapbox-highlight-fill",
        "geolibre-mapbox-highlight-line",
        "geolibre-mapbox-highlight-point",
      ],
    );
  });

  it("leaves Z-aware GeoJSON to deck.gl instead of drawing a flat duplicate", () => {
    const elevated = geojsonLayer({
      style: { ...geojsonLayer().style, elevation3dEnabled: true },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [1, 2, 30] },
          },
        ],
      },
    });
    engine.syncLayers([elevated]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);

    engine.syncLayers([
      {
        ...elevated,
        geojson: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [1, 2] },
            },
          ],
        },
      },
    ]);
    assert.ok(map.sources.has(SOURCE));
    assert.ok(map.layers.length > 0);
  });

  it("removes the source and layers of a layer that left the store", () => {
    engine.syncLayers([geojsonLayer()]);
    engine.syncLayers([]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
  });

  it("reports a visible layer the adapter cannot compile and clears it on removal", () => {
    const layer = geojsonLayer({
      id: "cog",
      name: "Elevation",
      type: "cog",
      source: { type: "raster", url: "cog://tiles/elevation.tif" },
      geojson: undefined,
    });
    engine.syncLayers([layer]);
    assert.equal(engine.getRenderStatus().errors.length, 1);
    assert.match(engine.getRenderStatus().errors[0], /^Elevation: /);
    // A hidden layer has nothing on the map to report.
    engine.syncLayers([{ ...layer, visible: false }]);
    assert.deepEqual(engine.getRenderStatus().errors, []);
    engine.syncLayers([layer]);
    engine.syncLayers([]);
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });

  it("leaves plugin-managed rasters to their renderer without unsupported-layer errors", () => {
    const layer = geojsonLayer({
      id: "campus",
      type: "cog",
      geojson: undefined,
      source: { type: "raster", url: "https://example.com/campus.tif" },
      metadata: { sourceKind: "maplibre-gl-raster", externalNativeLayer: true },
    });
    map.addLayer({ id: layer.id, type: "custom" });
    engine.syncLayers([layer]);
    assert.equal(isMapboxSupportedLayer(layer), true);
    assert.deepEqual(engine.getRenderStatus().errors, []);
    assert.equal(map.sources.size, 0);
    assert.ok(map.getLayer(layer.id));
    engine.syncLayers([{ ...layer, opacity: 0.5 }]);
    engine.syncLayers([]);
    assert.ok(map.getLayer(layer.id), "the plugin owns teardown too");
  });

  it("drops a source error once the source loads or its layer is removed", () => {
    engine.syncLayers([geojsonLayer()]);
    map.fire("error", { error: new Error("tile 404"), sourceId: SOURCE });
    assert.deepEqual(engine.getRenderStatus().errors, ["tile 404"]);
    // Metadata and visibility events are not a recovery.
    map.fire("sourcedata", {
      sourceId: SOURCE,
      sourceDataType: "metadata",
      isSourceLoaded: true,
    });
    map.fire("sourcedata", {
      sourceId: SOURCE,
      sourceDataType: "content",
      isSourceLoaded: false,
    });
    assert.equal(engine.getRenderStatus().errors.length, 1);
    map.fire("sourcedata", {
      sourceId: SOURCE,
      sourceDataType: "content",
      isSourceLoaded: true,
    });
    assert.deepEqual(engine.getRenderStatus().errors, []);

    map.fire("error", { error: new Error("tile 404"), sourceId: SOURCE });
    engine.syncLayers([]);
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });

  it("redacts tokens from engine errors", () => {
    map.fire("error", {
      error: new Error("https://api.mapbox.com/x?access_token=pk.secret failed"),
    });
    assert.deepEqual(engine.getRenderStatus().errors, ["https://api.mapbox.com/x failed"]);
  });

  it("redacts common credential formats from diagnostic text", () => {
    const redacted = redactMapboxError(
      'https://user:password@example.com/data?api_key=url-secret&sig=azure-secret&sv=version&public=ok Authorization: Bearer bearer-secret Basic basic-secret {"token":"json-secret","apiKey":"key-secret"}',
    );

    assert.equal(
      redacted,
      'https://example.com/data?public=ok Authorization: Bearer [redacted] Basic [redacted] {"token":"[redacted]","apiKey":"[redacted]"}',
    );
  });

  it("ignores aborted renderer requests", () => {
    const diagnosticMap = makeMap();
    const diagnostics: Array<{ message: string }> = [];
    const diagnosticEngine = new MapboxEngine(diagnosticMap as unknown as mapboxgl.Map, gl, "", {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const error = new Error("The operation was aborted");
    error.name = "AbortError";

    diagnosticMap.fire("error", { error, sourceId: "roads" });

    assert.deepEqual(diagnosticEngine.getRenderStatus().errors, []);
    assert.deepEqual(diagnostics, []);
  });

  it("reports renderer errors to Diagnostics once with structured context", () => {
    const diagnosticMap = makeMap();
    const diagnostics: Array<{
      message: string;
      detail?: string;
      source?: string;
      status?: number;
      url?: string;
    }> = [];
    new MapboxEngine(diagnosticMap as unknown as mapboxgl.Map, gl, "", {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const error = Object.assign(new Error("Tile pk.secret failed"), {
      status: 404,
      resource: "https://api.mapbox.com/tiles/2/1/0.png?access_token=pk.secret",
    });

    diagnosticMap.fire("error", { error, sourceId: "roads" });
    diagnosticMap.fire("error", {
      error: Object.assign(new Error("Another tile failed"), {
        status: 404,
        resource: "https://api.mapbox.com/tiles/2/1/1.png?access_token=pk.secret",
      }),
      sourceId: "roads",
    });

    assert.equal(diagnostics.length, 1, "one broken source reports once per failure episode");
    assert.deepEqual(diagnostics[0], {
      message: "Tile [redacted] failed",
      detail:
        '{\n  "source": "roads",\n  "status": 404,\n  "url": "https://api.mapbox.com/tiles/2/1/0.png",\n  "error": "Tile [redacted] failed"\n}',
      source: "roads",
      status: 404,
      url: "https://api.mapbox.com/tiles/2/1/0.png",
    });
  });

  it("groups a sourceless tile burst without hiding a later resource failure", () => {
    const diagnosticMap = makeMap();
    const diagnostics: Array<{ message: string }> = [];
    new MapboxEngine(diagnosticMap as unknown as mapboxgl.Map, gl, "", {
      onDiagnostic: (event) => diagnostics.push(event),
    });

    diagnosticMap.fire("error", {
      error: Object.assign(new Error("tile zero failed"), {
        resource: "https://tiles.example.com/4/2/0.png",
      }),
    });
    diagnosticMap.fire("error", {
      error: Object.assign(new Error("tile one failed"), {
        resource: "https://tiles.example.com/4/2/1.png",
      }),
    });
    diagnosticMap.fire("error", {
      error: Object.assign(new Error("retina tile zero failed"), {
        resource: "https://tiles.example.com/4/2/0@2x.png",
      }),
    });
    diagnosticMap.fire("error", {
      error: Object.assign(new Error("retina tile one failed"), {
        resource: "https://tiles.example.com/4/2/1@2x.png",
      }),
    });
    diagnosticMap.fire("error", {
      error: Object.assign(new Error("sprite failed"), {
        resource: "https://tiles.example.com/styles/main/sprite.json",
      }),
    });

    assert.deepEqual(
      diagnostics.map((event) => event.message),
      ["tile zero failed", "retina tile zero failed", "sprite failed"],
    );
  });

  it("reports a repeatedly failing layer once until it recovers", () => {
    const diagnosticMap = makeMap();
    const diagnostics: Array<{ message: string }> = [];
    const diagnosticEngine = new MapboxEngine(diagnosticMap as unknown as mapboxgl.Map, gl, "", {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const layer = geojsonLayer({
      id: "broken-cog",
      name: "Broken COG",
      type: "cog",
      source: { type: "raster", url: "cog://tiles/broken.tif" },
      geojson: undefined,
    });

    diagnosticEngine.syncLayers([layer]);
    diagnosticEngine.syncLayers([layer]);

    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /^Broken COG: /);
  });

  it("labels with the font the loaded basemap style uses", () => {
    const layer = geojsonLayer();
    layer.style = {
      ...layer.style,
      labels: { ...layer.style.labels, enabled: true, field: "name" },
    };
    engine.syncLayers([layer]);
    const font = () =>
      (map.layers.find((l) => l.type === "symbol")?.layout as Record<string, unknown>)?.[
        "text-font"
      ];
    // The fake style has no symbol layer, so the Mapbox default applies.
    assert.deepEqual(font(), ["Open Sans Regular"]);
    map.getStyle = () => ({
      layers: [
        { id: "background", type: "background" },
        {
          id: "place",
          type: "symbol",
          layout: {
            "text-field": "{name}",
            "text-font": ["Noto Sans Regular"],
          },
        },
      ],
    });
    map.fire("style.load");
    assert.deepEqual(font(), ["Noto Sans Regular"]);
  });

  it("rebuilds everything after a style swap", () => {
    engine.syncLayers([geojsonLayer()]);
    map.sources.clear();
    map.layers.length = 0;
    map.fire("style.load");
    assert.ok(map.sources.has(SOURCE));
    assert.equal(map.layers.length, 3);
  });
});

describe("MapboxEngine.identifyFeatures", () => {
  it("maps Mapbox's generated ids back to the layer's own feature identity", () => {
    const { engine, map } = makeEngine();
    // A polygon and a point, so the engine compiles the fill, line and circle
    // layers the hits below come from; it only adds the ones the data can draw.
    const feature = (id: string | undefined, name: string, geometry: Geometry) => ({
      type: "Feature" as const,
      ...(id === undefined ? {} : { id }),
      properties: { name },
      geometry,
    });
    engine.syncLayers([
      geojsonLayer({
        geojson: {
          type: "FeatureCollection",
          features: [
            feature("ca", "California", {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            }),
            feature(undefined, "Nevada", {
              type: "Point",
              coordinates: [0, 0],
            }),
          ],
        },
      }),
    ]);
    // `generateId` makes Mapbox report the feature's index as its id, and a
    // polygon spanning two tiles comes back twice.
    map.setQueried([
      {
        id: 0,
        layer: { id: FILL },
        properties: { name: "California" },
        geometry: null,
      },
      {
        id: 0,
        layer: { id: LINE },
        properties: { name: "California" },
        geometry: null,
      },
      {
        id: 1,
        layer: { id: CIRCLE },
        properties: { name: "Nevada" },
        geometry: null,
      },
    ]);
    const found = engine.identifyFeatures([0, 0]);
    assert.deepEqual(
      found.map((f) => [f.layerId, f.featureId]),
      [
        ["layer-a", "ca"],
        ["layer-a", "1"],
      ],
    );
    assert.deepEqual(engine.identifyFeatures([0, 0], "other"), []);
    assert.equal(engine.featureIdAtPoint("layer-a", { x: 20, y: 30 }), "ca");
    assert.equal(engine.featureIdAtPoint("other", { x: 20, y: 30 }), null);
  });
});

describe("MapboxEngine camera and preferences", () => {
  it("reads the camera and skips a jump that changes nothing", () => {
    const { engine, map } = makeEngine();
    const view = engine.readView();
    assert.deepEqual(view.center, [0, 0]);
    assert.deepEqual(view.bbox, [-10, -5, 10, 5]);
    map.calls.length = 0;
    engine.applyView({ center: [0, 0], zoom: 2, bearing: 0, pitch: 0 });
    assert.deepEqual(map.calls, []);
    engine.applyView({ center: [10, 20], zoom: 5, bearing: 30, pitch: 40 });
    assert.deepEqual(map.calls, ["jumpTo"]);
    assert.deepEqual(engine.readView().center, [10, 20]);
    assert.equal(engine.readView().bearing, 30);
  });

  it("tilts into a tileset on zoom-to-layer, like the MapLibre engine", () => {
    const { engine, map } = makeEngine();
    const tileset = {
      ...geojsonLayer(),
      geojson: undefined,
      type: "3d-tiles" as const,
      source: { url: "https://example.com/tileset.json" },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "3d-tiles-url",
        center: [-75, 40],
        zoom: 15,
      },
    };
    map.calls.length = 0;
    engine.fitLayer(tileset);
    assert.deepEqual(map.calls, ['flyTo:{"center":[-75,40],"zoom":15,"pitch":60}']);
    // An already steeper camera is kept, and a point cloud is not tilted.
    map.jumpTo({ center: [-75, 40], zoom: 15, bearing: 0, pitch: 70 });
    engine.fitLayer(tileset);
    assert.equal(map.calls.at(-1), 'flyTo:{"center":[-75,40],"zoom":15,"pitch":70}');
    engine.fitLayer({
      ...tileset,
      type: "lidar",
      metadata: {
        ...tileset.metadata,
        sourceKind: "lidar-url",
        zoom: undefined,
      },
    });
    assert.equal(map.calls.at(-1), 'flyTo:{"center":[-75,40],"zoom":16}');
    engine.fitLayer({
      ...tileset,
      metadata: { externalNativeLayer: true, center: "nowhere" },
    });
    assert.equal(map.calls.length, 4);
  });

  it("clamps a saved camera to the project preferences before moving", () => {
    const { engine, map } = makeEngine();
    engine.applyMapPreferences({
      minZoom: 3,
      maxZoom: 12,
      maxPitch: 60,
      bounds: [-180, -90, 180, 90],
      restrictBounds: false,
      renderWorldCopies: false,
      projection: "mercator",
      terrainEnabled: false,
    } as unknown as MapPreferences);
    map.calls.length = 0;
    engine.applyView({ center: [200, 89], zoom: 18, bearing: 10, pitch: 80 });
    assert.deepEqual(map.calls, ["jumpTo"]);
    const view = engine.readView();
    assert.deepEqual(view.center, [180, 85]);
    assert.equal(view.zoom, 12);
    assert.equal(view.pitch, 60);
    assert.equal(view.bearing, 10);
    engine.applyView({ center: [0, 0], zoom: 1, bearing: 0, pitch: 0 });
    assert.equal(engine.readView().zoom, 3);
  });

  it("applies zoom, pitch, bounds, projection and terrain preferences", () => {
    const { engine, map } = makeEngine();
    map.calls.length = 0;
    const preferences = {
      minZoom: 3,
      maxZoom: 40,
      maxPitch: 90,
      bounds: [-1, -2, 3, 4],
      restrictBounds: true,
      renderWorldCopies: false,
      projection: "globe",
      terrainEnabled: true,
    } as unknown as MapPreferences;
    engine.applyMapPreferences(preferences);
    // Constraints are cleared before the new interval is applied, and the
    // out-of-range values are clamped.
    assert.deepEqual(map.calls.slice(0, 4), [
      "setMinZoom:0",
      "setMaxZoom:24",
      "setMaxZoom:24",
      "setMinZoom:3",
    ]);
    assert.ok(map.calls.includes("setMaxPitch:85"));
    assert.ok(map.calls.includes("setMaxBounds:[[-1,-2],[3,4]]"));
    assert.ok(map.calls.includes("setRenderWorldCopies:false"));
    assert.ok(map.calls.includes("setProjection:globe"));
    assert.ok(map.sources.has("geolibre-mapbox-dem"));
    assert.ok(map.calls.includes('setTerrain:{"source":"geolibre-mapbox-dem","exaggeration":1}'));
    assert.equal(engine.isTerrainEnabled(), true);

    map.calls.length = 0;
    engine.applyMapPreferences({
      ...preferences,
      restrictBounds: false,
      terrainEnabled: false,
    });
    assert.ok(map.calls.includes("setMaxBounds:null"));
    assert.ok(map.calls.includes("setTerrain:null"));
  });

  it("re-applies the remembered preferences after a style swap", () => {
    const { engine, map } = makeEngine();
    engine.applyMapPreferences({
      minZoom: 3,
      maxZoom: 12,
      maxPitch: 60,
      bounds: [-1, -2, 3, 4],
      restrictBounds: false,
      renderWorldCopies: true,
      projection: "mercator",
      terrainEnabled: false,
    } as unknown as MapPreferences);
    map.calls.length = 0;
    map.fire("style.load");
    assert.ok(map.calls.includes("setMinZoom:3"));
    assert.ok(map.calls.includes("setMaxZoom:12"));
  });
});

describe("Mapbox shared raster basemaps", () => {
  it("adopts the control layer, updates visibility and removes it without duplicates", () => {
    const { engine, map } = makeEngine();
    const sourceId = "maplibre-basemap-control-source-osm";
    const layerId = "osm";
    const source = {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
    };
    map.addSource(sourceId, source);
    map.addLayer({ id: layerId, type: "raster", source: sourceId });
    const layer = {
      ...geojsonLayer({ id: "basemap-osm" }),
      type: "raster" as const,
      geojson: undefined,
      source,
      metadata: {
        sourceKind: "maplibre-basemap-control",
        sourceId,
        nativeLayerIds: [layerId],
      },
    };
    engine.syncLayers([layer]);
    assert.equal(map.sources.size, 1);
    assert.equal(map.layers.length, 1);
    engine.syncLayers([{ ...layer, visible: false, opacity: 0.4 }]);
    assert.equal((map.getLayer(layerId)?.layout as Record<string, unknown>).visibility, "none");
    engine.syncLayers([]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
  });
});

describe("Mapbox plugin-drawn native layers", () => {
  it("waits for the vector bridge to materialize non-GeoJSON sources", () => {
    const { engine, map } = makeEngine();
    const pending = {
      ...geojsonLayer({ id: "countries" }),
      geojson: undefined,
      source: {
        type: "geojson" as const,
        url: "https://example.test/countries.parquet",
      },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "maplibre-gl-vector",
        nativeLayerIds: ["countries-fill"],
      },
    };

    engine.syncLayers([pending]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
    assert.deepEqual(engine.getRenderStatus().errors, []);

    const materialized = geojsonLayer({
      ...pending,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Canada" },
            geometry: { type: "Point", coordinates: [-106, 56] },
          },
        ],
      },
    });
    engine.syncLayers([materialized]);
    assert.deepEqual(map.sources.get("geolibre-mapbox-countries"), {
      type: "geojson",
      data: materialized.geojson,
      generateId: true,
    });
    assert.ok(map.layers.length > 0);
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });

  // The Web Services panels (FEMA NFHL here) add their raster source and layer
  // to the map themselves and mirror them into the store as external native
  // layers. MapLibre's layer-sync rebuilds those under the control's own ids;
  // the Mapbox engine must do the same rather than draw a second copy.
  it("adopts a Web Services raster layer under its native ids and rebuilds it after a style reload", () => {
    const { engine, map } = makeEngine();
    const nativeId = "fema-wms-NFHL";
    const source = {
      type: "raster",
      tiles: ["https://example.test/{z}/{x}/{y}"],
      tileSize: 256,
    };
    map.addSource(nativeId, source);
    map.addLayer({ id: nativeId, type: "raster", source: nativeId, paint: {} });
    const layer = {
      ...geojsonLayer({ id: nativeId }),
      type: "wms" as const,
      geojson: undefined,
      source: { ...source, sourceId: nativeId },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "fema-wms",
        sourceId: nativeId,
        sourceIds: [nativeId],
        nativeLayerIds: [nativeId],
      },
    };
    engine.syncLayers([layer]);
    assert.deepEqual([...map.sources.keys()], [nativeId]);
    assert.deepEqual(
      map.layers.map((l) => l.id),
      [nativeId],
    );
    engine.syncLayers([{ ...layer, visible: false, opacity: 0.3 }]);
    assert.equal((map.getLayer(nativeId)?.layout as Record<string, unknown>).visibility, "none");
    assert.equal((map.getLayer(nativeId)?.paint as Record<string, unknown>)["raster-opacity"], 0.3);
    // A basemap swap drops every source and layer; the engine puts the
    // control's layer back under the same ids, as MapLibre's layer-sync does.
    map.sources.clear();
    map.layers.length = 0;
    map.fire("style.load");
    assert.deepEqual([...map.sources.keys()], [nativeId]);
    assert.deepEqual(
      map.layers.map((l) => l.id),
      [nativeId],
    );
    engine.syncLayers([]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
  });

  it("mirrors store visibility and opacity onto a plugin-owned layer's native style layers", () => {
    const { engine, map } = makeEngine();
    // A plugin-owned kind (the engine never compiles it) whose plugin also
    // registered a native style layer under the store layer's nativeLayerIds.
    map.addSource("dep-index", {
      type: "raster",
      tiles: ["https://example.test/{z}/{x}/{y}"],
    });
    map.addLayer({
      id: "dep-index",
      type: "raster",
      source: "dep-index",
      paint: {},
    });
    const layer = {
      ...geojsonLayer({ id: "cloud" }),
      type: "lidar" as const,
      geojson: undefined,
      source: { type: "lidar", url: "https://example.test/cloud.copc.laz" },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "lidar-url",
        nativeLayerIds: ["dep-index", "not-on-the-map"],
      },
    };
    engine.syncLayers([{ ...layer, visible: false, opacity: 0.5 }]);
    assert.equal((map.getLayer("dep-index")?.layout as Record<string, unknown>).visibility, "none");
    assert.equal(
      (map.getLayer("dep-index")?.paint as Record<string, unknown>)["raster-opacity"],
      0.5,
    );
    // Nothing of the engine's own was added for it.
    assert.deepEqual([...map.sources.keys()], ["dep-index"]);
    map.calls.length = 0;
    engine.syncLayers([{ ...layer, visible: false, opacity: 0.5 }]);
    assert.deepEqual(
      map.calls.filter((call) => call.startsWith("set")),
      [],
      "an unchanged state is not re-applied",
    );
    map.calls.length = 0;
    engine.syncLayers([
      {
        ...layer,
        visible: true,
        opacity: 0.8,
        metadata: { ...layer.metadata, controlOwnsPaint: true },
      },
    ]);
    assert.deepEqual(
      map.calls.filter((call) => call.startsWith("setPaintProperty:")),
      [],
      "no paint setter runs for a control that owns its paint",
    );
    assert.equal(
      (map.getLayer("dep-index")?.layout as Record<string, unknown>).visibility,
      "visible",
    );
    assert.equal(
      (map.getLayer("dep-index")?.paint as Record<string, unknown>)["raster-opacity"],
      0.5,
      "paint is left to a control that owns it",
    );
  });

  it("leaves a control-rendered layer's paint alone and never compiles its archive URL", () => {
    const { engine, map } = makeEngine();
    // The Overture Maps control adds its own PMTiles source and styled layers;
    // the store row mirrors them (`customLayerType`) and names the archive URL
    // only for the record.
    map.addSource("overture-buildings", {
      type: "vector",
      url: "https://tiles.example.test/2026-05-20.0/buildings.pmtiles",
    });
    map.addLayer({
      id: "overture-buildings-building-fill",
      type: "fill",
      source: "overture-buildings",
      "source-layer": "building",
      paint: { "fill-color": "#4363d8", "fill-opacity": 0.8 },
    });
    map.calls.length = 0;
    const layer = {
      ...geojsonLayer({ id: "overture-maps-buildings-building" }),
      type: "vector-tiles" as const,
      geojson: undefined,
      source: {
        type: "vector",
        sourceId: "overture-buildings",
        url: "https://tiles.example.test/2026-05-20.0/buildings.pmtiles",
      },
      metadata: {
        customLayerType: "overture-maps",
        externalNativeLayer: true,
        sourceKind: "overture-maps",
        sourceId: "overture-buildings",
        nativeLayerIds: ["overture-buildings-building-fill", "overture-buildings-building-line"],
      },
    };
    engine.syncLayers([{ ...layer, visible: false, opacity: 0.3 }]);
    assert.deepEqual([...map.sources.keys()], ["overture-buildings"], "no second source");
    assert.equal(
      map.layers.filter((l) => l.id === "overture-buildings-building-fill").length,
      1,
      "the control's fill is not drawn twice",
    );
    assert.equal(
      (map.getLayer("overture-buildings-building-fill")?.layout as Record<string, unknown>)
        .visibility,
      "none",
      "store visibility is mirrored",
    );
    assert.deepEqual(
      map.calls.filter((call) => call.startsWith("setPaintProperty:")),
      [],
      "the control keeps its own color and opacity",
    );
    assert.deepEqual(
      (map.getLayer("overture-buildings-building-fill")?.paint as Record<string, unknown>)[
        "fill-color"
      ],
      "#4363d8",
    );
    // A story chapter's fade still reaches the control's layers (replacing
    // their opacity, as on MapLibre) and hands the control's paint back when
    // playback ends.
    engine.syncLayers([layer]);
    engine.setStoryLayerOpacity("overture-maps-buildings-building", 0.25);
    const fillPaint = () =>
      map.getLayer("overture-buildings-building-fill")?.paint as Record<string, unknown>;
    assert.equal(fillPaint()["fill-opacity"], 0.25, "story opacity applied");
    assert.equal(fillPaint()["fill-color"], "#4363d8", "color untouched by the fade");
    engine.restoreLayerStyles();
    assert.equal(fillPaint()["fill-opacity"], 0.8, "the control's opacity is restored");
    map.calls.length = 0;
    engine.syncLayers([layer]);
    assert.deepEqual(
      map.calls.filter((call) => call.startsWith("setPaintProperty:")),
      [],
      "nothing is re-applied once restored",
    );
    // A row that leaves the store mid-fade gets the control's paint back at
    // once, and a row re-added under the same id later is not handed the old
    // snapshot when its own fade ends.
    engine.setStoryLayerOpacity("overture-maps-buildings-building", 0.25);
    assert.equal(fillPaint()["fill-opacity"], 0.25);
    engine.syncLayers([]);
    assert.equal(fillPaint()["fill-opacity"], 0.8, "restored when the row is removed");
    map.setPaintProperty("overture-buildings-building-fill", "fill-opacity", 0.6);
    engine.syncLayers([layer]);
    assert.equal(fillPaint()["fill-opacity"], 0.25, "the active fade applies to the new row");
    engine.restoreLayerStyles();
    assert.equal(fillPaint()["fill-opacity"], 0.6, "the control's current paint comes back");
  });

  it("scales a plugin-owned fill's own opacity by the store opacity instead of replacing it", () => {
    const { engine, map } = makeEngine();
    map.addSource("footprints", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
      id: "footprints-fill",
      type: "fill",
      source: "footprints",
      paint: {},
    });
    engine.syncLayers([
      {
        ...geojsonLayer({ id: "oam" }),
        opacity: 0.5,
        style: { fillOpacity: 0.08, fillColor: "#ff0000" },
        metadata: {
          externalNativeLayer: true,
          sourceKind: "openaerialmap-footprints",
          nativeLayerIds: ["footprints-fill"],
        },
      },
    ]);
    const paint = map.getLayer("footprints-fill")?.paint as Record<string, unknown>;
    const opacity = paint["fill-opacity"] as number;
    assert.ok(Math.abs(opacity - 0.04) < 1e-9, `fill-opacity ${opacity}`);
    // The whole paint object lands, not only opacity: a Style panel colour edit
    // on a plugin-owned layer shows on Mapbox as it does on MapLibre.
    assert.equal(paint["fill-color"], "#ff0000");
  });
});

describe("Mapbox story opacity on plugin-owned layers", () => {
  it("applies a story chapter's transient opacity to a plugin-owned native layer", () => {
    const { engine, map } = makeEngine();
    map.addSource("dep-index", {
      type: "raster",
      tiles: ["https://example.test/{z}/{x}/{y}"],
    });
    map.addLayer({
      id: "dep-index",
      type: "raster",
      source: "dep-index",
      paint: {},
    });
    const layer = {
      ...geojsonLayer({ id: "cloud" }),
      type: "lidar" as const,
      geojson: undefined,
      opacity: 1,
      source: { type: "lidar", url: "https://example.test/cloud.copc.laz" },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "lidar-url",
        nativeLayerIds: ["dep-index"],
      },
    };
    engine.syncLayers([layer]);
    engine.setStoryLayerOpacity("cloud", 0.2);
    assert.equal(
      (map.getLayer("dep-index")?.paint as Record<string, unknown>)["raster-opacity"],
      0.2,
    );
    engine.restoreLayerStyles();
    assert.equal(
      (map.getLayer("dep-index")?.paint as Record<string, unknown>)["raster-opacity"],
      1,
    );
  });
});

describe("Mapbox ArcGIS vector tile services", () => {
  it("preserves service styling and manages every source through updates and removal", () => {
    const { engine, map } = makeEngine();
    const layer = geojsonLayer({ id: "arcgis-test" });
    layer.type = "arcgis";
    delete layer.geojson;
    layer.opacity = 0.5;
    layer.source = {
      arcgisSources: {
        parcels: {
          type: "vector",
          url: "https://example.com/VectorTileServer/",
          tiles: ["https://example.com/VectorTileServer/tile/{z}/{y}/{x}.pbf"],
        },
        boundaries: {
          type: "vector",
          tiles: ["https://example.com/boundaries/{z}/{x}/{y}.pbf"],
        },
      },
      arcgisLayers: [
        {
          id: "parcels-fill",
          type: "fill",
          source: "parcels",
          "source-layer": "parcels",
          filter: ["==", "_symbol", 0],
          minzoom: 11,
          maxzoom: 18,
          paint: { "fill-color": "#ffff00", "fill-opacity": 0.8 },
        },
        {
          id: "boundaries-line",
          type: "line",
          source: "boundaries",
          "source-layer": "boundaries",
          paint: { "line-color": "#ff0000" },
        },
      ],
    };
    layer.metadata = { nativeLayerIds: ["parcels-fill", "boundaries-line"] };
    assert.equal(isMapboxSupportedLayer(layer), true);
    engine.syncLayers([layer]);
    assert.equal(map.sources.size, 2);
    assert.equal(map.sources.get("parcels")?.url, undefined);
    const fill = map.layers.find((l) => l.id === "parcels-fill")!;
    assert.deepEqual(fill.filter, ["==", "_symbol", 0]);
    assert.equal(fill.minzoom, 11);
    assert.deepEqual(fill.paint, {
      "fill-color": "#ffff00",
      "fill-opacity": 0.4,
    });
    engine.syncLayers([{ ...layer, visible: false }]);
    assert.equal(
      (
        map.layers.find((l) => l.id === "parcels-fill")!.layout as {
          visibility: string;
        }
      ).visibility,
      "none",
    );
    engine.syncLayers([]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
  });

  it("rejects a source whose tile templates were never resolved", () => {
    const { engine, map } = makeEngine();
    const layer = geojsonLayer({ id: "arcgis-no-tiles" });
    layer.type = "arcgis";
    delete layer.geojson;
    layer.source = {
      // The REST service URL alone is not a TileJSON manifest Mapbox can fetch.
      arcgisSources: {
        parcels: {
          type: "vector",
          url: "https://example.com/VectorTileServer/",
        },
      },
      arcgisLayers: [
        {
          id: "parcels-fill",
          type: "fill",
          source: "parcels",
          "source-layer": "parcels",
        },
      ],
    };
    layer.metadata = { nativeLayerIds: ["parcels-fill"] };
    assert.equal(isMapboxSupportedLayer(layer), false);
    engine.syncLayers([layer]);
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
    assert.match(engine.getRenderStatus().errors[0] ?? "", /tile templates/);
  });
});

it("retries a Standard visibility change made while its opacity update is loading", () => {
  const { engine, map } = makeEngine();
  engine.setBlankBackgroundColor("#ffffff");
  const config: Record<string, unknown> = {
    geolibreBasemapOpacity: 1,
    geolibreBlankColor: "#ffffff",
  };
  Object.assign(map, {
    getConfigProperty: (_id: string, key: string) => config[key],
    setConfigProperty: (_id: string, key: string, value: unknown) => {
      config[key] = value;
      map.setStyleLoaded(false);
    },
  });
  map.getStyle = () => ({
    layers: [],
    imports: [
      {
        id: "basemap",
        url: "mapbox://styles/mapbox/standard",
        data: {
          schema: { geolibreBasemapOpacity: { type: "number", default: 1 } },
        },
      },
    ],
  });
  map.fire("style.load");
  engine.setBasemapOpacity(0.5);
  engine.setBasemapVisible(false);
  assert.equal(config.geolibreBasemapOpacity, 0.5);
  map.setStyleLoaded(true);
  map.fire("idle");
  assert.equal(config.geolibreBasemapOpacity, 0);
});

// The layer control is maplibre-gl-layer-control driven through the shared
// LayerControlHost. These tests cover the Mapbox side of that seam: when the
// engine mounts it, how it answers the built-in control API, when it rebuilds,
// and — against a linkedom DOM — that the panel lists store layers, mirrors
// store state in place, and keeps GeoLibre's own layers out of the Background
// group on a style whose basemap the control cannot fetch.
describe("MapboxEngine layer control", () => {
  it("mounts the layer control once the style has loaded, unless a pane opts out", () => {
    const { map } = makeEngine();
    assert.equal(map.controls.length, 6);
    const paneMap = makeMap();
    new MapboxEngine(paneMap as unknown as mapboxgl.Map, gl, "", {
      controlVisibility: { "layer-control": false },
    });
    assert.equal(paneMap.controls.length, 5);
    const lateMap = makeMap();
    lateMap.setStyleLoaded(false);
    new MapboxEngine(lateMap as unknown as mapboxgl.Map, gl);
    assert.equal(lateMap.controls.length, 5);
    lateMap.setStyleLoaded(true);
    lateMap.fire("style.load");
    assert.equal(lateMap.controls.length, 6);
  });
  it("hides, shows and repositions the layer control through the built-in control API", () => {
    const { engine, map } = makeEngine();
    assert.equal(engine.getBuiltInControlPosition("layer-control"), "top-right");
    assert.equal(engine.setBuiltInControlVisible("layer-control", false), true);
    assert.equal(map.controls.length, 5);
    // Hidden stays hidden across a rebuild trigger.
    engine.syncLayers([geojsonLayer()]);
    assert.equal(map.controls.length, 5);
    assert.equal(engine.setBuiltInControlVisible("layer-control", true), true);
    assert.equal(map.controls.length, 6);
    const before = map.controls.at(-1);
    assert.equal(engine.setBuiltInControlPosition("layer-control", "top-left"), true);
    assert.equal(engine.getBuiltInControlPosition("layer-control"), "top-left");
    assert.equal(map.controls.length, 6);
    assert.notEqual(map.controls.at(-1), before);
  });
  it("rebuilds the control only when the controllable layer set changes", () => {
    const { engine, map } = makeEngine();
    const initial = map.controls.at(-1);
    engine.syncLayers([geojsonLayer()]);
    const withLayer = map.controls.at(-1);
    assert.notEqual(withLayer, initial);
    // Visibility and opacity are mirrored in place, never by a rebuild that
    // would collapse the panel mid-drag.
    engine.syncLayers([geojsonLayer({ visible: false, opacity: 0.5 })]);
    assert.equal(map.controls.at(-1), withLayer);
    engine.syncLayers([geojsonLayer({ name: "Renamed" })]);
    assert.notEqual(map.controls.at(-1), withLayer);
    engine.syncLayers([]);
    assert.equal(map.controls.length, 6);
  });
  it("drops the control before a style swap and remounts it on style.load", () => {
    const { engine, map } = makeEngine();
    (map as unknown as { setStyle: () => void }).setStyle = () => {
      map.calls.push("setStyle");
    };
    engine.setResolvedStyle({ version: 8, sources: {}, layers: [] });
    assert.ok(map.calls.includes("setStyle"));
    assert.equal(map.controls.length, 5);
    map.fire("style.load");
    assert.equal(map.controls.length, 6);
  });
  it("lists store layers, mirrors store state, and seeds the basemap group", () => {
    const { window } = parseHTML('<div id="map"><div class="mapboxgl-ctrl-top-right"></div></div>');
    const globals = globalThis as { document?: unknown; window?: unknown };
    const previous = { document: globals.document, window: globals.window };
    globals.document = window.document;
    globals.window = window;
    const basemapVisible = useAppStore.getState().basemapVisible;
    try {
      const map = makeMap();
      const container = window.document.getElementById("map")!;
      map.getContainer = () => container;
      // The fake's fixed style only names the basemap; the control needs to
      // see the live layer list to classify layers. Start with no root layers
      // at all, the shape of Mapbox Standard (its basemap lives in imports).
      map.getStyle = () => ({
        sources: {},
        layers: map.layers as { id: string; type: string }[],
      });
      // A real map runs a control's onAdd inside addControl; the control
      // detects its layers there, so the fake has to do the same here.
      const mounted = new Map<unknown, HTMLElement>();
      Object.assign(map, {
        getLayoutProperty: () => undefined,
        getPaintProperty: () => undefined,
        addControl: (control: Partial<mapboxgl.IControl>) => {
          map.controls.push(control);
          if (control.onAdd) mounted.set(control, control.onAdd(map as unknown as mapboxgl.Map));
        },
        removeControl: (control: Partial<mapboxgl.IControl>) => {
          map.controls.splice(map.controls.indexOf(control), 1);
          control.onRemove?.(map as unknown as mapboxgl.Map);
          mounted.delete(control);
        },
      });
      const engine = new MapboxEngine(map as unknown as mapboxgl.Map, gl);
      // With no root layers and no project layers the control alone would
      // build an empty panel; the host still offers the Background row.
      assert.deepEqual(
        Array.from(container.querySelectorAll(".layer-control-item")).map((item) =>
          item.getAttribute("data-layer-id"),
        ),
        ["Background"],
      );

      // A style with a root basemap layer, loaded afresh.
      map.layers.push({ id: "background", type: "background" });
      map.fire("style.load");
      engine.syncLayers([geojsonLayer()]);
      const nativeIds = map.layers.map((l) => l.id as string).filter((id) => id !== "background");
      assert.ok(nativeIds.length > 0);

      const element = mounted.get(map.controls.at(-1))!;
      assert.ok(element.classList.contains("maplibregl-ctrl-layer-control"));
      const items = Array.from(container.querySelectorAll(".layer-control-item")).map((item) =>
        item.getAttribute("data-layer-id"),
      );
      // One row per GeoLibre layer (by store id, not per native style layer)
      // plus the Background group.
      assert.deepEqual(items.sort(), ["Background", "layer-a"]);

      engine.syncLayers([geojsonLayer({ visible: false, opacity: 0.4 })]);
      const row = container.querySelector('.layer-control-item[data-layer-id="layer-a"]')!;
      assert.equal(row.querySelector<HTMLInputElement>(".layer-control-checkbox")!.checked, false);
      assert.equal(row.querySelector<HTMLInputElement>(".layer-control-opacity")!.value, "0.4");

      // Toggling Background reaches the store (which drives the engine) and,
      // because the basemap ids were seeded from the loaded style rather than
      // guessed from "whatever was on the map", leaves the layer's native
      // style layers alone.
      map.calls.length = 0;
      const background = container.querySelector<HTMLInputElement>(
        '.layer-control-item[data-layer-id="Background"] .layer-control-checkbox',
      )!;
      background.checked = false;
      background.dispatchEvent(new window.Event("change"));
      assert.equal(useAppStore.getState().basemapVisible, false);
      assert.ok(map.calls.includes("setLayoutProperty:background:visibility"));
      for (const id of nativeIds) {
        assert.ok(!map.calls.includes(`setLayoutProperty:${id}:visibility`), id);
      }
    } finally {
      useAppStore.setState({ basemapVisible });
      if (previous.document === undefined) delete globals.document;
      else globals.document = previous.document;
      if (previous.window === undefined) delete globals.window;
      else globals.window = previous.window;
    }
  });
});

describe("MapboxEngine search result lifecycle", () => {
  it("uses native markers and removes each result exactly once, including on engine teardown", () => {
    const map = makeMap();
    const markers: {
      center?: [number, number];
      removals: number;
      color?: string;
    }[] = [];
    class Marker {
      center?: [number, number];
      removals = 0;
      color?: string;
      constructor(options: { color?: string }) {
        this.color = options.color;
        markers.push(this);
      }
      setLngLat(center: [number, number]) {
        this.center = center;
        return this;
      }
      addTo(target: unknown) {
        assert.equal(target, map);
        return this;
      }
      remove() {
        this.removals++;
      }
    }
    const engine = new MapboxEngine(
      map as unknown as mapboxgl.Map,
      { ...gl, Marker } as unknown as typeof mapboxgl.default,
    );
    const clearFirst = engine.showSearchResult({
      type: "Point",
      coordinates: [-77.0365, 38.8977],
    });
    const clearSecond = engine.showSearchResult({
      type: "Point",
      coordinates: [10, 20],
    });
    assert.deepEqual(markers[0].center, [-77.0365, 38.8977]);
    assert.equal(markers[0].color, "#ef4444");
    clearFirst();
    clearFirst();
    assert.deepEqual(
      markers.map((m) => m.removals),
      [1, 0],
    );
    engine.destroy();
    clearSecond();
    assert.deepEqual(
      markers.map((m) => m.removals),
      [1, 1],
    );
    engine.showSearchResult({ type: "Point", coordinates: [0, 0] })();
    assert.equal(markers.length, 2);
  });

  it("cleans up cell sources without disturbing other results, even after a style reload", () => {
    const { engine, map } = makeEngine();
    const cell: import("geojson").Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [179, 0],
          [181, 0],
          [181, 1],
          [179, 0],
        ],
      ],
    };
    map.setStyleLoaded(false);
    engine.showSearchResult(cell)();
    assert.equal(map.sources.size, 0);
    map.setStyleLoaded(true);
    const clearFirst = engine.showSearchResult(cell);
    const clearSecond = engine.showSearchResult(cell);
    assert.equal(map.sources.size, 2);
    assert.equal(map.layers.length, 4);
    clearFirst();
    clearFirst();
    assert.equal(map.sources.size, 1);
    assert.equal(map.layers.length, 2);
    map.sources.clear();
    map.layers.length = 0;
    assert.doesNotThrow(clearSecond);
    const clearLast = engine.showSearchResult(cell);
    engine.destroy();
    assert.equal(map.sources.size, 0);
    assert.equal(map.layers.length, 0);
    assert.doesNotThrow(clearLast);
  });
});
