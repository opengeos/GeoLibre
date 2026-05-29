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

const DEFAULT_GEE_OAUTH_CLIENT_ID =
  "141292844612-gitmgm28jkmkujonfkrkvdaqjiqt6qkf.apps.googleusercontent.com";
const STORAGE_PREFIX = "geolibre.geoagent";

type GeoAgentImportMetaEnv = {
  VITE_GEE_OAUTH_CLIENT_ID?: unknown;
  VITE_GEE_PROJECT_ID?: unknown;
};

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

function envString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function importMetaEnv(): GeoAgentImportMetaEnv {
  return (
    import.meta as ImportMeta & {
      env?: GeoAgentImportMetaEnv;
    }
  ).env ?? {};
}

function oauthClientIdValue(envValue: unknown): string {
  return envString(envValue) || DEFAULT_GEE_OAUTH_CLIENT_ID;
}

function projectValue(envValue: unknown): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("ee_project_id") ||
    envString(envValue) ||
    sessionStorage.getItem(`${STORAGE_PREFIX}.earthEngine.projectId`) ||
    localStorage.getItem(`${STORAGE_PREFIX}.ee_project_id`) ||
    ""
  );
}

function preloadEarthEngineAuthLibrary(): void {
  earthEngine.apiclient?.ensureAuthLibLoaded?.(() => undefined);
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
      status.textContent =
        error instanceof Error ? error.message : "Earth Engine sign-in failed.";
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
    tokenType: "Bearer",
    tokenExpiresIn: 3600,
  };

  if (control.options) {
    control.options.earthEngine = earthEngineOptions;
  }
  control.tools?.updateEarthEngineOptions?.(earthEngineOptions);
  control.invalidateAgent?.();
}

function earthEngineAccessToken(): string {
  return (earthEngine.data?.getAuthToken?.() ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function authenticateEarthEngine(oauthClientId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSuccess = () => resolve();
    const onFailure = (error: unknown) => reject(new Error(errorMessage(error)));
    const onImmediateFailed = () => {
      if (!earthEngine.data?.authenticateViaPopup) {
        reject(new Error("Earth Engine popup authentication is unavailable."));
        return;
      }
      earthEngine.data.authenticateViaPopup(onSuccess, onFailure);
    };

    if (earthEngine.data?.getAuthToken?.()) {
      resolve();
      return;
    }
    if (!earthEngine.data?.authenticateViaOauth) {
      reject(new Error("Earth Engine OAuth authentication is unavailable."));
      return;
    }
    earthEngine.data.authenticateViaOauth(
      oauthClientId,
      onSuccess,
      onFailure,
      undefined,
      onImmediateFailed,
    );
  });
}

async function closeTauriOauthPopups(): Promise<void> {
  let closedByCommand = false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_oauth_popups");
    closedByCommand = true;
    setTimeout(() => {
      void invoke("close_oauth_popups");
    }, 500);
  } catch {
    // Browser builds do not have a Tauri command bridge.
  }

  try {
    if (closedByCommand) return;
    const { getAllWindows } = await import("@tauri-apps/api/window");
    const windows = await getAllWindows();
    await Promise.all(
      windows
        .filter((window) => window.label.startsWith("oauthPopup"))
        .map((window) => window.close()),
    );
    setTimeout(() => {
      void getAllWindows().then((openWindows) =>
        Promise.all(
          openWindows
            .filter((window) => window.label.startsWith("oauthPopup"))
            .map((window) => window.close()),
        ),
      );
    }, 500);
  } catch {
    // Browser builds do not have a Tauri window manager.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Earth Engine sign-in failed.";
}
