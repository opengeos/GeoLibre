import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getExternalNativePaintBridge,
  pluginOwnsPaint,
  createProjectLayerSerializationCache,
  parseProject,
  projectFromStore,
  serializeProject,
  serializeProjectWithLayerCache,
  useAppStore,
} from "@geolibre/core";
import { zarrRequestHeaders } from "@geolibre/map/zarr-source";
import {
  __setComponentsModuleLoaderForTests,
  addCloudNetcdfLayer,
  addZarrRasterLayer,
  queryZarrLayer,
  restoreZarrLayers,
  setZarrLayerSelector,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/maplibre-components.ts";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// `addZarrLayer` lets a plugin render a Zarr store through GeoLibre's own
// @carbonplan/zarr-layer instance instead of bundling a second copy and adding a
// raw MapLibre custom layer whose paint the Style panel cannot reach
// (opengeos/GeoLibre#1445). These tests drive the real code path with a stand-in
// for maplibre-gl-components' ZarrLayerControl.

interface StubAddOptions {
  selector?: Record<string, number | string>;
  clim?: [number, number];
  colormap?: string[];
  opacity?: number;
  crs?: string;
  proj4?: string;
  bounds?: [number, number, number, number];
  spatialDimensions?: { lat?: string; lon?: string };
  zarrVersion?: 2 | 3;
  transformRequest?: (url: string) => { url: string; headers?: Record<string, string> };
}

// What the stub control reports as the spatial reference it *resolved*, standing
// in for the real control's panel fields / store-metadata detection. Deliberately
// different from anything a test requests, so an assertion can tell "mirrored
// from the renderer's reported state" apart from "copied from the request".
const RESOLVED_SPATIAL_REFERENCE = {
  crs: "EPSG:3031",
  proj4: "+proj=stere +lat_0=-90 +lat_ts=-71 +datum=WGS84 +units=m +no_defs",
  bounds: [-3315363.2, -3316901.5, 3316909.4, 3315371.1] as [number, number, number, number],
};

const addCalls: { url?: string; variable?: string; options?: StubAddOptions }[] = [];
const opacityCalls: { layerId: string; opacity: number }[] = [];
const visibilityCalls: { layerId: string; visible: boolean; opacity?: number }[] = [];
const selectorCalls: Record<string, number | string>[] = [];
const queryCalls: { geometry: unknown; selector?: unknown; options?: unknown }[] = [];
let failNextAdd: string | null = null;
// Runs as the stub's addLayer starts, i.e. after the caller's awaits and while
// the control is loading the store.
let beforeNextAdd: (() => void) | null = null;

// What the stub renderer answers a query with: values plus the store's own
// spatial axis names, whose coordinates are in the source CRS (see the
// renderer's QueryResult contract).
const QUERY_RESULT = {
  sst: [12.5],
  dimensions: ["y", "x"],
  coordinates: { y: [1234567.5], x: [-987654.5] },
};

let lastStubControl: ZarrLayerControlStub | null = null;
const stubControl = () => lastStubControl;

class ZarrLayerControlStub {
  constructor() {
    lastStubControl = this;
  }

  private handlers = new Map<string, Set<(event: unknown) => void>>();
  private layers: {
    id: string;
    url: string;
    variable: string;
    colormap: string[];
    clim: [number, number];
    opacity: number;
    selector?: Record<string, number | string>;
    crs?: string;
    proj4?: string;
    bounds?: [number, number, number, number];
  }[] = [];
  private instances = new Map<
    string,
    {
      setSelector: (s: never) => Promise<void>;
      queryData: (
        geometry: unknown,
        selector?: unknown,
        options?: unknown,
      ) => Promise<typeof QUERY_RESULT>;
    }
  >();
  private counter = 0;

  on(event: string, handler: (event: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  hide() {}

  async addLayer(url?: string, variable?: string, options?: StubAddOptions) {
    addCalls.push({ url, variable, options });
    const hook = beforeNextAdd;
    beforeNextAdd = null;
    hook?.();
    if (failNextAdd) {
      const error = failNextAdd;
      failNextAdd = null;
      this.emit("error", { error, state: { layers: this.layers } });
      return;
    }
    const id = `zarr-layer-${this.counter++}`;
    this.layers.push({
      id,
      url: url ?? "",
      variable: variable ?? "",
      colormap: options?.colormap ?? ["#000000"],
      clim: options?.clim ?? [0, 1],
      opacity: options?.opacity ?? 1,
      selector: options?.selector,
      // The real control reports the spatial reference it resolved, which is not
      // necessarily what the caller asked for: the panel's CRS fields or the
      // store's own metadata can supply it. Always report the fixture so the
      // mirroring is provably read from here.
      ...RESOLVED_SPATIAL_REFERENCE,
    });
    this.instances.set(id, {
      setSelector: async (selector) => {
        selectorCalls.push(selector as Record<string, number | string>);
      },
      queryData: async (geometry, selector, options) => {
        queryCalls.push({ geometry, selector, options });
        return QUERY_RESULT;
      },
    });
    this.emit("layeradd", { url, layerId: id, state: { layers: this.layers } });
  }

  getLayersMap() {
    return this.instances;
  }

  setLayerOpacity(layerId: string, opacity: number) {
    opacityCalls.push({ layerId, opacity });
  }

  setLayerVisibility(layerId: string, visible: boolean, opacity?: number) {
    visibilityCalls.push({ layerId, visible, opacity });
  }

  removeLayer(id?: string) {
    if (id) this.instances.delete(id);
  }

  private emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const fakeComponentsModule = {
  ZarrLayerControl: ZarrLayerControlStub,
} as unknown as NonNullable<ComponentsModules[0]>;

function installStubModule(): void {
  __setComponentsModuleLoaderForTests(
    (): Promise<ComponentsModules> => Promise.resolve([fakeComponentsModule, null]),
  );
}

const app = {
  addMapControl: () => true,
  removeMapControl: () => {},
  getMap: () => null,
} as unknown as GeoLibreAppAPI;

afterEach(() => {
  useAppStore.setState({ layers: [] });
});

describe("addZarrRasterLayer", () => {
  it("forwards CRS, colormap, and selector to the renderer and mirrors the layer", async () => {
    installStubModule();
    addCalls.length = 0;

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/senorge.zarr",
      name: "seNorge tmax",
      variable: "tmax",
      selector: { time: 3 },
      clim: [-30, 30],
      // The public option takes a named GeoLibre ramp; the control needs the
      // resolved hex stops.
      colormap: "viridis",
      opacity: 0.6,
      crs: "EPSG:32633",
      proj4: "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs",
      headers: { authorization: "Bearer token" },
    });

    const call = addCalls.at(-1);
    assert.equal(call?.url, "https://example.org/senorge.zarr");
    assert.equal(call?.variable, "tmax");
    assert.equal(call?.options?.crs, "EPSG:32633");
    assert.match(call?.options?.proj4 ?? "", /\+proj=utm \+zone=33/);
    assert.deepEqual(call?.options?.selector, { time: 3 });
    assert.deepEqual(call?.options?.clim, [-30, 30]);
    assert.equal(call?.options?.opacity, 0.6);
    assert.ok(
      (call?.options?.colormap?.length ?? 0) > 1,
      "expected the named ramp to be resolved to hex stops",
    );
    assert.ok(call?.options?.colormap?.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
    // Authenticated stores travel as a transformRequest, the only auth hook the
    // renderer exposes.
    assert.deepEqual(
      call?.options?.transformRequest?.("https://example.org/senorge.zarr/.zmetadata"),
      {
        url: "https://example.org/senorge.zarr/.zmetadata",
        headers: { authorization: "Bearer token" },
      },
    );

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer, "expected the Zarr layer to be mirrored into the store");
    assert.equal(layer.name, "seNorge tmax");
    assert.equal(layer.type, "zarr");
    // Mirrored from what the renderer reported, not from the request: the
    // control resolves the reference (panel fields, or the store's own
    // metadata), so the request's own EPSG:32633 must not be what lands here.
    assert.equal(layer.metadata.crs, RESOLVED_SPATIAL_REFERENCE.crs);
    assert.equal(layer.metadata.proj4, RESOLVED_SPATIAL_REFERENCE.proj4);
    assert.equal(layer.source.crs, RESOLVED_SPATIAL_REFERENCE.crs);
    assert.equal(layer.source.proj4, RESOLVED_SPATIAL_REFERENCE.proj4);
    assert.deepEqual(layer.source.bounds, RESOLVED_SPATIAL_REFERENCE.bounds);
    // The renderer owns the pixels: no MapLibre paint editors, opacity bridged.
    assert.equal(pluginOwnsPaint(layer), true);
    assert.ok(getExternalNativePaintBridge(id)?.setOpacity);
  });

  it("records a spatial reference the control resolved without being asked", async () => {
    // The panel's CRS fields and the store's own metadata both reach the layer
    // this way, so a caller that passes no CRS still gets the placement recorded.
    installStubModule();

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/antarctic_era5.zarr",
      variable: "wind_speed",
    });

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.equal(layer?.source.crs, RESOLVED_SPATIAL_REFERENCE.crs);
    assert.equal(layer?.metadata.proj4, RESOLVED_SPATIAL_REFERENCE.proj4);
    assert.deepEqual(layer?.source.bounds, RESOLVED_SPATIAL_REFERENCE.bounds);
  });

  it("bridges opacity and visibility to the control's setters", async () => {
    installStubModule();
    opacityCalls.length = 0;
    visibilityCalls.length = 0;

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/climate.zarr",
      variable: "climate",
    });
    const bridge = getExternalNativePaintBridge(id);

    bridge?.setOpacity?.(0.25);
    assert.deepEqual(opacityCalls.at(-1), { layerId: id, opacity: 0.25 });

    // Hiding a custom layer is expressed as opacity 0, so the stored opacity has
    // to travel with the visibility call or re-showing would jump back to 1.
    useAppStore.setState({
      layers: useAppStore
        .getState()
        .layers.map((layer) => (layer.id === id ? { ...layer, opacity: 0.25 } : layer)),
    });
    bridge?.setVisibility?.(false);
    assert.deepEqual(visibilityCalls.at(-1), { layerId: id, visible: false, opacity: 0.25 });
  });

  it("rejects with an actionable message when the variable is missing", async () => {
    installStubModule();
    await assert.rejects(
      addZarrRasterLayer(app, { url: "https://example.org/climate.zarr", variable: "  " }),
      /variable/i,
    );
  });

  it("rejects with an actionable message when the URL is missing", async () => {
    installStubModule();
    await assert.rejects(addZarrRasterLayer(app, { url: "  ", variable: "climate" }), /URL/i);
  });

  it("serializes overlapping adds so each caller gets its own layer id", async () => {
    // The control's url/variable live in one shared state slot and its
    // "layeradd" event carries no correlation id, so concurrent adds must not
    // observe each other's events.
    installStubModule();

    const [first, second] = await Promise.all([
      addZarrRasterLayer(app, { url: "https://example.org/a.zarr", variable: "a", name: "A" }),
      addZarrRasterLayer(app, { url: "https://example.org/b.zarr", variable: "b", name: "B" }),
    ]);

    assert.notEqual(first, second);
    const layers = useAppStore.getState().layers;
    assert.equal(layers.find((layer) => layer.id === first)?.name, "A");
    assert.equal(layers.find((layer) => layer.id === second)?.name, "B");
  });

  it("rejects with the renderer's error when the store cannot be read", async () => {
    installStubModule();
    failNextAdd = "Failed to load Zarr: 403";
    await assert.rejects(
      addZarrRasterLayer(app, { url: "https://example.org/private.zarr", variable: "t" }),
      /403/,
    );
  });
});

describe("setZarrLayerSelector", () => {
  it("re-selects the dimensions in place and records them on the layer", async () => {
    installStubModule();
    selectorCalls.length = 0;

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/climate.zarr",
      variable: "climate",
      selector: { month: 1 },
    });

    assert.equal(await setZarrLayerSelector(id, { month: 7 }), true);
    assert.deepEqual(selectorCalls.at(-1), { month: 7 });

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.deepEqual(layer?.metadata.selector, { month: 7 });
    assert.deepEqual(layer?.source.selector, { month: 7 });
  });

  it("reports false for a layer the Zarr renderer does not own", async () => {
    installStubModule();
    assert.equal(await setZarrLayerSelector("not-a-zarr-layer", { month: 2 }), false);
  });
});

// The read counterpart: a plugin that renders through addZarrLayer has no handle
// on the renderer's layer instance, so click-to-value and region statistics have
// to reach `queryData` by layer id (opengeos/GeoLibre#1555).
describe("queryZarrLayer", () => {
  it("reads the clicked point through the renderer and returns its result", async () => {
    installStubModule();
    queryCalls.length = 0;

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/oisst.zarr",
      variable: "sst",
      selector: { time: 0 },
    });

    const point = { type: "Point" as const, coordinates: [-30.5, 42.25] as [number, number] };
    const result = await queryZarrLayer(id, point);

    // Handed to the renderer untouched: it owns the reprojection into the
    // store's grid, so the WGS84 click must not be transformed on the way in.
    assert.deepEqual(queryCalls.at(-1)?.geometry, point);
    assert.equal(queryCalls.at(-1)?.selector, undefined);
    assert.deepEqual(result, QUERY_RESULT);
  });

  it("forwards a selector override, a polygon, and the abort signal", async () => {
    installStubModule();
    queryCalls.length = 0;
    selectorCalls.length = 0;

    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/oisst.zarr",
      variable: "sst",
      selector: { time: 0 },
    });

    const controller = new AbortController();
    const polygon = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-31, 42],
          [-30, 42],
          [-30, 43],
          [-31, 43],
          [-31, 42],
        ],
      ],
    };
    await queryZarrLayer(id, polygon, { time: 12 }, { signal: controller.signal });

    const call = queryCalls.at(-1);
    assert.deepEqual(call?.geometry, polygon);
    // A region query on a slice other than the one on screen: the override must
    // reach the renderer without re-selecting the layer itself.
    assert.deepEqual(call?.selector, { time: 12 });
    assert.equal(
      (call?.options as { signal?: AbortSignal } | undefined)?.signal,
      controller.signal,
    );
    assert.deepEqual(selectorCalls.at(-1), undefined);
  });

  it("resolves null for a layer the Zarr renderer does not own", async () => {
    installStubModule();
    assert.equal(
      await queryZarrLayer("not-a-zarr-layer", { type: "Point", coordinates: [0, 0] }),
      null,
    );
  });
});

// Request headers authenticate a store (a bearer token, an API key), so they are
// credentials and must never reach a saved, autosaved, or shared project
// (opengeos/GeoLibre#2643). Every project write goes through projectFromStore.
const TOKEN = "Bearer secret-zarr-token";

describe("Zarr request headers stay out of project files", () => {
  it("keeps an ArcGIS-native add's headers in the session, not on the layer", async () => {
    const arcgisApp = {
      ...app,
      getMapRenderer: () => "arcgis",
    } as unknown as GeoLibreAppAPI;

    const id = await addZarrRasterLayer(arcgisApp, {
      url: "https://example.org/private.zarr",
      variable: "tmax",
      headers: { authorization: TOKEN },
    });

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer, "expected the native Zarr layer in the store");
    assert.equal(layer.source.headers, undefined);
    // The renderer still authenticates the live layer.
    assert.deepEqual(zarrRequestHeaders(layer), { authorization: TOKEN });
    const saved = serializeProject(projectFromStore(useAppStore.getState()));
    assert.equal(saved.includes("secret-zarr-token"), false);
  });

  it("remembers a MapLibre add's headers for the session without persisting them", async () => {
    installStubModule();
    const id = await addZarrRasterLayer(app, {
      url: "https://example.org/private.zarr",
      variable: "tmax",
      headers: { authorization: TOKEN },
    });

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer);
    assert.deepEqual(zarrRequestHeaders(layer), { authorization: TOKEN });
    const saved = serializeProject(projectFromStore(useAppStore.getState()));
    assert.equal(saved.includes("secret-zarr-token"), false);
  });

  it("strips headers a project saved before the fix still carries on source", () => {
    useAppStore.setState({
      layers: [
        {
          id: "legacy-zarr",
          name: "Legacy",
          type: "zarr",
          source: {
            url: "https://example.org/private.zarr",
            variable: "tmax",
            headers: { authorization: TOKEN },
          },
          visible: true,
          opacity: 1,
          style: {},
          metadata: {},
        } as never,
      ],
    });

    // Still readable for the live session...
    const live = useAppStore.getState().layers[0];
    assert.deepEqual(zarrRequestHeaders(live), { authorization: TOKEN });
    // ...but never written back out.
    const project = projectFromStore(useAppStore.getState());
    assert.equal(project.layers[0].source.headers, undefined);
    assert.equal(project.layers[0].source.variable, "tmax");
    assert.equal(serializeProject(project).includes("secret-zarr-token"), false);
    // A project serialized directly, not built from the store, is scrubbed too.
    const direct = serializeProject({ ...project, layers: useAppStore.getState().layers });
    assert.equal(direct.includes("secret-zarr-token"), false);
    assert.equal(
      serializeProjectWithLayerCache(
        { ...project, layers: useAppStore.getState().layers },
        useAppStore.getState().layers,
        createProjectLayerSerializationCache(),
      ).includes("secret-zarr-token"),
      false,
    );
  });
});

describe("addCloudNetcdfLayer", () => {
  it("rejects with the renderer's error when the store or variable fails to load", async () => {
    installStubModule();
    failNextAdd = "Variable 'missing' not found";

    await assert.rejects(
      addCloudNetcdfLayer(app, {
        url: "https://example.org/manifest.json",
        refs: {},
        variable: "missing",
      }),
      /Variable 'missing' not found/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("resolves and mirrors the layer when the add succeeds", async () => {
    installStubModule();

    await addCloudNetcdfLayer(app, {
      url: "https://example.org/manifest.json",
      refs: {},
      variable: "air",
      bounds: [-10, -5, 10, 5],
      headers: { authorization: TOKEN },
    });

    const layer = useAppStore.getState().layers.at(-1);
    assert.ok(layer);
    // Remembered for a renderer swap, never written to the layer record.
    assert.deepEqual(zarrRequestHeaders(layer), { authorization: TOKEN });
    assert.equal(layer.source.headers, undefined);
    assert.equal(layer?.source.variable, "air");
    assert.deepEqual(layer?.source.bounds, [-10, -5, 10, 5]);
  });

  it("sends an empty selector rather than none, so the control's default cannot leak in", async () => {
    // The control reads a missing selector as "use the panel's", which is the
    // CarbonPlan sample's `{ band, month }`: a local (time, lat, lon) file then
    // failed with "selector 'band', 'month' does not name a dimension".
    installStubModule();
    addCalls.length = 0;

    await addCloudNetcdfLayer(app, {
      url: "local:air-temperature.nc",
      refs: {},
      variable: "air",
    });

    assert.deepEqual(addCalls.at(-1)?.options?.selector, {});
  });

  it("forwards a kept time axis selector as given", async () => {
    installStubModule();
    addCalls.length = 0;

    await addCloudNetcdfLayer(app, {
      url: "local:air-temperature.nc",
      refs: {},
      variable: "air",
      selector: { time: 0 },
    });

    assert.deepEqual(addCalls.at(-1)?.options?.selector, { time: 0 });
  });
});

describe("addZarrRasterLayer without a selector", () => {
  it("sends an empty selector to the control", async () => {
    installStubModule();
    addCalls.length = 0;

    await addZarrRasterLayer(app, { url: "https://example.org/store.zarr", variable: "sst" });

    assert.deepEqual(addCalls.at(-1)?.options?.selector, {});
  });
});

// A saved Zarr layer reopens as an inert store record: the Zarr control draws it,
// not layer sync, so without a restore it sits in the Layers panel and paints
// nothing on MapLibre.
describe("restoreZarrLayers", () => {
  const SST_URL = "https://data.source.coop/giswqs/opengeos/noaa-oisst-v2-monthly.zarr";

  function savedZarrLayer(id: string, name: string, url = SST_URL) {
    return {
      id,
      name,
      type: "zarr" as const,
      source: {
        clim: [-2, 32] as [number, number],
        colormap: ["#30123b", "#7a0403"],
        sourceId: id,
        type: "raster",
        url,
        variable: "sst",
      },
      visible: true,
      opacity: 0.85,
      style: { fillOpacity: 1 } as never,
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: [id],
        paintMode: "plugin",
        sourceKind: "zarr-url",
        description: "kept",
      },
      sourcePath: url,
    };
  }

  function otherLayer(id: string) {
    return {
      id,
      name: id,
      type: "geojson" as const,
      source: {},
      visible: true,
      opacity: 1,
      style: {} as never,
      metadata: {},
    };
  }

  it("re-adds a reopened project's Zarr layer with its saved settings", async () => {
    installStubModule();
    // Round-trip the record through the real project file, so this also pins
    // that saving writes everything a restore needs.
    const id = await addZarrRasterLayer(app, {
      url: SST_URL,
      variable: "sst",
      name: "Sea surface temperature",
      clim: [-2, 32],
      colormap: ["#30123b", "#7a0403"],
      opacity: 0.85,
    });
    useAppStore.getState().setLayerVisibility(id, false);
    const project = parseProject(serializeProject(projectFromStore(useAppStore.getState())));
    // Opening a project drops the session's layers, and the control's with them.
    useAppStore.setState({ layers: [] });
    useAppStore.setState({ layers: [otherLayer("below"), ...project.layers, otherLayer("above")] });
    addCalls.length = 0;
    visibilityCalls.length = 0;

    await restoreZarrLayers(app);

    assert.equal(addCalls.length, 1);
    const call = addCalls[0];
    assert.equal(call.url, SST_URL);
    assert.equal(call.variable, "sst");
    assert.deepEqual(call.options?.clim, [-2, 32]);
    assert.deepEqual(call.options?.colormap, ["#30123b", "#7a0403"]);
    assert.deepEqual(call.options?.selector, {});
    assert.equal(call.options?.opacity, 0.85);

    const layers = useAppStore.getState().layers;
    assert.deepEqual(
      layers.map((layer) => layer.type),
      ["geojson", "zarr", "geojson"],
      "the live layer takes the saved record's place, not a second entry",
    );
    const restored = layers[1];
    assert.equal(restored.name, "Sea surface temperature");
    assert.equal(restored.visible, false);
    assert.ok(
      visibilityCalls.some((c) => c.layerId === restored.id && c.visible === false),
      "a layer saved hidden stays hidden",
    );
    assert.ok(getExternalNativePaintBridge(restored.id), "panels reach the restored layer");
  });

  it("keeps saved metadata and moves aside a record whose id the control reuses", async () => {
    installStubModule();
    // Learn the control's next id, then save two records that collide with the
    // ids it will hand out: the first restore is given the second record's id.
    const probe = await addZarrRasterLayer(app, {
      url: "https://example.org/a.zarr",
      variable: "x",
    });
    const next = Number(probe.split("-").at(-1)) + 1;
    useAppStore.setState({
      layers: [
        savedZarrLayer(`zarr-layer-${next + 1}`, "First"),
        savedZarrLayer(`zarr-layer-${next}`, "Second"),
      ],
    });
    addCalls.length = 0;

    await restoreZarrLayers(app);

    assert.equal(addCalls.length, 2);
    const layers = useAppStore.getState().layers;
    assert.deepEqual(
      layers.map((layer) => [layer.id, layer.name]),
      [
        [`zarr-layer-${next}`, "First"],
        [`zarr-layer-${next + 1}`, "Second"],
      ],
    );
    assert.equal(layers[0].metadata.description, "kept");
    assert.deepEqual(layers[0].metadata.nativeLayerIds, [`zarr-layer-${next}`]);
  });

  it("moves aside a skipped local record that holds the id the control hands out", async () => {
    installStubModule();
    const probe = await addZarrRasterLayer(app, {
      url: "https://example.org/b.zarr",
      variable: "x",
    });
    const next = Number(probe.split("-").at(-1)) + 1;
    useAppStore.setState({
      layers: [
        savedZarrLayer(`zarr-layer-${next}`, "Folder", "local-zarr:cube?1"),
        savedZarrLayer(`zarr-layer-${next + 5}`, "SST"),
      ],
    });

    await restoreZarrLayers(app);

    const layers = useAppStore.getState().layers;
    assert.equal(new Set(layers.map((layer) => layer.id)).size, 2, "ids stay unique");
    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["Folder", "SST"],
    );
    assert.equal(layers[1].id, `zarr-layer-${next}`);
  });

  it("drops the live layer when its record is removed while the store loads", async () => {
    installStubModule();
    // A probe add first, so the control exists and its live count is known.
    await addZarrRasterLayer(app, { url: "https://example.org/c.zarr", variable: "x" });
    useAppStore.setState({ layers: [savedZarrLayer("gone", "Gone")] });
    addCalls.length = 0;
    const liveBefore = stubControl()?.getLayersMap().size;
    beforeNextAdd = () => useAppStore.setState({ layers: [] });

    await restoreZarrLayers(app);

    assert.equal(addCalls.length, 1, "the restore reached the control");
    assert.deepEqual(useAppStore.getState().layers, []);
    assert.equal(stubControl()?.getLayersMap().size, liveBefore, "the live layer is dropped");
  });

  it("does not send saved headers over plain HTTP", async () => {
    installStubModule();
    const layer = savedZarrLayer("insecure", "Insecure", "http://example.org/private.zarr");
    useAppStore.setState({
      layers: [{ ...layer, source: { ...layer.source, headers: { authorization: TOKEN } } }],
    });
    addCalls.length = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await restoreZarrLayers(app);
    } finally {
      console.warn = warn;
    }
    assert.equal(addCalls.length, 0);
    assert.equal(useAppStore.getState().layers.length, 1);
  });

  it("restores each record once and skips stores the URL alone cannot open", async () => {
    installStubModule();
    useAppStore.setState({
      layers: [
        savedZarrLayer("saved-sst", "SST"),
        savedZarrLayer("local", "Folder", "local-zarr:cube?1"),
        savedZarrLayer("icechunk", "Repo", "https://example.org/repo#icechunk=main"),
      ],
    });
    addCalls.length = 0;

    await Promise.all([restoreZarrLayers(app), restoreZarrLayers(app)]);
    await restoreZarrLayers(app);

    assert.deepEqual(
      addCalls.map((call) => call.url),
      [SST_URL],
    );
    assert.equal(useAppStore.getState().layers.length, 3);
  });

  it("leaves the record in place when the store fails to load", async () => {
    installStubModule();
    useAppStore.setState({ layers: [savedZarrLayer("broken", "Broken")] });
    failNextAdd = "Failed to load Zarr: 404";
    const warn = console.warn;
    console.warn = () => {};
    try {
      await restoreZarrLayers(app);
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      ["broken"],
    );
  });
});
