import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
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
    getLayer: (id: string) =>
      layers.has(id) ? { id, ...layers.get(id) } : undefined,
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
    queryRenderedFeatures: () => {
      const features = pendingRenderedFeatures;
      pendingRenderedFeatures = [];
      return features;
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
      fake.calls.filter(
        (c) => c.method === "addSource" && c.args[0] === srcId("a"),
      ).length;
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

    controller.syncLayers([
      pointLayer("a", {}, { pointRenderer: "cluster", clusterRadius: 40 }),
    ]);

    assert.equal(fake.sources.get(srcId("a"))?.cluster, true);
    assert.ok(
      fake.calls.some(
        (c) => c.method === "removeSource" && c.args[0] === srcId("a"),
      ),
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
      fake.calls.filter(
        (c) => c.method === "setPaintProperty" && c.args[0] === circleId("a"),
      ).length;
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

  it("identifies features across a synced layer's style layers", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    controller.syncLayers([pointLayer("a")]);

    fake.queueRenderedFeatures([
      {
        id: "f1",
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
    const ok = controller.setBuiltInControlPosition("geolocate", "bottom-right");

    assert.equal(ok, true);
    assert.equal(
      controller.getBuiltInControlPosition("geolocate"),
      "bottom-right",
    );
  });
});
