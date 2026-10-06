// "Sign in with ArcGIS": Authorization Code + S256 PKCE against an ArcGIS Online
// organization or an ArcGIS Enterprise portal (issue #2948).
//
// The user authenticates on the portal's own page, so GeoLibre never sees a
// password, an MFA code or an identity-provider credential. Web uses a
// same-origin popup that lands on `oauth-callback.html`; desktop uses the
// system browser and the app's deep-link callback. Tokens live in memory only,
// keyed by portal, and are never written to a project or the service library.
// The OAuth client ID is not a secret and is remembered per portal.

import type { ParseKeys } from "i18next";
import { create } from "zustand";
import { isDesktopRuntime } from "./is-mobile";
import { isTauri } from "./is-tauri";
import {
  DESKTOP_SHARE_CALLBACK,
  NativeShareCallbackError,
  NO_ISSUER,
  waitForNativeShareCode,
} from "./native-share-auth";
import {
  deriveCallbackUrl,
  waitForDesktopOAuthReady,
  randomUrlSafeToken,
  s256Challenge,
  validateCallbackPayload,
} from "./share-oauth";

export const ARCGIS_ONLINE_PORTAL = "https://www.arcgis.com";

/** Give the user five minutes to finish the portal's sign-in page. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const POPUP_POLL_MS = 500;
/** Renew an access token this long before its stated expiry. */
const ACCESS_EXPIRY_BUFFER_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_ID_STORAGE_PREFIX = "geolibre.arcgis.clientId:";

export type ArcGISAuthErrorCode =
  | "invalid-portal"
  | "client-id-required"
  | "already-pending"
  | "crypto-unavailable"
  | "popup-blocked"
  | "cancelled"
  | "timeout"
  | "access-denied"
  | "exchange-failed"
  | "not-signed-in"
  | "session-expired"
  | "network-error"
  | "unsupported"
  | "restart-required";

/** Typed failure so the UI can show guidance instead of a raw code. */
export class ArcGISAuthError extends Error {
  readonly code: ArcGISAuthErrorCode;

  constructor(code: ArcGISAuthErrorCode, message?: string) {
    super(message ?? code);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ArcGISAuthError";
    this.code = code;
  }
}

/**
 * Whether this build can complete a sign-in: the browser (popup) and the
 * desktop app (deep link). The mobile apps have neither redirect target.
 */
export function supportsArcGISSignIn(): boolean {
  return !isTauri() || isDesktopRuntime();
}

/** The catalog key for each failure the UI words specifically. */
const AUTH_ERROR_KEYS: Partial<Record<ArcGISAuthErrorCode, ParseKeys>> = {
  "invalid-portal": "addData.arcgis.signInErrorPortal",
  "client-id-required": "addData.arcgis.signInErrorClientId",
  "already-pending": "addData.arcgis.signInErrorPending",
  "popup-blocked": "addData.arcgis.signInErrorPopup",
  cancelled: "addData.arcgis.signInErrorCancelled",
  "access-denied": "addData.arcgis.signInErrorCancelled",
  timeout: "addData.arcgis.signInErrorTimeout",
  "session-expired": "addData.arcgis.signInErrorExpired",
  "network-error": "addData.arcgis.signInErrorNetwork",
  "restart-required": "addData.arcgis.signInErrorRestart",
  "not-signed-in": "addData.arcgis.signInErrorExpired",
};

/**
 * The i18n key describing a sign-in failure.
 *
 * @param error - Anything thrown by the sign-in or token functions.
 * @returns The key, or null when the error is not an ArcGIS sign-in failure.
 */
export function arcgisAuthErrorKey(error: unknown): ParseKeys | null {
  if (!(error instanceof ArcGISAuthError)) return null;
  return AUTH_ERROR_KEYS[error.code] ?? "addData.arcgis.signInError";
}

/**
 * Reduce a portal URL to its base, for example `https://gis.example.org/portal`.
 *
 * Accepts the base itself or any `/sharing/rest...` URL (the form the Add Data
 * portal field takes). A blank input means ArcGIS Online. Only HTTPS portals
 * are accepted, since the tokens travel to it.
 *
 * @param input - A portal base URL, a `/sharing/rest` URL, or blank.
 * @returns The normalized base URL, or null when the input is not a usable portal.
 */
export function normalizeArcGISPortalUrl(input: string | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return ARCGIS_ONLINE_PORTAL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const path = url.pathname.replace(/\/sharing(\/rest.*)?\/?$/i, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** An ArcGIS Online organization URL, such as `https://myorg.maps.arcgis.com`. */
function isArcGISOnlineOrgPortal(portal: string): boolean {
  return /\.maps\.arcgis\.com$/i.test(new URL(portal).hostname);
}

/**
 * The OAuth2 endpoint URL on a normalized portal base.
 *
 * An ArcGIS Online organization URL answers CORS only for its own origin, so
 * the browser cannot read its token responses. The token and revoke calls go to
 * www.arcgis.com, which serves the same organization; `authorize` stays on the
 * organization URL so the user still gets its sign-in page (SSO included).
 *
 * @param portal - A portal base from `normalizeArcGISPortalUrl`.
 * @param endpoint - The OAuth2 endpoint name.
 * @returns The endpoint URL.
 */
export function arcgisOAuthEndpoint(
  portal: string,
  endpoint: "authorize" | "token" | "revokeToken",
): URL {
  const base =
    endpoint !== "authorize" && isArcGISOnlineOrgPortal(portal) ? ARCGIS_ONLINE_PORTAL : portal;
  return new URL(`${base}/sharing/rest/oauth2/${endpoint}`);
}

/** The OAuth client ID last used with this portal, or "". */
export function loadArcGISClientId(portal: string): string {
  try {
    return localStorage.getItem(CLIENT_ID_STORAGE_PREFIX + portal) ?? "";
  } catch {
    return "";
  }
}

function saveArcGISClientId(portal: string, clientId: string): void {
  try {
    localStorage.setItem(CLIENT_ID_STORAGE_PREFIX + portal, clientId);
  } catch {
    // Remembering the client ID is a convenience only.
  }
}

/** What the UI may show about a connection. Tokens are never in the store. */
export interface ArcGISConnectionInfo {
  portal: string;
  username: string;
}

interface ArcGISAuthState {
  connections: Record<string, ArcGISConnectionInfo>;
  pending: boolean;
}

export const useArcGISAuthStore = create<ArcGISAuthState>(() => ({
  connections: {},
  pending: false,
}));

interface Session {
  clientId: string;
  username: string;
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
}

const sessions = new Map<string, Session>();
const refreshing = new Map<string, Promise<string>>();

function publishConnections(): void {
  const connections: Record<string, ArcGISConnectionInfo> = {};
  for (const [portal, session] of sessions) {
    connections[portal] = { portal, username: session.username };
  }
  useArcGISAuthStore.setState({ connections });
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  username: string;
}

/** ArcGIS reports failures as HTTP 200 with an `error` object, so read the body. */
function parseTokenResponse(body: unknown, previous?: Session): TokenResponse {
  if (!body || typeof body !== "object") throw new ArcGISAuthError("exchange-failed");
  const data = body as Record<string, unknown>;
  if (data.error || typeof data.access_token !== "string" || !data.access_token) {
    throw new ArcGISAuthError("exchange-failed");
  }
  const lifetime = Number(data.expires_in);
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" && data.refresh_token
        ? data.refresh_token
        : (previous?.refreshToken ?? null),
    expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 1800) * 1000,
    username: typeof data.username === "string" ? data.username : (previous?.username ?? ""),
  };
}

async function postToken(portal: string, params: Record<string, string>): Promise<unknown> {
  let response: Response;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(arcgisOAuthEndpoint(portal, "token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ f: "json", ...params }),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    // The portal was never reached (offline, timeout, redirect): not a verdict
    // on the credentials, so a signed-in session is kept for a later retry.
    throw new ArcGISAuthError("network-error");
  } finally {
    window.clearTimeout(timeout);
  }
  try {
    return await response.json();
  } catch {
    throw new ArcGISAuthError("exchange-failed");
  }
}

let pendingFlow = false;
let cancelActiveFlow: (() => void) | null = null;

/** Abort an in-flight sign-in (the popup is closed or the system-browser wait ends). */
export function cancelArcGISSignIn(): void {
  cancelActiveFlow?.();
}

function waitForPopupCode(popup: Window, state: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
      window.clearTimeout(timer);
      run();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      // ArcGIS sends no `iss`, so only the state binds the callback to this flow.
      const verdict = validateCallbackPayload(event.data, { state, issuer: NO_ISSUER });
      if (!verdict.ok) {
        finish(() =>
          reject(
            new ArcGISAuthError(
              verdict.code === "access-denied" ? "access-denied" : "exchange-failed",
            ),
          ),
        );
        return;
      }
      finish(() => resolve(verdict.code));
    };
    const poll = window.setInterval(() => {
      if (popup.closed) finish(() => reject(new ArcGISAuthError("cancelled")));
    }, POPUP_POLL_MS);
    const timer = window.setTimeout(
      () => finish(() => reject(new ArcGISAuthError("timeout"))),
      SIGN_IN_TIMEOUT_MS,
    );
    window.addEventListener("message", onMessage);
  });
}

/**
 * Sign in to an ArcGIS portal through its own sign-in page.
 *
 * Call it directly from a click handler: on web the popup is reserved
 * synchronously so the browser does not block it.
 *
 * @param options - The portal URL (blank for ArcGIS Online) and the OAuth client ID registered on it.
 * @returns The signed-in connection.
 */
export async function signInToArcGIS(options: {
  portalUrl?: string;
  clientId: string;
}): Promise<ArcGISConnectionInfo> {
  const portal = normalizeArcGISPortalUrl(options.portalUrl);
  if (!portal) throw new ArcGISAuthError("invalid-portal");
  const clientId = options.clientId.trim();
  if (!clientId) throw new ArcGISAuthError("client-id-required");
  if (!supportsArcGISSignIn()) throw new ArcGISAuthError("unsupported");
  if (pendingFlow) throw new ArcGISAuthError("already-pending");
  if (!window.crypto?.subtle) throw new ArcGISAuthError("crypto-unavailable");

  const desktop = isDesktopRuntime();
  const popup = desktop
    ? null
    : window.open("about:blank", "geolibre-arcgis-oauth", "popup,width=520,height=720");
  if (!desktop && !popup) throw new ArcGISAuthError("popup-blocked");

  pendingFlow = true;
  useArcGISAuthStore.setState({ pending: true });
  let cancelled = false;
  let nativeWaiter: ReturnType<typeof waitForNativeShareCode> | null = null;
  cancelActiveFlow = () => {
    cancelled = true;
    nativeWaiter?.cancel();
    popup?.close();
  };
  try {
    const state = randomUrlSafeToken();
    const verifier = randomUrlSafeToken();
    const challenge = await s256Challenge(verifier);
    const redirectUri = desktop
      ? DESKTOP_SHARE_CALLBACK
      : deriveCallbackUrl(window.location.origin);
    const authorizeUrl = arcgisOAuthEndpoint(portal, "authorize");
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      // Minutes; the refresh token carries the rest of the session.
      expiration: "20160",
    }).toString();

    let code: string;
    if (desktop) {
      try {
        // The deep-link receiver starts asynchronously after launch.
        await waitForDesktopOAuthReady();
        if (cancelled) throw new ArcGISAuthError("cancelled");
        // Throws "malformed" while another flow (a Share sign-in) holds the
        // shared receiver.
        const waiter = waitForNativeShareCode(state, NO_ISSUER, SIGN_IN_TIMEOUT_MS);
        nativeWaiter = waiter;
        void waiter.code.catch(() => {});
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(authorizeUrl.toString());
        code = await waiter.code;
      } catch (error) {
        if (cancelled) throw new ArcGISAuthError("cancelled");
        nativeWaiter?.cancel();
        if (error instanceof NativeShareCallbackError) {
          throw new ArcGISAuthError(
            error.code === "access-denied"
              ? "access-denied"
              : error.code === "timeout"
                ? "timeout"
                : error.code === "restart-required"
                  ? "restart-required"
                  : error.code === "malformed" && !nativeWaiter
                    ? "already-pending"
                    : "exchange-failed",
          );
        }
        // Startup readiness failed (a ShareOAuthError): the receiver is not usable.
        throw new ArcGISAuthError("restart-required");
      }
    } else {
      popup!.location.href = authorizeUrl.toString();
      code = await waitForPopupCode(popup!, state);
    }
    if (cancelled) throw new ArcGISAuthError("cancelled");

    const tokens = parseTokenResponse(
      await postToken(portal, {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );
    sessions.set(portal, {
      clientId,
      username: tokens.username,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken,
    });
    saveArcGISClientId(portal, clientId);
    publishConnections();
    return { portal, username: tokens.username };
  } finally {
    cancelActiveFlow = null;
    pendingFlow = false;
    useArcGISAuthStore.setState({ pending: false });
    popup?.close();
  }
}

/** Whether a sign-in exists for this portal (blank means ArcGIS Online). */
export function isSignedInToArcGIS(portalUrl: string | undefined): boolean {
  const portal = normalizeArcGISPortalUrl(portalUrl);
  return portal !== null && sessions.has(portal);
}

/**
 * A current access token for a signed-in portal, renewed from the refresh token
 * when it is about to expire.
 *
 * @param portalUrl - The portal URL (blank for ArcGIS Online).
 * @returns The access token.
 * @throws ArcGISAuthError `not-signed-in` without a session, `session-expired`
 *   when it cannot be renewed (the session is dropped and a new sign-in is needed).
 */
export async function getArcGISAccessToken(portalUrl: string | undefined): Promise<string> {
  const portal = normalizeArcGISPortalUrl(portalUrl);
  const session = portal ? sessions.get(portal) : undefined;
  if (!portal || !session) throw new ArcGISAuthError("not-signed-in");
  if (session.expiresAt - Date.now() > ACCESS_EXPIRY_BUFFER_MS) return session.accessToken;
  const inFlight = refreshing.get(portal);
  if (inFlight) return inFlight;
  const renewal = (async () => {
    try {
      if (!session.refreshToken) throw new ArcGISAuthError("session-expired");
      const tokens = parseTokenResponse(
        await postToken(portal, {
          grant_type: "refresh_token",
          client_id: session.clientId,
          refresh_token: session.refreshToken,
        }),
        session,
      );
      // A sign-out during the request must not resurrect the session.
      if (sessions.get(portal) !== session) throw new ArcGISAuthError("not-signed-in");
      session.accessToken = tokens.accessToken;
      session.expiresAt = tokens.expiresAt;
      session.refreshToken = tokens.refreshToken;
      return session.accessToken;
    } catch (error) {
      // A transport failure leaves a still-usable refresh token in place.
      if (error instanceof ArcGISAuthError && error.code === "network-error") throw error;
      if (sessions.get(portal) === session) {
        sessions.delete(portal);
        publishConnections();
      }
      throw error instanceof ArcGISAuthError && error.code === "not-signed-in"
        ? error
        : new ArcGISAuthError("session-expired");
    } finally {
      refreshing.delete(portal);
    }
  })();
  refreshing.set(portal, renewal);
  return renewal;
}

/**
 * Like {@link getArcGISAccessToken}, but returns undefined when signed out or
 * expired, for a layer's token provider. A transient network failure still throws.
 */
export async function tryGetArcGISAccessToken(
  portalUrl: string | undefined,
): Promise<string | undefined> {
  try {
    return await getArcGISAccessToken(portalUrl);
  } catch (error) {
    // Signed out or expired means "no token"; a transient failure is the
    // caller's to see, so the request is not silently sent unauthenticated.
    if (
      error instanceof ArcGISAuthError &&
      (error.code === "not-signed-in" || error.code === "session-expired")
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Sign out of a portal: forget the session and revoke its refresh token on a best-effort basis. */
export async function signOutOfArcGIS(portalUrl: string | undefined): Promise<void> {
  const portal = normalizeArcGISPortalUrl(portalUrl);
  const session = portal ? sessions.get(portal) : undefined;
  if (!portal || !session) return;
  sessions.delete(portal);
  publishConnections();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    await fetch(arcgisOAuthEndpoint(portal, "revokeToken"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        f: "json",
        client_id: session.clientId,
        auth_token: session.refreshToken ?? session.accessToken,
        token_type_hint: session.refreshToken ? "refresh_token" : "access_token",
      }),
      credentials: "omit",
      // A redirect would replay the refresh token to another origin.
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    // The session is already gone locally; revocation is best effort.
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Test hook: drop every session. */
export function resetArcGISSessions(): void {
  sessions.clear();
  refreshing.clear();
  publishConnections();
}
