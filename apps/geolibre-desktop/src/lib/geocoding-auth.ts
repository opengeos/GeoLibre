import {
  GeocoderServiceError,
  normalizeArcGISLocatorUrl,
  setGeocodingTokenProvider,
  type GeocodingLocator,
} from "@geolibre/core";
import { normalizeArcGISPortalUrl, tryGetArcGISAccessToken } from "./arcgis-oauth";

/**
 * Secured ArcGIS GeocodeServer locators borrow an ArcGIS portal sign-in.
 *
 * A portal token is sent to a locator on the portal's own host. Any other host
 * needs two things: its ArcGIS Server's `rest/info` names the portal as its
 * `owningSystemUrl` (a federated server), and the user approved sending that
 * portal's sign-in to that host on this device, by checking the locator in
 * Settings. The `owningSystemUrl` claim alone is not enough, since the server
 * attests it about itself: a shared project could otherwise pair a hostile
 * server with a portal the user is signed in to. A standalone server, or one
 * federated with another portal, never receives the token.
 */

/** Whether each (portal, ArcGIS Server) pair is federated, cached per session. */
const federation = new Map<string, Promise<boolean>>();

/** Device-local approvals, as `"<portal host> <locator host>"` entries. */
const APPROVALS_STORAGE_KEY = "geolibre.geocoding.locatorTokenHosts";
/** Approvals kept for this session when storage is unavailable. */
const sessionApprovals = new Set<string>();
/**
 * Approvals revoked this session. They stay revoked even if removing them from
 * storage failed, so a stale stored copy can never re-grant them.
 */
const revokedApprovals = new Set<string>();
/** Checks that passed in the open Settings dialog, granted only when it saves. */
const stagedApprovals = new Set<string>();

/** The ArcGIS Server REST root of a GeocodeServer URL (`.../rest`), or null. */
function restRoot(locatorUrl: string): string | null {
  const match = /^(.*\/rest)\/services\//i.exec(locatorUrl);
  return match ? match[1] : null;
}

/** The host of `url`, lower-cased, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The approval entry for sending `portalUrl`'s token to `locatorUrl`'s host, or null. */
function approvalKey(locatorUrl: string, portalUrl: string | undefined): string | null {
  const portal = portalUrl?.trim() ? normalizeArcGISPortalUrl(portalUrl) : null;
  const portalHost = portal ? hostOf(portal) : null;
  const locatorHost = hostOf(locatorUrl);
  return portalHost && locatorHost ? `${portalHost} ${locatorHost}` : null;
}

function readApprovals(): Set<string> {
  const approvals = new Set(sessionApprovals);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(APPROVALS_STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const entry of stored) if (typeof entry === "string") approvals.add(entry);
    }
  } catch {
    // Storage unavailable or corrupt: only this session's approvals count.
  }
  for (const key of revokedApprovals) approvals.delete(key);
  return approvals;
}

/**
 * Record that the user allows `portalUrl`'s sign-in to be sent to the host of
 * `locatorUrl` on this device.
 *
 * @param locatorUrl - The locator's GeocodeServer URL.
 * @param portalUrl - The locator's portal.
 */
export function approveLocatorPortalToken(locatorUrl: string, portalUrl: string | undefined): void {
  const key = approvalKey(locatorUrl, portalUrl);
  if (!key) return;
  revokedApprovals.delete(key);
  sessionApprovals.add(key);
  try {
    localStorage.setItem(APPROVALS_STORAGE_KEY, JSON.stringify([...readApprovals()]));
  } catch {
    // Kept for this session only.
  }
}

/** One device-local approval to send a portal's sign-in to a locator server. */
export interface LocatorPortalApproval {
  /** The portal whose sign-in is sent. */
  portalHost: string;
  /** The server that receives it. */
  locatorHost: string;
}

/**
 * The approvals granted on this device, for review in Settings.
 *
 * @returns The approvals, sorted by portal then server.
 */
export function listLocatorPortalApprovals(): LocatorPortalApproval[] {
  return [...readApprovals()]
    .flatMap((entry) => {
      const [portalHost, locatorHost] = entry.split(" ");
      return portalHost && locatorHost ? [{ portalHost, locatorHost }] : [];
    })
    .sort(
      (a, b) =>
        a.portalHost.localeCompare(b.portalHost) || a.locatorHost.localeCompare(b.locatorHost),
    );
}

/**
 * Withdraw an approval: the portal's sign-in is no longer sent to that server
 * until a locator on it is checked and saved again.
 *
 * @param approval - The approval to remove.
 */
export function revokeLocatorPortalApproval(approval: LocatorPortalApproval): void {
  const key = `${approval.portalHost} ${approval.locatorHost}`;
  revokedApprovals.add(key);
  sessionApprovals.delete(key);
  stagedApprovals.delete(key);
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(APPROVALS_STORAGE_KEY) ?? "[]");
    const kept = Array.isArray(stored) ? stored.filter((entry) => entry !== key) : [];
    localStorage.setItem(APPROVALS_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage unavailable: the session copy is already gone.
  }
}

/**
 * Note that the user checked a locator with its portal while signed in. The
 * approval is only granted by {@link commitLocatorPortalApprovals} when the
 * Settings dialog saves with that locator, so a cancelled dialog grants nothing.
 *
 * @param locatorUrl - The locator's GeocodeServer URL.
 * @param portalUrl - The locator's portal.
 */
export function stageLocatorPortalApproval(
  locatorUrl: string,
  portalUrl: string | undefined,
): void {
  const key = approvalKey(locatorUrl, portalUrl);
  if (key) stagedApprovals.add(key);
}

/** Forget approvals staged by a Settings dialog that did not save. */
export function discardStagedLocatorApprovals(): void {
  stagedApprovals.clear();
}

/**
 * Grant the staged approvals of the locators being saved.
 *
 * @param locators - The locators the Settings dialog saves.
 */
export function commitLocatorPortalApprovals(locators: readonly GeocodingLocator[]): void {
  for (const locator of locators) {
    const key = approvalKey(locator.url, locator.portalUrl);
    if (key && stagedApprovals.has(key)) approveLocatorPortalToken(locator.url, locator.portalUrl);
  }
  stagedApprovals.clear();
}

/** Ask an ArcGIS Server which portal it is federated with. */
async function owningSystemHost(root: string): Promise<string | null> {
  const response = await fetch(`${root}/info?f=json`, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
  });
  // Throw rather than answer "not federated", so a transient failure is not
  // cached for the session (see locatorAcceptsPortalToken).
  if (!response.ok) throw new Error(`rest/info returned HTTP ${response.status}`);
  const info = (await response.json()) as { owningSystemUrl?: unknown };
  return typeof info.owningSystemUrl === "string" ? hostOf(info.owningSystemUrl) : null;
}

/**
 * Whether the locator at `locatorUrl` is on `portal`'s host or on a server that
 * reports being federated with it. This is the server's own claim; see
 * {@link resolveLocatorToken} for what else a token needs.
 *
 * @param locatorUrl - The locator's GeocodeServer URL.
 * @param portalUrl - The portal the locator was configured with.
 * @returns True when the locator is on the portal's host or on a server
 *   federated with it, over HTTPS.
 */
export async function locatorAcceptsPortalToken(
  locatorUrl: string,
  portalUrl: string | undefined,
): Promise<boolean> {
  const locator = normalizeArcGISLocatorUrl(locatorUrl);
  const portal = portalUrl?.trim() ? normalizeArcGISPortalUrl(portalUrl) : null;
  if (!locator || !portal || !locator.startsWith("https://")) return false;
  const portalHost = hostOf(portal);
  if (!portalHost) return false;
  if (hostOf(locator) === portalHost) return true;
  const root = restRoot(locator);
  if (!root) return false;
  const key = `${portalHost} ${root}`;
  let federated = federation.get(key);
  if (!federated) {
    federated = owningSystemHost(root).then(
      (host) => host === portalHost,
      () => {
        // Unreachable is not "not federated": let a later request ask again.
        federation.delete(key);
        return false;
      },
    );
    federation.set(key, federated);
  }
  return federated;
}

/**
 * The token for a secured locator: its portal's current access token when the
 * locator is on the portal's host, or on a federated server the user approved
 * on this device, and the user is signed in; else undefined.
 *
 * @param locator - The locator.
 * @returns The token, or undefined to send the request without one.
 * @throws GeocoderServiceError When the token may not be sent to the locator,
 *   so a configuration problem is reported rather than hidden.
 */
export async function resolveLocatorToken(locator: GeocodingLocator): Promise<string | undefined> {
  if (!(await locatorAcceptsPortalToken(locator.url, locator.portalUrl))) {
    throw new GeocoderServiceError(
      "This locator is not on a server federated with its portal, so GeoLibre will not send the portal sign-in to it.",
    );
  }
  const portal = normalizeArcGISPortalUrl(locator.portalUrl);
  const sameHost = portal !== null && hostOf(portal) === hostOf(locator.url);
  const key = approvalKey(locator.url, locator.portalUrl);
  if (!sameHost && (!key || !readApprovals().has(key))) {
    throw new GeocoderServiceError(
      "Check this locator in Settings → Geocoding to allow GeoLibre to send your portal sign-in to its server.",
    );
  }
  return tryGetArcGISAccessToken(locator.portalUrl);
}

/** Let secured locators reuse ArcGIS portal sign-ins (all builds). */
export function installGeocodingTokenProvider(): void {
  setGeocodingTokenProvider(resolveLocatorToken);
}

/** Test hook: forget cached federation checks and approvals. */
export function resetLocatorFederationCache(): void {
  federation.clear();
  sessionApprovals.clear();
  stagedApprovals.clear();
  revokedApprovals.clear();
  try {
    localStorage.removeItem(APPROVALS_STORAGE_KEY);
  } catch {
    // Storage unavailable.
  }
}
