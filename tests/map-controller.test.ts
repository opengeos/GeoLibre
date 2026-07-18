import assert from "node:assert/strict";
import { describe, it } from "node:test";
import maplibregl from "maplibre-gl";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { createMapController, MapController } from "../packages/map/src/map-controller";

// Internal shape of MapController we reach into to inject a fake map. The
// controller only ever constructs a real maplibregl.Map through init(), which
// needs a DOM + WebGL; assigning a stub map plus styleReady lets us drive
// syncLayers and the camera/identify helpers in plain Node.
interface MapControllerInternals {
  map: unknown;
  styleReady: boolean;
  layerIds: string[];
  syncedLayers: GeoLibreLayer[];
}

interface FakeMap {
  order: string[];
  sources: Map<string, Record<string, unknown>>;
  layers: Map<string, Record<string, unknown>>;
  calls: { method: string; args: unknown[] }[];
  setDataCalls: { id: string; data: unknown }[];
  queueRenderedFeatures: (features: unknown[]) => void;
}

/**
 * Stateful fake MapLibre map. Tracks sources, style layers, and their render
 * order across sync passes so a test can assert what the controller adds,
 * removes, reorders, and repaints. `order` is bottom-to-top render order, the
 * same convention map.moveLayer(id, beforeId) uses (id is moved beneath
 * beforeId).
 */
function makeFakeMap(initialBasemapLayers: string[] = ["basemap-bg"]): {
  map: unknown;
  fake: FakeMap;
} {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const calls: { method: string; args: unknown[] }[] = [];
  const setDataCalls: { id: string; data: unknown }[] = [];
  let pendingRenderedFeatures: unknown[] = [];

  for (const id of initialBasemapLayers) {
    // Background layers participate in basemap visibility/opacity sync.
    layers.set(id, { id, type: "background", paint: {} });
    order.push(id);
  }

  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };

  const insertBefore = (id: string, beforeId?: string) => {
    const existing = order.indexOf(id);
    if (existing !== -1) order.splice(existing, 1);
    const at = beforeId ? order.indexOf(beforeId) : -1;
    if (at === -1) order.push(id);
    else order.splice(at, 0, id);
  };

  const map = {
    getStyle: () => ({
      layers: order.map((id) => ({ id, ...layers.get(id) })),
      sources: Object.fromEntries(sources),
    }),
    getSource: (id: string) =>
      sources.has(id)
        ? {
            type: (sources.get(id)?.type as string) ?? "geojson",
            bounds: sources.get(id)?.bounds,
            // Mirrors RasterTileSource.serialize(): a copy of the original
            // source spec, used by getLayerRasterSource.
            serialize: () => ({ ...sources.get(id) }),
            setData: (data: unknown) => {
              const spec = sources.get(id);
              if (spec) spec.data = data;
              setDataCalls.push({ id, data });
              calls.push({ method: "setData", args: [id, data] });
            },
          }
        : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
      calls.push({ method: "addSource", args: [id, spec] });
    },
    removeSource: (id: string) => {
      sources.delete(id);
      calls.push({ method: "removeSource", args: [id] });
    },
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>, beforeId?: string) => {
      layers.set(spec.id as string, spec);
      insertBefore(spec.id as string, beforeId);
      calls.push({ method: "addLayer", args: [spec, beforeId] });
    },
    removeLayer: (id: string) => {
      layers.delete(id);
      const at = order.indexOf(id);
      if (at !== -1) order.splice(at, 1);
      calls.push({ method: "removeLayer", args: [id] });
    },
    moveLayer: (id: string, beforeId?: string) => {
      insertBefore(id, beforeId);
      calls.push({ method: "moveLayer", args: [id, beforeId] });
    },
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: (id: string, filter: unknown) => {
      const spec = layers.get(id);
      if (spec) spec.filter = filter;
      calls.push({ method: "setFilter", args: [id, filter] });
    },
    setPaintProperty: (id: string, key: string, value: unknown) => {
      const spec = layers.get(id);
      if (spec) {
        const paint = (spec.paint as Record<string, unknown>) ?? {};
        paint[key] = value;
        spec.paint = paint;
      }
      calls.push({ method: "setPaintProperty", args: [id, key, value] });
    },
    getPaintProperty: (id: string, key: string) =>
      (layers.get(id)?.paint as Record<string, unknown> | undefined)?.[key],
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const spec = layers.get(id);
      if (spec) {
        const layout = (spec.layout as Record<string, unknown>) ?? {};
        layout[key] = value;
        spec.layout = layout;
      }
      calls.push({ method: "setLayoutProperty", args: [id, key, value] });
    },
    setLayerZoomRange: record("setLayerZoomRange"),
    // Camera + query helpers used by the controller's public methods.
    project: (lngLat: [number, number]) => ({ x: lngLat[0], y: lngLat[1] }),
    queryRenderedFeatures: (_point?: unknown, opts?: { layers?: string[] }) => {
      // Honor the layers filter the real map applies, and do NOT clear the
      // queue on read: identifyFeatures calls this once per synced layer, so
      // clearing here would starve every layer after the first.
      if (!opts?.layers) return pendingRenderedFeatures;
      return pendingRenderedFeatures.filter((feature) =>
        opts.layers?.includes((feature as { layer?: { id?: string } }).layer?.id ?? ""),
      );
    },
    getCenter: () => ({ lng: -100, lat: 40 }),
    getBounds: () => ({
      getWest: () => -120,
      getSouth: () => 30,
      getEast: () => -80,
      getNorth: () => 50,
    }),
    getZoom: () => 4,
    getBearing: () => 0,
    getPitch: () => 0,
    getProjection: () => ({ type: "mercator" }),
    flyTo: record("flyTo"),
    fitBounds: record("fitBounds"),
    cameraForBounds: (...args: unknown[]) => {
      calls.push({ method: "cameraForBounds", args });
      return { center: { lng: 51.9, lat: 35.7 }, zoom: 8.5 };
    },
    addControl: record("addControl"),
    removeControl: record("removeControl"),
    once: () => {},
    on: () => {},
    off: () => {},
  };

  const fake: FakeMap = {
    order,
    sources,
    layers,
    calls,
    setDataCalls,
    queueRenderedFeatures: (features) => {
      pendingRenderedFeatures = features;
    },
  };
  return { map, fake };
}

/** Inject a fake map and mark the style ready so syncLayers runs. */
function controllerWith(map: unknown): MapController {
  const controller = createMapController();
  const internal = controller as unknown as MapControllerInternals;
  internal.map = map;
  internal.styleReady = true;
  return controller;
}

function internals(controller: MapController): MapControllerInternals {
  return controller as unknown as MapControllerInternals;
}

function pointLayer(
  id: string,
  patch: Partial<GeoLibreLayer> = {},
  style: Partial<LayerStyle> = {},
): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    },
    ...patch,
  };
}

function rasterLayer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "raster",
    source: { type: "raster", tiles: ["https://example.com/{z}/{x}/{y}.png"] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const circleId = (id: string) => `layer-${id}-circle`;
const srcId = (id: string) => `source-${id}`;

describe("MapController.syncLayers reconciliation", () => {
  it("does nothing until the style is ready", () => {
    const { map, fake } = makeFakeMap();
    const controller = createMapController();
    // Inject the map but leave styleReady false.
    (controller as unknown as MapControllerInternals).map = map;

    controller.syncLayers([pointLayer("a")]);

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(internals(controller).layerIds, []);
  });

  it("adds a layer's source and style layer, tracking ids and snapshot", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    const a = pointLayer("a");
    controller.syncLayers([a]);

    assert.ok(fake.sources.has(srcId("a")));
    assert.ok(fake.layers.has(circleId("a")));
    assert.deepEqual(internals(controller).layerIds, ["a"]);
    assert.deepEqual(internals(controller).syncedLayers, [a]);
  });

  it("removes the native source and layers when a layer drops out", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a"), pointLayer("b")]);
    assert.ok(fake.layers.has(circleId("a")));
    assert.ok(fake.layers.has(circleId("b")));

    controller.syncLayers([pointLayer("b")]);

    assert.ok(!fake.layers.has(circleId("a")), "a's style layer removed");
    assert.ok(!fake.sources.has(srcId("a")), "a's source removed");
    assert.ok(fake.layers.has(circleId("b")), "b is kept");
    assert.deepEqual(internals(controller).layerIds, ["b"]);
  });

  it("reorders style layers when the layer order changes", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a"), pointLayer("b")]);
    const userOrder = () => fake.order.filter((id) => id !== "basemap-bg");
    // Initial: index 0 sits below index 1 (a beneath b).
    assert.deepEqual(userOrder(), [circleId("a"), circleId("b")]);

    controller.syncLayers([pointLayer("b"), pointLayer("a")]);

    assert.deepEqual(userOrder(), [circleId("b"), circleId("a")]);
    assert.ok(
      fake.calls.some((c) => c.method === "moveLayer"),
      "reorder is applied via moveLayer, not a teardown",
    );
  });

  it("updates data in place via setData rather than recreating the source", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a")]);
    const addSourceCalls = () =>
      fake.calls.filter((c) => c.method === "addSource" && c.args[0] === srcId("a")).length;
    assert.equal(addSourceCalls(), 1);

    const moved = pointLayer("a");
    moved.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [10, 10] },
        },
      ],
    };
    controller.syncLayers([moved]);

    assert.equal(addSourceCalls(), 1, "source is not re-added");
    assert.equal(fake.setDataCalls.length, 1, "data refreshed via setData");
    assert.equal(fake.setDataCalls[0].id, srcId("a"));
  });

  it("recreates the source when a layer-level change demands it (clustering)", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a")]);
    assert.equal(fake.sources.get(srcId("a"))?.cluster, undefined);

    controller.syncLayers([pointLayer("a", {}, { pointRenderer: "cluster", clusterRadius: 40 })]);

    assert.equal(fake.sources.get(srcId("a"))?.cluster, true);
    assert.ok(
      fake.calls.some((c) => c.method === "removeSource" && c.args[0] === srcId("a")),
      "clustered source recreated",
    );
  });

  it("applies a visibility toggle as a layout property", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a")]);
    controller.syncLayers([pointLayer("a", { visible: false })]);

    const vis = fake.calls.find(
      (c) =>
        c.method === "setLayoutProperty" &&
        c.args[0] === circleId("a") &&
        c.args[1] === "visibility",
    );
    assert.ok(vis, "visibility synced");
    assert.equal(vis.args[2], "none");
  });

  it("repaints when a layer's paint style changes", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a")]);
    const paintCallCount = () =>
      fake.calls.filter((c) => c.method === "setPaintProperty" && c.args[0] === circleId("a"))
        .length;
    const before = paintCallCount();

    controller.syncLayers([pointLayer("a", {}, { fillColor: "#ff0000" })]);

    assert.ok(paintCallCount() > before, "paint properties were updated");
  });

  it("tears down a layer's native state when it is replaced by a different id", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([pointLayer("a")]);
    assert.ok(fake.layers.has(circleId("a")));

    // Replacing the geojson layer with a raster layer under a new id drops the
    // old id, so its source and style layers are reconciled away.
    controller.syncLayers([rasterLayer("r")]);

    assert.ok(!fake.layers.has(circleId("a")), "geojson layers torn down");
    assert.ok(!fake.sources.has(srcId("a")), "geojson source torn down");
    assert.ok(fake.layers.has("layer-r-raster"), "raster layer added");
    assert.deepEqual(internals(controller).layerIds, ["r"]);
  });
});

describe("MapController basemap controls", () => {
  it("hides and shows basemap style layers", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    controller.setBasemapVisible(false);

    // The initial sync already set visibility once; assert the latest call.
    const hidden = fake.calls.findLast(
      (c) =>
        c.method === "setLayoutProperty" &&
        c.args[0] === "basemap-bg" &&
        c.args[1] === "visibility",
    );
    assert.ok(hidden);
    assert.equal(hidden.args[2], "none");
  });

  it("excludes user style layers from the basemap layer set", () => {
    const { map } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    const ids = controller.getBasemapStyleLayerIds();
    assert.ok(ids.includes("basemap-bg"));
    assert.ok(!ids.includes(circleId("a")), "user layers are not basemap layers");
  });

  it("scales basemap opacity from the layer's original paint value", () => {
    const { map, fake } = makeFakeMap();
    fake.layers.set("basemap-bg", {
      id: "basemap-bg",
      type: "background",
      paint: { "background-opacity": 0.8 },
    });
    const controller = controllerWith(map);

    controller.setBasemapOpacity(0.5);

    const set = fake.calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === "basemap-bg" &&
        c.args[1] === "background-opacity",
    );
    assert.ok(set);
    assert.equal(set.args[2], 0.4);
  });
});

describe("MapController camera and query helpers", () => {
  it("reads the current view from the map", () => {
    const { map } = makeFakeMap();
    const controller = controllerWith(map);

    assert.deepEqual(controller.readView(), {
      center: [-100, 40],
      zoom: 4,
      bearing: 0,
      pitch: 0,
      bbox: [-120, 30, -80, 50],
    });
  });

  it("normalizes the projection to globe/mercator", () => {
    const { map } = makeFakeMap();
    const controller = controllerWith(map);
    assert.equal(controller.readProjection(), "mercator");
  });

  it("normalizes any non-mercator projection to globe", () => {
    const { map } = makeFakeMap();
    (map as { getProjection: () => unknown }).getProjection = () => ({
      type: "globe",
    });
    const controller = controllerWith(map);
    assert.equal(controller.readProjection(), "globe");
  });

  it("flies to a degenerate point box instead of fitting bounds", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.fitBounds([5, 5, 5, 5]);

    assert.ok(fake.calls.some((c) => c.method === "flyTo"));
    assert.ok(!fake.calls.some((c) => c.method === "fitBounds"));
  });

  it("rejects a non-finite bounds box", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.fitBounds([0, 0, Number.NaN, 1]);

    assert.equal(fake.calls.length, 0);
  });

  it("frames a scenegraph model layer at a tilt so it is not edge-on", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.fitLayer(
      pointLayer("model", {
        type: "deckgl-viz",
        source: { type: "deckgl-viz" },
        geojson: undefined,
        metadata: {
          customLayerType: "scenegraph",
          bounds: [51.5, 35.3, 52.3, 36.1],
        },
      }),
    );

    const flyTo = fake.calls.find((c) => c.method === "flyTo");
    assert.ok(flyTo, "a scenegraph fit flies (with pitch) rather than fitBounds");
    assert.equal((flyTo.args[0] as { pitch: number }).pitch, 60);
    assert.ok(
      !fake.calls.some((c) => c.method === "fitBounds"),
      "does not also fit bounds top-down",
    );
  });

  it("identifies features across a synced layer's style layers", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    fake.queueRenderedFeatures([
      {
        id: "f1",
        // The fake honors the layers filter the real map applies, so the
        // feature must report the style layer it was rendered in.
        layer: { id: circleId("a") },
        properties: { name: "Site" },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ]);

    const hits = controller.identifyFeatures([0, 0]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].layerId, "a");
    assert.equal(hits[0].featureId, "f1");
    assert.deepEqual(hits[0].properties, { name: "Site" });
  });

  it("restricts identify to the requested layer and skips others", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a"), pointLayer("b")]);

    // A feature rendered only in layer b must not surface when identify is
    // scoped to layer a — exercising the per-layer queryRenderedFeatures loop.
    fake.queueRenderedFeatures([
      {
        id: "fb",
        layer: { id: circleId("b") },
        properties: {},
        geometry: { type: "Point", coordinates: [0, 0] },
      },
    ]);

    assert.equal(controller.identifyFeatures([0, 0], "a").length, 0);
    assert.equal(controller.identifyFeatures([0, 0], "b").length, 1);
  });

  it("writes story opacity directly to the native paint property", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    controller.setStoryLayerOpacity("a", 0.3);

    const op = fake.calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === circleId("a") &&
        c.args[1] === "circle-opacity",
    );
    assert.ok(op);
    assert.equal(op.args[2], 0.3);
  });

  it("clamps story opacity into the 0-1 range", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    controller.setStoryLayerOpacity("a", 5);

    const op = fake.calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === circleId("a") &&
        c.args[1] === "circle-opacity",
    );
    assert.ok(op);
    assert.equal(op.args[2], 1);
  });

  it("sets a paint transition when a duration is provided", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    controller.setStoryLayerOpacity("a", 0.5, 500);

    const transition = fake.calls.find(
      (c) =>
        c.method === "setPaintProperty" &&
        c.args[0] === circleId("a") &&
        c.args[1] === "circle-opacity-transition",
    );
    assert.ok(transition, "transition property set");
    assert.deepEqual(transition.args[2], { duration: 500 });
  });
});

describe("MapController built-in control positions", () => {
  it("returns the default position for a control", () => {
    const controller = createMapController();
    assert.equal(controller.getBuiltInControlPosition("navigation"), "top-right");
    assert.equal(controller.getBuiltInControlPosition("scale"), "bottom-left");
  });

  it("records a new position even when the control is hidden", () => {
    const { map } = makeFakeMap();
    const controller = controllerWith(map);

    // geolocate defaults to hidden, so setting its position just records it.
    // The visible-control reposition path tears down and re-creates a real
    // maplibregl control, whose constructor needs a DOM (`window`) that
    // `node --test` does not provide, so it cannot be exercised here; the
    // generic addControl/removeControl passthrough below covers the map calls.
    const ok = controller.setBuiltInControlPosition("geolocate", "bottom-right");

    assert.equal(ok, true);
    assert.equal(controller.getBuiltInControlPosition("geolocate"), "bottom-right");
  });

  it("passes a control through to the map and reports success", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    const control = { onAdd: () => document?.createElement?.("div") };

    const added = controller.addControl(control as never, "bottom-left");

    assert.equal(added, true);
    const call = fake.calls.find((c) => c.method === "addControl");
    assert.ok(call);
    assert.deepEqual(call.args, [control, "bottom-left"]);
  });

  it("swallows errors when removing an already-removed control", () => {
    const { map } = makeFakeMap();
    (map as { removeControl: () => void }).removeControl = () => {
      throw new Error("control already removed");
    };
    const controller = controllerWith(map);

    // MapLibre throws if a control was already removed; the controller must
    // not propagate that.
    assert.doesNotThrow(() => controller.removeControl({} as never));
  });
});

// Internal surface used to drive the geolocate error handler in plain Node.
interface GeolocateInternals {
  map: unknown;
  geolocateControl: { handlers: Record<string, (e: unknown) => void> } | null;
  controlVisibility: Record<string, boolean>;
  addGeolocateControl(): boolean;
}

/** Minimal stand-in for maplibregl.GeolocateControl that records listeners. */
class FakeGeolocateControl {
  handlers: Record<string, (e: unknown) => void> = {};
  on(event: string, fn: (e: unknown) => void): void {
    this.handlers[event] = fn;
  }
  off(event: string, fn: (e: unknown) => void): void {
    if (this.handlers[event] === fn) delete this.handlers[event];
  }
}

/**
 * Replace the global `navigator` for a test; returns a restore function.
 * Pass `permissionState` of `null` to omit the Permissions API entirely, or a
 * `queryOverride` to control how `permissions.query()` resolves/throws.
 */
function stubNavigator(
  permissionState: string | null,
  queryOverride?: () => Promise<unknown>,
): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let value: unknown;
  if (queryOverride) value = { permissions: { query: queryOverride } };
  else if (permissionState === null) value = {};
  else value = { permissions: { query: async () => ({ state: permissionState }) } };
  Object.defineProperty(globalThis, "navigator", { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  };
}

/** Mount a fresh geolocate control on a controller backed by a fake map. */
function controllerWithGeolocate(): {
  controller: MapController;
  internal: GeolocateInternals;
  firstControl: { handlers: Record<string, (e: unknown) => void> };
} {
  const controller = createMapController();
  const internal = controller as unknown as GeolocateInternals;
  internal.map = { addControl() {}, removeControl() {} };
  internal.controlVisibility.geolocate = true;
  internal.addGeolocateControl();
  return { controller, internal, firstControl: internal.geolocateControl! };
}

/** Flush pending microtasks (the async permission query and its `.then`). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MapController geolocate permission-denied recovery", () => {
  const originalControl = maplibregl.GeolocateControl;

  function withStubbedControl(run: () => Promise<void>): Promise<void> {
    (maplibregl as { GeolocateControl: unknown }).GeolocateControl = FakeGeolocateControl;
    return run().finally(() => {
      (maplibregl as { GeolocateControl: unknown }).GeolocateControl = originalControl;
    });
  }

  it("re-creates the control when the prompt was dismissed (state 'prompt')", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("prompt");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        // A dismissed prompt surfaces as a PERMISSION_DENIED (code 1) error.
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.notEqual(internal.geolocateControl, firstControl);
        assert.ok(internal.geolocateControl instanceof FakeGeolocateControl);
      } finally {
        restore();
      }
    }));

  it("leaves the control disabled on a genuine denial (state 'denied')", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("denied");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.equal(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("does not reset on a contradictory granted denial (state 'granted')", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("granted");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.equal(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("re-creates when the Permissions API is unavailable", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator(null);
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.notEqual(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("re-creates when the permission query rejects", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator(null, () => Promise.reject(new Error("not supported")));
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.notEqual(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("re-creates when the permission query throws synchronously", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator(null, () => {
        throw new Error("permissions blocked");
      });
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        await flush();
        assert.notEqual(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("ignores non-permission errors (e.g. timeout, code 3)", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("prompt");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 3 });
        await flush();
        assert.equal(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));

  it("does not disturb a control that was replaced before the check resolved", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("prompt");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        // The control is swapped out (e.g. toggled off/on) before the async
        // permission query resolves; the stale handler must not touch it.
        const replacement = new FakeGeolocateControl();
        internal.geolocateControl = replacement;
        await flush();
        assert.equal(internal.geolocateControl, replacement);
      } finally {
        restore();
      }
    }));

  it("is a no-op when the map is destroyed before the check resolves", () =>
    withStubbedControl(async () => {
      const restore = stubNavigator("prompt");
      try {
        const { internal, firstControl } = controllerWithGeolocate();
        firstControl.handlers.error({ code: 1 });
        internal.map = null;
        await flush();
        assert.equal(internal.geolocateControl, firstControl);
      } finally {
        restore();
      }
    }));
});

interface LayerLabelWindow {
  __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
  dispatchEvent: (event: unknown) => boolean;
}

// publishLayerDisplayNames is guarded on `window`, which `node --test` lacks,
// so stub a minimal one for the duration of a test. Dispatched event types are
// recorded so a test can assert the swipe panel's change event actually fires.
function withStubbedLabelWindow(run: (win: LayerLabelWindow, dispatched: string[]) => void): void {
  const globals = globalThis as { window?: LayerLabelWindow };
  const original = globals.window;
  const dispatched: string[] = [];
  const stub: LayerLabelWindow = {
    dispatchEvent: (event: unknown) => {
      dispatched.push((event as { type: string }).type);
      return true;
    },
  };
  globals.window = stub;
  try {
    run(stub, dispatched);
  } finally {
    if (original === undefined) delete globals.window;
    else globals.window = original;
  }
}

describe("MapController base-layer label", () => {
  it("publishes the grouped basemap label so the swipe panel can localize it", () => {
    withStubbedLabelWindow((win, dispatched) => {
      const controller = createMapController();

      // An explicit English push publishes under the "__basemap__" key the
      // swipe panel reads, and fires the change event the panel listens for.
      controller.setBackgroundLabel("Background");
      assert.equal(win.__GEOLIBRE_LAYER_LABELS__?.__basemap__, "Background");
      assert.deepEqual(dispatched, ["geolibre-layer-labels-change"]);

      // A language change re-publishes the translated label under the same key
      // and fires the event again so the panel re-syncs.
      controller.setBackgroundLabel("Hintergrund");
      assert.equal(win.__GEOLIBRE_LAYER_LABELS__?.__basemap__, "Hintergrund");
      assert.equal(dispatched.length, 2);
    });
  });

  it("clears published labels on destroy", () => {
    withStubbedLabelWindow((win) => {
      const controller = createMapController();
      controller.setBackgroundLabel("Background");
      assert.equal(win.__GEOLIBRE_LAYER_LABELS__?.__basemap__, "Background");

      // Teardown clears the bridge entirely (including the basemap entry),
      // rather than leaving the last label behind.
      controller.destroy();
      assert.deepEqual(win.__GEOLIBRE_LAYER_LABELS__, {});
    });
  });
});

describe("MapController story-map layer helpers", () => {
  /**
   * Register a plugin-owned native raster layer + source on the fake map, the
   * way the Planetary Computer control does (outside syncLayers), and inject
   * the matching store layer so getNativeLayerIdsByLayerId resolves it.
   */
  function externalRasterSetup(sourceSpec: Record<string, unknown>) {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    fake.sources.set("pc-1-source", sourceSpec);
    fake.layers.set("pc-1", {
      id: "pc-1",
      type: "raster",
      source: "pc-1-source",
      paint: {},
    });
    fake.order.push("pc-1");
    const layer = rasterLayer("pc-1", {
      // Planetary Computer store records carry no tiles/url; the live source
      // is the only place the TileJSON URL exists.
      source: { type: "raster" },
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["pc-1"],
        sourceId: "pc-1-source",
      },
    });
    internals(controller).syncedLayers = [layer];
    return { controller, fake };
  }

  it("reads a live TileJSON raster source back for the HTML export (#1272)", () => {
    const tilejson =
      "https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json?collection=sentinel-2-l2a&item=S2A&assets=visual";
    const { controller } = externalRasterSetup({
      type: "raster",
      url: tilejson,
      // A resolved tile template alongside the TileJSON url (the shape a
      // loaded source would have if serialize() ever returned merged state).
      // The url must win so the export embeds the stable TileJSON endpoint,
      // never a resolved template that could carry a time-limited token.
      tiles: ["https://example.com/signed/{z}/{x}/{y}.png?token=abc"],
      tileSize: 256,
      bounds: [76.8, 12.5, 77.9, 13.6],
      attribution: "Microsoft Planetary Computer",
    });

    const spec = controller.getLayerRasterSource("pc-1");
    assert.ok(spec, "returns the live source spec");
    assert.equal(spec.url, tilejson);
    assert.equal(spec.tiles, undefined, "resolved tiles are not embedded");
    assert.equal(spec.tileSize, 256);
    assert.deepEqual(spec.bounds, [76.8, 12.5, 77.9, 13.6]);
  });

  it("keeps only http(s) tile templates and drops non-embeddable urls", () => {
    const { controller } = externalRasterSetup({
      type: "raster",
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png", "geolibre://local/{z}/{x}/{y}.png"],
      tileSize: 256,
    });
    const spec = controller.getLayerRasterSource("pc-1");
    assert.ok(spec);
    assert.deepEqual(spec.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);

    const blobBacked = externalRasterSetup({
      type: "raster",
      url: "blob:https://app.example/1234",
    });
    assert.equal(blobBacked.controller.getLayerRasterSource("pc-1"), null);
  });

  it("returns null for layers without a live raster source", () => {
    const { map } = makeFakeMap();
    const controller = controllerWith(map);
    const layer = pointLayer("a");
    internals(controller).syncedLayers = [layer];
    assert.equal(controller.getLayerRasterSource("a"), null);
    assert.equal(controller.getLayerRasterSource("missing"), null);
  });

  it("setStoryLayerOpacity applies an explicit 0 duration as an instant change", () => {
    const { controller, fake } = externalRasterSetup({ type: "raster" });

    controller.setStoryLayerOpacity("pc-1", 0.4, 0);

    const paint = fake.layers.get("pc-1")?.paint as Record<string, unknown>;
    assert.equal(paint["raster-opacity"], 0.4);
    // The explicit 0 must override MapLibre's default 300 ms paint transition,
    // or the handout capture grabs a mid-fade frame.
    assert.deepEqual(paint["raster-opacity-transition"], { duration: 0 });
  });

  it("setStoryLayerOpacity leaves the default transition when no duration is given", () => {
    const { controller, fake } = externalRasterSetup({ type: "raster" });

    controller.setStoryLayerOpacity("pc-1", 0.4);

    const paint = fake.layers.get("pc-1")?.paint as Record<string, unknown>;
    assert.equal(paint["raster-opacity"], 0.4);
    assert.equal(paint["raster-opacity-transition"], undefined);
  });
});
