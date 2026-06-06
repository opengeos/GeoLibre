/// <reference path="../earthengine.d.ts" />

import { invoke } from "@tauri-apps/api/core";

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

type EarthEngineApi = {
  apiclient?: {
    ensureAuthLibLoaded?: (callback: () => void) => void;
  };
  data?: {
    authenticateViaOauth?: (
      clientId: string,
      onSuccess: () => void,
      onFailure: (error: unknown) => void,
      extraScopes?: unknown,
      onImmediateFailed?: () => void,
    ) => void;
    authenticateViaPopup?: (
      onSuccess: () => void,
      onFailure: (error: unknown) => void,
    ) => void;
    getAuthToken?: () => string;
  };
};

type EarthEngineExportedFunctionInfoGlobal = {
  EXPORTED_FN_INFO?: unknown;
};

let earthEngineExportedFunctionInfo: unknown;

export function captureEarthEngineFunctionInfo(): unknown {
  const scope = globalThis as EarthEngineExportedFunctionInfoGlobal;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "EXPORTED_FN_INFO");
  if (descriptor && "value" in descriptor) return descriptor.value;
  return scope.EXPORTED_FN_INFO;
}

export function clearEarthEngineFunctionInfo(): void {
  earthEngineExportedFunctionInfo = undefined;
  const scope = globalThis as EarthEngineExportedFunctionInfoGlobal;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "EXPORTED_FN_INFO");
  if (descriptor?.configurable === false) {
    try {
      scope.EXPORTED_FN_INFO = undefined;
    } catch {
      // A non-configurable readonly host property cannot be cleared here.
    }
    return;
  }

  try {
    delete scope.EXPORTED_FN_INFO;
  } catch {
    try {
      Object.defineProperty(scope, "EXPORTED_FN_INFO", {
        configurable: true,
        writable: true,
        value: undefined,
      });
    } catch {
      // The Earth Engine call site will report the real failure.
    }
  }
}

export function installEarthEngineFunctionInfoFallback(
  functionInfo?: unknown,
): void {
  const scope = globalThis as EarthEngineExportedFunctionInfoGlobal;
  const descriptor = Object.getOwnPropertyDescriptor(scope, "EXPORTED_FN_INFO");
  if (descriptor?.configurable === false) return;

  if (functionInfo !== undefined) {
    earthEngineExportedFunctionInfo = functionInfo;
  } else if ("value" in (descriptor ?? {})) {
    earthEngineExportedFunctionInfo = descriptor?.value;
  }

  try {
    Object.defineProperty(scope, "EXPORTED_FN_INFO", {
      configurable: true,
      writable: true,
      value: earthEngineExportedFunctionInfo,
    });
  } catch {
    // If the host has already installed a non-configurable global, do not
    // throw here. The Earth Engine call site will report the real failure.
  }
}

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
  if (shouldUseTauriEarthEngineOAuth()) return;
  void loadEarthEngine()
    .then((earthEngine) => {
      earthEngine.apiclient?.ensureAuthLibLoaded?.(() => undefined);
    })
    .catch(() => undefined);
}

export async function ensureEarthEngineAuthLibraryLoaded(): Promise<void> {
  if (shouldUseTauriEarthEngineOAuth()) return;
  const earthEngine = await loadEarthEngine();
  return new Promise((resolve) => {
    const ensureAuthLibLoaded = earthEngine.apiclient?.ensureAuthLibLoaded;
    if (!ensureAuthLibLoaded) {
      resolve();
      return;
    }
    ensureAuthLibLoaded(() => resolve());
  });
}

export async function authenticateEarthEngine(
  oauthClientId: string,
): Promise<TauriEarthEngineOAuthToken | null> {
  if (shouldUseTauriEarthEngineOAuth()) {
    return authenticateEarthEngineViaTauri(oauthClientId);
  }

  await authenticateEarthEngineViaBrowser(oauthClientId);
  return null;
}

function normalizeEarthEngineAccessToken(
  token: TauriEarthEngineOAuthToken,
): Required<Pick<TauriEarthEngineOAuthToken, "accessToken" | "tokenType" | "expiresIn">> {
  if (token.error) throw new Error(token.error);
  if (!token.accessToken) {
    throw new Error("Earth Engine sign-in did not return an access token.");
  }

  const accessToken = token.accessToken.replace(/^Bearer\s+/i, "").trim();
  const tokenType = token.tokenType || "Bearer";
  const expiresIn = token.expiresIn || 3600;

  return { accessToken, tokenType, expiresIn };
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as TauriRuntimeWindow).__TAURI_INTERNALS__);
}

export function isTauriProductionOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const { hostname, protocol } = window.location;
  return (
    protocol === "tauri:" ||
    protocol === "file:" ||
    (hostname.endsWith(".localhost") && hostname !== "localhost")
  );
}

export function shouldUseTauriEarthEngineOAuth(): boolean {
  return isTauriProductionOrigin();
}

async function authenticateEarthEngineViaBrowser(
  oauthClientId: string,
): Promise<void> {
  const earthEngine = await loadEarthEngine();
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

  const popup = window.open(
    session.url,
    "geolibre-earth-engine-oauth",
    "popup,width=520,height=680",
  );
  if (!popup) {
    throw new Error("Earth Engine sign-in popup was blocked.");
  }

  const token = await waitForTauriEarthEngineToken(session.state, popup);
  popup.close();
  return normalizeEarthEngineAccessToken(token);
}

async function loadEarthEngine(): Promise<EarthEngineApi> {
  installEarthEngineFunctionInfoFallback();
  const module = await import("@google/earthengine");
  return (module.default ?? module) as EarthEngineApi;
}

async function waitForTauriEarthEngineToken(
  state: string,
  popup: Window,
): Promise<TauriEarthEngineOAuthToken> {
  let closedPolls = 0;
  for (let poll = 0; poll < 300; poll += 1) {
    const token = await invoke<TauriEarthEngineOAuthToken | null>(
      "poll_earth_engine_oauth",
      { stateId: state },
    );
    if (token) return token;
    if (popup.closed) {
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
  await closeTauriOauthPopupsOnce();
  for (const delayMs of [250, 750, 1500]) {
    setTimeout(() => {
      void closeTauriOauthPopupsOnce();
    }, delayMs);
  }
}

async function closeTauriOauthPopupsOnce(): Promise<void> {
  await Promise.allSettled([
    closeTauriOauthPopupsByCommand(),
    closeTauriOauthPopupsByWindowApi(),
  ]);
}

async function closeTauriOauthPopupsByCommand(): Promise<void> {
  await invoke("close_oauth_popups");
}

async function closeTauriOauthPopupsByWindowApi(): Promise<void> {
  const { getAllWindows } = await import("@tauri-apps/api/window");
  const windows = await getAllWindows();
  await Promise.all(
    windows
      .filter((window) => window.label.startsWith("oauthPopup"))
      .map((window) => window.close()),
  );
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
