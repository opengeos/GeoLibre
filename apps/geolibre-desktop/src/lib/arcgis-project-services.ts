import { isTrustedPortalServiceUrl } from "@geolibre/plugins/arcgis-portal-api";
import { ARCGIS_ONLINE_PORTAL } from "./arcgis-oauth";

/**
 * Hosts of ArcGIS Online's multi-tenant feature service hosting, where the
 * first path segment is the publishing organisation's id: `services.arcgis.com`,
 * numbered hosts such as `services3.arcgis.com`, and regional hosts such as
 * `services-eu1.arcgis.com` and `services-ap1.arcgis.com`. Anchored at both
 * ends, so a look-alike such as `services-eu1.arcgis.com.example.org` or
 * `myservices-eu1.arcgis.com` never matches.
 */
export const ARCGIS_ONLINE_HOSTING = /^services(?:\d*|-[a-z]{2}\d+)\.arcgis\.com$/i;

/**
 * A service path on that hosting that the organisation check can trust: plain
 * segments of ASCII letters, digits, `_` and `-`, with an optional trailing
 * slash. `new URL` already resolves literal and `%2e` dot segments, but it
 * keeps `%2e%2e%2f`, `..;` and other encoded separators inside one segment,
 * which the server may decode or resolve into another organisation's folder
 * after the first segment has been checked. Such a path loads anonymously.
 */
export const PLAIN_SERVICE_PATH = /^(?:\/[\w-]+)+\/?$/;

/**
 * The ArcGIS sign-in, if any, whose token an imported project's service may
 * receive. The project file names the host, so the rule is stricter than for a
 * web map the user opens:
 *
 * - a host the signed-in portal trusts ({@link isTrustedPortalServiceUrl});
 * - on ArcGIS Online's shared hosting ({@link ARCGIS_ONLINE_HOSTING}), which
 *   any organisation can publish to, only a service whose path carries the
 *   signed-in user's own organisation id and nothing the server could resolve
 *   elsewhere ({@link PLAIN_SERVICE_PATH}), so a crafted project cannot collect
 *   the token;
 * - no other `*.arcgis.com` host.
 *
 * Sessions are tried with ArcGIS Online's default portal first. A session whose
 * token cannot be read is skipped, so a public service still loads.
 *
 * @param url - The service URL from the project.
 * @param deps - The signed-in portals, and lookups for a portal's current
 *   token and its user's organisation id.
 * @returns The portal and its current token, or null to load anonymously.
 */
export async function signInForImportedService(
  url: string,
  deps: {
    portals: string[];
    token: (portal: string) => Promise<string | undefined>;
    orgId: (portal: string, token: string) => Promise<string | undefined>;
  },
): Promise<{ portal: string; token: string } | null> {
  const service = new URL(url);
  const candidates = deps.portals
    .filter((portal) => isTrustedPortalServiceUrl(portal, url))
    .sort((a, b) => Number(b === ARCGIS_ONLINE_PORTAL) - Number(a === ARCGIS_ONLINE_PORTAL));
  for (const portal of candidates) {
    const sameHost = service.hostname.toLowerCase() === new URL(portal).hostname.toLowerCase();
    const hostedOrgId =
      ARCGIS_ONLINE_HOSTING.test(service.hostname) && PLAIN_SERVICE_PATH.test(service.pathname)
        ? service.pathname.split("/")[1]
        : undefined;
    if (!sameHost && !hostedOrgId) continue;
    const token = await deps.token(portal).catch(() => undefined);
    if (!token) continue;
    if (sameHost || (await deps.orgId(portal, token)) === hostedOrgId) return { portal, token };
  }
  return null;
}

/**
 * The organisation id behind a portal token, looked up once per token and
 * shared by every service in one import and their later requests. One entry is
 * kept per portal, for its latest token: the id a service is matched against
 * always belongs to the account whose token it is sent, a renewed or switched
 * session looks up again, and a superseded token is not kept in memory. A
 * failed lookup is not kept, so a transient error does not strip the token
 * from the import's later services.
 *
 * @param fetchOrgId - Reads the user's organisation id from the portal.
 * @returns The lookup, resolving to undefined when the portal cannot say.
 */
export function cachedOrgIdLookup(
  fetchOrgId: (portal: string, token: string) => Promise<string | undefined>,
): (portal: string, token: string) => Promise<string | undefined> {
  const lookups = new Map<string, { token: string; lookup: Promise<string | undefined> }>();
  return (portal, token) => {
    const cached = lookups.get(portal);
    if (cached?.token === token) return cached.lookup;
    const lookup: Promise<string | undefined> = fetchOrgId(portal, token).catch(() => {
      if (lookups.get(portal)?.lookup === lookup) lookups.delete(portal);
      return undefined;
    });
    lookups.set(portal, { token, lookup });
    return lookup;
  };
}

/**
 * The token provider for an imported service layer's later requests (viewport
 * queries, refreshes, edits). Each renewed token passes
 * {@link signInForImportedService} again. If the portal's session changes to an
 * account in another organisation, that account's token is withheld from a
 * service on ArcGIS Online's shared hosting rather than sent with the next
 * request. An account in the same organisation, or any account on an Enterprise
 * portal's own host, still passes the rule and gets its token, as at import.
 *
 * @param url - The service URL.
 * @param portal - The portal the import chose for this service.
 * @param token - Reads the portal's current token.
 * @param orgId - Looks up the organisation behind a token.
 * @returns A provider resolving to the token, or undefined to send none.
 */
export function serviceTokenProvider(
  url: string,
  portal: string,
  token: () => Promise<string | undefined>,
  orgId: (portal: string, token: string) => Promise<string | undefined>,
): () => Promise<string | undefined> {
  return async () =>
    (await signInForImportedService(url, { portals: [portal], token, orgId }))?.token;
}
