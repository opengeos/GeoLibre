import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { createAppAPI, type AppApiHost } from "../apps/geolibre-desktop/src/lib/app-api";
import {
  listAssistantToolEntries,
  registerAssistantGuidance,
  registerAssistantTool,
  registerAssistantToolSpec,
  unregisterAssistantToolsByOwner,
} from "../packages/plugins/src/assistant-tool-registry";
import {
  closeFloatingPanel,
  getOpenFloatingPanels,
  openFloatingPanel,
  registerFloatingPanel,
  unregisterFloatingPanel,
} from "../packages/plugins/src/floating-panel-registry";
import {
  registerMenuContribution,
  unregisterMenuContribution,
} from "../packages/plugins/src/menu-contribution-registry";
import { GEO_EDITOR_PLUGIN_ID } from "../packages/plugins/src/plugin-ids";
import { PluginManager } from "../packages/plugins/src/plugin-manager";
import {
  closeRightPanel,
  collapseRightPanel,
  getActiveRightPanel,
  getActiveRightPanelDock,
  openRightPanel,
  registerRightPanel,
  setActiveRightPanelDock,
  unregisterRightPanel,
} from "../packages/plugins/src/right-panel-registry";
import {
  registerToolbarMenu,
  unregisterToolbarMenu,
} from "../packages/plugins/src/toolbar-menu-registry";
import type {
  GeoLibreActiveMapTool,
  GeoLibreAppAPI,
  GeoLibrePlugin,
} from "../packages/plugins/src/types";

// Contract tests for the plugin API object (`GeoLibreAppAPI`) the host hands to
// every plugin. `createAppAPI` takes the `@geolibre/plugins` barrel services and
// the plugin manager through `AppApiHost`, so the real implementation runs here
// with fakes and the real (node-loadable) UI registries.

type AppAPI = ReturnType<typeof createAppAPI>;

// Compile-time half of the contract (checked by `npm run typecheck:tests`):
// the host object must be assignable to the public interface and must declare
// every member of it, optional ones included.
type MissingMembers = Exclude<keyof GeoLibreAppAPI, keyof AppAPI>;
const noMissingMembers: [MissingMembers] extends [never] ? true : MissingMembers = true;
void noMissingMembers;
const assignable = (api: AppAPI): GeoLibreAppAPI => api;
void assignable;

/**
 * Reads the member names declared on `GeoLibreAppAPI` from its source, so the
 * runtime check below follows the interface instead of a hand-kept copy.
 *
 * @returns The interface's member names, in declaration order.
 */
function declaredAppApiMembers(): string[] {
  const source = readFileSync(new URL("../packages/plugins/src/types.ts", import.meta.url), "utf8");
  const start = source.indexOf("export interface GeoLibreAppAPI {");
  assert.ok(start >= 0, "GeoLibreAppAPI interface not found in types.ts");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}([A-Za-z_]\w*)\??\s*[:(<]/gm)].map((match) => match[1]);
}

/** Members only the desktop (Tauri) runtime provides; undefined in a browser. */
const DESKTOP_ONLY_MEMBERS = new Set(["nativeFetch", "pickVectorFilesWithSidecars"]);
/** Members that are objects rather than functions. */
const OBJECT_MEMBERS = new Set(["credentials"]);

interface HostCalls {
  activate: string[];
  deactivate: string[];
  persisted: string[];
  errors: Array<{ pluginId: string; action: string; message: string }>;
  credentials: Array<[string, ...unknown[]]>;
  cesiumSceneArgs: unknown[];
}

/**
 * Builds an {@link AppApiHost} from recording fakes plus the real UI registries.
 *
 * @param overrides - Members to replace.
 * @returns The host and the calls it recorded.
 */
function fakeHost(overrides: Partial<AppApiHost> = {}): { host: AppApiHost; calls: HostCalls } {
  const calls: HostCalls = {
    activate: [],
    deactivate: [],
    persisted: [],
    errors: [],
    credentials: [],
    cesiumSceneArgs: [],
  };
  const active = new Set<string>();
  const unused = (name: string) => () => {
    throw new Error(`${name} should not be called by this test`);
  };
  const host = {
    plugins: {
      activate: (id: string) => {
        calls.activate.push(id);
        active.add(id);
        return true;
      },
      deactivate: (id: string) => {
        calls.deactivate.push(id);
        active.delete(id);
      },
      isActive: (id: string) => active.has(id),
      applyPluginState: () => true,
      subscribe: () => () => undefined,
    },
    projectPluginStateSnapshot: () => ({ active: [...active] }),
    persistProjectPluginState: (previousJson: string) => {
      calls.persisted.push(previousJson);
    },
    reportPluginError: (pluginId: string, action: string, error: unknown) => {
      calls.errors.push({ pluginId, action, message: (error as Error).message });
    },
    bindTemporalLayer: () => true,
    buildProjectSnapshot: unused("buildProjectSnapshot"),
    credentials: {
      get: (name: string, ownerPluginId?: string) => {
        calls.credentials.push(["get", name, ownerPluginId]);
        return `secret:${ownerPluginId}:${name}`;
      },
      set: (name: string, value: string, ownerPluginId?: string) => {
        calls.credentials.push(["set", name, value, ownerPluginId]);
        return true;
      },
      location: () => "browser" as const,
    },
    i18n: {
      language: "en",
      t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
      on: () => undefined,
      off: () => undefined,
    },
    getCesiumScene: (engine: unknown) => {
      calls.cesiumSceneArgs.push(engine);
      return null;
    },
    getPrimaryCesiumControlHost: () => null,
    addRasterToMap: unused("addRasterToMap"),
    readRasterWindow: unused("readRasterWindow"),
    setRasterRenderEngine: unused("setRasterRenderEngine"),
    addZarrRasterLayer: unused("addZarrRasterLayer"),
    queryZarrLayer: unused("queryZarrLayer"),
    setZarrLayerSelector: unused("setZarrLayerSelector"),
    registerTemporalLayer: () => () => undefined,
    unregisterTemporalLayer: () => undefined,
    queryOvertureFeatures: unused("queryOvertureFeatures"),
    registerRightPanel,
    unregisterRightPanel,
    openRightPanel,
    collapseRightPanel,
    closeRightPanel,
    getActiveRightPanel,
    setActiveRightPanelDock,
    getActiveRightPanelDock,
    registerAssistantTool,
    registerAssistantToolSpec,
    registerAssistantGuidance,
    registerToolbarMenu,
    unregisterToolbarMenu,
    registerMenuContribution,
    unregisterMenuContribution,
    registerFloatingPanel,
    unregisterFloatingPanel,
    openFloatingPanel,
    closeFloatingPanel,
    getOpenFloatingPanels,
    ...overrides,
  } as unknown as AppApiHost;
  return { host, calls };
}

/** A ref the way `useRef<MapEngine | null>(null)` hands it out. */
function engineRef(engine: Partial<MapEngine> | null = null): { current: MapEngine | null } {
  return { current: engine as MapEngine | null };
}

/** Whether a member value has the kind the contract requires. */
function kindOf(value: unknown): string {
  if (value === undefined) return "missing";
  return typeof value === "function" ? "function" : typeof value;
}

describe("plugin app API contract", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API contract" });
  });

  it("parses a plausible member list from the GeoLibreAppAPI interface", () => {
    const members = declaredAppApiMembers();
    // A guard on the parser itself: if the interface's formatting changes and
    // the regex stops matching, the contract checks below would pass vacuously.
    assert.ok(members.length > 80, `only ${members.length} members parsed`);
    for (const name of ["setBasemap", "addGeoJsonLayer", "credentials", "getMap"]) {
      assert.ok(members.includes(name), `${name} not parsed from GeoLibreAppAPI`);
    }
  });

  it("provides every declared member with the right kind in the browser", () => {
    const api = createAppAPI(engineRef(), fakeHost().host) as unknown as Record<string, unknown>;
    const wrong: string[] = [];
    for (const name of declaredAppApiMembers()) {
      const expected = DESKTOP_ONLY_MEMBERS.has(name)
        ? "missing"
        : OBJECT_MEMBERS.has(name)
          ? "object"
          : "function";
      const actual = kindOf(api[name]);
      if (actual !== expected) wrong.push(`${name}: expected ${expected}, got ${actual}`);
    }
    assert.deepEqual(wrong, []);
  });

  it("adds the desktop-only members inside the Tauri runtime", () => {
    const globals = globalThis as { window?: unknown };
    const previous = globals.window;
    globals.window = { __TAURI_INTERNALS__: {} };
    try {
      const api = createAppAPI(engineRef(), fakeHost().host);
      assert.equal(typeof api.nativeFetch, "function");
      assert.equal(typeof api.pickVectorFilesWithSidecars, "function");
    } finally {
      if (previous === undefined) delete globals.window;
      else globals.window = previous;
    }
  });

  it("exposes nothing beyond the public interface", () => {
    const declared = new Set(declaredAppApiMembers());
    const api = createAppAPI(engineRef(), fakeHost().host);
    const extra = Object.keys(api).filter((name) => !declared.has(name));
    assert.deepEqual(extra, []);
  });
});

describe("plugin app API map tools", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API map tools" });
  });

  it("reports live tool transitions, gives feature selection precedence, and unsubscribes", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const events: Array<"identify" | "feature-selection" | null> = [];
    assert.equal(api.getActiveMapTool(), null);
    const unsubscribe = api.onActiveMapToolChange((activeTool) => events.push(activeTool));

    useAppStore.getState().setIdentifyLayer("first");
    assert.equal(api.getActiveMapTool(), "identify");
    useAppStore.getState().setIdentifyLayer("second");
    assert.deepEqual(events, ["identify"]);

    useAppStore.getState().setFeatureSelectionActive(true);
    assert.equal(api.getActiveMapTool(), "feature-selection");
    useAppStore.getState().setIdentifyLayer(null);
    assert.deepEqual(events, ["identify", "feature-selection"]);

    useAppStore.getState().setFeatureSelectionActive(false);
    assert.equal(api.getActiveMapTool(), null);
    assert.deepEqual(events, ["identify", "feature-selection", null]);
    unsubscribe();

    useAppStore.getState().setIdentifyLayer("after-unsubscribe");
    assert.deepEqual(events, ["identify", "feature-selection", null]);
  });

  it("reports the GeoEditor while its plugin is active, below Identify and selection", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const api = createAppAPI(undefined, fakeHost({ plugins: manager }).host);
    const events: Array<GeoLibreActiveMapTool> = [];
    const unsubscribe = api.onActiveMapToolChange((activeTool) => events.push(activeTool));

    await manager.activate(GEO_EDITOR_PLUGIN_ID, api as unknown as GeoLibreAppAPI);
    assert.equal(api.getActiveMapTool(), "geo-editor");
    assert.deepEqual(events, ["geo-editor"]);

    useAppStore.getState().setIdentifyLayer("points");
    assert.equal(api.getActiveMapTool(), "identify");
    useAppStore.getState().setFeatureSelectionActive(true);
    assert.equal(api.getActiveMapTool(), "feature-selection");
    useAppStore.getState().setFeatureSelectionActive(false);
    useAppStore.getState().setIdentifyLayer(null);
    assert.equal(api.getActiveMapTool(), "geo-editor");

    manager.deactivate(GEO_EDITOR_PLUGIN_ID, api as unknown as GeoLibreAppAPI);
    assert.equal(api.getActiveMapTool(), null);
    assert.deepEqual(events, [
      "geo-editor",
      "identify",
      "feature-selection",
      "identify",
      "geo-editor",
      null,
    ]);
    unsubscribe();

    await manager.activate(GEO_EDITOR_PLUGIN_ID, api as unknown as GeoLibreAppAPI);
    assert.equal(events.length, 6);
  });
});

describe("plugin app API layers", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API layers" });
  });

  it("adds a GeoJSON layer to the store and reports it through the layer queries", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const seen: string[][] = [];
    const unsubscribe = api.onLayersChanged((ids) => seen.push(ids));
    const id = api.addGeoJsonLayer("Points", { type: "FeatureCollection", features: [] });
    unsubscribe();

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.equal(layer?.name, "Points");
    assert.deepEqual(api.getLayers(), [id]);
    assert.deepEqual(
      api.listLayers().map((summary) => summary.id),
      [id],
    );
    assert.deepEqual(seen, [[id]]);
  });

  it("stores a tile layer without leaking beforeLayerId into its options", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const id = api.addTileLayer("Tiles", "https://tiles.example.com/{z}/{x}/{y}.png", {
      opacity: 0.5,
    });
    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.equal(layer?.type, "xyz");
    assert.equal(layer?.opacity, 0.5);
    assert.equal("beforeLayerId" in (layer ?? {}), false);
  });

  it("keeps queryable: false on a WMS layer and leaves it out otherwise (#2887)", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const options = { url: "https://example.com/wms", layers: "buildings" };
    const off = api.addWmsLayer("Off", { ...options, queryable: false });
    const on = api.addWmsLayer("On", { ...options, queryable: true });
    const unset = api.addWmsLayer("Unset", options);
    const source = (id: string) =>
      useAppStore.getState().layers.find((item) => item.id === id)?.source ?? {};
    assert.equal(source(off).queryable, false);
    assert.equal("queryable" in source(on), false);
    assert.equal("queryable" in source(unset), false);
  });

  it("rejects a WMS layer without an endpoint or layer names", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    assert.throws(() => api.addWmsLayer("WMS", { url: "", layers: "a" }), /options\.url/);
    assert.throws(
      () => api.addWmsLayer("WMS", { url: "https://example.com/wms", layers: "" }),
      /options\.layers/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("registers, re-registers and removes an external native layer", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    api.registerExternalNativeLayer({
      id: "ext-1",
      name: "External",
      nativeLayerIds: ["ext-1-fill"],
    });
    assert.equal(useAppStore.getState().layers.filter((l) => l.id === "ext-1").length, 1);
    // A second registration of the same id updates in place.
    api.registerExternalNativeLayer({
      id: "ext-1",
      name: "Renamed",
      nativeLayerIds: ["ext-1-fill"],
    });
    const layers = useAppStore.getState().layers.filter((l) => l.id === "ext-1");
    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.name, "Renamed");

    api.unregisterExternalNativeLayer("ext-1");
    assert.equal(
      useAppStore.getState().layers.some((l) => l.id === "ext-1"),
      false,
    );
    // Unregistering an unknown id is a no-op rather than a throw.
    api.unregisterExternalNativeLayer("ext-1");
  });

  it("routes the basemap to the Mapbox style while Mapbox is the primary renderer", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const changes: string[] = [];
    const unsubscribe = api.onBasemapChange((url) => changes.push(url));

    api.setBasemap("https://example.com/maplibre.json");
    assert.equal(useAppStore.getState().basemapStyleUrl, "https://example.com/maplibre.json");
    assert.equal(api.getActiveBasemap(), "https://example.com/maplibre.json");

    // Switching renderer is itself a basemap change for subscribers.
    useAppStore.setState({ primaryRenderer: "mapbox" });
    const mapboxDefault = api.getActiveBasemap();
    api.setBasemap("mapbox://styles/example/style");
    assert.equal(useAppStore.getState().basemapStyleUrl, "https://example.com/maplibre.json");
    assert.equal(api.getActiveBasemap(), "mapbox://styles/example/style");
    unsubscribe();
    useAppStore.setState({ primaryRenderer: "maplibre" });

    assert.deepEqual(changes, [
      "https://example.com/maplibre.json",
      mapboxDefault,
      "mapbox://styles/example/style",
    ]);
  });
});

describe("plugin app API map access", () => {
  for (const [label, ref] of [
    ["no ref", undefined],
    ["an unmounted ref", engineRef()],
  ] as const) {
    it(`returns null or a safe default with ${label}`, () => {
      const { host, calls } = fakeHost();
      const api = createAppAPI(ref, host);
      assert.equal(api.getMap(), null);
      assert.equal(api.getViewBounds(), null);
      assert.equal(api.fitBounds([0, 0, 1, 1]), undefined);
      assert.deepEqual(api.getBasemapLayerIds(), []);
      assert.equal(api.getArcgisView(), null);
      assert.equal(api.getArcgisControlMap(), null);
      assert.equal(api.getMapboxMap(), null);
      assert.equal(api.getMapboxGl(), null);
      assert.equal(api.getMapboxAccessToken(), null);
      assert.equal(api.getCesiumScene(), null);
      assert.deepEqual(calls.cesiumSceneArgs, [ref?.current]);
      assert.equal(api.addMapControl({ onAdd: () => document, onRemove() {} } as never), false);
      assert.doesNotThrow(() => api.removeMapControl({} as never));
      assert.equal(api.setBuiltInMapControlVisible("navigation" as never, false), false);
      assert.equal(api.getBuiltInMapControlPosition("navigation" as never), "top-right");
      assert.equal(api.setBuiltInMapControlPosition("navigation" as never, "top-left"), false);
      assert.equal(api.setTerrainEnabled(true), false);
      assert.equal(api.isTerrainEnabled(), false);
    });
  }

  it("dereferences the engine lazily, so an API built before mount works after", () => {
    const ref = engineRef();
    const api = createAppAPI(ref, fakeHost().host);
    assert.equal(api.getMap(), null);
    const map = { id: "map" };
    ref.current = { getMap: () => map } as unknown as MapEngine;
    assert.equal(api.getMap(), map);
  });

  it("adds controls to the mounted engine, falling back to the Cesium host", () => {
    const added: unknown[] = [];
    const cesiumAdded: unknown[] = [];
    const { host } = fakeHost({
      getPrimaryCesiumControlHost: (() => ({
        addControl: (control: unknown) => {
          cesiumAdded.push(control);
          return true;
        },
        removeControl: () => undefined,
      })) as unknown as AppApiHost["getPrimaryCesiumControlHost"],
    });
    const control = { onAdd: () => null, onRemove: () => undefined } as never;

    const mounted = createAppAPI(
      engineRef({
        addControl: (c: unknown) => {
          added.push(c);
          return true;
        },
      } as unknown as Partial<MapEngine>),
      host,
    );
    assert.equal(mounted.addMapControl(control), true);
    assert.deepEqual([added.length, cesiumAdded.length], [1, 0]);

    const cesiumOnly = createAppAPI(engineRef(), host);
    assert.equal(cesiumOnly.addMapControl(control), true);
    assert.deepEqual([added.length, cesiumAdded.length], [1, 1]);
  });

  it("returns renderer-specific handles only from the matching engine kind", () => {
    const mapboxMap = { id: "mapbox" };
    const api = createAppAPI(
      engineRef({
        kind: "mapbox",
        getMapboxMap: () => mapboxMap,
      } as unknown as Partial<MapEngine>),
      fakeHost().host,
    );
    assert.equal(api.getMapboxMap(), mapboxMap);
    assert.equal(api.getArcgisView(), null);
  });
});

describe("plugin app API plugin lifecycle", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API lifecycle" });
  });

  it("activates through the plugin manager and applies optional state", async () => {
    const applied: unknown[] = [];
    const { host, calls } = fakeHost();
    host.plugins.applyPluginState = (id, _app, state) => {
      applied.push([id, state]);
      return true;
    };
    const api = createAppAPI(undefined, host);
    assert.equal(await api.activatePlugin("alpha"), true);
    assert.equal(await api.activatePlugin("alpha", { zoom: 3 }), true);
    assert.deepEqual(calls.activate, ["alpha", "alpha"]);
    assert.deepEqual(applied, [["alpha", { zoom: 3 }]]);
  });

  it("deactivates and persists the plugin state, and ignores inactive plugins", async () => {
    const { host, calls } = fakeHost();
    const api = createAppAPI(undefined, host);
    assert.equal(api.deactivatePlugin("alpha"), false);
    assert.deepEqual(calls.deactivate, []);

    await api.activatePlugin("alpha");
    assert.equal(api.deactivatePlugin("alpha"), true);
    assert.deepEqual(calls.deactivate, ["alpha"]);
    // The snapshot taken before deactivation is what gets compared.
    assert.deepEqual(calls.persisted, [JSON.stringify({ active: ["alpha"] })]);
  });

  it("contains a throwing deactivation and reports it instead of persisting", async () => {
    const { host, calls } = fakeHost();
    host.plugins.deactivate = () => {
      throw new Error("teardown failed");
    };
    const api = createAppAPI(undefined, host);
    await api.activatePlugin("alpha");
    assert.equal(api.deactivatePlugin("alpha"), false);
    assert.deepEqual(calls.errors, [
      { pluginId: "alpha", action: "deactivate", message: "teardown failed" },
    ]);
    assert.deepEqual(calls.persisted, []);
  });
});

describe("plugin app API through the plugin manager", () => {
  const OWNER = "contract-plugin";

  afterEach(() => {
    unregisterAssistantToolsByOwner(OWNER);
  });

  /**
   * Activates a plugin whose `activate` runs `body` with the scoped app.
   *
   * @param body - Receives the per-plugin app the manager hands the plugin.
   * @returns The manager and the host's recorded calls.
   */
  function activateWith(body: (app: GeoLibreAppAPI) => void) {
    const manager = new PluginManager();
    const { host, calls } = fakeHost({ plugins: manager });
    const plugin: GeoLibrePlugin = {
      id: OWNER,
      name: "Contract plugin",
      version: "1.0.0",
      activate: (app) => body(app),
      deactivate: () => undefined,
    };
    manager.register(plugin);
    const api = createAppAPI(undefined, host);
    assert.equal(manager.activate(OWNER, api), true);
    return { manager, api, calls };
  }

  it("routes credentials to the host store with the plugin's id as owner", () => {
    let read = "";
    let saved = false;
    const { calls } = activateWith((app) => {
      read = app.credentials?.get("api-token") ?? "";
      saved = app.credentials?.set("api-token", "abc") ?? false;
      assert.equal(app.credentials?.location(), "browser");
    });
    assert.equal(read, `secret:${OWNER}:api-token`);
    assert.equal(saved, true);
    assert.deepEqual(calls.credentials, [
      ["get", "api-token", OWNER],
      ["set", "api-token", "abc", OWNER],
    ]);
  });

  it("hands the host credential store through unchanged", () => {
    const { host } = fakeHost();
    assert.equal(createAppAPI(undefined, host).credentials, host.credentials);
  });

  it("scopes assistant tools to the owning plugin and drops them on deactivation", () => {
    const ownedNames = () =>
      listAssistantToolEntries()
        .filter((entry) => entry.ownerPluginId === OWNER)
        .map((entry) => entry.tool.name);
    let dispose: (() => void) | undefined;
    const { manager, api } = activateWith((app) => {
      dispose = app.registerAssistantTool?.(
        tool({
          name: "count",
          description: "Counts things.",
          inputSchema: z.object({}),
          callback: () => 1,
        }),
      );
      app.registerAssistantToolSpec?.({
        name: "sum",
        description: "Sums things.",
        callback: () => 2,
      });
    });
    const scoped = (name: string) => `plugin_${OWNER.length}_${OWNER}_${name}`;
    assert.deepEqual(ownedNames().sort(), [scoped("count"), scoped("sum")]);

    // The disposer the plugin got back removes just its own tool.
    dispose?.();
    assert.deepEqual(ownedNames(), [scoped("sum")]);

    manager.deactivate(OWNER, api);
    assert.deepEqual(ownedNames(), []);
  });

  it("does not hand the unscoped assistant registration to deactivate", () => {
    let seen: GeoLibreAppAPI | undefined;
    const manager = new PluginManager();
    const { host } = fakeHost({ plugins: manager });
    manager.register({
      id: OWNER,
      name: "Contract plugin",
      version: "1.0.0",
      activate: () => undefined,
      deactivate: (app) => {
        seen = app;
      },
    });
    const api = createAppAPI(undefined, host);
    manager.activate(OWNER, api);
    manager.deactivate(OWNER, api);
    assert.ok(seen);
    assert.equal(seen.registerAssistantTool, undefined);
    assert.equal(typeof api.registerAssistantTool, "function");
  });
});
