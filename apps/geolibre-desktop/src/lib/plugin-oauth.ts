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

/** Why a plugin sign-in ended without an authorization code. */
export type PluginOAuthFailure =
  | "invalid-request"
  | "popup-blocked"
  | "already-pending"
  | "access-denied"
  | "invalid-callback"
  | "cancelled"
  | "timeout"
  | "restart-required";

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
  const desktop = isDesktopRuntime();
  // Reserve the popup synchronously, while the browser still treats this call
  // as part of the user's click.
  const popup = desktop
    ? null
    : window.open("about:blank", "geolibre-plugin-oauth", "popup,width=520,height=720");
  const fail = (reason: PluginOAuthFailure): never => {
    popup?.close();
    throw new PluginOAuthError(reason);
  };

  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    return fail("invalid-request");
  }
  const state = url.searchParams.get("state");
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !state ||
    url.searchParams.get("redirect_uri") !== getPluginOAuthRedirectUri()
  ) {
    return fail("invalid-request");
  }
  if (!desktop && !popup) return fail("popup-blocked");
  if (pendingFlow) return fail("already-pending");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  pendingFlow = true;
  try {
    if (desktop) return await authorizeInSystemBrowser(url, state, timeoutMs);
    popup!.location.href = url.toString();
    return await waitForPopupCode(popup!, state, timeoutMs);
  } catch (error) {
    if (error instanceof OAuthPopupError) throw new PluginOAuthError(error.reason);
    throw error;
  } finally {
    pendingFlow = false;
  }
}

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
    return await waiter.code;
  } catch (error) {
    waiter.cancel();
    if (error instanceof NativeShareCallbackError) {
      throw new PluginOAuthError(
        error.code === "access-denied"
          ? "access-denied"
          : error.code === "timeout"
            ? "timeout"
            : error.code === "restart-required"
              ? "restart-required"
              : "invalid-callback",
      );
    }
    throw error;
  }
}
