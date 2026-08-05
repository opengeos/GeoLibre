/**
 * Signing in to Google Drive and letting the user choose files.
 *
 * Everything here exists to make *private* Drive files reachable. A shared
 * link needs no sign-in at all (see `google-drive-client.ts`), but a file in
 * the user's own Drive is invisible without one — and the scope that would let
 * GeoLibre browse a Drive freely (`drive.readonly`) is one of Google's
 * restricted scopes, gated behind an annual CASA security assessment.
 *
 * Google's answer to exactly that problem is the **Picker**: the user chooses
 * files in a Google-hosted widget, and each chosen file becomes accessible to
 * the app under the non-sensitive `drive.file` scope. GeoLibre therefore never
 * lists a Drive; the Picker does, and hands back only what was chosen. That is
 * also why sign-in and picking are one action rather than two — a `drive.file`
 * token on its own reaches nothing that already exists.
 *
 * Two transports, because Google will not accept the packaged desktop app's
 * origin (`tauri://localhost`) as an OAuth JavaScript origin:
 *
 *  - **Browser origins** (the web build, and `tauri:dev`, which is served over
 *    `http://localhost`) run Google's scripts in the page.
 *  - **The packaged desktop app** delegates to the Rust loopback helper
 *    (`src-tauri/src/google_oauth.rs`), which serves the same flow from
 *    `http://localhost:5173` in the system browser and posts the result back.
 */

import {
  DEFAULT_GEE_OAUTH_CLIENT_ID,
  isGoogleOAuthLoopbackAvailable,
  isTauriProductionOrigin,
} from "@geolibre/plugins";
import { pickerOutcome, type DriveFile } from "./google-drive";

/** What the Picker returns: the token to download with, and what was chosen. */
export interface DrivePickerResult {
  accessToken: string;
  /** Empty when the user closed the Picker without choosing — not an error. */
  files: DriveFile[];
}

/** Where a user-entered API key is remembered between sessions. */
const API_KEY_STORAGE_KEY = "geolibre.googleApiKey";

/**
 * The Picker's own scope. Deliberately the per-file grant rather than
 * `drive.readonly`; see the module comment.
 */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const GIS_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GAPI_SCRIPT_URL = "https://apis.google.com/js/api.js";

type ImportMetaEnvShape = {
  VITE_GOOGLE_OAUTH_CLIENT_ID?: unknown;
  VITE_GOOGLE_API_KEY?: unknown;
};

function importMetaEnv(): ImportMetaEnvShape {
  return (import.meta as ImportMeta & { env?: ImportMetaEnvShape }).env ?? {};
}

function envString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The OAuth client to authenticate against.
 *
 * Falls back to the Earth Engine client ID, which is the same Google Cloud
 * project and already requests `drive.file` — so a stock build signs in to
 * Drive without any extra configuration. A deployment that wants its own
 * consent screen sets `VITE_GOOGLE_OAUTH_CLIENT_ID`.
 *
 * @returns The OAuth client ID
 */
export function googleOAuthClientId(): string {
  return envString(importMetaEnv().VITE_GOOGLE_OAUTH_CLIENT_ID) || DEFAULT_GEE_OAUTH_CLIENT_ID;
}

/**
 * The Google API key ("developer key").
 *
 * Prefers a build-time `VITE_GOOGLE_API_KEY` and falls back to one the user
 * pasted into the dialog. Unlike the client ID there is no usable default:
 * an API key is billed to whoever issued it, so a shipped one would be a
 * shared quota that any user could exhaust for everyone else.
 *
 * @returns The configured key, or "" when there is none
 */
export function googleApiKey(): string {
  const fromEnv = envString(importMetaEnv().VITE_GOOGLE_API_KEY);
  if (fromEnv) return fromEnv;
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY)?.trim() ?? "";
  } catch {
    // Storage can be unavailable (private browsing, a sandboxed iframe); an
    // absent key is a supported state, so this is not worth surfacing.
    return "";
  }
}

/**
 * Remembers (or clears, when blank) a user-entered API key.
 *
 * @param key - The key to store; blank removes the stored value
 */
export function setStoredGoogleApiKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) localStorage.setItem(API_KEY_STORAGE_KEY, trimmed);
    else localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // As above: losing the convenience of a remembered key is not an error the
    // user needs to see, since the field still holds it for this session.
  }
}

/** Whether a build-time key is set, so the dialog can hide the key field. */
export function hasBuildTimeGoogleApiKey(): boolean {
  return Boolean(envString(importMetaEnv().VITE_GOOGLE_API_KEY));
}

/**
 * Whether this build can open the Picker at all.
 *
 * The Picker needs a Google sign-in, and on a packaged app that means the Rust
 * loopback listener — which the Apple App Store builds compile out, since it
 * would need the `network.server` entitlement App Review rejects. That is the
 * same listener Earth Engine sign-in uses, and it is compiled out of both by
 * one `#[cfg]`, so this defers to the shared predicate rather than re-deriving
 * "is this an Apple build?" here: a local copy would have to repeat the
 * iPadOS 13+ rule (an iPad reports a "Macintosh" user agent) and would silently
 * disagree with Earth Engine the moment either changed.
 *
 * Where it returns false the link path still works, so the dialog hides the
 * browse button rather than failing on click.
 *
 * @returns True when the Picker can be shown
 */
export function isDrivePickerAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return isGoogleOAuthLoopbackAvailable();
}

/**
 * Opens the Drive picker and resolves with the user's choice.
 *
 * @param apiKey - The Google developer key the Picker widget requires
 * @returns The token and chosen files; `files` is empty when the user cancelled
 * @throws Error when sign-in fails or the Picker cannot be loaded
 */
export async function openDrivePicker(apiKey: string): Promise<DrivePickerResult> {
  const clientId = googleOAuthClientId();
  if (isTauriProductionOrigin()) {
    return openDrivePickerViaLoopback(clientId, apiKey);
  }
  return openDrivePickerInPage(clientId, apiKey);
}

// --- Packaged desktop: the Rust loopback helper -----------------------------

interface LoopbackStart {
  url: string;
  state: string;
}

interface LoopbackResult {
  accessToken?: string;
  error?: string;
  files?: DriveFile[];
}

async function openDrivePickerViaLoopback(
  clientId: string,
  apiKey: string,
): Promise<DrivePickerResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const session = await invoke<LoopbackStart>("start_google_drive_picker", {
    clientId,
    apiKey,
  });

  // The SYSTEM BROWSER, not an in-app child webview — matching the Earth Engine
  // flow, where routing this through window.open spawned a second app window on
  // WebKitGTK and crashed the macOS WKWebView (Tauri turns window.open into a
  // native child window).
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(session.url);

  // Five minutes: the user has to sign in, possibly consent, then browse their
  // Drive in a separate application. Abandoning the browser tab is the normal
  // way this ends, and nothing else would ever resolve the promise.
  for (let poll = 0; poll < 300; poll += 1) {
    const result = await invoke<LoopbackResult | null>("poll_google_drive_picker", {
      stateId: session.state,
    });
    if (result) {
      if (result.error) throw new Error(result.error);
      if (!result.accessToken) throw new Error("Google sign-in did not return an access token.");
      return { accessToken: result.accessToken, files: result.files ?? [] };
    }
    await delay(1000);
  }
  throw new Error("The Google Drive picker timed out.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// --- Browser origins: Google's scripts, in the page ------------------------

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GooglePickerDoc {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: string | number;
}

interface GoogleGlobal {
  accounts?: {
    oauth2?: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: GoogleTokenResponse) => void;
      }) => { requestAccessToken: () => void };
    };
  };
  picker?: {
    // `LOADED` is the one action that is *not* terminal — the widget reports it
    // when it finishes rendering, and the session continues. Everything else
    // ends the session, which is what lets the callback below treat any other
    // unrecognized action as "nothing chosen" rather than waiting forever.
    Action: { PICKED: string; CANCEL: string; LOADED?: string };
    Feature: { MULTISELECT_ENABLED: string };
    ViewId: { DOCS: string };
    DocsView: new (viewId: string) => {
      setIncludeFolders: (value: boolean) => GooglePickerView;
      setSelectFolderEnabled: (value: boolean) => GooglePickerView;
    };
    PickerBuilder: new () => GooglePickerBuilder;
  };
}

interface GooglePickerView {
  setIncludeFolders: (value: boolean) => GooglePickerView;
  setSelectFolderEnabled: (value: boolean) => GooglePickerView;
}

interface GooglePickerBuilder {
  enableFeature: (feature: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  addView: (view: GooglePickerView) => GooglePickerBuilder;
  setCallback: (
    callback: (data: { action: string; docs?: GooglePickerDoc[] }) => void,
  ) => GooglePickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
}

interface GapiGlobal {
  load: (module: string, config: { callback: () => void; onerror?: () => void }) => void;
}

type ScriptHostWindow = Window & { google?: GoogleGlobal; gapi?: GapiGlobal };

/**
 * Loads an external script once, resolving when it is ready.
 *
 * Keyed on the URL so a second Picker session reuses the tag already in the
 * document rather than re-evaluating Google's SDK, which resets its internal
 * state.
 */
const scriptPromises = new Map<string, Promise<void>>();

function loadScript(url: string): Promise<void> {
  const existing = scriptPromises.get(url);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Drop the rejected promise so a later attempt can retry: the usual cause
      // is a blocked network or an ad blocker, both of which can change.
      scriptPromises.delete(url);
      reject(new Error(`Could not load ${url}.`));
    };
    document.head.appendChild(script);
  });
  scriptPromises.set(url, promise);
  return promise;
}

async function requestAccessTokenInPage(clientId: string): Promise<string> {
  await loadScript(GIS_SCRIPT_URL);
  const oauth2 = (window as ScriptHostWindow).google?.accounts?.oauth2;
  if (!oauth2) throw new Error("Google sign-in could not be initialized.");

  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(response.error_description || response.error || "Google sign-in failed."),
          );
          return;
        }
        resolve(response.access_token);
      },
    });
    client.requestAccessToken();
  });
}

async function openDrivePickerInPage(clientId: string, apiKey: string): Promise<DrivePickerResult> {
  const accessToken = await requestAccessTokenInPage(clientId);

  await loadScript(GAPI_SCRIPT_URL);
  const gapi = (window as ScriptHostWindow).gapi;
  if (!gapi) throw new Error("Could not load the Google Picker library.");
  await new Promise<void>((resolve, reject) => {
    gapi.load("picker", {
      callback: resolve,
      onerror: () => reject(new Error("Could not load the Google Picker library.")),
    });
  });

  const picker = (window as ScriptHostWindow).google?.picker;
  if (!picker) throw new Error("Could not load the Google Picker library.");

  return new Promise<DrivePickerResult>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const widget = new picker.PickerBuilder()
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setDeveloperKey(apiKey)
      // The Picker wants the Cloud project number, which is the client ID's
      // leading numeric segment.
      .setAppId(clientId.split("-")[0])
      .setOAuthToken(accessToken)
      .addView(view)
      .setCallback((data) => {
        const outcome = pickerOutcome(data.action, picker.Action.PICKED, picker.Action.LOADED);
        if (outcome === "continue") return;
        if (outcome === "picked") {
          resolve({
            accessToken,
            files: (data.docs ?? []).map((doc) => ({
              id: doc.id,
              name: doc.name,
              mimeType: doc.mimeType,
              size: doc.sizeBytes === undefined ? undefined : Number(doc.sizeBytes),
            })),
          });
          return;
        }
        // Dismissed — a cancel, an error, or an action this code does not know.
        // All land the user back on the dialog's fields, which is the one
        // outcome that is always recoverable.
        resolve({ accessToken, files: [] });
      })
      .build();
    widget.setVisible(true);
  });
}
