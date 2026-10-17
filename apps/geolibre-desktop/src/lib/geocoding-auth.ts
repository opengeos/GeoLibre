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
 * A portal token is only sent to a locator that the portal vouches for: one on
 * the portal's own host, or on an ArcGIS Server whose `rest/info` names the
 * portal as its `owningSystemUrl` (a federated server). A standalone server, or
 * one federated with another portal, never receives the token; its requests go
 * out without one and the service's own "token required" answer is shown.
 */

/** Whether each (portal, ArcGIS Server) pair is federated, cached per session. */
const federation = new Map<string, Promise<boolean>>();

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

/** Ask an ArcGIS Server which portal it is federated with. */
async function owningSystemHost(root: string): Promise<string | null> {
  const response = await fetch(`${root}/info?f=json`, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) return null;
  const info = (await response.json()) as { owningSystemUrl?: unknown };
  return typeof info.owningSystemUrl === "string" ? hostOf(info.owningSystemUrl) : null;
}

/**
 * Whether `portal`'s sign-in may be sent to the locator at `locatorUrl`.
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
 * portal vouches for the locator and the user is signed in, else undefined.
 *
 * @param locator - The locator.
 * @returns The token, or undefined to send the request without one.
 * @throws GeocoderServiceError When the locator is not on a server the portal
 *   vouches for, so a configuration mistake is reported rather than hidden.
 */
async function locatorToken(locator: GeocodingLocator): Promise<string | undefined> {
  if (!(await locatorAcceptsPortalToken(locator.url, locator.portalUrl))) {
    throw new GeocoderServiceError(
      "This locator is not on a server federated with its portal, so GeoLibre will not send the portal sign-in to it.",
    );
  }
  return tryGetArcGISAccessToken(locator.portalUrl);
}

/** Let secured locators reuse ArcGIS portal sign-ins (all builds). */
export function installGeocodingTokenProvider(): void {
  setGeocodingTokenProvider(locatorToken);
}

/** Test hook: forget cached federation checks. */
export function resetLocatorFederationCache(): void {
  federation.clear();
}
