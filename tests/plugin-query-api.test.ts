import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { before, beforeEach, describe, it } from "node:test";

(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
(globalThis as typeof globalThis & { location: { search: string } }).location = { search: "" };
const emptyStorage = { getItem: () => null };
(globalThis as typeof globalThis & { sessionStorage: typeof emptyStorage }).sessionStorage =
  emptyStorage;
(globalThis as typeof globalThis & { localStorage: typeof emptyStorage }).localStorage = emptyStorage;
const maplibreGl = createRequire(`${process.cwd()}/package.json`)("maplibre-gl") as Record<
  string,
  unknown
>;
(globalThis as typeof globalThis & { __maplibreGl: Record<string, unknown> }).__maplibreGl =
  maplibreGl;
const maplibreGlModuleSource = [
  "export default globalThis.__maplibreGl;",
  ...Object.keys(maplibreGl)
    .filter((name) => name !== "default" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
    .map((name) => `export const ${name} = globalThis.__maplibreGl[${JSON.stringify(name)}];`),
].join("\n");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "maplibre-gl") {
      return { url: "test:maplibre-gl", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "test:maplibre-gl") {
      return { format: "module", source: maplibreGlModuleSource, shortCircuit: true };
    }
    if (url.endsWith(".css")) {
      return { format: "module", source: "", shortCircuit: true };
    }
    if (url === "virtual:bundled-plugins") {
      return {
        format: "module",
        source: "export const bundledPluginManifestPaths = [];",
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const SKETCHES_SOURCE_KIND = "geoeditor-sketches";
let useAppStore: typeof import("@geolibre/core").useAppStore;
let createAppAPI: typeof import("../apps/geolibre-desktop/src/hooks/usePlugins").createAppAPI;

before(async () => {
  [{ useAppStore }, { createAppAPI }] = await Promise.all([
    import("@geolibre/core"),
    import("../apps/geolibre-desktop/src/hooks/usePlugins"),
  ]);
});

describe("external plugin query API", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Plugin query API" });
  });

  it("returns every selected feature and its layer id", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "A", properties: { NAME: "A" }, geometry: null },
        { type: "Feature", id: "B", properties: { NAME: "B" }, geometry: null },
      ],
    });
    store.selectLayer(layerId);
    store.selectFeatures(["A", "B"]);

    const app = createAppAPI();
    assert.equal(app.getSelectedLayerId?.(), layerId);
    assert.deepEqual(
      app.getSelectedFeatures?.().map((feature) => feature.id),
      ["A", "B"],
    );
  });

  it("notifies and unsubscribes selection listeners", () => {
    const app = createAppAPI();
    const events: unknown[] = [];
    const unsubscribe = app.onSelectionChange?.((selection) => events.push(selection));
    assert.ok(unsubscribe);
    useAppStore.getState().selectFeatures(["A"]);
    assert.equal(events.length, 1);
    unsubscribe();
    useAppStore.getState().selectFeatures([]);
    assert.equal(events.length, 1);
  });

  it("lists layers and returns feature properties and geometry without mutating state", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "A",
          properties: { NAME: "Upper Basin", AREA_KM2: 12.5 },
          geometry: { type: "Point", coordinates: [101.7, 3.1] },
        },
      ],
    });
    const before = JSON.stringify(useAppStore.getState());

    const app = createAppAPI();
    assert.deepEqual(app.listLayers?.(), [
      {
        id: layerId,
        name: "Catchments",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
    ]);
    assert.deepEqual(app.getLayerFeatures?.(layerId), [
      {
        type: "Feature",
        id: "A",
        properties: { NAME: "Upper Basin", AREA_KM2: 12.5 },
        geometry: { type: "Point", coordinates: [101.7, 3.1] },
      },
    ]);
    app.getSelectedFeatures?.();
    app.getSelectedLayerId?.();
    app.getDrawnFeatures?.();

    assert.equal(JSON.stringify(useAppStore.getState()), before);
  });

  it("throws when a requested layer does not exist", () => {
    const app = createAppAPI();
    assert.throws(() => app.getLayerFeatures?.("missing-layer"), {
      message: 'No layer with id "missing-layer"',
    });
  });

  it("resolves selected features by their array index when ids are absent", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Unkeyed", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { NAME: "First" }, geometry: null },
        { type: "Feature", properties: { NAME: "Second" }, geometry: null },
      ],
    });
    store.selectLayer(layerId);
    store.selectFeatures(["1"]);

    assert.deepEqual(
      createAppAPI()
        .getSelectedFeatures?.()
        .map((feature) => feature.properties?.NAME),
      ["Second"],
    );
  });

  it("returns an empty feature list for an empty selection", () => {
    const store = useAppStore.getState();
    const layerId = store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: "A", properties: {}, geometry: null }],
    });
    store.selectLayer(layerId);

    const app = createAppAPI();
    assert.equal(app.getSelectedLayerId?.(), layerId);
    assert.deepEqual(app.getSelectedFeatures?.(), []);
  });

  it("returns features from every sketch layer and excludes ordinary layers", () => {
    const store = useAppStore.getState();
    store.addGeoJsonLayer("Catchments", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "ordinary", properties: {}, geometry: null },
      ],
    });
    const sketchLayerId = store.addGeoJsonLayer("Sketches", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "drawn-1",
          properties: { label: "Outlet" },
          geometry: { type: "Point", coordinates: [101.6, 3.2] },
        },
      ],
    });
    store.updateLayer(sketchLayerId, {
      metadata: { sourceKind: SKETCHES_SOURCE_KIND },
    });

    assert.deepEqual(createAppAPI().getDrawnFeatures?.(), [
      {
        type: "Feature",
        id: "drawn-1",
        properties: { label: "Outlet" },
        geometry: { type: "Point", coordinates: [101.6, 3.2] },
      },
    ]);
  });
});
