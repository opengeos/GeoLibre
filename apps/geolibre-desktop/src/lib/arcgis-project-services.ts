import { normalizeGroupContiguity, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { isTrustedPortalServiceUrl } from "@geolibre/plugins";
import { ARCGIS_ONLINE_PORTAL } from "./arcgis-oauth";

/**
 * Puts the feature service layers added so far where project load would have
 * put them had they been file layers: the project's layers and services in
 * ArcGIS order, then the store's own group contiguity pass, exactly as
 * `applyProjectToStore` lays out a loaded project. A layer the import placed
 * another way (a raster, a vector tile service) travels with the ranked layer
 * just before it, which keeps it in its group; any ahead of every ranked layer
 * stay first.
 *
 * @param projectLayerIds - The loaded project's layer ids, in ArcGIS order.
 * @param placed - Each loaded service's layer id with the project layers that
 *   follow it, in ArcGIS order.
 */
export function placeImportedServiceLayers(
  projectLayerIds: string[],
  placed: { layerId: string; nextLayerIds: string[] }[],
): void {
  const projectRank = new Map(projectLayerIds.map((id, index) => [id, index]));
  const rank = new Map(projectRank);
  placed.forEach(({ layerId, nextLayerIds }, index) => {
    const nextId = nextLayerIds.find((id) => projectRank.has(id));
    const next = nextId === undefined ? projectLayerIds.length : projectRank.get(nextId)!;
    // Just ahead of the next project layer, keeping services that share it in
    // their own order.
    rank.set(layerId, next - 1 + (index + 1) / (placed.length + 1));
  });
  const head: GeoLibreLayer[] = [];
  const runs: { rank: number; layers: GeoLibreLayer[] }[] = [];
  for (const layer of useAppStore.getState().layers) {
    const layerRank = rank.get(layer.id);
    if (layerRank !== undefined) runs.push({ rank: layerRank, layers: [layer] });
    else (runs.at(-1)?.layers ?? head).push(layer);
  }
  runs.sort((a, b) => a.rank - b.rank);
  // A direct write, as project load makes one: the store has no bulk reorder
  // action, and this only reorders the same layer objects (same ids, same
  // groups) and restores group contiguity, so nothing the actions maintain
  // (joins, selection, references in other slices) changes.
  useAppStore.setState({
    layers: normalizeGroupContiguity([...head, ...runs.flatMap((run) => run.layers)]),
  });
}

/**
 * The ArcGIS sign-in, if any, whose token an imported project's service may
 * receive. The project file names the host, so the rule is stricter than for a
 * web map the user opens:
 *
 * - a host the signed-in portal trusts ({@link isTrustedPortalServiceUrl});
 * - on ArcGIS Online's shared hosting (`services*.arcgis.com`), which any
 *   organisation can publish to, only a service whose path carries the signed-in
 *   user's own organisation id, so a crafted project cannot collect the token;
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
    const hostedOrgId = /^services\d*\.arcgis\.com$/i.test(service.hostname)
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
 * {@link signInForImportedService} again, so if the portal's session changes to
 * another account, that account's token is withheld from a service in the first
 * account's organisation rather than sent with the next request.
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
