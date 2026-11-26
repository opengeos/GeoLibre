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

const REQUEST_TIMEOUT_MS = 10_000;

export interface CollabIdentityDeps {
  /** The server API issuer; defaults to the configured share server. */
  issuer?: string | null;
  /** Resolve the OAuth access token; null when not signed in. */
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
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
  try {
    const injected = deps.issuer !== undefined || deps.getAccessToken !== undefined;
    if (!injected && !supportsShareOAuth()) return null;
    const issuer = deps.issuer !== undefined ? deps.issuer : resolveShareIssuer();
    if (!issuer) return null;
    const accessToken = await (deps.getAccessToken ?? (() => getShareAccessToken()))();
    if (!accessToken) return null;
    const request = shareAuthorizedFetch(accessToken, issuer, deps.fetchImpl ?? getShareFetch());
    const response = await request(new URL("api/collab/identity-token", `${issuer}/`), {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    return typeof body?.token === "string" && body.token ? body.token : null;
  } catch {
    return null;
  }
}
