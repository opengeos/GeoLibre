/// <reference path="../earthengine.d.ts" />

import type { GeoAgentControl, GeoAgentControlOptions } from "maplibre-gl-geoagent";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  authenticateWithOAuth,
  renderEeLayer,
  type VisualizeOptions,
} from "maplibre-gl-earth-engine";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
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

let geoAgentPosition: GeoLibreMapControlPosition = "top-left";

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
} satisfies Omit<GeoAgentControlOptions, "position">;

let geoAgentControl: GeoAgentControl | null = null;
/** The dynamic import, shared across activations: the module is engine-neutral. */
let geoAgentModulePromise: Promise<typeof import("maplibre-gl-geoagent")> | null = null;
/** A mount in flight, so a second one is not started on top of it. */
let geoAgentControlPromise: Promise<GeoAgentControl | null> | null = null;
let geoAgentActive = false;
// Bumped on every (re)mount so a slow async mount from an earlier
// activate/deactivate cycle cannot resume and mount over a newer one. Only the
// continuation whose generation still matches the latest is allowed to apply.
let geoAgentActivationGeneration = 0;
let earthEngineAccessTokenOverride = "";
let earthEngineTokenTypeOverride = "Bearer";
let earthEngineTokenExpiresInOverride = 3600;
let geoAgentEarthEngineFunctionInfo: unknown;

export { GEOAGENT_PLUGIN_ID };

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
    geoAgentActive = true;
    // Return the mount promise so the host can roll back the Plugins menu when
    // the GeoAgent chunk fails to load (e.g. a stale chunk after a web
    // redeploy). It resolves false when the control never mounts, instead of
    // leaving GeoAgent marked active with no visible panel.
    return mountGeoAgentControl(app, ++geoAgentActivationGeneration);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    geoAgentActive = false;
    unwireGeoAgentStoreSync();
    if (geoAgentControl) {
      app.removeMapControl(geoAgentControl);
      geoAgentControl = null;
    }
    // The control's teardown already cleared its overlays from the map; drop
    // the matching store entries so the layer panel does not list dead layers.
    removeGeoAgentStoreLayers();
  },
  getMapControlPosition: () => geoAgentPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
    geoAgentPosition = position;
    if (!geoAgentControl) {
      // Only kick off a mount if one is not already in flight. A mount started
      // by activate() reads the updated geoAgentPosition when it adds the
      // control, so starting a second (generation-bumping) mount here would
      // needlessly invalidate that in-flight attempt and make its host-side
      // rollback tear the freshly added control back down.
      if (geoAgentActive && !geoAgentControlPromise) {
        void mountGeoAgentControl(app, ++geoAgentActivationGeneration);
      }
      return;
    }
    app.removeMapControl(geoAgentControl);
    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) {
      // removeMapControl already tore the tools (and their overlays) down;
      // drop the now-stale sync wiring and store layers with them.
      unwireGeoAgentStoreSync();
      removeGeoAgentStoreLayers();
      return false;
    }
    patchGeoAgentToolRunner(geoAgentControl);
    setTimeout(() => geoAgentControl?.expand(), 0);
    setTimeout(enhanceEarthEngineSignIn, 0);
  },
};

async function mountGeoAgentControl(
  app: GeoLibreAppAPI,
  activationGeneration: number,
): Promise<boolean> {
  let control: GeoAgentControl | null;
  try {
    control = await loadGeoAgentControl(app, activationGeneration);
  } catch (error) {
    // The dynamic import failed (offline, or a chunk orphaned by a web
    // redeploy). Clear the active flag and report the failure so the host can
    // revert the Plugins menu rather than leaving GeoAgent stuck on "active"
    // with no panel. The stale-chunk recovery (host side) decides whether to
    // reload; here we only need to surface that the mount did not happen. Only
    // clear the flag for the latest attempt so a stale failure does not
    // deactivate a newer activation that is already in flight.
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
  // cannot mount a stale control on top of the current one. `control` is null
  // when the same check already refused to build one.
  if (!control || !geoAgentActive || activationGeneration !== geoAgentActivationGeneration) {
    return false;
  }

  const added = app.addMapControl(control, geoAgentPosition);
  if (!added) {
    if (geoAgentControl === control) geoAgentControl = null;
    return false;
  }
  patchGeoAgentToolRunner(control);
  setTimeout(() => geoAgentControl?.expand(), 0);
  setTimeout(enhanceEarthEngineSignIn, 0);
  preloadEarthEngineAuthLibrary();
  return true;
}

/**
 * Resolve the shared control, importing the GeoAgent chunk on first use.
 *
 * @param app - The plugin host this activation is mounting into; its renderer
 *   is what `mapEngine` is built from, and the control cannot be re-pointed at
 *   another engine afterwards.
 * @param activationGeneration - The activation asking. Only the latest may
 *   build the control.
 * @returns The control, or `null` when a later activation superseded this one
 *   while the chunk was still loading.
 */
async function loadGeoAgentControl(
  app: GeoLibreAppAPI,
  activationGeneration: number,
): Promise<GeoAgentControl | null> {
  if (geoAgentControl) return geoAgentControl;
  installEarthEngineFunctionInfoFallback();
  // Cache the *module*, not the control. A single memoized promise that also
  // constructed the control would build it from whichever activation started
  // the import — GeoAgent's chunk is large, so a renderer swap can easily land
  // inside that window — and every later activation would reuse that instance.
  // The module is engine-neutral and safe to share; the control is not.
  geoAgentModulePromise ??= import("maplibre-gl-geoagent").catch((error: unknown) => {
    // A rejected promise is cached like any other, so without this an import
    // that failed once (offline, or a chunk orphaned by a redeploy) would keep
    // rejecting every later activation until the page reloads. Forget it and
    // the next activation retries — which is what the caller's catch, and the
    // host-side rollback it drives, assume happens.
    geoAgentModulePromise = null;
    throw error;
  });
  geoAgentControlPromise = geoAgentModulePromise
    .then(({ GeoAgentControl }) => {
      // Caching the module is not on its own enough: continuations run in the
      // order they were registered, so an activation superseded mid-import
      // still runs first and would win the race to fill `geoAgentControl` with
      // its (now stale) engine baked in — leaving the current activation's
      // `??=` to hand back that wrong-engine instance and mount it. Refuse
      // here, and the generation that is actually current builds it. A plain
      // deactivate mid-import is refused for the same reason: it does not bump
      // the generation, and the control it would leave behind is one nothing
      // tears down.
      if (!geoAgentActive || activationGeneration !== geoAgentActivationGeneration) return null;
      geoAgentControl ??= new GeoAgentControl(getGeoAgentOptions(app));
      return geoAgentControl;
    })
    .finally(() => {
      geoAgentControlPromise = null;
    });
  return geoAgentControlPromise;
}

function getGeoAgentOptions(app: GeoLibreAppAPI | null): GeoAgentControlOptions {
  return {
    ...GEOAGENT_OPTIONS,
    position: geoAgentPosition,
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

function enhanceEarthEngineSignIn(): void {
  const details = document.querySelector<HTMLElement>(".geoagent-earth-engine");
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
    return;
  }
  if (
    !details ||
    !status ||
    !clientIdInput ||
    !projectIdInput ||
    details.querySelector(".geolibre-ee-sign-in")
  ) {
    return;
  }

  const button = document.createElement("button");
  button.className = "geolibre-ee-sign-in secondary";
  button.type = "button";
  button.textContent = "Sign in";
  button.addEventListener("click", async () => {
    const oauthClientId = oauthClientIdValue(clientIdInput.value);
    clientIdInput.value = oauthClientId;
    button.disabled = true;
    status.textContent = "Opening Google sign-in...";
    try {
      await authenticateEarthEngine(oauthClientId);
      await applyEarthEngineAccessToken(oauthClientId, projectValue(projectIdInput.value));
      void closeTauriOauthPopups();
      status.textContent = "Earth Engine sign-in complete.";
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });

  status.insertAdjacentElement("beforebegin", button);
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
