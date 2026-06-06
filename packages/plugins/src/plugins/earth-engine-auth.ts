/// <reference path="../earthengine.d.ts" />

import earthEngine from "@google/earthengine";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export const DEFAULT_GEE_OAUTH_CLIENT_ID =
  "141292844612-gitmgm28jkmkujonfkrkvdaqjiqt6qkf.apps.googleusercontent.com";

export type EarthEngineImportMetaEnv = {
  VITE_GEE_OAUTH_CLIENT_ID?: unknown;
  VITE_GEE_PROJECT_ID?: unknown;
};

export type TauriEarthEngineOAuthStart = {
  url: string;
  state: string;
};

export type TauriEarthEngineOAuthToken = {
  accessToken?: string;
  tokenType?: string;
  expiresIn?: number;
  error?: string;
};

type TauriRuntimeWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
};

export function importMetaEnv(): EarthEngineImportMetaEnv {
  return (
    import.meta as ImportMeta & {
      env?: EarthEngineImportMetaEnv;
    }
  ).env ?? {};
}

export function envString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function oauthClientIdValue(envValue: unknown): string {
  return envString(envValue) || DEFAULT_GEE_OAUTH_CLIENT_ID;
}

export function projectValue(envValue: unknown, storagePrefix: string): string {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("ee_project_id") ||
    envString(envValue) ||
    sessionStorage.getItem(`${storagePrefix}.earthEngine.projectId`) ||
    localStorage.getItem(`${storagePrefix}.ee_project_id`) ||
    ""
  );
}

export function preloadEarthEngineAuthLibrary(): void {
  earthEngine.apiclient?.ensureAuthLibLoaded?.(() => undefined);
}

export async function authenticateEarthEngine(
  oauthClientId: string,
): Promise<TauriEarthEngineOAuthToken | null> {
  if (isTauriRuntime()) {
    return authenticateEarthEngineViaTauri(oauthClientId);
  }

  await authenticateEarthEngineViaBrowser(oauthClientId);
  return null;
}

export function applyEarthEngineAccessToken(
  oauthClientId: string,
  token: TauriEarthEngineOAuthToken,
): Required<Pick<TauriEarthEngineOAuthToken, "accessToken" | "tokenType" | "expiresIn">> {
  if (token.error) throw new Error(token.error);
  if (!token.accessToken) {
    throw new Error("Earth Engine sign-in did not return an access token.");
  }

  const accessToken = token.accessToken.replace(/^Bearer\s+/i, "").trim();
  const tokenType = token.tokenType || "Bearer";
  const expiresIn = token.expiresIn || 3600;

  earthEngine.apiclient?.setAuthToken?.(
    oauthClientId,
    tokenType,
    accessToken,
    expiresIn,
    [],
    () => undefined,
    false,
  );

  return { accessToken, tokenType, expiresIn };
}

export function isTauriRuntime(): boolean {
  return Boolean((window as TauriRuntimeWindow).__TAURI_INTERNALS__);
}

async function authenticateEarthEngineViaBrowser(
  oauthClientId: string,
): Promise<void> {
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

async function authenticateEarthEngineViaTauri(
  oauthClientId: string,
): Promise<TauriEarthEngineOAuthToken> {
  const session = await invoke<TauriEarthEngineOAuthStart>(
    "start_earth_engine_oauth",
    { clientId: oauthClientId },
  );

  const popup = await openTauriBrowserTab(session.url);
  const token = await waitForTauriEarthEngineToken(session.state, popup);
  applyEarthEngineAccessToken(oauthClientId, token);
  return token;
}

async function openTauriBrowserTab(url: string): Promise<Window | null> {
  try {
    await openUrl(url);
    // Native browser tabs cannot be observed for cancellation; the poll loop
    // falls back to its timeout in that case.
    return null;
  } catch {
    // Fall back to window.open in development or if the opener plugin is absent.
  }

  const popup = window.open(
    url,
    "geolibre-earth-engine-oauth",
    "popup,width=520,height=680",
  );
  if (!popup) {
    throw new Error("Earth Engine sign-in popup was blocked.");
  }
  return popup;
}

async function waitForTauriEarthEngineToken(
  state: string,
  popup?: Window | null,
): Promise<TauriEarthEngineOAuthToken> {
  let closedPolls = 0;
  for (let poll = 0; poll < 300; poll += 1) {
    const token = await invoke<TauriEarthEngineOAuthToken | null>(
      "poll_earth_engine_oauth",
      { stateId: state },
    );
    if (token) return token;
    if (popup?.closed) {
      closedPolls += 1;
      if (closedPolls > 2) {
        throw new Error("Earth Engine sign-in was cancelled.");
      }
    }
    await delay(1000);
  }
  throw new Error("Earth Engine sign-in timed out.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function closeTauriOauthPopups(): Promise<void> {
  let closedByCommand = false;
  try {
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

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    // Fall back to the generic message below.
  }
  return "Earth Engine sign-in failed.";
}
