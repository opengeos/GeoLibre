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
 * A portal's signed-in organisation id, looked up once per portal and shared by
 * every service in one import. A failed lookup is not kept, so a transient
 * error does not strip the token from the import's later services.
 *
 * @param fetchOrgId - Reads the user's organisation id from the portal.
 * @returns The lookup, resolving to undefined when the portal cannot say.
 */
export function cachedOrgIdLookup(
  fetchOrgId: (portal: string, token: string) => Promise<string | undefined>,
): (portal: string, token: string) => Promise<string | undefined> {
  const lookups = new Map<string, Promise<string | undefined>>();
  return (portal, token) => {
    let lookup = lookups.get(portal);
    if (!lookup) {
      lookup = fetchOrgId(portal, token).catch(() => {
        lookups.delete(portal);
        return undefined;
      });
      lookups.set(portal, lookup);
    }
    return lookup;
  };
}
