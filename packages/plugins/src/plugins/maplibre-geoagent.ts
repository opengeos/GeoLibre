/// <reference path="../earthengine.d.ts" />

import type {
  GeoAgentControl,
  GeoAgentControlOptions,
} from "maplibre-gl-geoagent";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";
import {
  authenticateEarthEngine as authenticateEarthEngineForGeoLibre,
  closeTauriOauthPopups,
  errorMessage,
  importMetaEnv,
  oauthClientIdValue,
  preloadEarthEngineAuthLibrary,
  projectValue as earthEngineProjectValue,
  shouldUseTauriEarthEngineOAuth,
} from "./earth-engine-auth";

const STORAGE_PREFIX = "geolibre.geoagent";

type GeoAgentControlInternals = {
  options?: GeoAgentControlOptions;
  tools?: {
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
  setTimeout(() => geoAgentControl?.expand(), 0);
  setTimeout(enhanceEarthEngineSignIn, 0);
  preloadEarthEngineAuthLibrary();
}

async function loadGeoAgentControl(): Promise<GeoAgentControl> {
  if (geoAgentControl) return geoAgentControl;
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
