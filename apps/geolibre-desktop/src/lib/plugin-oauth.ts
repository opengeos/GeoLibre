/**
 * OAuth authorization-code sign-in for plugins (`authorizeInPopup` and
 * `getOAuthRedirectUri` on the plugin app API).
 *
 * GeoLibre only runs the round trip: on the web, a popup that comes back
 * through `oauth-callback.html`; on the desktop, the system browser and the
 * app's deep-link callback. The plugin builds the authorization URL (with its
 * own `state` and PKCE challenge), keeps the verifier, and exchanges the code
 * itself, so no plugin secret passes through the host.
 */

import type { GeoLibreOAuthFailure } from "@geolibre/plugins";
import { isDesktopRuntime } from "./is-mobile";
import {
  DESKTOP_SHARE_CALLBACK,
  NativeShareCallbackError,
  NO_ISSUER,
  waitForNativeShareCode,
} from "./native-share-auth";
import { OAuthPopupError, waitForPopupCode } from "./oauth-popup";
import { deriveCallbackUrl, waitForDesktopOAuthReady } from "./share-oauth";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// setTimeout's largest delay; a longer one fires straight away.
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Why a plugin sign-in ended without an authorization code. */
export type PluginOAuthFailure = GeoLibreOAuthFailure;

// The desktop callback failures plugins see under their own name; the rest
// (a malformed or mismatched callback) are an invalid callback.
const NATIVE_CALLBACK_FAILURES: Partial<Record<string, PluginOAuthFailure>> = {
  "access-denied": "access-denied",
  timeout: "timeout",
  "restart-required": "restart-required",
};

export class PluginOAuthError extends Error {
  constructor(readonly reason: PluginOAuthFailure) {
    super(`Plugin OAuth sign-in failed: ${reason}`);
    this.name = "PluginOAuthError";
  }
}

let pendingFlow = false;

/**
 * The redirect URI a plugin registers with its OAuth provider: the app's
 * callback page on the web, its custom URL scheme on the desktop.
 *
 * @returns The redirect URI for {@link authorizeInPopup}.
 */
export function getPluginOAuthRedirectUri(): string {
  return isDesktopRuntime() ? DESKTOP_SHARE_CALLBACK : deriveCallbackUrl(window.location.origin);
}

/**
 * Send the user to an OAuth provider's authorization page and resolve with the
 * authorization code it redirects back with. On the web this opens a popup, so
 * call it from a click handler, before any `await`: browsers block popups
 * opened later.
 *
 * @param authorizationUrl - The provider's authorization URL, with `state` and
 *   a `redirect_uri` equal to {@link getPluginOAuthRedirectUri}.
 * @param options - `timeoutMs`: how long the user has to finish (default five
 *   minutes).
 * @returns The authorization code, once the callback's `state` matches.
 */
export async function authorizeInPopup(
  authorizationUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  // Everything up to window.open is synchronous, so the browser still treats
  // the popup as part of the user's click. Refuse a second sign-in before
  // opening anything: the popup's name is fixed, so window.open would hand back
  // the first sign-in's popup and navigate it away.
  if (pendingFlow) throw new PluginOAuthError("already-pending");
  const { url, state } = parseAuthorizationRequest(authorizationUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new PluginOAuthError("invalid-request");
  }
  const desktop = isDesktopRuntime();
  const popup = desktop
    ? null
    : window.open("about:blank", "geolibre-plugin-oauth", "popup,width=520,height=720");
  if (!desktop && !popup) throw new PluginOAuthError("popup-blocked");

  pendingFlow = true;
  try {
    if (desktop) return await authorizeInSystemBrowser(url, state, timeoutMs);
    popup!.location.href = url.toString();
    return await waitForPopupCode(popup!, state, timeoutMs);
  } catch (error) {
    // The callback page closes the popup on success; after a timeout, denial or
    // bad callback it would stay on the provider's page, and the next sign-in
    // would pick it up again by name.
    popup?.close();
    if (error instanceof OAuthPopupError) throw new PluginOAuthError(error.reason);
    throw error;
  } finally {
    pendingFlow = false;
  }
}

/**
 * Check a plugin's authorization URL: HTTP(S), with a `state` and the app's
 * redirect URI.
 *
 * @param authorizationUrl - The provider's authorization URL.
 * @returns The parsed URL and its `state`.
 */
function parseAuthorizationRequest(authorizationUrl: string): { url: URL; state: string } {
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw new PluginOAuthError("invalid-request");
  }
  const state = url.searchParams.get("state");
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !state ||
    url.searchParams.get("redirect_uri") !== getPluginOAuthRedirectUri()
  ) {
    throw new PluginOAuthError("invalid-request");
  }
  return { url, state };
}

/**
 * The desktop round trip: open the authorization page in the system browser
 * and wait for the app's deep-link callback.
 *
 * @param url - The validated authorization URL.
 * @param state - Its `state`.
 * @param timeoutMs - How long the user has to finish.
 * @returns The authorization code.
 */
async function authorizeInSystemBrowser(url: URL, state: string, timeoutMs: number) {
  try {
    // The deep-link receiver starts asynchronously after launch.
    await waitForDesktopOAuthReady();
  } catch {
    throw new PluginOAuthError("restart-required");
  }
  let waiter: ReturnType<typeof waitForNativeShareCode>;
  try {
    waiter = waitForNativeShareCode(state, NO_ISSUER, timeoutMs);
  } catch (error) {
    // The receiver is shared with the app's own sign-ins; it refuses a second
    // waiter while one of them is in progress.
    throw new PluginOAuthError(
      error instanceof NativeShareCallbackError && error.code === "restart-required"
        ? "restart-required"
        : "already-pending",
    );
  }
  void waiter.code.catch(() => {});
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url.toString());
  } catch {
    waiter.cancel();
    throw new PluginOAuthError("launch-failed");
  }
  try {
    return await waiter.code;
  } catch (error) {
    waiter.cancel();
    if (error instanceof NativeShareCallbackError) {
      throw new PluginOAuthError(NATIVE_CALLBACK_FAILURES[error.code] ?? "invalid-callback");
    }
    throw error;
  }
}
