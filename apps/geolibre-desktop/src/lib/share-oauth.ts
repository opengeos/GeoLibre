// Authorization Code + S256 PKCE for the reference share server. Web uses a
// same-origin popup and issuer-keyed tab storage; desktop uses the system
// browser and keeps the refresh token in the OS credential store. Neither mode
// stores an access token.
// The manager step-up grant never enters the project-session cache or storage.

import { create } from "zustand";
import type { ParseKeys } from "i18next";
import {
  hasPendingCredential,
  queueCredentialChanges,
  reportCredentialStorageError,
  useCredentialStorageStatus,
  writeSecureCredential,
} from "./credential-store";
import { isDesktopRuntime } from "./is-mobile";
import { isTauri } from "./is-tauri";
import { getShareFetch } from "./share-fetch";
import { resolveShareBaseUrl } from "./share-geolibre";
import {
  DESKTOP_SHARE_CALLBACK,
  NativeShareCallbackError,
  waitForNativeShareCode,
} from "./native-share-auth";

export function shareOAuthClientId(): "geolibre-web" | "geolibre-desktop" {
  return isDesktopRuntime() ? "geolibre-desktop" : "geolibre-web";
}

/** One-time PKCE/state material: 32 random bytes, unpadded base64url (43 chars). */
const TOKEN_BYTES = 32;

/** Give the user five minutes to finish the server's consent form. */
const POPUP_TIMEOUT_MS = 5 * 60_000;

/** How often a closed popup is noticed between message events. */
const POPUP_POLL_MS = 500;

/** Refresh an access token this long before its stated expiry. */
const ACCESS_EXPIRY_BUFFER_MS = 30_000;

/** Bound token endpoint requests so a stalled server cannot block sign-in. */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
/** Reject unexpectedly large OAuth JSON responses before buffering them. */
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/** sessionStorage key prefix; the issuer completes it. */
const SESSION_PREFIX = "geolibre-share-oauth:";

/** postMessage tag carried by the callback page's single message. */
const MESSAGE_TYPE = "geolibre-share-oauth";

export type ShareOAuthErrorCode =
  | "unsupported"
  | "not-configured"
  | "already-pending"
  | "crypto-unavailable"
  | "popup-blocked"
  | "cancelled"
  | "timeout"
  | "access-denied"
  | "state-mismatch"
  | "issuer-mismatch"
  | "malformed"
  | "exchange-failed"
  | "refresh-unavailable"
  | "setup-failed"
  | "restart-required"
  | "sign-out-incomplete";

/** Typed failure so the UI renders guidance (t()) instead of a raw message. */
export class ShareOAuthError extends Error {
  readonly code: ShareOAuthErrorCode;

  constructor(code: ShareOAuthErrorCode, message?: string) {
    super(message ?? code);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ShareOAuthError";
    this.code = code;
  }
}

/** i18n catalog key for each failure, so the UI never renders the raw code. */
export function shareOAuthErrorKey(code: ShareOAuthErrorCode): ParseKeys {
  switch (code) {
    case "refresh-unavailable":
      return "share.oauthRefreshFailed";
    case "popup-blocked":
      return "share.oauthPopupBlocked";
    case "cancelled":
    case "access-denied":
      return "share.oauthCancelled";
    case "timeout":
      return "share.oauthTimeout";
    case "already-pending":
      return "share.oauthInProgress";
    case "setup-failed":
      return "share.oauthSetupFailed";
    case "restart-required":
      return "share.oauthRestartSignIn";
    case "sign-out-incomplete":
      return "share.oauthSignOutIncomplete";
    case "not-configured":
      return "gallery.errorNotConfigured";
    default:
      return "share.oauthFailed";
  }
}

interface ShareOAuthState {
  issuer: string | null;
  sessionRevision: number;
  pending: boolean;
  startupError: "restart-required" | null;
  setupError: boolean;
  /**
   * Desktop: the sign-in could not be marked for safe persistence, so it is
   * kept in memory only and any stored copy is being removed.
   */
  desktopSessionOnly: boolean;
}

export const useShareOAuthStore = create<ShareOAuthState>(() => ({
  issuer: loadSignedInIssuer(),
  sessionRevision: 0,
  pending: false,
  startupError: null,
  setupError: false,
  desktopSessionOnly: false,
}));

// ---------------------------------------------------------------------------
// Capability and issuer resolution
// ---------------------------------------------------------------------------

/** Desktop uses the system browser; mobile Tauri and notebook embeds stay PAT-only. */
export function supportsShareOAuth(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof __GEOLIBRE_EMBED_BUILD__ !== "undefined" && __GEOLIBRE_EMBED_BUILD__) return false;
  if (isTauri()) return isDesktopRuntime() && !useShareOAuthStore.getState().setupError;
  return true;
}

/**
 * The canonical OAuth issuer for this deployment, or null when sharing is
 * unavailable or the configured base URL is invalid.
 */
export function resolveShareIssuer(baseUrl?: string): string | null {
  const base =
    baseUrl === undefined
      ? resolveShareBaseUrl()
      : baseUrl.trim()
        ? resolveShareBaseUrl(baseUrl)
        : null;
  if (!base) return null;
  try {
    return new URL(base).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Resolve an OAuth endpoint below the issuer, preserving any issuer path. */
export function oauthEndpointUrl(issuer: string, endpoint: "authorize" | "token" | "revoke"): URL {
  return new URL(`oauth/${endpoint}`, `${issuer}/`);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested security boundaries)
// ---------------------------------------------------------------------------

/** Unpadded base64url of `count` cryptographically random bytes. */
export function randomUrlSafeToken(count = TOKEN_BYTES): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The S256 PKCE challenge for a verifier: base64url(SHA-256(verifier)). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The redirect URI the server must have registered for this deployment: the
 * app's own origin plus the Vite base path and `oauth-callback.html`. Honors
 * subpath deployments (`GEOLIBRE_APP_BASE`) the same way Auth0Gate's redirect
 * does — one stable value an operator can register.
 */
export function deriveCallbackUrl(appOrigin: string, base?: string, documentUrl?: string): string {
  // Vite exposes the configured base with a trailing slash; the tsx test
  // loader has no import.meta.env at all, hence the safe read.
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  const raw = base ?? env?.BASE_URL ?? "/";
  const baseDir = raw.endsWith("/") ? raw : `${raw}/`;
  const resolutionBase =
    raw.startsWith(".") && documentUrl
      ? documentUrl
      : raw.startsWith(".") && typeof window !== "undefined"
        ? window.location.href
        : appOrigin;
  return new URL(`${baseDir}oauth-callback.html`, resolutionBase).toString();
}

export interface CallbackPayload {
  type?: unknown;
  code?: unknown;
  state?: unknown;
  iss?: unknown;
  error?: unknown;
}

export type CallbackVerdict =
  | { ok: true; code: string }
  | { ok: false; code: "access-denied" | "state-mismatch" | "issuer-mismatch" | "malformed" };

/**
 * Validate one callback message against what this flow minted. Everything is
 * compared strictly: the state must match exactly (a mismatch is an attempt to
 * splice a foreign authorization into this flow, never a warning), and a
 * present `iss` must equal the issuer we navigated to (RFC 9207 mix-up
 * defense). A malformed payload is rejected outright.
 */
export function validateCallbackPayload(
  payload: unknown,
  expected: { state: string; issuer: string },
): CallbackVerdict {
  if (!payload || typeof payload !== "object") return { ok: false, code: "malformed" };
  const data = payload as CallbackPayload;
  if (data.type !== MESSAGE_TYPE) return { ok: false, code: "malformed" };
  if (typeof data.error === "string" && data.error) {
    return { ok: false, code: "access-denied" };
  }
  if (typeof data.state !== "string" || data.state !== expected.state) {
    return { ok: false, code: "state-mismatch" };
  }
  if (data.iss !== undefined && data.iss !== null && data.iss !== expected.issuer) {
    return { ok: false, code: "issuer-mismatch" };
  }
  if (typeof data.code !== "string" || !data.code) return { ok: false, code: "malformed" };
  return { ok: true, code: data.code };
}

// ---------------------------------------------------------------------------
// Session persistence (refresh token only; access token stays in memory)
// ---------------------------------------------------------------------------

interface StoredSession {
  refreshToken: string;
}

/**
 * The desktop session. It is persisted to the OS credential store (issue
 * #1667) through {@link persistDesktopRefresh} and restored before the app
 * renders by {@link hydrateDesktopShareSession}; this variable is the source
 * of truth while the app runs.
 */
let desktopRefresh: { issuer: string; refreshToken: string } | null = null;

/** Credential-store account holding the desktop refresh token for `issuer`. */
export function shareRefreshTokenAccount(issuer: string): string {
  return `share.oauth.refreshToken.${issuer}`;
}

/** Keychain accounts the desktop Share sign-in reads at startup. */
export function desktopShareSessionAccounts(): string[] {
  const issuer = resolveShareIssuer();
  return issuer ? [shareRefreshTokenAccount(issuer)] : [];
}

/**
 * Non-secret localStorage list of issuers whose keychain entry may be stale:
 * written synchronously before a keychain write is queued and cleared only
 * once no write for that issuer is pending. Refresh tokens rotate and the
 * server revokes the whole session when a consumed one is presented, so a
 * stored token is trusted at startup only when this list does not name its
 * issuer.
 */
export const SHARE_UNSAVED_ISSUERS_STORAGE_KEY = "geolibre.share.oauth.unsavedIssuers";

/** Throws on unreadable storage or a malformed value, so callers stay conservative. */
function readUnsavedIssuers(): string[] {
  const raw = window.localStorage.getItem(SHARE_UNSAVED_ISSUERS_STORAGE_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((issuer) => typeof issuer === "string")) {
    throw new Error("The saved sign-in marker is malformed.");
  }
  return parsed as string[];
}

function writeUnsavedIssuers(issuers: readonly string[]): void {
  if (issuers.length === 0) window.localStorage.removeItem(SHARE_UNSAVED_ISSUERS_STORAGE_KEY);
  else window.localStorage.setItem(SHARE_UNSAVED_ISSUERS_STORAGE_KEY, JSON.stringify(issuers));
}

/** Drop issuers whose keychain writes have all completed. */
function reconcileUnsavedIssuers(): void {
  try {
    const unsaved = readUnsavedIssuers();
    const still = unsaved.filter((issuer) =>
      hasPendingCredential(shareRefreshTokenAccount(issuer)),
    );
    if (still.length !== unsaved.length) writeUnsavedIssuers(still);
  } catch (error) {
    reportCredentialStorageError(error);
  }
}

let reconcilingOnRetry = false;

/**
 * Mirror a desktop session change into the OS credential store. The issuer is
 * marked unsaved first, so quitting while the write is in flight, or after it
 * failed, makes the next launch start signed out instead of presenting a
 * consumed refresh token. A failed write is retried with the next queued
 * credential change, and the marker clears once it succeeds.
 *
 * If the marker itself cannot be written (localStorage unavailable), the new
 * token is not stored at all and a delete of any stored copy is queued; the
 * session continues in memory only. After a refresh this is best effort: the
 * delete is asynchronous, so quitting before it completes leaves the previous
 * token stored with no marker, and the next launch restores it. Rotation has
 * already consumed that token, so the server rejects its first refresh and
 * the app signs out (the pre-#1667 outcome, reached one request later).
 * Sign-out waits for its delete (see {@link signOutOfShare}), because the
 * stored token is still valid there if the revoke request also fails.
 */
function persistDesktopRefresh(
  previous: typeof desktopRefresh,
  next: typeof desktopRefresh,
): Promise<void> {
  const secrets = (session: typeof desktopRefresh): Record<string, string> =>
    session ? { [shareRefreshTokenAccount(session.issuer)]: session.refreshToken } : {};
  const issuers = [previous?.issuer, next?.issuer].filter((issuer) => issuer !== undefined);
  if (!reconcilingOnRetry) {
    reconcilingOnRetry = true;
    // A retry triggered by another credential change clears a failed account.
    useCredentialStorageStatus.subscribe((state, before) => {
      if (state.failedAccounts !== before.failedAccounts) reconcileUnsavedIssuers();
    });
  }
  try {
    writeUnsavedIssuers([...new Set([...readUnsavedIssuers(), ...issuers])]);
  } catch (error) {
    reportCredentialStorageError(error);
    useShareOAuthStore.setState({ desktopSessionOnly: next !== null });
    const stored = Object.fromEntries(
      issuers.map((issuer) => [shareRefreshTokenAccount(issuer), "stored"]),
    );
    return queueCredentialChanges(stored, {});
  }
  useShareOAuthStore.setState({ desktopSessionOnly: false });
  return queueCredentialChanges(secrets(previous), secrets(next)).then(reconcileUnsavedIssuers);
}

/**
 * Desktop startup: restore the sign-in for the configured issuer from the
 * caller's single credential-store read (`null` when that read failed and was
 * reported). A token whose last save never completed may already be consumed,
 * so it is deleted instead and the app starts signed out.
 */
export async function hydrateDesktopShareSession(
  stored: Readonly<Record<string, string>> | null,
): Promise<void> {
  const issuer = resolveShareIssuer();
  if (!issuer || stored === null) return;
  const account = shareRefreshTokenAccount(issuer);
  try {
    const unsaved = readUnsavedIssuers();
    if (unsaved.includes(issuer)) {
      await writeSecureCredential(account, "");
      writeUnsavedIssuers(unsaved.filter((candidate) => candidate !== issuer));
      return;
    }
    const refreshToken = stored[account];
    if (!refreshToken) return;
    desktopRefresh = { issuer, refreshToken };
    setStoreIssuer(issuer);
  } catch (error) {
    reportCredentialStorageError(error);
  }
}

/** Main installs listener and HTTP transport before enabling native sign-in. */
let desktopOAuthReady: Promise<void> | null = null;

export function configureShareOAuthReadiness(ready: Promise<void>): void {
  desktopOAuthReady = ready.catch(() => {
    useShareOAuthStore.setState({ setupError: true });
    throw new ShareOAuthError("setup-failed");
  });
  // Keep a startup failure observable without an unhandled rejection when no
  // control has yet asked for the readiness promise.
  void desktopOAuthReady.catch(() => {});
}

export async function waitForDesktopOAuthReady(): Promise<void> {
  if (!desktopOAuthReady) throw new ShareOAuthError("setup-failed");
  await desktopOAuthReady;
}

export function markColdShareCallback(): void {
  useShareOAuthStore.setState({ startupError: "restart-required" });
}

function readSession(issuer: string): StoredSession | null {
  if (isDesktopRuntime()) {
    return desktopRefresh?.issuer === issuer ? { refreshToken: desktopRefresh.refreshToken } : null;
  }
  try {
    const raw = window.sessionStorage.getItem(SESSION_PREFIX + issuer);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (typeof parsed?.refreshToken === "string" && parsed.refreshToken) {
      return { refreshToken: parsed.refreshToken };
    }
    window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
    return null;
  } catch {
    // Private-mode storage or tampered value: treat as signed out.
    try {
      window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
    } catch {
      // Nothing further to clean up.
    }
    return null;
  }
}

function writeSession(issuer: string, refreshToken: string): void {
  if (isDesktopRuntime()) {
    const previous = desktopRefresh;
    desktopRefresh = { issuer, refreshToken };
    void persistDesktopRefresh(previous, desktopRefresh);
    return;
  }
  try {
    window.sessionStorage.setItem(
      SESSION_PREFIX + issuer,
      JSON.stringify({ refreshToken } satisfies StoredSession),
    );
  } catch {
    // Quota/disabled storage: the session simply does not survive a reload.
  }
}

/**
 * Forget the stored session. On desktop the returned promise settles once the
 * keychain delete has been attempted (it never rejects; a failure is reported
 * through the credential-storage status).
 */
function clearStoredSession(issuer: string): Promise<void> {
  if (isDesktopRuntime()) {
    if (desktopRefresh?.issuer !== issuer) return Promise.resolve();
    const previous = desktopRefresh;
    desktopRefresh = null;
    return persistDesktopRefresh(previous, null);
  }
  try {
    window.sessionStorage.removeItem(SESSION_PREFIX + issuer);
  } catch {
    // Nothing further to clean up.
  }
  return Promise.resolve();
}

function loadSignedInIssuer(): string | null {
  if (isDesktopRuntime()) return null;
  if (typeof window === "undefined") return null;
  const issuer = resolveShareIssuer();
  return issuer && readSession(issuer) ? issuer : null;
}

interface CachedAccessToken {
  issuer: string;
  token: string;
  expiresAt: number;
}

let cachedAccess: CachedAccessToken | null = null;
let sessionGeneration = 0;

function setStoreIssuer(issuer: string | null, newGrant = false): void {
  useShareOAuthStore.setState((state) =>
    state.issuer === issuer && !newGrant
      ? state
      : { ...state, issuer, sessionRevision: state.sessionRevision + 1 },
  );
}

// ---------------------------------------------------------------------------
// Sign-in: popup consent → callback message → code exchange
// ---------------------------------------------------------------------------

/** A single in-flight consent flow. A second sign-in request is rejected. */
let pendingFlow: symbol | null = null;
let cancelActiveDesktopFlow: (() => void) | null = null;

/** Cancel this process's pending desktop consent without affecting web popups. */
export function cancelShareSignIn(): void {
  cancelActiveDesktopFlow?.();
}

type RequestedGrant = "project" | "management";

async function authorizeShareGrant(
  baseUrl: string | undefined,
  grant: RequestedGrant,
): Promise<{ issuer: string; tokens: TokenResponse; generation: number } | null> {
  if (!supportsShareOAuth()) {
    throw new ShareOAuthError(
      useShareOAuthStore.getState().setupError ? "setup-failed" : "unsupported",
    );
  }
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) throw new ShareOAuthError("not-configured");
  if (pendingFlow) throw new ShareOAuthError("already-pending");
  if (!window.crypto?.subtle) throw new ShareOAuthError("crypto-unavailable");

  const desktop = isDesktopRuntime();
  const flow = Symbol("share-oauth-flow");
  const state = randomUrlSafeToken();
  const verifier = randomUrlSafeToken();
  // Reserve the popup synchronously inside the originating click on web.
  const popup = desktop
    ? null
    : window.open("about:blank", "geolibre-share-oauth", "popup,width=480,height=680");
  if (!desktop && !popup) throw new ShareOAuthError("popup-blocked");

  pendingFlow = flow;
  useShareOAuthStore.setState({ pending: true, startupError: null });
  const flowGeneration = sessionGeneration;
  let cancelled = false;
  let nativeWaiter: ReturnType<typeof waitForNativeShareCode> | null = null;
  const cancelFlow = () => {
    cancelled = true;
    nativeWaiter?.cancel();
  };
  if (desktop) cancelActiveDesktopFlow = cancelFlow;
  try {
    if (desktop) await waitForDesktopOAuthReady();
    if (cancelled) throw new ShareOAuthError("cancelled");
    const challenge = await s256Challenge(verifier);
    if (cancelled) throw new ShareOAuthError("cancelled");
    if (flowGeneration !== sessionGeneration) return null;
    const redirectUri = desktop
      ? DESKTOP_SHARE_CALLBACK
      : deriveCallbackUrl(window.location.origin);
    const authorizeUrl = oauthEndpointUrl(issuer, "authorize");
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: shareOAuthClientId(),
      redirect_uri: redirectUri,
      scope:
        grant === "management" ? "manage:sessions" : "read:projects write:projects share:public",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    let code: string;
    if (desktop) {
      const waiter = waitForNativeShareCode(state, issuer, POPUP_TIMEOUT_MS);
      nativeWaiter = waiter;
      // Cancellation can precede openUrl's completion; observe that rejection
      // even before the code wait below starts awaiting it.
      void waiter.code.catch(() => {});
      try {
        // Platform-only API: the web and embed bundles do not use the opener.
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(authorizeUrl.toString());
      } catch {
        if (cancelled) throw new ShareOAuthError("cancelled");
        waiter.cancel();
        throw new ShareOAuthError("exchange-failed");
      }
      try {
        code = await waiter.code;
        if (cancelled) throw new ShareOAuthError("cancelled");
      } catch (error) {
        if (cancelled) throw new ShareOAuthError("cancelled");
        if (error instanceof NativeShareCallbackError) throw new ShareOAuthError(error.code);
        throw error;
      }
      if (cancelled) throw new ShareOAuthError("cancelled");
    } else {
      popup!.location.href = authorizeUrl.toString();
      code = await waitForCallbackCode(popup!, { state, issuer, flow });
    }
    if (flowGeneration !== sessionGeneration) return null;
    if (cancelled) throw new ShareOAuthError("cancelled");
    const tokens = await exchangeCode(issuer, code, verifier, redirectUri, grant);
    if (cancelled) throw new ShareOAuthError("cancelled");
    if (flowGeneration !== sessionGeneration) return null;
    return { issuer, tokens, generation: flowGeneration };
  } finally {
    if (cancelActiveDesktopFlow === cancelFlow) cancelActiveDesktopFlow = null;
    if (pendingFlow === flow) {
      pendingFlow = null;
      useShareOAuthStore.setState({ pending: false });
    }
    popup?.close();
  }
}

export async function signInToShare(baseUrl?: string): Promise<void> {
  const result = await authorizeShareGrant(baseUrl, "project");
  if (!result) return;
  if (result.generation !== sessionGeneration) return;
  const { issuer, tokens } = result;
  if (!tokens.refresh_token) throw new ShareOAuthError("exchange-failed");
  sessionGeneration += 1;
  writeSession(issuer, tokens.refresh_token);
  cachedAccess = {
    issuer,
    token: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  setStoreIssuer(issuer, true);
}

export interface ShareManagementGrant {
  issuer: string;
  accessToken: string;
  expiresAt: number;
}

/** Fresh step-up consent only; never shares the project token cache or storage. */
export async function authorizeShareManagement(baseUrl?: string): Promise<ShareManagementGrant> {
  const result = await authorizeShareGrant(baseUrl, "management");
  if (!result || result.generation !== sessionGeneration || result.tokens.refresh_token) {
    throw new ShareOAuthError("exchange-failed");
  }
  return {
    issuer: result.issuer,
    accessToken: result.tokens.access_token,
    expiresAt: Date.now() + result.tokens.expires_in * 1000,
  };
}

/** Resolve with the authorization code from the popup, or reject. */
function waitForCallbackCode(
  popup: Window,
  expected: { state: string; issuer: string; flow: symbol },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const appOrigin = window.location.origin;
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      run();
    };

    const onMessage = (event: MessageEvent) => {
      // The app origin, and the very popup we opened — never a stranger tab.
      if (event.origin !== appOrigin || event.source !== popup) return;
      const verdict = validateCallbackPayload(event.data, {
        state: expected.state,
        issuer: expected.issuer,
      });
      if (!verdict.ok) {
        finish(() => reject(new ShareOAuthError(verdict.code)));
        return;
      }
      finish(() => resolve(verdict.code));
    };

    const pollTimer = window.setInterval(() => {
      if (popup.closed) finish(() => reject(new ShareOAuthError("cancelled")));
    }, POPUP_POLL_MS);

    const timeoutTimer = window.setTimeout(() => {
      finish(() => reject(new ShareOAuthError("timeout")));
    }, POPUP_TIMEOUT_MS);

    window.addEventListener("message", onMessage);
  });
}

async function readTokenResponseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_TOKEN_RESPONSE_BYTES - byteLength) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
      byteLength += value.byteLength;
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function fetchTokenEndpoint(
  url: URL,
  init: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    if (isDesktopRuntime()) await waitForDesktopOAuthReady();
    const response = await getShareFetch()(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400)
      throw new ShareOAuthError("exchange-failed");
    const body = await readTokenResponseBody(response);
    return { response, body };
  } finally {
    window.clearTimeout(timeout);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** POST /oauth/token; validates the payload shape before anything is stored. */
async function exchangeCode(
  issuer: string,
  code: string,
  verifier: string,
  redirectUri: string,
  grant: RequestedGrant,
): Promise<TokenResponse> {
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await fetchTokenEndpoint(oauthEndpointUrl(issuer, "token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: shareOAuthClientId(),
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    }));
  } catch {
    throw new ShareOAuthError("exchange-failed", "Could not reach the share server.");
  }
  const payload = body as Partial<TokenResponse> | null;
  if (
    !response.ok ||
    typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    (grant === "project" &&
      (typeof payload.refresh_token !== "string" || !payload.refresh_token)) ||
    (grant === "management" && payload.refresh_token !== undefined)
  ) {
    throw new ShareOAuthError("exchange-failed", "The share server rejected the sign-in.");
  }
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : 600;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: expiresIn,
  };
}

// ---------------------------------------------------------------------------
// Access-token resolution: cache → single-flight refresh
// ---------------------------------------------------------------------------

const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * A fresh access token for the share issuer, or null when there is no web
 * session or the refresh grant is confirmed dead. Transient refresh failures
 * reject with a retryable ShareOAuthError and preserve the stored session.
 */
export async function getShareAccessToken(baseUrl?: string): Promise<string | null> {
  if (!supportsShareOAuth()) return null;
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) return null;
  if (isDesktopRuntime()) await waitForDesktopOAuthReady();

  if (
    cachedAccess &&
    cachedAccess.issuer === issuer &&
    cachedAccess.expiresAt - ACCESS_EXPIRY_BUFFER_MS > Date.now()
  ) {
    return cachedAccess.token;
  }
  const session = readSession(issuer);
  if (!session) return null;

  const generation = sessionGeneration;
  const existing = refreshInFlight.get(issuer);
  if (existing) return existing;
  const refreshPromise = refreshAccessToken(issuer, session.refreshToken, generation).finally(
    () => {
      if (refreshInFlight.get(issuer) === refreshPromise) refreshInFlight.delete(issuer);
    },
  );
  refreshInFlight.set(issuer, refreshPromise);
  return refreshPromise;
}

/**
 * The Bearer token for a share-server request: the OAuth access token when a
 * web session exists, otherwise the pasted personal API token. A transient
 * refresh failure falls back to the personal token when one is configured, and
 * rethrows otherwise. Resolves to "" when neither credential is available.
 */
export async function resolveShareRequestToken(
  personalToken: string,
  baseUrl?: string,
): Promise<string> {
  const pasted = personalToken.trim();
  if (!supportsShareOAuth()) return pasted;
  try {
    return (await getShareAccessToken(baseUrl)) ?? pasted;
  } catch (err) {
    if (err instanceof ShareOAuthError && err.code === "refresh-unavailable" && pasted) {
      return pasted;
    }
    throw err;
  }
}

async function refreshAccessToken(
  issuer: string,
  refreshToken: string,
  generation: number,
): Promise<string | null> {
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await fetchTokenEndpoint(oauthEndpointUrl(issuer, "token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: shareOAuthClientId(),
        refresh_token: refreshToken,
      }),
    }));
  } catch {
    if (generation !== sessionGeneration) return null;
    throw new ShareOAuthError("refresh-unavailable");
  }
  if (generation !== sessionGeneration) return null;
  if (!response.ok) {
    const parsedBody = body as { error?: unknown } | null;
    if (generation !== sessionGeneration) return null;
    const grantDead =
      (response.status === 400 || response.status === 401) &&
      (parsedBody?.error === "invalid_grant" || parsedBody?.error === "invalid_client");
    if (grantDead) {
      // Dead family (reused/rotated elsewhere, revoked, expired): drop it.
      void clearStoredSession(issuer);
      if (cachedAccess?.issuer === issuer) cachedAccess = null;
      if (loadSignedInIssuer() === null) setStoreIssuer(null);
      return null;
    }
    throw new ShareOAuthError("refresh-unavailable");
  }
  const payload = body as Partial<TokenResponse> | null;
  if (generation !== sessionGeneration) return null;
  if (
    typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    typeof payload?.refresh_token !== "string" ||
    !payload.refresh_token
  ) {
    throw new ShareOAuthError("refresh-unavailable");
  }
  // Rotation: the presented refresh token is consumed; store the successor.
  writeSession(issuer, payload.refresh_token);
  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0
      ? payload.expires_in
      : 600;
  cachedAccess = { issuer, token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return cachedAccess.token;
}

// ---------------------------------------------------------------------------
// Sign-out: clear local state, delete the stored token and revoke the family
// ---------------------------------------------------------------------------

/**
 * Sign out. The keychain delete and the revoke request run independently: a
 * failed delete must not skip the revoke, and a failed revoke must not keep a
 * token stored on this device. The session stops being usable immediately;
 * the UI reports signed out once the stored token is gone, so it never says
 * signed out while a still-valid token could be restored on the next launch.
 * Resolves once both have been attempted.
 */
export async function signOutOfShare(baseUrl?: string): Promise<void> {
  if (!supportsShareOAuth()) return;
  sessionGeneration += 1;
  const issuer = resolveShareIssuer(baseUrl);
  if (!issuer) return;
  const session = readSession(issuer);
  const deleted = clearStoredSession(issuer);
  if (cachedAccess?.issuer === issuer) cachedAccess = null;
  const revoked = session ? revokeRefreshToken(issuer, session.refreshToken) : Promise.resolve();
  await deleted;
  if (loadSignedInIssuer() === null) setStoreIssuer(null);
  await revoked;
  // The session is gone from memory either way, but a failed delete leaves the
  // token on this device. The delete stays queued and is retried only with a
  // later credential write in this process, so report the sign-out as
  // incomplete instead of as clean.
  if (session && isDesktopRuntime() && hasPendingCredential(shareRefreshTokenAccount(issuer))) {
    throw new ShareOAuthError("sign-out-incomplete");
  }
}

async function revokeRefreshToken(issuer: string, refreshToken: string): Promise<void> {
  try {
    await getShareFetch()(oauthEndpointUrl(issuer, "revoke"), {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: shareOAuthClientId(),
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
  } catch {
    // Best effort: local state is already gone.
  }
}
