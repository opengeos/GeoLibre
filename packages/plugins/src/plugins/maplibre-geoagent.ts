/// <reference path="../earthengine.d.ts" />

import {
  GeoAgentControl,
  type GeoAgentControlOptions,
} from "maplibre-gl-geoagent";
import earthEngine from "@google/earthengine";
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
let earthEngineAccessTokenOverride = "";
let earthEngineTokenTypeOverride = "Bearer";
let earthEngineTokenExpiresInOverride = 3600;

export const maplibreGeoAgentPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geoagent",
  name: "GeoAgent",
  version: "0.4.2",
  activate: (app: GeoLibreAppAPI) => {
    if (!geoAgentControl) {
      geoAgentControl = new GeoAgentControl(getGeoAgentOptions());
    }

    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) {
      geoAgentControl = null;
      return false;
    }
    setTimeout(() => geoAgentControl?.expand(), 0);
    setTimeout(enhanceEarthEngineSignIn, 0);
    preloadEarthEngineAuthLibrary();
  },
  deactivate: (app: GeoLibreAppAPI) => {
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
    if (!geoAgentControl) return;
    app.removeMapControl(geoAgentControl);
    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) return false;
    setTimeout(() => geoAgentControl?.expand(), 0);
    setTimeout(enhanceEarthEngineSignIn, 0);
  },
};

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
      applyEarthEngineAccessToken(
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

function applyEarthEngineAccessToken(
  oauthClientId: string,
  projectId: string,
): void {
  const accessToken = earthEngineAccessToken();
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

function earthEngineAccessToken(): string {
  if (earthEngineAccessTokenOverride) return earthEngineAccessTokenOverride;
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
