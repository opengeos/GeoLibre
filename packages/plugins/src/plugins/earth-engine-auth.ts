/// <reference path="../earthengine.d.ts" />

import { invoke } from "@tauri-apps/api/core";

export const DEFAULT_GEE_OAUTH_CLIENT_ID =
  "937635412428-qc3albpo6dtm2jdp2o5mk8biqlh0i6vo.apps.googleusercontent.com";

// The OAuth scopes GeoLibre requests for Earth Engine. Deliberately minimal so
// the app can pass Google's OAuth verification without the broad `cloud-platform`
// scope: the @google/earthengine SDK requests earthengine + cloud-platform +
// full drive by default, but GeoLibre only displays tiles/thumbnails and exports
// to Drive — it never touches Cloud Storage, BigQuery, or project/asset
// management, so cloud-platform is unnecessary. Keep this in sync with the scope
// list in the desktop helper page (src-tauri/src/earth_engine_oauth.rs).
//   - earthengine: request/display Earth Engine map tiles and visualizations.
//   - drive.file:  the EE control's "Export" writes to Google Drive; drive.file
//     is the non-sensitive per-file scope, avoiding the restricted full-drive
//     scope (and its CASA security assessment).
export const EARTH_ENGINE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/earthengine",
  "https://www.googleapis.com/auth/drive.file",
];

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
      suppressDefaultScopes?: boolean,
    ) => void;
    authenticateViaPopup?: (onSuccess: () => void, onFailure: (error: unknown) => void) => void;
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

export function installEarthEngineFunctionInfoFallback(functionInfo?: unknown): void {
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
    (
      import.meta as ImportMeta & {
        env?: EarthEngineImportMetaEnv;
      }
    ).env ?? {}
  );
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

async function authenticateEarthEngineViaBrowser(oauthClientId: string): Promise<void> {
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
    // Suppress the SDK's default scopes (earthengine + cloud-platform + full
    // drive) and request only EARTH_ENGINE_OAUTH_SCOPES, so the web path asks
    // for the same minimal set as the desktop helper page.
    earthEngine.data.authenticateViaOauth(
      oauthClientId,
      onSuccess,
      onFailure,
      EARTH_ENGINE_OAUTH_SCOPES,
      onImmediateFailed,
      true,
    );
  });
}

async function authenticateEarthEngineViaTauri(
  oauthClientId: string,
): Promise<TauriEarthEngineOAuthToken> {
  const session = await invoke<TauriEarthEngineOAuthStart>("start_earth_engine_oauth", {
    clientId: oauthClientId,
  });

  // Open the loopback OAuth helper page (served by the Rust
  // `start_earth_engine_oauth` command on 127.0.0.1) in the SYSTEM BROWSER, not
  // an in-app child webview. Routing it through window.open spawned a second app
  // window on Linux (WebKitGTK) and crashed the macOS WKWebView, because Tauri's
  // on_new_window handler turns window.open into a native child window. The
  // browser runs Google Identity Services against the registered
  // http://localhost origin and POSTs the token back to the loopback server,
  // which we poll for below.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(session.url);

  const token = await waitForTauriEarthEngineToken(session.state);
  return normalizeEarthEngineAccessToken(token);
}

async function loadEarthEngine(): Promise<EarthEngineApi> {
  installEarthEngineFunctionInfoFallback();
  const module = await import("@google/earthengine");
  return (module.default ?? module) as EarthEngineApi;
}

async function waitForTauriEarthEngineToken(state: string): Promise<TauriEarthEngineOAuthToken> {
  // The helper page now runs in the system browser, so there is no popup window
  // handle to watch for cancellation; poll the loopback server for the token and
  // fall back to the timeout below if the user abandons the browser sign-in.
  for (let poll = 0; poll < 300; poll += 1) {
    const token = await invoke<TauriEarthEngineOAuthToken | null>("poll_earth_engine_oauth", {
      stateId: state,
    });
    if (token) return token;
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
  await Promise.allSettled([closeTauriOauthPopupsByCommand(), closeTauriOauthPopupsByWindowApi()]);
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
