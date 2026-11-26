// Signed-in identity for live collaboration (#3530).
//
// When the user is signed in to the GeoLibre server API (the share server's
// OAuth session), ask it for a short-lived relay identity token
// (`POST /api/collab/identity-token`) and present that on join, so the relay
// can show the account on the roster, attribute edits in the session log, and
// let a host require signed-in participants. The access token itself never
// reaches the relay. Every failure resolves to null: the user joins anonymously,
// exactly as before.

import { getShareFetch } from "./share-fetch";
import { shareAuthorizedFetch } from "./share-gallery";
import { getShareAccessToken, resolveShareIssuer, supportsShareOAuth } from "./share-oauth";

// The join waits on this request, so keep a slow server from holding it long.
const REQUEST_TIMEOUT_MS = 3_000;
/** Reuse a token while it has at least this long left (reconnects). */
const REUSE_MARGIN_MS = 60_000;

let cached: { issuer: string; accessToken: string; token: string; expiresAt: number } | null = null;

/**
 * Forget the reusable token, so the next lookup mints a fresh one. Signing out
 * needs no call: without an access token the cache is never consulted.
 */
export function clearCollabIdentityCache(): void {
  cached = null;
}

export interface CollabIdentityDeps {
  /** The server API issuer; defaults to the configured share server. */
  issuer?: string | null;
  /** Resolve the OAuth access token; null when not signed in. */
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Overall deadline; defaults to three seconds. */
  timeoutMs?: number;
}

/**
 * Fetch a relay identity token for the signed-in account.
 *
 * @param deps - Injectable issuer, token source and fetch, for tests.
 * @returns The token, or null when not signed in, the server has no
 *   collaboration identity configured, or anything else fails.
 */
export async function fetchCollabIdentityToken(
  deps: CollabIdentityDeps = {},
): Promise<string | null> {
  // One deadline for the whole lookup, token refresh included: the join waits
  // on it, and a desktop refresh alone may take up to 30 s.
  // The same deadline aborts the request, so no work outlives the caller.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([lookup(deps, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(deps: CollabIdentityDeps, signal: AbortSignal): Promise<string | null> {
  try {
    const injected = deps.issuer !== undefined || deps.getAccessToken !== undefined;
    if (!injected && !supportsShareOAuth()) return null;
    const issuer = deps.issuer !== undefined ? deps.issuer : resolveShareIssuer();
    if (!issuer) return null;
    const accessToken = await (deps.getAccessToken ?? (() => getShareAccessToken()))();
    if (!accessToken || signal.aborted) return null;
    if (
      cached &&
      cached.issuer === issuer &&
      cached.accessToken === accessToken &&
      cached.expiresAt - REUSE_MARGIN_MS > Date.now()
    ) {
      return cached.token;
    }
    const request = shareAuthorizedFetch(accessToken, issuer, deps.fetchImpl ?? getShareFetch());
    const response = await request(new URL("api/collab/identity-token", `${issuer}/`), {
      method: "POST",
      signal,
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      token?: unknown;
      expiresAt?: unknown;
    } | null;
    if (typeof body?.token !== "string" || !body.token) return null;
    const expiresAt = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
    cached = Number.isFinite(expiresAt)
      ? { issuer, accessToken, token: body.token, expiresAt }
      : null;
    return body.token;
  } catch {
    return null;
  }
}
