import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProjectToStore,
  createEmptyProject,
  getArcgisApiKey,
  normalizePrimaryRenderer,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import { ARCGIS_CAPABILITIES } from "../packages/map/src/arcgis-engine";
import { whenDrawn } from "../packages/map/src/ArcgisCanvas";
import {
  absolutizeCssUrls,
  arcgisCssUrl,
  arcgisModuleUrl,
  ARCGIS_SDK_VERSION,
  assembleArcgisSdk,
  loadArcgisSceneSdk,
  loadArcgisSdk,
  redactArcgisError,
  resetArcgisSdkForTests,
} from "../packages/map/src/arcgis-sdk";
import { MAPLIBRE_CAPABILITIES } from "../packages/map/src/map-engine";
import { isPluginEngineSupported } from "../packages/plugins/src/types";
import {
  requiresArcgisDeckOverlay,
  supportsAddDataRenderer,
} from "../apps/geolibre-desktop/src/lib/add-data-renderer";
import { isPluginEngineList } from "../apps/geolibre-desktop/src/lib/plugin-archive-unpack";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { mergeRuntimeEnv } from "../apps/geolibre-desktop/src/lib/assistant/provider";

describe("ArcGIS project and plugin boundaries", () => {
  it("round trips the primary renderer and ArcGIS panes", () => {
    const project = createEmptyProject();
    project.primaryRenderer = "arcgis";
    project.mapLayout = { rows: 1, cols: 2, syncView: true };
    project.secondaryMapViews = [
      { id: "arcgis-pane", view: project.mapView, viewKind: "arcgis", layerVisibility: {} },
    ];
    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.primaryRenderer, "arcgis");
    assert.equal(reopened.secondaryMapViews?.[0].viewKind, "arcgis");
    assert.equal(applyProjectToStore(reopened).primaryRenderer, "arcgis");
    useAppStore.getState().newProject();
    useAppStore.getState().setPrimaryRenderer("arcgis");
    assert.equal(projectFromStore(useAppStore.getState()).primaryRenderer, "arcgis");
    assert.equal(normalizePrimaryRenderer("arcgis"), "arcgis");
    assert.equal(normalizePrimaryRenderer("esri"), null);
  });
  it("defaults new projects to ArcGIS Streets and lets a basemap choice replace it", () => {
    useAppStore.getState().newProject();
    assert.equal(useAppStore.getState().preferences.map.arcgisBasemap, "arcgis/streets");
    // A project saved without the field follows the shared basemap.
    const project = createEmptyProject();
    delete project.preferences.map.arcgisBasemap;
    assert.equal(parseProject(serializeProject(project)).preferences.map.arcgisBasemap, undefined);
    // Picking a shared basemap while ArcGIS is primary clears the override, as
    // it does for the Mapbox style.
    useAppStore.getState().setPrimaryRenderer("arcgis");
    useAppStore.getState().setBasemapStyleUrl("https://tiles.openfreemap.org/styles/liberty");
    assert.equal(useAppStore.getState().preferences.map.arcgisBasemap, undefined);
    // A split pane on ArcGIS clears it too, whatever the primary renderer.
    useAppStore.getState().newProject();
    useAppStore.setState((s) => ({
      preferences: {
        ...s.preferences,
        map: { ...s.preferences.map, arcgisBasemap: "arcgis/streets" },
      },
    }));
    useAppStore.setState({
      secondaryMapViews: [
        {
          id: "pane",
          view: createEmptyProject().mapView,
          viewKind: "arcgis",
          layerVisibility: {},
        },
      ],
    });
    assert.equal(useAppStore.getState().preferences.map.arcgisBasemap, "arcgis/streets");
    useAppStore.getState().setBasemapStyleUrl("https://tiles.openfreemap.org/styles/bright");
    assert.equal(useAppStore.getState().preferences.map.arcgisBasemap, undefined);
  });
  it("keeps MapLibre plugins off the engine and declares what it cannot host", () => {
    assert.equal(isPluginEngineSupported({}, "arcgis"), false);
    assert.equal(isPluginEngineSupported({ engines: ["maplibre", "mapbox"] }, "arcgis"), false);
    assert.equal(isPluginEngineSupported({ engines: ["arcgis"] }, "arcgis"), true);
    assert.equal(isPluginEngineList(["maplibre", "arcgis"]), true);
    assert.equal(isPluginEngineList(["esri"]), false);
    assert.equal(ARCGIS_CAPABILITIES.styleSpec, false);
    assert.equal(ARCGIS_CAPABILITIES.nativeMapInstance, false);
    assert.equal(ARCGIS_CAPABILITIES.deckOverlay, false);
    assert.equal(ARCGIS_CAPABILITIES.picking, true);
    assert.equal(ARCGIS_CAPABILITIES.onMapDrawing, true);
    assert.equal(ARCGIS_CAPABILITIES.terrain, true);
    assert.equal(MAPLIBRE_CAPABILITIES.domControls, true);
  });
  it("greys out the Add Data sources the engine has no adapter for", () => {
    assert.equal(supportsAddDataRenderer("mbtiles", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("pmtiles", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("deckgl-viz", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("gltf-model", "arcgis"), true);
    // Vector uses the store bridge; raster uses the host importer.
    assert.equal(supportsAddDataRenderer("vector", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("raster", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("xyz", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("flatgeobuf", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("arcgis", "arcgis"), true);
    assert.equal(supportsAddDataRenderer("pmtiles", "mapbox"), true);
    assert.equal(supportsAddDataRenderer("pmtiles", "maplibre"), true);
  });
});

describe("ArcGIS API key", () => {
  it("resolves the prefixed name over the bare alias and trims", () => {
    assert.equal(getArcgisApiKey({ VITE_ARCGIS_API_KEY: " a ", ARCGIS_API_KEY: "b" }), "a");
    assert.equal(getArcgisApiKey({ ARCGIS_API_KEY: "b" }), "b");
    assert.equal(getArcgisApiKey({ ARCGIS_API_KEY: "  " }), undefined);
  });
  it("is a device-local setting projected into the runtime environment", () => {
    assert.equal(normalizeDesktopSettings({ arcgisApiKey: " key " }).arcgisApiKey, "key");
    assert.equal(normalizeDesktopSettings({}).arcgisApiKey, "");
    const env = mergeRuntimeEnv({
      osEnv: {},
      aiEnv: {},
      geocoderEnv: {},
      cesiumEnv: {},
      arcgisEnv: { VITE_ARCGIS_API_KEY: "device" },
      projectEnv: {},
    });
    assert.equal(env.VITE_ARCGIS_API_KEY, "device");
    // An explicit project entry still wins.
    const overridden = mergeRuntimeEnv({
      osEnv: {},
      aiEnv: {},
      geocoderEnv: {},
      cesiumEnv: {},
      arcgisEnv: { VITE_ARCGIS_API_KEY: "device" },
      projectEnv: { VITE_ARCGIS_API_KEY: "project" },
    });
    assert.equal(overridden.VITE_ARCGIS_API_KEY, "project");
  });
  it("redacts keys and tokens from engine errors", () => {
    const result = redactArcgisError(
      "Failed https://basemapstyles-api.arcgis.com/x?token=AAPTsecret&f=json AAPTother AAPKlegacy token=bare",
    );
    assert.ok(!result.includes("secret"));
    assert.ok(!result.includes("AAPTother"));
    assert.ok(!result.includes("AAPKlegacy"));
    assert.ok(!result.includes("bare"));
    assert.ok(result.includes("&f=json"));
  });
});

describe("ArcGIS SDK loader", () => {
  it("builds versioned CDN URLs", () => {
    assert.equal(
      arcgisModuleUrl("views/MapView"),
      `https://js.arcgis.com/${ARCGIS_SDK_VERSION}/@arcgis/core/views/MapView.js`,
    );
    assert.equal(
      arcgisCssUrl("dark"),
      `https://js.arcgis.com/${ARCGIS_SDK_VERSION}/esri/themes/dark/main.css`,
    );
  });
  it("rewrites relative stylesheet references against the CDN", () => {
    const css = absolutizeCssUrls(
      'a{background:url("../../base/images/x.svg")} b{src:url(data:font/woff2;base64,AA)} c{src:url(https://h/f.woff)}',
      arcgisCssUrl("light"),
    );
    assert.ok(
      css.includes(`url("https://js.arcgis.com/${ARCGIS_SDK_VERSION}/esri/base/images/x.svg")`),
    );
    assert.ok(css.includes("url(data:font/woff2;base64,AA)"));
    assert.ok(css.includes("url(https://h/f.woff)"));
  });
  it("assembles default and namespace exports and memoizes the load", async () => {
    resetArcgisSdkForTests();
    const requested: string[] = [];
    const importer = async (url: string) => {
      requested.push(url);
      const module = url.split("/@arcgis/core/")[1];
      if (module === "config.js") return { default: { apiKey: null } };
      if (module.startsWith("core/") || module.startsWith("geometry/support/"))
        return { watch() {}, when() {}, on() {}, webMercatorToGeographic() {} };
      return { default: class {} };
    };
    const sdk = await loadArcgisSdk(importer);
    assert.equal(sdk.config.apiKey, null);
    assert.equal(typeof sdk.layers.GeoJSONLayer, "function");
    assert.equal(typeof sdk.reactiveUtils.watch, "function");
    assert.ok(
      requested.every((url) => url.startsWith(`https://js.arcgis.com/${ARCGIS_SDK_VERSION}/`)),
    );
    const again = await loadArcgisSdk(importer);
    assert.equal(again, sdk);
    assert.throws(
      () => assembleArcgisSdk({ config: {}, Map: {} } as never),
      /has no default export/,
    );
    resetArcgisSdkForTests();
  });
  it("loads the 3D modules separately, after the core SDK", async () => {
    resetArcgisSdkForTests();
    const requested: string[] = [];
    const importer = async (url: string) => {
      const module = url.split("/@arcgis/core/")[1];
      requested.push(module);
      if (module === "config.js") return { default: { apiKey: null } };
      if (/^(core|geometry\/support)\//.test(module)) return { watch() {} };
      return { default: class {} };
    };
    await loadArcgisSdk(importer);
    assert.ok(!requested.includes("views/SceneView.js"));
    const scene = await loadArcgisSceneSdk(importer);
    assert.equal(typeof scene.SceneView, "function");
    assert.equal(typeof scene.BaseElevationLayer, "function");
    assert.deepEqual(requested.slice(-3), [
      "views/SceneView.js",
      "layers/ElevationLayer.js",
      "layers/BaseElevationLayer.js",
    ]);
    assert.equal(await loadArcgisSceneSdk(importer), scene);
    resetArcgisSdkForTests();
    await assert.rejects(
      loadArcgisSceneSdk(async (url) => {
        if (url.includes("SceneView")) return {};
        return importer(url);
      }),
      /views\/SceneView has no default export/,
    );
    resetArcgisSdkForTests();
  });
  it("forgets a failed load so the next mount retries", async () => {
    resetArcgisSdkForTests();
    let attempts = 0;
    const importer = async () => {
      attempts++;
      throw new Error("offline");
    };
    await assert.rejects(loadArcgisSdk(importer), /offline/);
    await assert.rejects(loadArcgisSdk(importer), /offline/);
    assert.ok(attempts > 1);
    resetArcgisSdkForTests();
  });
});

describe("ArcGIS view swap", () => {
  /** A reactiveUtils fake whose `when` re-checks its predicate on `tick()`. */
  function reactive() {
    let watchers: { get: () => unknown; cb: () => void; removed: boolean }[] = [];
    return {
      reactiveUtils: {
        when: (get: () => unknown, cb: () => void) => {
          const watcher = { get, cb, removed: false };
          watchers.push(watcher);
          if (get()) cb();
          return { remove: () => (watcher.removed = true) };
        },
      } as never,
      tick: () => {
        for (const w of watchers) if (!w.removed && w.get()) w.cb();
        watchers = watchers.filter((w) => !w.removed);
      },
    };
  }
  const frames = async () => new Promise((resolve) => setTimeout(resolve, 5));
  const withFrames = async (run: () => Promise<void>) => {
    const g = globalThis as { requestAnimationFrame?: unknown; window?: unknown };
    const previous = [g.requestAnimationFrame, g.window];
    g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    g.window ??= globalThis;
    try {
      await run();
    } finally {
      [g.requestAnimationFrame, g.window] = previous;
    }
  };
  const layerViews = (items: { updating: boolean }[]) => ({
    length: items.length,
    every: (f: (item: { updating: boolean }) => boolean) => items.every(f),
  });

  it("swaps once the basemap has drawn, without waiting for the rest of the view", async () => {
    await withFrames(async () => {
      const { reactiveUtils, tick } = reactive();
      const base = { updating: true };
      const view = { updating: true, basemapView: { baseLayerViews: layerViews([base]) } };
      let resolved = false;
      void whenDrawn({ reactiveUtils }, view as never).then(() => (resolved = true));
      await frames();
      assert.equal(resolved, false);
      base.updating = false;
      tick();
      await frames();
      // The view as a whole (data layers, terrain) is still loading.
      assert.equal(view.updating, true);
      assert.equal(resolved, true);
    });
  });

  it("waits for the whole view without basemap layers, and gives up after the timeout", async () => {
    await withFrames(async () => {
      const { reactiveUtils, tick } = reactive();
      const view = { updating: true, basemapView: { baseLayerViews: layerViews([]) } };
      let resolved = false;
      void whenDrawn({ reactiveUtils }, view as never).then(() => (resolved = true));
      await frames();
      assert.equal(resolved, false);
      view.updating = false;
      tick();
      await frames();
      assert.equal(resolved, true);

      const stuck = { updating: true, basemapView: null };
      await whenDrawn(reactive() as never, stuck as never, 20);
    });
  });
});

it("keeps the Add Data palette and menu off deck-only sources in ArcGIS global views", () => {
  for (const id of ["deckgl-viz", "gltf-model", "lidar", "duckdb", "3d-tiles"]) {
    assert.equal(requiresArcgisDeckOverlay(id), true);
    assert.equal(supportsAddDataRenderer(id, "arcgis", false), false);
    assert.equal(supportsAddDataRenderer(id, "arcgis", true), true);
  }
  assert.equal(supportsAddDataRenderer("vector", "arcgis", false), true);
  assert.equal(supportsAddDataRenderer("zarr", "arcgis", false), true);
  assert.equal(requiresArcgisDeckOverlay("splatting"), false);
});
