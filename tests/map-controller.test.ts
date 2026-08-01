import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as maplibregl from "maplibre-gl";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import {
  createMapController,
  geolocateControlFactory,
  MapController,
} from "../packages/map/src/map-controller";

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
    // A laid-out viewport, so the camera helpers that scale with the canvas
    // (the globe-safe fit ceiling) have a real size to work from.
    getCanvas: () => ({ clientWidth: 576, clientHeight: 648 }),
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

// An Add Vector Layer entry: the maplibre-gl-vector control owns the paint and
// creates the native style layers itself, so the store layer only names them.
function controlVectorLayer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      controlOwnsPaint: true,
      customLayerType: "fill",
      externalNativeLayer: true,
      nativeLayerIds: [`${id}-fill`, `${id}-outline`],
      sourceIds: [`${id}-source`],
      sourceKind: "maplibre-gl-vector",
    },
    ...patch,
  };
}

const circleId = (id: string) => `layer-${id}-circle`;
const markerId = (id: string) => `layer-${id}-marker`;
const rasterId = (id: string) => `layer-${id}-raster`;
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

  it("restacks every layer in one pass when a control adds its style layers late", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);
    // Bottom to top: a raster underlay, an Add Vector Layer polygon layer, and a
    // point overlay, the shape of the shared project in opengeos/GeoLibre#1404.
    const layers = [rasterLayer("under"), controlVectorLayer("vec"), pointLayer("over")];
    const userOrder = () => fake.order.filter((id) => id !== "basemap-bg");

    controller.syncLayers(layers);
    // The control's data is still loading, so its native layers do not exist yet.
    assert.deepEqual(userOrder(), [rasterId("under"), circleId("over")]);

    // maplibre-gl-vector finishes loading and adds its layers on top of the
    // style; the store write that follows drives one more sync pass.
    const styled = map as unknown as {
      addLayer: (spec: Record<string, unknown>) => void;
    };
    styled.addLayer({ id: "vec-fill", type: "fill", paint: {} });
    styled.addLayer({ id: "vec-outline", type: "line", paint: {} });
    controller.syncLayers(layers);

    assert.deepEqual(userOrder(), [rasterId("under"), "vec-fill", "vec-outline", circleId("over")]);
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

function vectorTileLayer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles: ["https://example.com/{z}/{x}/{y}.pbf"],
      sourceLayer: "buildings",
      sourceLayers: ["buildings"],
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const POLYGON_GEOMETRY_FILTER = [
  "match",
  ["geometry-type"],
  ["Polygon", "MultiPolygon"],
  true,
  false,
];

describe("MapController.syncLayers vector-tile time filtering", () => {
  // A Time Slider window on a tile layer is a filter expression evaluated per
  // feature as each tile decodes, so binding needs no local copy of the data.
  const timeFilter = ["all", [">=", ["to-number", ["get", "year"]], 1950]];

  it("leaves the geometry filter alone when no time filter is set", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([vectorTileLayer("vt")]);

    assert.deepEqual(fake.layers.get("layer-vt-vector")?.filter, POLYGON_GEOMETRY_FILTER);
  });

  it("combines the time window with each sub-layer's geometry filter", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([vectorTileLayer("vt", { timeFilter })]);

    assert.deepEqual(fake.layers.get("layer-vt-vector")?.filter, [
      "all",
      POLYGON_GEOMETRY_FILTER,
      timeFilter,
    ]);
    assert.deepEqual(fake.layers.get("layer-vt-vector-line")?.filter, [
      "all",
      [
        "match",
        ["geometry-type"],
        ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
        true,
        false,
      ],
      timeFilter,
    ]);
    assert.deepEqual(fake.layers.get("layer-vt-vector-circle")?.filter, [
      "all",
      ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      timeFilter,
    ]);
  });

  it("applies the window to an extruded tile layer", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([
      vectorTileLayer("vt", {
        timeFilter,
        style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true },
      }),
    ]);

    assert.deepEqual(fake.layers.get("layer-vt-vector-extrusion")?.filter, [
      "all",
      POLYGON_GEOMETRY_FILTER,
      timeFilter,
    ]);
  });

  it("drops the window again when the layer is unbound", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.syncLayers([vectorTileLayer("vt", { timeFilter })]);
    // Unbinding clears the transient filter; the next sync must restore the
    // bare geometry filter rather than leave the last window applied.
    controller.syncLayers([vectorTileLayer("vt", { timeFilter: undefined })]);

    assert.deepEqual(fake.layers.get("layer-vt-vector")?.filter, POLYGON_GEOMETRY_FILTER);
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

  it("keeps KML marker symbols independent from basemap visibility and opacity", () => {
    for (const type of ["geojson", "vector-tiles"] as const) {
      const { map, fake } = makeFakeMap();
      const controller = controllerWith(map);
      controller.syncLayers([controlVectorLayer("kml", { type })]);
      fake.layers.set(markerId("kml"), {
        id: markerId("kml"),
        type: "symbol",
        paint: { "icon-opacity": 1 },
      });
      fake.order.push(markerId("kml"));

      assert.ok(!controller.getBasemapStyleLayerIds().includes(markerId("kml")));

      controller.setBasemapVisible(false);
      controller.setBasemapOpacity(0.25);

      assert.ok(
        !fake.calls.some(
          (call) =>
            call.args[0] === markerId("kml") &&
            (call.method === "setLayoutProperty" || call.method === "setPaintProperty"),
        ),
        `background controls do not update the ${type} KML marker symbol`,
      );
    }
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

  it("caps a world-spanning fit at the flat-map zoom so the data stays in frame", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    // A mostly-US point layer with a few records in Europe and Asia: the
    // globe camera would answer this 259°-wide box with zoom ~2, hiding every
    // feature behind the horizon.
    controller.fitBounds([-124.16, 16.53, 135.51, 51.58]);

    const fit = fake.calls.find((c) => c.method === "fitBounds");
    assert.ok(fit, "fits the bounds");
    const options = fit.args[1] as { maxZoom?: number };
    assert.ok(typeof options.maxZoom === "number");
    assert.ok(
      Math.abs(options.maxZoom - 0.4255) < 0.001,
      `expected the flat-map fit (~0.4255), got ${options.maxZoom}`,
    );
  });

  it("leaves an extent the globe can frame uncapped", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    // A city-sized box is nowhere near the hemisphere MapLibre's globe fit
    // mishandles, so no ceiling is imposed and the camera is left as it was.
    controller.fitBounds([-83.93, 35.94, -83.9, 35.97]);

    const fit = fake.calls.find((c) => c.method === "fitBounds");
    assert.ok(fit);
    assert.ok(!("maxZoom" in (fit.args[1] as object)));
  });

  it("omits the fit ceiling when the canvas has not been laid out", () => {
    const { map, fake } = makeFakeMap();
    (map as { getCanvas: () => unknown }).getCanvas = () => ({
      clientWidth: 0,
      clientHeight: 0,
    });
    const controller = controllerWith(map);

    controller.fitBounds([-124.16, 16.53, 135.51, 51.58]);

    const fit = fake.calls.find((c) => c.method === "fitBounds");
    assert.ok(fit);
    assert.ok(!("maxZoom" in (fit.args[1] as object)));
  });

  it("applies the fit ceiling before comparing against a layer's min render zoom", () => {
    const { map, fake } = makeFakeMap();
    // `cameraForBounds` shares the globe over-zoom, so the fake reports a
    // camera above the tile source's minzoom for a world-scale extent. Capped
    // at the flat-map fit the extent is well below it, and the layer must fly
    // to its minimum render zoom rather than fit to an empty viewport.
    (map as { cameraForBounds: unknown }).cameraForBounds = () => ({
      center: { lng: 0, lat: 0 },
      zoom: 2.36,
    });
    const controller = controllerWith(map);

    controller.fitLayer(
      pointLayer("global-tiles", {
        type: "vector-tile",
        source: { type: "vector-tile", minzoom: 2 },
        geojson: undefined,
        metadata: { bounds: [-180, -85, 180, 85] },
      }),
    );

    const flyTo = fake.calls.find((c) => c.method === "flyTo");
    assert.ok(flyTo, "flies to the layer's minimum render zoom");
    assert.equal((flyTo.args[0] as { zoom: number }).zoom, 2);
    assert.ok(!fake.calls.some((c) => c.method === "fitBounds"));
  });

  it("routes a layer fit through the globe-safe path", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    controller.fitLayer(
      pointLayer("wide", {
        geojson: undefined,
        metadata: { bounds: [-124.16, 16.53, 135.51, 51.58] },
      }),
    );

    const fit = fake.calls.find((c) => c.method === "fitBounds");
    assert.ok(fit, "zoom-to-layer fits the bounds");
    assert.ok(typeof (fit.args[1] as { maxZoom?: number }).maxZoom === "number");
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
    // The Maptoolkit logo shares the bottom-left corner with the MapLibre logo.
    assert.equal(controller.getBuiltInControlPosition("maptoolkit-logo"), "bottom-left");
  });

  it("adds and removes the Maptoolkit logo control on toggle", () => {
    const { map, fake } = makeFakeMap();
    const controller = controllerWith(map);

    const shown = controller.setBuiltInControlVisible("maptoolkit-logo", true);
    assert.equal(shown, true);
    const addCall = fake.calls.find((c) => c.method === "addControl");
    assert.ok(addCall, "the logo control is added to the map");
    assert.equal(addCall.args[1], "bottom-left");
    assert.equal(
      (addCall.args[0] as { constructor: { name: string } }).constructor.name,
      "MaptoolkitLogoControl",
    );

    controller.setBuiltInControlVisible("maptoolkit-logo", false);
    const removeCall = fake.calls.find((c) => c.method === "removeControl");
    assert.ok(removeCall, "the same logo control is removed from the map");
    assert.equal(removeCall.args[0], addCall.args[0]);
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
  const originalCreate = geolocateControlFactory.create;

  function withStubbedControl(run: () => Promise<void>): Promise<void> {
    geolocateControlFactory.create = () =>
      new FakeGeolocateControl() as unknown as maplibregl.GeolocateControl;
    return run().finally(() => {
      geolocateControlFactory.create = originalCreate;
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

// A DOM stub just rich enough for TerrainControl.onAdd, which the fake map's
// addControl invokes below so the control has a live map to enable terrain on.
function makeTerrainDomStub(): { createElement: () => unknown } {
  return {
    createElement: () => {
      const classes = new Set<string>();
      return {
        className: "",
        type: "",
        title: "",
        setAttribute() {},
        appendChild: (child: unknown) => child,
        addEventListener() {},
        remove() {},
        classList: {
          toggle: (name: string, force?: boolean) => {
            const next = force ?? !classes.has(name);
            if (next) classes.add(name);
            else classes.delete(name);
            return next;
          },
        },
      };
    },
  };
}

describe("MapController terrain auto-enable", () => {
  it("lets a plugin enable and restore terrain while the map control is hidden", () => {
    let terrain: maplibregl.TerrainSpecification | null = null;
    let centerClamped = true;
    const sources = new Set<string>();
    const map = {
      getSource: (id: string) => (sources.has(id) ? {} : undefined),
      addSource: (id: string) => {
        sources.add(id);
      },
      getTerrain: () => terrain,
      setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
        terrain = spec;
      },
      setCenterClampedToGround: (value: boolean) => {
        centerClamped = value;
      },
    };
    const controller = createMapController();
    const internal = controller as unknown as { map: unknown; styleReady: boolean };
    internal.map = map;
    internal.styleReady = true;

    assert.equal(controller.setTerrainEnabled(true), true);
    assert.equal(terrain?.source, "geolibre-terrain-dem");
    assert.equal(centerClamped, false);

    assert.equal(controller.setTerrainEnabled(false), true);
    assert.equal(terrain, null);
    assert.equal(centerClamped, true);
  });

  it("enables terrain when the Terrain control is turned on, without a click", () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = makeTerrainDomStub();
    try {
      let terrain: maplibregl.TerrainSpecification | null = null;
      const sources = new Set<string>();
      const map = {
        // addControl mirrors MapLibre: it runs the control's onAdd so the
        // control captures the map and can toggle terrain.
        addControl: (control: maplibregl.IControl) =>
          control.onAdd(map as unknown as maplibregl.Map),
        removeControl() {},
        getSource: (id: string) => (sources.has(id) ? {} : undefined),
        addSource: (id: string) => {
          sources.add(id);
        },
        getTerrain: () => terrain,
        setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
          terrain = spec;
        },
        setCenterClampedToGround() {},
        on() {},
        off() {},
      };
      const controller = createMapController();
      const internal = controller as unknown as { map: unknown; styleReady: boolean };
      internal.map = map;
      internal.styleReady = true;

      const ok = controller.setBuiltInControlVisible("terrain", true);

      assert.equal(ok, true);
      // Terrain is active immediately — the user never had to click the button.
      assert.equal(terrain?.source, "geolibre-terrain-dem");
    } finally {
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
    }
  });

  it("defers the enable while the style loads, then turns terrain on once ready", () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = makeTerrainDomStub();
    try {
      let terrain: maplibregl.TerrainSpecification | null = null;
      const sources = new Set<string>();
      const map = {
        addControl: (control: maplibregl.IControl) =>
          control.onAdd(map as unknown as maplibregl.Map),
        removeControl() {},
        getSource: (id: string) => (sources.has(id) ? {} : undefined),
        addSource: (id: string) => {
          sources.add(id);
        },
        getTerrain: () => terrain,
        setTerrain: (spec: maplibregl.TerrainSpecification | null) => {
          terrain = spec;
        },
        setCenterClampedToGround() {},
        on() {},
        off() {},
      };
      const controller = createMapController();
      const internal = controller as unknown as {
        map: unknown;
        styleReady: boolean;
        terrainEnablePending: boolean;
        addTerrainSource(): boolean;
        autoEnableTerrain(): void;
      };
      internal.map = map;
      // Style not ready: addTerrainSource no-ops, so there is no source yet for
      // setTerrain to point at. Auto-enable must be deferred, not dropped.
      internal.styleReady = false;

      controller.setBuiltInControlVisible("terrain", true);

      assert.equal(terrain, null);
      assert.equal(internal.terrainEnablePending, true);

      // Emulate handleStyleReady: the DEM source lands, and the deferred enable
      // is reconciled so terrain turns on without the user re-toggling.
      internal.styleReady = true;
      internal.addTerrainSource();
      if (internal.terrainEnablePending) internal.autoEnableTerrain();

      assert.equal(terrain?.source, "geolibre-terrain-dem");
      assert.equal(internal.terrainEnablePending, false);
    } finally {
      if (prevDoc === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document?: unknown }).document = prevDoc;
    }
  });
});

describe("MapController Mapbox descriptor requests", () => {
  const MAPBOX_STREETS = "https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=tok";
  const MAPBOX_DARK = "https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=tok";
  const OPENFREEMAP = "https://tiles.openfreemap.org/styles/liberty";

  /** Minimal map stub: setStyle/remove are all the Mapbox path touches. */
  function mapboxController(): { controller: MapController; styles: unknown[] } {
    const styles: unknown[] = [];
    const map = {
      setStyle: (style: unknown) => {
        styles.push(style);
      },
      remove: () => {},
      addControl: () => {},
      removeControl: () => {},
      getTerrain: () => null,
      setTerrain: () => {},
      once: () => {},
      on: () => {},
      off: () => {},
    };
    const controller = createMapController();
    const internal = controller as unknown as MapControllerInternals;
    internal.map = map;
    internal.styleReady = true;
    return { controller, styles };
  }

  /**
   * Runs `body` with a fetch that never settles on its own, so a descriptor
   * request stays in flight until something aborts its signal. Every signal
   * handed to fetch is collected in order.
   */
  async function withPendingFetch(
    body: (signals: (AbortSignal | undefined)[]) => Promise<void> | void,
  ): Promise<void> {
    const signals: (AbortSignal | undefined)[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    try {
      await body(signals);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("aborts a descriptor request the next basemap supersedes", async () => {
    await withPendingFetch(async (signals) => {
      const warnings: unknown[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      const { controller } = mapboxController();
      try {
        controller.setStyle(MAPBOX_STREETS);
        controller.setStyle(MAPBOX_DARK);

        assert.equal(signals.length, 2);
        assert.equal(signals[0]?.aborted, true);
        assert.equal(signals[1]?.aborted, false);

        // The abort rejection is this controller cancelling its own request,
        // so it must not surface as a failed-style warning.
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(warnings, []);
      } finally {
        console.warn = originalWarn;
        controller.destroy();
      }
    });
  });

  it("aborts a pending descriptor request when a non-Mapbox style is applied", async () => {
    await withPendingFetch((signals) => {
      const { controller, styles } = mapboxController();
      try {
        controller.setStyle(MAPBOX_STREETS);
        controller.setStyle(OPENFREEMAP);

        // The plain URL resolves synchronously, and no second fetch is made.
        assert.deepEqual(styles, [OPENFREEMAP]);
        assert.equal(signals.length, 1);
        assert.equal(signals[0]?.aborted, true);
      } finally {
        controller.destroy();
      }
    });
  });

  it("aborts a pending descriptor request on destroy", async () => {
    await withPendingFetch((signals) => {
      const { controller } = mapboxController();
      controller.setStyle(MAPBOX_STREETS);
      assert.equal(signals[0]?.aborted, false);

      controller.destroy();
      assert.equal(signals[0]?.aborted, true);
    });
  });
});
