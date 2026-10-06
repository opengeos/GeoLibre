/// <reference path="../earthengine.d.ts" />

import type { GeoAgentControl, GeoAgentControlOptions } from "maplibre-gl-geoagent";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { VisualizeOptions } from "maplibre-gl-earth-engine";
import { createPluginTranslator, pluginDisplayTitle, type PluginTranslate } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { mountMapControlInPanel, unmountMapControlFromPanel } from "./dockable-map-control";
import {
  removeGeoAgentStoreLayers,
  syncGeoAgentOverlaysToStore,
  unwireGeoAgentStoreSync,
  wireGeoAgentStoreSync,
  type GeoAgentOverlayRecord,
} from "./geoagent-layer-sync";
import {
  authenticateEarthEngine as authenticateEarthEngineForGeoLibre,
  captureEarthEngineFunctionInfo,
  clearEarthEngineFunctionInfo,
  closeTauriOauthPopups,
  errorMessage,
  importMetaEnv,
  installEarthEngineFunctionInfoFallback,
  isEarthEngineAvailable,
  oauthClientIdValue,
  preloadEarthEngineAuthLibrary,
  projectValue as earthEngineProjectValue,
  shouldUseTauriEarthEngineOAuth,
} from "./earth-engine-auth";
import { geoAgentMapEngine } from "./geoagent-map-engine";
import { GEOAGENT_PLUGIN_ID } from "../plugin-ids";
import { getControlMap } from "./style-map";

const STORAGE_PREFIX = "geolibre.geoagent";

type GeoAgentControlInternals = {
  options?: GeoAgentControlOptions;
  tools?: {
    __geolibreToolRunnerPatched?: boolean;
    addGeeRasterOverlay?: (overlay: { name: string; url: string }) => Promise<void>;
    map?: MapLibreMap;
    overlays?: Map<string, GeoAgentOverlayRecord>;
    publishEarthEngineState?: () => void;
    removeOverlay?: (name: string) => boolean;
    requireEarthEngine?: () => {
      registerLayer?: (layer: Record<string, unknown>) => void;
    };
    runCommand?: (command: string, args?: unknown) => Promise<unknown>;
    uniqueLayerBaseId?: (baseId: string, suffixes: string[]) => string;
    uniqueSourceId?: (baseId: string) => string;
    waitForMapIdle?: () => Promise<void>;
    updateEarthEngineOptions?: (
      options: NonNullable<GeoAgentControlOptions["earthEngine"]>,
    ) => void;
  };
  invalidateAgent?: () => void;
};

type GeoAgentModule = typeof import("maplibre-gl-geoagent");

const PANEL_ID = "geoagent-panel";

const GEOAGENT_OPTIONS = {
  title: "GeoAgent + Earth Engine",
  collapsed: false,
  storagePrefix: STORAGE_PREFIX,
  allowCodeExecutionDefault: true,
  allowDestructiveToolsDefault: true,
  showPermissionToggles: false,
  earthEngine: {
    oauthClientId: oauthClientIdValue(importMetaEnv().VITE_GEE_OAUTH_CLIENT_ID),
    projectId: projectValue(importMetaEnv().VITE_GEE_PROJECT_ID),
    includeCommunityCatalog: true,
  },
} satisfies GeoAgentControlOptions;

let geoAgentControl: GeoAgentControl | null = null;
/** The dynamic import, shared across activations: the module is engine-neutral. */
let geoAgentModulePromise: Promise<GeoAgentModule> | null = null;
let unregisterPanel: (() => void) | null = null;
let geoAgentActive = false;
// Bumped on every activation so a slow chunk load from an earlier
// activate/deactivate cycle cannot resume and open a panel over a newer one.
// Only the continuation whose generation still matches the latest may apply.
let geoAgentActivationGeneration = 0;
let earthEngineAccessTokenOverride = "";
let earthEngineTokenTypeOverride = "Bearer";
let earthEngineTokenExpiresInOverride = 3600;
let geoAgentEarthEngineFunctionInfo: unknown;

export { GEOAGENT_PLUGIN_ID };

/**
 * GeoAgent, hosted in GeoLibre's dockable side panel. The upstream
 * `GeoAgentControl` still drives the agent and its map tools, but its floating
 * shell and toolbar button are replaced by the host-owned dock (see
 * {@link mountMapControlInPanel}).
 */
export const maplibreGeoAgentPlugin: GeoLibrePlugin = {
  id: GEOAGENT_PLUGIN_ID,
  name: "GeoAgent",
  version: "0.5.0",
  // Both 2D engines: the tools that cannot stay on the shared Style Spec
  // surface follow `mapEngine` (see geoAgentMapEngine). A renderer swap tears
  // every active plugin down and re-activates it, so the rebuilt control is
  // told the engine that is now primary.
  engines: ["maplibre", "mapbox"],
  activate: (app: GeoLibreAppAPI) => {
    if (!getControlMap(app) || !app.registerRightPanel || !app.openRightPanel) return false;
    geoAgentActive = true;
    // Return the load promise so the host can roll back the Plugins menu when
    // the GeoAgent chunk fails to load (e.g. a stale chunk after a web
    // redeploy). It resolves false when the panel never opens, instead of
    // leaving GeoAgent marked active with no visible panel.
    return openGeoAgentPanel(app, ++geoAgentActivationGeneration);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    geoAgentActive = false;
    if (geoAgentControl) unmountMapControlFromPanel(geoAgentControl);
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    releaseGeoAgentControl();
  },
};

async function openGeoAgentPanel(
  app: GeoLibreAppAPI,
  activationGeneration: number,
): Promise<boolean> {
  let module: GeoAgentModule;
  try {
    module = await loadGeoAgentModule();
  } catch (error) {
    // The dynamic import failed (offline, or a chunk orphaned by a web
    // redeploy). Clear the active flag and report the failure so the host can
    // revert the Plugins menu rather than leaving GeoAgent stuck on "active"
    // with no panel. Only clear the flag for the latest attempt so a stale
    // failure does not deactivate a newer activation that is already in flight.
    if (activationGeneration === geoAgentActivationGeneration) {
      geoAgentActive = false;
    }
    // warn (not error): the stale-chunk path already records an actionable
    // diagnostic when the project is dirty, and rollbackFailedActivation cleans
    // up the active state, so this should not read as a fatal error.
    console.warn("GeoAgent failed to load.", error);
    return false;
  }
  // Ignore a continuation superseded by a later activate/deactivate cycle so it
  // cannot open a stale panel on top of the current one.
  if (!geoAgentActive || activationGeneration !== geoAgentActivationGeneration) {
    return false;
  }
  if (!app.registerRightPanel || !app.openRightPanel) return false;

  unregisterPanel?.();
  unregisterPanel = app.registerRightPanel({
    id: PANEL_ID,
    title: pluginDisplayTitle(app, GEOAGENT_PLUGIN_ID, "GeoAgent"),
    dock: "replace-style",
    defaultWidth: 400,
    deactivatePluginOnClose: true,
    render: (container) => {
      // Built per render rather than cached: the control bakes in the engine
      // drawing the map when it is constructed and cannot be re-pointed, and a
      // renderer swap re-activates the plugin and so re-renders the panel.
      const control = new module.GeoAgentControl(getGeoAgentOptions(app));
      // The map's own removal unmounts the control without closing the panel,
      // and a swap to an engine that never mounts (Mapbox with no token) does
      // not re-activate the plugin either; release the store sync and layer
      // rows then too.
      const release = () => {
        if (geoAgentControl === control) releaseGeoAgentControl();
      };
      const unmount = mountMapControlInPanel(
        app,
        control,
        container,
        () => app.closeRightPanel?.(PANEL_ID),
        release,
      );
      if (!unmount) return;
      // The dock owns collapsing and closing; the control's own close button
      // would otherwise hide the panel content inside an open dock.
      control.collapse = () => {};
      geoAgentControl = control;
      patchGeoAgentToolRunner(control);
      control.expand();
      const stopSignInRelabel = enhanceEarthEngineSignIn(container, app);
      preloadEarthEngineAuthLibrary();
      return () => {
        stopSignInRelabel();
        // Unmounting runs the control's onRemove, which clears its overlays
        // from the map; drop the matching store entries with them.
        unmount();
        release();
      };
    },
  });
  if (!app.openRightPanel(PANEL_ID)) {
    unregisterPanel();
    unregisterPanel = null;
    geoAgentActive = false;
    return false;
  }
  return true;
}

/** Drop the mounted control along with its store sync and Layers-panel rows. */
function releaseGeoAgentControl(): void {
  unwireGeoAgentStoreSync();
  geoAgentControl = null;
  removeGeoAgentStoreLayers();
}

/**
 * Import the GeoAgent chunk, sharing one import across activations.
 *
 * @returns The `maplibre-gl-geoagent` module.
 */
function loadGeoAgentModule(): Promise<GeoAgentModule> {
  installEarthEngineFunctionInfoFallback();
  geoAgentModulePromise ??= import("maplibre-gl-geoagent").catch((error: unknown) => {
    // A rejected promise is cached like any other, so without this an import
    // that failed once (offline, or a chunk orphaned by a redeploy) would keep
    // rejecting every later activation until the page reloads. Forget it and
    // the next activation retries — which is what the caller's catch, and the
    // host-side rollback it drives, assume happens.
    geoAgentModulePromise = null;
    throw error;
  });
  return geoAgentModulePromise;
}

function getGeoAgentOptions(app: GeoLibreAppAPI | null): GeoAgentControlOptions {
  return {
    ...GEOAGENT_OPTIONS,
    mapEngine: geoAgentMapEngine(app),
  };
}

function patchGeoAgentToolRunner(control: GeoAgentControl): void {
  const tools = (control as unknown as GeoAgentControlInternals).tools;
  if (!tools?.runCommand || tools.__geolibreToolRunnerPatched === true) {
    return;
  }

  const runCommand = tools.runCommand.bind(tools);
  tools.runCommand = async (command, args) => {
    try {
      if (isEarthEngineToolCommand(command)) {
        if (command === "load_gee_dataset") {
          return await loadGeoAgentDatasetWithGeoLibreEarthEngine(tools, args);
        }

        installEarthEngineFunctionInfoFallback(geoAgentEarthEngineFunctionInfo);
        try {
          return await runCommand(command, args);
        } finally {
          geoAgentEarthEngineFunctionInfo = captureEarthEngineFunctionInfo();
        }
      }
      return await runCommand(command, args);
    } finally {
      // Any command may add or remove overlays (including scripts run through
      // run_maplibre_script); mirror the registry into the store so the layer
      // panel stays in sync.
      syncGeoAgentOverlaysToStore(tools.overlays);
    }
  };
  tools.__geolibreToolRunnerPatched = true;

  wireGeoAgentStoreSync(tools);
  // The control recreates tools (with an empty overlay registry) on every
  // onAdd, so prune store entries left over from a previous tools instance.
  syncGeoAgentOverlaysToStore(tools.overlays);
}

async function loadGeoAgentDatasetWithGeoLibreEarthEngine(
  tools: NonNullable<GeoAgentControlInternals["tools"]>,
  args: unknown,
): Promise<Record<string, unknown>> {
  if (!tools.map) throw new Error("GeoAgent map is unavailable.");

  const input = recordArg(args);
  const assetId = stringArg(input, "asset_id");
  if (!assetId) throw new Error("load_gee_dataset requires asset_id.");

  const layerName = stringArg(input, "layer_name") || assetId;
  const vis = geoAgentVisualizeOptions(input);
  const earthEngine = geoAgentEarthEngineOptions();
  const oauthClientId = oauthClientIdValue(earthEngine.oauthClientId);
  const projectId = projectValue(earthEngine.projectId);
  let accessToken = earthEngine.accessToken || earthEngineAccessTokenOverride;

  if (shouldUseTauriEarthEngineOAuth() && !accessToken) {
    await authenticateEarthEngine(oauthClientId);
    accessToken = earthEngineAccessTokenOverride;
  }

  // Loaded on first use: the package is about 1.7 MB and not needed at startup.
  const { authenticateWithOAuth, renderEeLayer } = await import("maplibre-gl-earth-engine");
  clearEarthEngineFunctionInfo();
  await authenticateWithOAuth({
    accessToken: accessToken || undefined,
    oauthClientId,
    projectId,
    tokenExpiresIn: earthEngine.tokenExpiresIn ?? earthEngineTokenExpiresInOverride,
    tokenType: earthEngine.tokenType || earthEngineTokenTypeOverride,
  });

  await tools.waitForMapIdle?.();
  tools.removeOverlay?.(layerName);
  clearEarthEngineFunctionInfo();
  const layerBaseId = geoAgentSlug(layerName);
  const sourceId = tools.uniqueSourceId?.(`${layerBaseId}-source`) ?? `${layerBaseId}-source`;
  const layerId = tools.uniqueLayerBaseId?.(layerBaseId, [""]) ?? layerBaseId;
  const result = await renderEeLayer(tools.map, assetId, vis, sourceId, layerId);

  tools.overlays?.set(layerName, {
    attribution: "Google Earth Engine",
    geeLayerName: layerName,
    kind: "gee",
    layerIds: [result.layerId],
    name: layerName,
    sourceIds: [result.sourceId],
    url: result.tileUrl,
  });
  tools.requireEarthEngine?.().registerLayer?.({
    asset_id: assetId,
    asset_type: stringArg(input, "asset_type") || "Image",
    eeObject: result.eeObject,
    layer_name: layerName,
    name: layerName,
    object_type: stringArg(input, "asset_type") || "Image",
    source: "earth_engine",
    tile_url: result.tileUrl,
    vis_params: vis,
  });
  tools.publishEarthEngineState?.();

  return {
    success: true,
    asset_id: assetId,
    asset_type: stringArg(input, "asset_type") || "Image",
    layer_name: layerName,
    source: "maplibre-gl-earth-engine",
    tile_url: result.tileUrl,
    vis_params: vis,
  };
}

function isEarthEngineToolCommand(command: string): boolean {
  return (
    command === "initialize_earth_engine" || command.startsWith("gee_") || command.includes("_gee_")
  );
}

function geoAgentEarthEngineOptions(): NonNullable<GeoAgentControlOptions["earthEngine"]> {
  const control = geoAgentControl as unknown as GeoAgentControlInternals | null;
  return {
    ...GEOAGENT_OPTIONS.earthEngine,
    ...(control?.options?.earthEngine ?? {}),
  };
}

function recordArg(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  const numberValue =
    typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function geoAgentVisualizeOptions(args: Record<string, unknown>): VisualizeOptions {
  const vis: VisualizeOptions = {};
  const bands = stringArg(args, "bands") || stringArg(args, "band");
  const palette = stringArg(args, "palette");
  const min = numberArg(args, "min_value") ?? numberArg(args, "min");
  const max = numberArg(args, "max_value") ?? numberArg(args, "max");
  const opacity = numberArg(args, "opacity");

  if (bands) vis.bands = bands;
  if (palette) vis.palette = palette;
  if (min !== undefined) vis.min = min;
  if (max !== undefined) vis.max = max;
  if (opacity !== undefined) vis.opacity = Math.max(0, Math.min(1, opacity));
  return vis;
}

function geoAgentSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "layer"
  );
}

function projectValue(envValue: unknown): string {
  return earthEngineProjectValue(envValue, STORAGE_PREFIX);
}

/**
 * Add the Earth Engine Sign in button to GeoAgent's settings, labelled in the
 * active language and re-labelled when the language changes.
 *
 * @param root - The panel container.
 * @param app - The host API, for translation and locale changes.
 * @returns A function that stops following the language.
 */
function enhanceEarthEngineSignIn(root: ParentNode, app: GeoLibreAppAPI): () => void {
  const tr: PluginTranslate = createPluginTranslator(app, GEOAGENT_PLUGIN_ID);
  const details = root.querySelector<HTMLElement>(".geoagent-earth-engine");
  const status = details?.querySelector<HTMLElement>(".geoagent-earth-engine-status");
  const clientIdInput = details?.querySelector<HTMLInputElement>(".geoagent-ee-client-id");
  const projectIdInput = details?.querySelector<HTMLInputElement>(".geoagent-ee-project-id");
  // The Apple App Store builds ship without the loopback OAuth listener that
  // Earth Engine sign-in needs, so hide the whole section rather than render a
  // Sign in button that can only throw. Everything inside it is Earth
  // Engine-specific (status line, OAuth client id, project id), and this is the
  // GeoAgent counterpart of the ProcessingMenu/TopToolbar gates.
  if (details && !isEarthEngineAvailable()) {
    details.hidden = true;
    return () => {};
  }
  if (
    !details ||
    !status ||
    !clientIdInput ||
    !projectIdInput ||
    details.querySelector(".geolibre-ee-sign-in")
  ) {
    return () => {};
  }

  const button = document.createElement("button");
  button.className = "geolibre-ee-sign-in secondary";
  button.type = "button";
  button.textContent = tr("signIn", "Sign in");
  button.addEventListener("click", async () => {
    const oauthClientId = oauthClientIdValue(clientIdInput.value);
    clientIdInput.value = oauthClientId;
    button.disabled = true;
    status.textContent = tr("signInOpening", "Opening Google sign-in...");
    try {
      await authenticateEarthEngine(oauthClientId);
      await applyEarthEngineAccessToken(oauthClientId, projectValue(projectIdInput.value));
      void closeTauriOauthPopups();
      status.textContent = tr("signInComplete", "Earth Engine sign-in complete.");
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });

  status.insertAdjacentElement("beforebegin", button);
  // The button is plain DOM built once per panel render, so a live language
  // change would otherwise leave it in the previous language.
  return (
    app.onLocaleChange?.(() => {
      button.textContent = tr("signIn", "Sign in");
    }) ?? (() => {})
  );
}

async function applyEarthEngineAccessToken(
  oauthClientId: string,
  projectId: string,
): Promise<void> {
  const accessToken = await earthEngineAccessToken();
  if (!accessToken || !geoAgentControl) return;

  const control = geoAgentControl as unknown as GeoAgentControlInternals;
  const earthEngineOptions = {
    ...GEOAGENT_OPTIONS.earthEngine,
    ...(control.options?.earthEngine ?? {}),
    oauthClientId,
    projectId,
    accessToken,
    tokenType: earthEngineTokenTypeOverride,
    tokenExpiresIn: earthEngineTokenExpiresInOverride,
  };

  if (control.options) {
    control.options.earthEngine = earthEngineOptions;
  }
  control.tools?.updateEarthEngineOptions?.(earthEngineOptions);
  control.invalidateAgent?.();
}

async function earthEngineAccessToken(): Promise<string> {
  if (earthEngineAccessTokenOverride) return earthEngineAccessTokenOverride;
  if (shouldUseTauriEarthEngineOAuth()) return "";
  installEarthEngineFunctionInfoFallback();
  const { default: earthEngine } = await import("@google/earthengine");
  return (earthEngine.data?.getAuthToken?.() ?? "").replace(/^Bearer\s+/i, "").trim();
}

async function authenticateEarthEngine(oauthClientId: string): Promise<void> {
  const token = await authenticateEarthEngineForGeoLibre(oauthClientId);
  if (token?.accessToken) {
    earthEngineAccessTokenOverride = token.accessToken.replace(/^Bearer\s+/i, "").trim();
    earthEngineTokenTypeOverride = token.tokenType || "Bearer";
    earthEngineTokenExpiresInOverride = token.expiresIn || 3600;
  }
}
