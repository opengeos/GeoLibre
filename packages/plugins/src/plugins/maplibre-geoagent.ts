/// <reference path="../earthengine.d.ts" />

import type {
  GeoAgentControl,
  GeoAgentControlOptions,
} from "maplibre-gl-geoagent";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  authenticateWithOAuth,
  renderEeLayer,
  type VisualizeOptions,
} from "maplibre-gl-earth-engine";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";
import {
  authenticateEarthEngine as authenticateEarthEngineForGeoLibre,
  captureEarthEngineFunctionInfo,
  clearEarthEngineFunctionInfo,
  closeTauriOauthPopups,
  errorMessage,
  importMetaEnv,
  installEarthEngineFunctionInfoFallback,
  oauthClientIdValue,
  preloadEarthEngineAuthLibrary,
  projectValue as earthEngineProjectValue,
  shouldUseTauriEarthEngineOAuth,
} from "./earth-engine-auth";

const STORAGE_PREFIX = "geolibre.geoagent";

type GeoAgentControlInternals = {
  options?: GeoAgentControlOptions;
  tools?: {
    __geolibreEarthEngineFallbackPatched?: boolean;
    addGeeRasterOverlay?: (overlay: {
      name: string;
      url: string;
    }) => Promise<void>;
    map?: MapLibreMap;
    overlays?: Map<string, unknown>;
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
let geoAgentControlPromise: Promise<GeoAgentControl> | null = null;
let geoAgentActive = false;
let earthEngineAccessTokenOverride = "";
let earthEngineTokenTypeOverride = "Bearer";
let earthEngineTokenExpiresInOverride = 3600;
let geoAgentEarthEngineFunctionInfo: unknown;

export const maplibreGeoAgentPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geoagent",
  name: "GeoAgent",
  version: "0.4.2",
  activate: (app: GeoLibreAppAPI) => {
    geoAgentActive = true;
    void mountGeoAgentControl(app);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    geoAgentActive = false;
    if (!geoAgentControl) return;
    app.removeMapControl(geoAgentControl);
    geoAgentControl = null;
  },
  getMapControlPosition: () => geoAgentPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    geoAgentPosition = position;
    if (!geoAgentControl) {
      if (geoAgentActive) void mountGeoAgentControl(app);
      return;
    }
    app.removeMapControl(geoAgentControl);
    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) return false;
    patchGeoAgentEarthEngineToolRunner(geoAgentControl);
    setTimeout(() => geoAgentControl?.expand(), 0);
    setTimeout(enhanceEarthEngineSignIn, 0);
  },
};

async function mountGeoAgentControl(app: GeoLibreAppAPI): Promise<void> {
  const control = await loadGeoAgentControl();
  if (!geoAgentActive) return;

  const added = app.addMapControl(control, geoAgentPosition);
  if (!added) {
    if (geoAgentControl === control) geoAgentControl = null;
    return;
  }
  patchGeoAgentEarthEngineToolRunner(control);
  setTimeout(() => geoAgentControl?.expand(), 0);
  setTimeout(enhanceEarthEngineSignIn, 0);
  preloadEarthEngineAuthLibrary();
}

async function loadGeoAgentControl(): Promise<GeoAgentControl> {
  if (geoAgentControl) return geoAgentControl;
  installEarthEngineFunctionInfoFallback();
  geoAgentControlPromise ??= import("maplibre-gl-geoagent")
    .then(({ GeoAgentControl }) => {
      geoAgentControl ??= new GeoAgentControl(getGeoAgentOptions());
      return geoAgentControl;
    })
    .finally(() => {
      geoAgentControlPromise = null;
    });
  return geoAgentControlPromise;
}

function getGeoAgentOptions(): GeoAgentControlOptions {
  return {
    ...GEOAGENT_OPTIONS,
    position: geoAgentPosition,
  };
}

function patchGeoAgentEarthEngineToolRunner(control: GeoAgentControl): void {
  const tools = (control as unknown as GeoAgentControlInternals).tools;
  if (
    !tools?.runCommand ||
    tools.__geolibreEarthEngineFallbackPatched === true
  ) {
    return;
  }

  const runCommand = tools.runCommand.bind(tools);
  tools.runCommand = async (command, args) => {
    if (isEarthEngineToolCommand(command)) {
      if (command === "load_gee_dataset") {
        return loadGeoAgentDatasetWithGeoLibreEarthEngine(tools, args);
      }

      installEarthEngineFunctionInfoFallback(geoAgentEarthEngineFunctionInfo);
      try {
        return await runCommand(command, args);
      } finally {
        geoAgentEarthEngineFunctionInfo = captureEarthEngineFunctionInfo();
      }
    }
    return runCommand(command, args);
  };
  tools.__geolibreEarthEngineFallbackPatched = true;
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
    tokenExpiresIn:
      earthEngine.tokenExpiresIn ?? earthEngineTokenExpiresInOverride,
    tokenType: earthEngine.tokenType || earthEngineTokenTypeOverride,
  });

  await tools.waitForMapIdle?.();
  tools.removeOverlay?.(layerName);
  clearEarthEngineFunctionInfo();
  const layerBaseId = geoAgentSlug(layerName);
  const sourceId =
    tools.uniqueSourceId?.(`${layerBaseId}-source`) ?? `${layerBaseId}-source`;
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
    command === "initialize_earth_engine" ||
    command.startsWith("gee_") ||
    command.includes("_gee_")
  );
}

function geoAgentEarthEngineOptions(): NonNullable<
  GeoAgentControlOptions["earthEngine"]
> {
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
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function geoAgentVisualizeOptions(
  args: Record<string, unknown>,
): VisualizeOptions {
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
  const status = details?.querySelector<HTMLElement>(
    ".geoagent-earth-engine-status",
  );
  const clientIdInput = details?.querySelector<HTMLInputElement>(
    ".geoagent-ee-client-id",
  );
  const projectIdInput = details?.querySelector<HTMLInputElement>(
    ".geoagent-ee-project-id",
  );
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
      await applyEarthEngineAccessToken(
        oauthClientId,
        projectValue(projectIdInput.value),
      );
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
  return (earthEngine.data?.getAuthToken?.() ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

async function authenticateEarthEngine(oauthClientId: string): Promise<void> {
  const token = await authenticateEarthEngineForGeoLibre(oauthClientId);
  if (token?.accessToken) {
    earthEngineAccessTokenOverride = token.accessToken
      .replace(/^Bearer\s+/i, "")
      .trim();
    earthEngineTokenTypeOverride = token.tokenType || "Bearer";
    earthEngineTokenExpiresInOverride = token.expiresIn || 3600;
  }
}
