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
import {
  absolutizeCssUrls,
  arcgisCssUrl,
  arcgisModuleUrl,
  ARCGIS_SDK_VERSION,
  assembleArcgisSdk,
  loadArcgisSdk,
  redactArcgisError,
  resetArcgisSdkForTests,
} from "../packages/map/src/arcgis-sdk";
import { MAPLIBRE_CAPABILITIES } from "../packages/map/src/map-engine";
import { isPluginEngineSupported } from "../packages/plugins/src/types";
import { supportsAddDataRenderer } from "../apps/geolibre-desktop/src/lib/add-data-renderer";
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
    assert.equal(MAPLIBRE_CAPABILITIES.domControls, true);
  });
  it("greys out the Add Data sources the engine has no adapter for", () => {
    assert.equal(supportsAddDataRenderer("mbtiles", "arcgis"), false);
    assert.equal(supportsAddDataRenderer("pmtiles", "arcgis"), false);
    assert.equal(supportsAddDataRenderer("cog", "arcgis"), false);
    assert.equal(supportsAddDataRenderer("deckgl", "arcgis"), false);
    assert.equal(supportsAddDataRenderer("vector", "arcgis"), true);
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
      "Failed https://basemapstyles-api.arcgis.com/x?token=AAPTsecret&f=json AAPTother",
    );
    assert.ok(!result.includes("secret"));
    assert.ok(!result.includes("AAPTother"));
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
