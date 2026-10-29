import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  getExternalNativePaintBridge,
  registerS3UrlSigner,
  unsignedSourceUrl,
  useAppStore,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { tileRequestHeadersFor } from "@geolibre/map/tile-request-headers";
import { createAppAPI, type AppApiHost } from "../apps/geolibre-desktop/src/lib/app-api";
import { GEOMETRY_EDIT_QUEUE_WAIT_MS } from "../apps/geolibre-desktop/src/lib/geometry-edit-session";
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
  GeoLibreEditSessionChange,
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
const DESKTOP_ONLY_MEMBERS = new Set([
  "nativeFetch",
  "downloadRemoteFile",
  "pickDownloadFolder",
  "pickVectorFilesWithSidecars",
]);
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
    openControlPanel: unused("openControlPanel"),
    closeControlPanel: unused("closeControlPanel"),
    isControlPanelVisible: () => false,
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
    getGeometryEditTargetLayerId: () => null,
    getLastGeometryEditEnd: () => null,
    subscribeGeometryEdit: () => () => undefined,
    isPluginEngineSupported: () => true,
    maplibreGeoEditorPlugin: {},
    startLayerGeometryEdit: unused("startLayerGeometryEdit"),
    addLidarLayerFromUrl: unused("addLidarLayerFromUrl"),
    addLidarLayerFromBytes: unused("addLidarLayerFromBytes"),
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
      assert.equal(typeof api.downloadRemoteFile, "function");
      assert.equal(typeof api.pickDownloadFolder, "function");
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

describe("plugin app API built-in control panels", () => {
  it("opens, closes, and queries every panel through the host with the live app", () => {
    const calls: unknown[][] = [];
    const visible = new Set<string>();
    const { host } = fakeHost({
      openControlPanel: (app, id, options) => {
        calls.push(["open", app, id, options]);
        visible.add(id);
      },
      closeControlPanel: (app, id) => {
        calls.push(["close", app, id]);
        visible.delete(id);
      },
      isControlPanelVisible: (id) => visible.has(id),
    });
    const api = createAppAPI(engineRef(), host);
    for (const id of ["bookmark", "search", "measure", "minimap", "print"] as const) {
      assert.equal(api.isControlPanelVisible(id), false);
      api.openControlPanel(id);
      assert.equal(api.isControlPanelVisible(id), true);
      assert.deepEqual(calls.at(-1), ["open", api, id, undefined]);
      api.closeControlPanel(id);
      assert.equal(api.isControlPanelVisible(id), false);
      assert.deepEqual(calls.at(-1), ["close", api, id]);
    }
    const options = { zoomOffset: -6, width: 320, height: 220 };
    api.openControlPanel("minimap", options);
    assert.deepEqual(calls.at(-1), ["open", api, "minimap", options]);
  });
});

describe("plugin app API map tools", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API map tools" });
  });

  it("reports live tool transitions, gives feature selection precedence, and unsubscribes", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const events: Array<GeoLibreActiveMapTool> = [];
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

/** A GeoEditor session a test drives by hand, through the host's hooks. */
function fakeEditSessions() {
  let layerId: string | null = null;
  let lastEnd: { layerId: string; saved: boolean } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    host: {
      getGeometryEditTargetLayerId: () => layerId,
      getLastGeometryEditEnd: () => lastEnd,
      subscribeGeometryEdit: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    start(id: string) {
      if (layerId) this.end(true);
      layerId = id;
      notify();
    },
    end(saved: boolean) {
      if (layerId) lastEnd = { layerId, saved };
      layerId = null;
      notify();
    },
    // Ends the open session without recording how it ended.
    endWithoutRecord() {
      layerId = null;
      notify();
    },
    // Ends the open session and starts another on the same layer, notifying
    // once for both.
    restartInOneNotification(saved: boolean) {
      if (layerId) lastEnd = { layerId, saved };
      notify();
    },
  };
}

const EMPTY_COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

describe("plugin app API edit sessions", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API edit sessions" });
  });

  it("reports sessions starting and ending, saved or not, and unsubscribes", () => {
    const sessions = fakeEditSessions();
    const api = createAppAPI(undefined, fakeHost(sessions.host).host);
    const changes: GeoLibreEditSessionChange[] = [];
    const unsubscribe = api.onEditSessionChange((change) => changes.push(change));

    sessions.start("roads");
    assert.equal(api.getEditSessionLayerId(), "roads");
    sessions.end(true);
    sessions.start("rivers");
    sessions.end(false);
    unsubscribe();
    sessions.start("after-unsubscribe");

    assert.equal(api.getEditSessionLayerId(), "after-unsubscribe");
    assert.deepEqual(changes, [
      { layerId: "roads", state: "started" },
      { layerId: "roads", state: "ended", saved: true },
      { layerId: "rivers", state: "started" },
      { layerId: "rivers", state: "ended", saved: false },
    ]);
  });

  it("reports the old session ending before the new one starts on a switch", () => {
    const sessions = fakeEditSessions();
    const api = createAppAPI(undefined, fakeHost(sessions.host).host);
    sessions.start("roads");
    const changes: GeoLibreEditSessionChange[] = [];
    api.onEditSessionChange((change) => changes.push(change));

    sessions.start("rivers");

    assert.deepEqual(changes, [
      { layerId: "roads", state: "ended", saved: true },
      { layerId: "rivers", state: "started" },
    ]);
  });

  it("reports a session that ends and restarts on the same layer in one notification", () => {
    const sessions = fakeEditSessions();
    const api = createAppAPI(undefined, fakeHost(sessions.host).host);
    sessions.start("roads");
    const changes: GeoLibreEditSessionChange[] = [];
    api.onEditSessionChange((change) => changes.push(change));

    sessions.restartInOneNotification(true);

    assert.deepEqual(changes, [
      { layerId: "roads", state: "ended", saved: true },
      { layerId: "roads", state: "started" },
    ]);
  });

  it("doesn't report an earlier session's save for a session that ended without a record", () => {
    const sessions = fakeEditSessions();
    const api = createAppAPI(undefined, fakeHost(sessions.host).host);
    sessions.start("roads");
    sessions.end(true);
    sessions.start("roads");
    const changes: GeoLibreEditSessionChange[] = [];
    api.onEditSessionChange((change) => changes.push(change));

    sessions.endWithoutRecord();

    assert.deepEqual(changes, [{ layerId: "roads", state: "ended", saved: false }]);
  });

  it("still reports the new session to a callback that threw on the old one's end", () => {
    const sessions = fakeEditSessions();
    const api = createAppAPI(undefined, fakeHost(sessions.host).host);
    sessions.start("roads");
    const changes: GeoLibreEditSessionChange[] = [];
    api.onEditSessionChange((change) => {
      changes.push(change);
      if (change.state === "ended") throw new Error("plugin bug");
    });
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      sessions.restartInOneNotification(true);
      sessions.start("rivers");
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(changes, [
      { layerId: "roads", state: "ended", saved: true },
      { layerId: "roads", state: "started" },
      { layerId: "roads", state: "ended", saved: true },
      { layerId: "rivers", state: "started" },
    ]);
  });

  it("runs overlapping starts one after another", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const steps: string[] = [];
    const api = createAppAPI(
      undefined,
      fakeHost({
        plugins: manager,
        startLayerGeometryEdit: async (_app: GeoLibreAppAPI, layerId: string) => {
          steps.push(`begin ${layerId}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          steps.push(`end ${layerId}`);
          return true;
        },
      }).host,
    );

    const roads = api.addGeoJsonLayer("Roads", EMPTY_COLLECTION);
    const rivers = api.addGeoJsonLayer("Rivers", EMPTY_COLLECTION);

    const results = await Promise.all([api.startEditSession(roads), api.startEditSession(rivers)]);

    assert.deepEqual(results, [true, true]);
    assert.deepEqual(steps, [`begin ${roads}`, `end ${roads}`, `begin ${rivers}`, `end ${rivers}`]);
  });

  it("gives up waiting behind a start that never finishes, without running alongside it", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    let releaseStuckStart!: (started: boolean) => void;
    const ran: string[] = [];
    const api = createAppAPI(
      undefined,
      fakeHost({
        plugins: manager,
        startLayerGeometryEdit: (_app: GeoLibreAppAPI, layerId: string) => {
          ran.push(layerId);
          return ran.length === 1
            ? new Promise<boolean>((resolve) => {
                releaseStuckStart = resolve;
              })
            : Promise.resolve(true);
        },
      }).host,
    );
    const stuck = api.addGeoJsonLayer("Stuck", EMPTY_COLLECTION);
    const later = api.addGeoJsonLayer("Later", EMPTY_COLLECTION);
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const stuckStart = api.startEditSession(stuck);
      const waitingStart = api.startEditSession(later);
      await flush();
      mock.timers.tick(GEOMETRY_EDIT_QUEUE_WAIT_MS);
      assert.equal(await waitingStart, false);
      assert.deepEqual(ran, [stuck], "the waiting start never ran alongside the stuck one");

      releaseStuckStart(true);
      assert.equal(await stuckStart, true);
      assert.equal(await api.startEditSession(later), true);
      assert.deepEqual(ran, [stuck, later]);
    } finally {
      mock.timers.reset();
    }
  });

  it("starts a session, activating the GeoEditor first", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const started: string[] = [];
    const api = createAppAPI(
      undefined,
      fakeHost({
        plugins: manager,
        startLayerGeometryEdit: async (_app: GeoLibreAppAPI, layerId: string) => {
          started.push(layerId);
          return true;
        },
      }).host,
    );

    const roads = api.addGeoJsonLayer("Roads", EMPTY_COLLECTION);

    assert.equal(await api.startEditSession(roads), true);
    assert.equal(manager.isActive(GEO_EDITOR_PLUGIN_ID), true);
    assert.deepEqual(started, [roads]);
  });

  it("reports false when the GeoEditor can't be activated", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => {
        throw new Error("the editor's packages failed to load");
      },
      deactivate: () => undefined,
    });
    const started: string[] = [];
    const api = createAppAPI(
      undefined,
      fakeHost({
        plugins: manager,
        startLayerGeometryEdit: async (_app: GeoLibreAppAPI, layerId: string) => {
          started.push(layerId);
          return true;
        },
      }).host,
    );
    const roads = api.addGeoJsonLayer("Roads", EMPTY_COLLECTION);

    assert.equal(await api.startEditSession(roads), false);
    assert.deepEqual(started, [], "no session starts without the editor");
  });

  it("reports false when starting the session throws", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const api = createAppAPI(
      undefined,
      fakeHost({
        plugins: manager,
        startLayerGeometryEdit: async () => {
          throw new Error("restoring the sketches failed");
        },
      }).host,
    );
    const roads = api.addGeoJsonLayer("Roads", EMPTY_COLLECTION);
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      assert.equal(await api.startEditSession(roads), false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("refuses a layer that doesn't exist without activating the GeoEditor", async () => {
    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const api = createAppAPI(undefined, fakeHost({ plugins: manager }).host);

    assert.equal(await api.startEditSession("missing"), false);
    assert.equal(manager.isActive(GEO_EDITOR_PLUGIN_ID), false);
  });

  it("refuses to start on an unsupported renderer, or when the layer can't be edited", async () => {
    const unsupported = createAppAPI(
      undefined,
      fakeHost({ isPluginEngineSupported: () => false }).host,
    );
    const roads = unsupported.addGeoJsonLayer("Roads", EMPTY_COLLECTION);
    assert.equal(await unsupported.startEditSession(roads), false);

    const manager = new PluginManager();
    manager.register({
      id: GEO_EDITOR_PLUGIN_ID,
      name: "GeoEditor",
      version: "0.0.0",
      activate: () => undefined,
      deactivate: () => undefined,
    });
    const notEditable = createAppAPI(
      undefined,
      fakeHost({ plugins: manager, startLayerGeometryEdit: async () => false }).host,
    );
    const tiles = notEditable.addTileLayer("Tiles", "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal(await notEditable.startEditSession(tiles), false);
  });
});

describe("plugin app API S3 URL resolution", () => {
  afterEach(() => registerS3UrlSigner(null));

  it("presigns covered buckets, reads others anonymously, and leaves other URLs alone", async () => {
    const signed: string[] = [];
    registerS3UrlSigner({
      covers: (bucket) => bucket === "private",
      connections: () => [],
      presign: async (location) => {
        signed.push(`${location.bucket}/${location.key}`);
        return {
          href: `https://private.s3.amazonaws.com/${location.key}?X-Amz-Signature=sig`,
          expiresAt: Date.now() + 60_000,
        };
      },
    });
    const api = createAppAPI(undefined, fakeHost().host);

    const href = await api.resolveReadableUrl("s3://private/datasets/a/index.json");
    assert.equal(
      href,
      "https://private.s3.amazonaws.com/datasets/a/index.json?X-Amz-Signature=sig",
    );
    // The host remembers the source, so nothing it saves keeps the signature.
    assert.equal(unsignedSourceUrl(href), "s3://private/datasets/a/index.json");
    assert.equal(
      await api.resolveReadableUrl("s3://public-bucket/x/tile.bin"),
      "https://public-bucket.s3.amazonaws.com/x/tile.bin",
    );
    assert.equal(
      await api.resolveReadableUrl(" https://example.com/a.json "),
      "https://example.com/a.json",
    );
    assert.deepEqual(signed, ["private/datasets/a/index.json"]);
  });

  it("rejects a missing URL and passes credential failures through", async () => {
    registerS3UrlSigner({
      covers: () => true,
      connections: () => [],
      presign: async () => {
        throw new Error("The SSO session has expired.");
      },
    });
    const api = createAppAPI(undefined, fakeHost().host);
    await assert.rejects(api.resolveReadableUrl("  "), /non-empty string/);
    await assert.rejects(api.resolveReadableUrl(42 as unknown as string), /non-empty string/);
    await assert.rejects(api.resolveReadableUrl("s3://private/a.json"), /SSO session has expired/);
    await assert.rejects(
      api.resolveReadableUrl("s3://private/a.json", {} as AbortSignal),
      /must be an AbortSignal/,
    );
  });

  it("never returns a URL once the signal aborts", async () => {
    let presigned = 0;
    let finishLookup: () => void = () => undefined;
    registerS3UrlSigner({
      covers: () => true,
      connections: () => [],
      // A credential lookup that ignores the signal, like an SSO refresh.
      presign: async (location) => {
        presigned += 1;
        await new Promise<void>((resolve) => (finishLookup = resolve));
        return { href: `https://b.s3.amazonaws.com/${location.key}?sig`, expiresAt: Infinity };
      },
    });
    const api = createAppAPI(undefined, fakeHost().host);

    await assert.rejects(
      api.resolveReadableUrl("s3://private/a.json", AbortSignal.abort()),
      (error: Error) => error.name === "AbortError",
    );
    assert.equal(presigned, 0);

    const controller = new AbortController();
    const pending = api.resolveReadableUrl("s3://private/a.json", controller.signal);
    await Promise.resolve();
    controller.abort();
    // Rejects while the lookup is still pending, not once it finishes.
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
    finishLookup();
    assert.equal(presigned, 1);
    // null means no signal, as an optional argument usually does in JS.
    assert.equal(
      await api.resolveReadableUrl(" https://example.com/a.json", null as unknown as AbortSignal),
      "https://example.com/a.json",
    );
  });
});

describe("plugin app API point clouds", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "App API point clouds" });
  });

  /** A layer like the one the LiDAR control's load handler adds. */
  const addStoreLayer = (name: string) =>
    useAppStore.getState().addGeoJsonLayer(name, { type: "FeatureCollection", features: [] });
  const layerName = (id: string) =>
    useAppStore.getState().layers.find((layer) => layer.id === id)?.name;

  it("streams a URL through the shared LiDAR control and names the layer", async () => {
    const calls: unknown[][] = [];
    const { host } = fakeHost({
      addLidarLayerFromUrl: async (app, url, options) => {
        calls.push([app, url, options]);
        return addStoreLayer("survey.copc.laz");
      },
    });
    const api = createAppAPI(undefined, host);

    const id = await api.addPointCloudLayer("  https://example.com/survey.copc.laz ", {
      name: "Survey",
    });
    assert.deepEqual(calls, [[api, "https://example.com/survey.copc.laz", { fit: true }]]);
    assert.equal(layerName(id), "Survey");

    const kept = await api.addPointCloudLayer("https://example.com/survey.copc.laz", {
      zoomTo: false,
    });
    assert.deepEqual(calls[1]?.[2], { fit: false });
    // Without a name the layer keeps the one the LiDAR control gave it.
    assert.equal(layerName(kept), "survey.copc.laz");
  });

  it("loads bytes and files under their file name", async () => {
    const calls: { bytes: unknown; options: unknown }[] = [];
    const { host } = fakeHost({
      addLidarLayerFromBytes: async (_app, bytes, options) => {
        calls.push({ bytes, options });
        return addStoreLayer(options.name);
      },
    });
    const api = createAppAPI(undefined, host);

    const buffer = new ArrayBuffer(8);
    await api.addPointCloudLayer(buffer, { fileName: "tile.laz" });
    const view = calls[0]?.bytes;
    assert.ok(view instanceof Uint8Array && view.buffer === buffer, "bytes are viewed, not copied");
    assert.deepEqual(calls[0]?.options, { name: "tile.laz", fileName: "tile.laz", fit: true });

    const file = new File([new Uint8Array(4)], "tile.copc.laz");
    await api.addPointCloudLayer(file, { name: "Tile", zoomTo: false });
    assert.equal(calls[1]?.bytes, file, "a File is passed through so a COPC streams");
    assert.deepEqual(calls[1]?.options, { name: "Tile", fileName: "tile.copc.laz", fit: false });
  });

  it("rejects sources and options it cannot load, before touching the LiDAR control", async () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const bytes = new Uint8Array(4);
    const cases: [string, () => Promise<string>, RegExp][] = [
      ["an empty URL", () => api.addPointCloudLayer("  "), /URL is empty/],
      ["bytes without a file name", () => api.addPointCloudLayer(bytes), /options\.fileName/],
      [
        "a file name that is not a point cloud",
        () => api.addPointCloudLayer(bytes, { fileName: "tile.tif" }),
        /not a point cloud file name/,
      ],
      [
        "a name that is not a string",
        () => api.addPointCloudLayer(bytes, { fileName: "a.las", name: 7 as unknown as string }),
        /options\.name must be a string/,
      ],
      [
        "a source of another type",
        () => api.addPointCloudLayer({} as unknown as string),
        /must be a URL, a File/,
      ],
    ];
    for (const [label, call, message] of cases) {
      await assert.rejects(call, message, label);
    }
  });

  it("rejects when the LiDAR control could not be opened", async () => {
    const { host } = fakeHost({ addLidarLayerFromUrl: async () => null });
    const api = createAppAPI(undefined, host);
    await assert.rejects(
      api.addPointCloudLayer("https://example.com/a.laz"),
      /could not be opened/,
    );
  });

  it("passes the LiDAR control's load errors through", async () => {
    const { host } = fakeHost({
      addLidarLayerFromUrl: async () => {
        throw new Error("Enter a valid HTTP or HTTPS LiDAR URL.");
      },
    });
    const api = createAppAPI(undefined, host);
    await assert.rejects(api.addPointCloudLayer("ftp://example.com/a.laz"), /valid HTTP/);
  });

  it("memoizes the shared maplibre-gl-lidar module", async () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const first = api.getMaplibreGlLidar();
    assert.equal(api.getMaplibreGlLidar(), first);
    // The module may not load under node (it expects a browser); only the
    // memoization is under test here.
    await first.catch(() => undefined);
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

  it("replaces a GeoJSON layer's features in place, keeping its place and settings", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const empty = { type: "FeatureCollection" as const, features: [] };
    const first = api.addGeoJsonLayer("First", empty, "service://records/first");
    const second = api.addGeoJsonLayer("Second", empty);
    useAppStore.getState().updateLayer(first, { opacity: 0.4, visible: false });
    const point = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [1, 2] },
      properties: { name: "kept" },
    };

    assert.equal(
      api.updateGeoJsonLayer(first, { type: "FeatureCollection", features: [point] }),
      true,
    );

    const { layers } = useAppStore.getState();
    const layer = layers.find((item) => item.id === first);
    assert.deepEqual(layer?.geojson?.features, [point]);
    assert.equal(layer?.name, "First");
    assert.equal(layer?.opacity, 0.4);
    assert.equal(layer?.visible, false);
    assert.equal(layer?.sourcePath, "service://records/first");
    assert.deepEqual(
      layers.map((item) => item.id),
      [first, second],
    );
  });

  it("refuses to replace the features of an unknown, non-GeoJSON or edited layer", () => {
    const empty = { type: "FeatureCollection" as const, features: [] };
    const point = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [1, 2] },
      properties: {},
    };
    const api = createAppAPI(undefined, fakeHost().host);
    const tiles = api.addTileLayer("Tiles", "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal(api.updateGeoJsonLayer("missing", empty), false);
    assert.equal(api.updateGeoJsonLayer(tiles, empty), false);

    const edited = api.addGeoJsonLayer("Edited", { type: "FeatureCollection", features: [point] });
    const editingApi = createAppAPI(
      undefined,
      fakeHost({ getGeometryEditTargetLayerId: () => edited }).host,
    );
    assert.equal(editingApi.updateGeoJsonLayer(edited, empty), false);
    const layer = useAppStore.getState().layers.find((item) => item.id === edited);
    assert.deepEqual(layer?.geojson?.features, [point], "the open session's data is left alone");
  });

  it("removes a layer and the selection on it, and ignores unknown ids", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const id = api.addGeoJsonLayer("Points", { type: "FeatureCollection", features: [] });
    assert.equal(useAppStore.getState().selectedLayerId, id);

    api.removeLayer(id);
    api.removeLayer("missing");

    assert.deepEqual(api.getLayers(), []);
    assert.notEqual(useAppStore.getState().selectedLayerId, id);
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

  it("adds a vector tile layer from a tile template or a TileJSON URL", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const below = api.addGeoJsonLayer("Below", { type: "FeatureCollection", features: [] });
    const bounds: [number, number, number, number] = [-10, -5, 10, 5];
    const template = api.addVectorTileLayer(
      "Records",
      "https://records.example.org/mvt/node/{z}/{x}/{y}.pbf",
      {
        sourceLayers: ["node"],
        bounds,
        minzoom: 0,
        maxzoom: 14,
        opacity: 0.5,
        beforeLayerId: below,
        metadata: {
          publisher: "Records",
          sourceLayers: ["ignored"],
          // Keys that would route the layer away from the vector tile path.
          sourceKind: "maplibre-gl-vector",
          customLayerType: "custom",
          externalNativeLayer: true,
          nativeLayerIds: ["someone-elses-layer"],
          sourceIds: ["someone-elses-source"],
          sourceId: "openmaptiles",
          externalDeckLayer: true,
          controlOwnsPaint: true,
          nativeFillExtrusion: true,
        },
      },
    );
    const tileJson = api.addVectorTileLayer("Roads", "  https://tiles.example.com/roads.json\n", {
      sourceLayers: ["roads", "labels", " roads "],
      // Not a layer: kept as a map anchor, and the layer goes on top.
      beforeLayerId: "basemap-labels",
    });
    bounds[0] = 99;
    const layers = useAppStore.getState().layers;
    const templateLayer = layers.find((item) => item.id === template);
    assert.equal(templateLayer?.type, "vector-tiles");
    assert.deepEqual(templateLayer?.source, {
      type: "vector",
      tiles: ["https://records.example.org/mvt/node/{z}/{x}/{y}.pbf"],
      sourceLayer: "node",
      sourceLayers: ["node"],
      bounds: [-10, -5, 10, 5],
      minzoom: 0,
      maxzoom: 14,
    });
    assert.equal(templateLayer?.opacity, 0.5);
    assert.equal(templateLayer?.metadata.publisher, "Records");
    assert.deepEqual(templateLayer?.metadata.sourceLayers, ["node"], "GeoLibre's keys win");
    assert.equal(templateLayer?.metadata.sourceKind, "plugin-vector-tiles");
    for (const key of [
      "customLayerType",
      "externalNativeLayer",
      "nativeLayerIds",
      "sourceIds",
      "sourceId",
      "externalDeckLayer",
      "controlOwnsPaint",
      "nativeFillExtrusion",
    ]) {
      assert.equal(key in (templateLayer?.metadata ?? {}), false, `${key} is dropped`);
    }
    assert.deepEqual(
      templateLayer?.metadata.bounds,
      [-10, -5, 10, 5],
      "a copy of the plugin's array",
    );
    assert.deepEqual(
      layers.map((item) => item.id),
      [template, below, tileJson],
    );
    const tileJsonLayer = layers.find((item) => item.id === tileJson);
    assert.equal(tileJsonLayer?.source.url, "https://tiles.example.com/roads.json");
    assert.equal("tiles" in (tileJsonLayer?.source ?? {}), false);
    assert.deepEqual(tileJsonLayer?.source.sourceLayers, ["roads", "labels"]);
  });

  it("rejects a vector tile layer it could not draw", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const url = "https://tiles.example.com/{z}/{x}/{y}.pbf";
    assert.throws(
      () =>
        api.addVectorTileLayer("Tiles", "file:///tiles/{z}/{x}/{y}.pbf", { sourceLayers: ["a"] }),
      /url must be/,
    );
    assert.throws(() => api.addVectorTileLayer("Tiles", url, { sourceLayers: [] }), /sourceLayers/);
    assert.throws(
      () => api.addVectorTileLayer("Tiles", url, { sourceLayers: ["a", ""] }),
      /sourceLayers/,
    );
    assert.throws(
      () => api.addVectorTileLayer("Tiles", url, { sourceLayers: ["a"], minzoom: 10, maxzoom: 4 }),
      /minzoom/,
    );
    assert.throws(
      () =>
        api.addVectorTileLayer("Tiles", url, {
          sourceLayers: ["a"],
          bounds: [0, 0, 1] as unknown as [number, number, number, number],
        }),
      /bounds/,
    );
    assert.throws(
      () =>
        api.addVectorTileLayer("Tiles", "https://tiles.example.com/{x}/{y}.pbf", {
          sourceLayers: ["a"],
        }),
      /needs all of/,
    );
    assert.throws(
      () => api.addVectorTileLayer("Tiles", url, { sourceLayers: ["a"], maxzoom: Number.NaN }),
      /maxzoom/,
    );
    for (const opacity of [Number.NaN, -0.5, 2]) {
      assert.throws(
        () => api.addVectorTileLayer("Tiles", url, { sourceLayers: ["a"], opacity }),
        /opacity/,
      );
    }
    assert.throws(
      () =>
        api.addVectorTileLayer(
          "Tiles",
          url,
          undefined as unknown as Parameters<typeof api.addVectorTileLayer>[2],
        ),
      /sourceLayers/,
    );
    for (const bounds of [
      [0, -100, 10, 100],
      [10, 0, 0, 10],
      [0, 10, 10, 0],
      [-200, 0, 10, 10],
    ] as [number, number, number, number][]) {
      assert.throws(
        () => api.addVectorTileLayer("Tiles", url, { sourceLayers: ["a"], bounds }),
        /bounds/,
      );
    }
    assert.throws(
      () =>
        api.addVectorTileLayer("Tiles", "https://tiles.example.com/tiles.json", {
          sourceLayers: ["a"],
          minzoom: 2,
        }),
      /TileJSON URL sets its own zoom range/,
    );
    assert.throws(
      () =>
        api.addVectorTileLayer("Tiles", 42 as unknown as string, {
          sourceLayers: ["a"],
        }),
      /url must be/,
    );
    for (const name of ["", "   ", 7 as unknown as string]) {
      assert.throws(
        () => api.addVectorTileLayer(name, url, { sourceLayers: ["a"] }),
        /name must be/,
      );
    }
    assert.deepEqual(api.getLayers(), []);
  });

  it("sends a tile layer's request headers for the session only", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const template = "https://records.example.org/mvt/node/{z}/{x}/{y}.pbf";
    const tile = "https://records.example.org/mvt/node/3/2/1.pbf";
    const vector = api.addVectorTileLayer("Records", template, {
      sourceLayers: ["node"],
      headers: { Authorization: "Bearer first" },
    });
    assert.deepEqual(tileRequestHeadersFor(tile), { Authorization: "Bearer first" });
    assert.equal(
      JSON.stringify(useAppStore.getState().layers).includes("Bearer"),
      false,
      "headers never reach the store or a saved project",
    );

    assert.equal(api.setLayerRequestHeaders(vector, { Authorization: "Bearer second" }), true);
    assert.deepEqual(tileRequestHeadersFor(tile), { Authorization: "Bearer second" });
    assert.equal(api.setLayerRequestHeaders(vector, null), true);
    assert.equal(tileRequestHeadersFor(tile), undefined);

    const raster = api.addTileLayer("Raster", "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal(api.setLayerRequestHeaders(raster, { "X-Api-Key": "k" }), true);
    assert.deepEqual(tileRequestHeadersFor("https://tiles.example.com/1/1/1.png"), {
      "X-Api-Key": "k",
    });
    api.removeLayer(raster);
    assert.equal(tileRequestHeadersFor("https://tiles.example.com/1/1/1.png"), undefined);

    const points = api.addGeoJsonLayer("Points", { type: "FeatureCollection", features: [] });
    assert.equal(api.setLayerRequestHeaders(points, { Authorization: "Bearer x" }), false);
    assert.equal(api.setLayerRequestHeaders("missing", { Authorization: "Bearer x" }), false);
    assert.throws(
      () => api.setLayerRequestHeaders(vector, { Authorization: "Bearer x\r\nX-Injected: 1" }),
      /header "Authorization"/,
    );

    api.setLayerRequestHeaders(vector, { Authorization: "Bearer third" });
    useAppStore.getState().newProject({ name: "Next" });
    assert.equal(tileRequestHeadersFor(tile), undefined, "another project starts without them");
  });

  it("drops a layer's headers however the layer is removed", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const tile = "https://records.example.org/mvt/node/3/2/1.pbf";
    const vector = api.addVectorTileLayer(
      "Records",
      "https://records.example.org/mvt/node/{z}/{x}/{y}.pbf",
      { sourceLayers: ["node"], headers: { Authorization: "Bearer token" } },
    );
    assert.ok(tileRequestHeadersFor(tile));

    // As the Layers panel does: straight through the store, not the plugin API.
    useAppStore.getState().removeLayer(vector);

    assert.equal(tileRequestHeadersFor(tile), undefined);
  });

  it("keeps a layer's headers through a token refresh, but not a move to another URL", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    const vector = api.addVectorTileLayer(
      "Records",
      "https://records.example.org/mvt/node/{z}/{x}/{y}.pbf?token=first",
      { sourceLayers: ["node"], headers: { Authorization: "Bearer token" } },
    );
    const update = (tiles: string) => {
      const layer = useAppStore.getState().layers.find((item) => item.id === vector);
      useAppStore.getState().updateLayer(vector, { source: { ...layer!.source, tiles: [tiles] } });
    };

    // Only the query string after the placeholders changes: same prefix.
    update("https://records.example.org/mvt/node/{z}/{x}/{y}.pbf?token=second");
    assert.ok(tileRequestHeadersFor("https://records.example.org/mvt/node/3/2/1.pbf"));

    update("https://elsewhere.example.com/mvt/node/{z}/{x}/{y}.pbf");
    assert.equal(
      tileRequestHeadersFor("https://records.example.org/mvt/node/3/2/1.pbf"),
      undefined,
    );
    assert.equal(
      tileRequestHeadersFor("https://elsewhere.example.com/mvt/node/3/2/1.pbf"),
      undefined,
    );
  });

  it("refuses headers that could reach other servers or repeat a name", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    // A placeholder in the host leaves only "https://" to match on.
    assert.throws(
      () =>
        api.addVectorTileLayer("Shards", "https://{z}.tiles.example.com/{x}/{y}.pbf", {
          sourceLayers: ["a"],
          headers: { Authorization: "Bearer token" },
        }),
      /fixed host and path/,
    );
    assert.deepEqual(api.getLayers(), [], "no layer is added");
    const sharded = api.addTileLayer("Shards", "https://{z}.tiles.example.com/{x}/{y}.png");
    assert.throws(
      () => api.setLayerRequestHeaders(sharded, { Authorization: "Bearer token" }),
      /fixed host and path/,
    );
    assert.equal(tileRequestHeadersFor("https://basemap.example.com/1/1/1.png"), undefined);
    assert.equal(api.setLayerRequestHeaders(sharded, null), true, "clearing still works");

    const vector = api.addVectorTileLayer("Records", "https://tiles.example.com/{z}/{x}/{y}.pbf", {
      sourceLayers: ["a"],
    });
    assert.throws(
      () =>
        api.setLayerRequestHeaders(vector, {
          Authorization: "Bearer a",
          authorization: "Bearer b",
        }),
      /given more than once/,
    );
    for (const browserOwned of ["Cookie", "host", "Sec-Fetch-Mode", "Proxy-Authorization"]) {
      assert.throws(
        () => api.setLayerRequestHeaders(vector, { [browserOwned]: "x" }),
        /the browser sets header/,
        browserOwned,
      );
    }
    assert.throws(
      () => api.setLayerRequestHeaders(vector, { Authorization: "Bearer ✓" }),
      /above U\+00FF/,
    );
    assert.equal(
      api.setLayerRequestHeaders(vector, { "X-Api-Key": "café" }),
      true,
      "Latin-1 is fine",
    );
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

  it("clears a native layer's paint bridge when removeLayer removes it", () => {
    const api = createAppAPI(undefined, fakeHost().host);
    api.registerExternalNativeLayer({
      id: "ext-painted",
      name: "Painted",
      nativeLayerIds: ["ext-painted-custom"],
      paintBridge: { setOpacity: () => undefined },
    });
    assert.ok(getExternalNativePaintBridge("ext-painted"));

    api.removeLayer("ext-painted");

    assert.equal(getExternalNativePaintBridge("ext-painted"), undefined);
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
