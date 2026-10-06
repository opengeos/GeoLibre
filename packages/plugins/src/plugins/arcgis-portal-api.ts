// REST helpers for the ArcGIS Portal plugin: browse a signed-in user's ArcGIS
// Online organization or ArcGIS Enterprise portal (their content, favorites,
// groups and organization) and turn portal items into layers. Kept free of the
// DOM and the store so it is unit-testable.

import type { ArcGISLayerType } from "./arcgis-layer";
import { sanitizeArcGisHubSearchText } from "./arcgis-hub-api";
import { parseWebMapLayers } from "./earthdata-gis-api";

export const ARCGIS_ONLINE_URL = "https://www.arcgis.com";

/** The browse scopes of the portal panel. */
export type ArcGisPortalView = "content" | "favorites" | "groups" | "organization" | "portal";

export const ARCGIS_PORTAL_VIEWS: readonly ArcGisPortalView[] = [
  "content",
  "favorites",
  "groups",
  "organization",
  "portal",
];

/** Portal item types the panel can add to the map, and how. */
export const PORTAL_ITEM_LAYER_TYPES: Readonly<Record<string, ArcGISLayerType | "web-map">> = {
  "Feature Service": "feature",
  "Map Service": "map-service",
  "Image Service": "image-service",
  "Vector Tile Service": "vector-tile",
  "Web Map": "web-map",
};

/** The supported item types, in the order the type filter lists them. */
export const PORTAL_ITEM_TYPES = Object.keys(PORTAL_ITEM_LAYER_TYPES);

/** One portal item as returned by `/sharing/rest/search`. */
export interface ArcGisPortalItem {
  id: string;
  title: string;
  type: string;
  owner: string;
  access?: string;
  snippet?: string;
  url?: string;
  thumbnail?: string;
  extent?: [[number, number], [number, number]];
}

export interface ArcGisPortalSearchResult {
  results: ArcGisPortalItem[];
  total: number;
  nextStart: number;
}

/** The signed-in user, as the browse views need it. */
export interface ArcGisPortalUser {
  username: string;
  orgId?: string;
  favGroupId?: string;
  groups: { id: string; title: string }[];
}

interface ErrorEnvelope {
  error?: { code?: number; message?: string };
}

// ArcGIS item, group and organization ids are pasted into a Lucene query, so
// anything that is not the expected shape is dropped rather than escaped.
const ID_RE = /^[0-9a-f]{32}$/i;
const ORG_ID_RE = /^[0-9A-Za-z]{16}$/;
// Usernames may hold `@`, `.`, `-` and `_` (SAML/enterprise logins); quoting
// covers those, so only characters that could close the quote are refused.
const USERNAME_RE = /^[^"\\\s]+$/;

/**
 * The REST base for a portal, from a normalized portal URL.
 *
 * An ArcGIS Online organization URL (`https://<org>.maps.arcgis.com`) answers
 * CORS only for its own origin, so the browser cannot read its REST responses.
 * www.arcgis.com serves the same organization and content with the same token.
 *
 * @param portal - A normalized portal base, such as `https://gis.example.org/portal`.
 * @returns The base to append `/sharing/rest` to.
 */
export function arcgisPortalRestBase(portal: string): string {
  return /\.maps\.arcgis\.com$/i.test(new URL(portal).hostname) ? ARCGIS_ONLINE_URL : portal;
}

/** The `/sharing/rest` URL of a portal, as `addArcGISLayer`'s `portalUrl` takes it. */
export function arcgisPortalSharingUrl(portal: string): string {
  return `${arcgisPortalRestBase(portal)}/sharing/rest`;
}

/** The item's page on the portal itself, for the Details button. */
export function arcgisPortalItemPageUrl(portal: string, itemId: string): string {
  const url = new URL(`${portal}/home/item.html`);
  url.searchParams.set("id", itemId);
  return url.href;
}

/**
 * The item's thumbnail URL, or null when it has none.
 *
 * Thumbnails of non-public items need the token. `thumbnail` comes from the
 * item's owner, so dot segments are dropped before joining (they would
 * otherwise steer the request to another path on the portal).
 */
export function arcgisPortalThumbnailUrl(
  portal: string,
  item: Pick<ArcGisPortalItem, "id" | "thumbnail" | "access">,
  token?: string,
): string | null {
  const thumbnail = item.thumbnail
    ?.trim()
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  if (!thumbnail) return null;
  const url = new URL(
    `${arcgisPortalSharingUrl(portal)}/content/items/${encodeURIComponent(item.id)}/info/${thumbnail}`,
  );
  if (token && item.access !== "public") url.searchParams.set("token", token);
  return url.href;
}

/** The layer type an item adds as, or undefined when the panel cannot add it. */
export function portalItemLayerType(type: string): ArcGISLayerType | "web-map" | undefined {
  // Own keys only: `type` comes from the portal, and a value such as
  // "constructor" must not resolve to an Object.prototype member.
  return Object.hasOwn(PORTAL_ITEM_LAYER_TYPES, type) ? PORTAL_ITEM_LAYER_TYPES[type] : undefined;
}

export interface ArcGisPortalQueryOptions {
  view: ArcGisPortalView;
  user: ArcGisPortalUser;
  /** Free text typed by the user. */
  text?: string;
  /** The group to browse in the `groups` view. */
  groupId?: string;
  /** Item types to include; defaults to every supported type. */
  types?: readonly string[];
}

/**
 * Build the Lucene `q` of a portal search for one browse view.
 *
 * @param options - The view, the signed-in user, and the filters.
 * @returns The query, or null when the view has nothing to search (no group
 *   chosen, no favorites group, an organization with no id).
 */
export function buildPortalSearchQuery(options: ArcGisPortalQueryOptions): string | null {
  const { view, user } = options;
  let scope: string;
  if (view === "content") {
    if (!USERNAME_RE.test(user.username)) return null;
    scope = `owner:"${user.username}"`;
  } else if (view === "favorites") {
    if (!user.favGroupId || !ID_RE.test(user.favGroupId)) return null;
    scope = `group:${user.favGroupId}`;
  } else if (view === "groups") {
    if (!options.groupId || !ID_RE.test(options.groupId)) return null;
    scope = `group:${options.groupId}`;
  } else if (view === "organization") {
    if (!user.orgId || !ORG_ID_RE.test(user.orgId)) return null;
    scope = `orgid:${user.orgId}`;
  } else {
    scope = "";
  }
  const types = (options.types?.length ? options.types : PORTAL_ITEM_TYPES).filter((type) =>
    Object.hasOwn(PORTAL_ITEM_LAYER_TYPES, type),
  );
  // `type:"Web Map"` also matches "Web Mapping Application", which is not a map.
  const typeQuery = `(${types.map((type) => `type:"${type}"`).join(" OR ")})${
    types.includes("Web Map") ? ' -type:"Web Mapping Application"' : ""
  }`;
  const text = sanitizeArcGisHubSearchText(options.text ?? "");
  return [text ? `(${text})` : "", scope, typeQuery].filter(Boolean).join(" AND ");
}

/**
 * Build the search URL for one page of a portal query.
 *
 * @param portal - A normalized portal base.
 * @param query - From {@link buildPortalSearchQuery}.
 * @param options - Paging and the access token.
 * @returns The request URL.
 */
export function buildPortalSearchUrl(
  portal: string,
  query: string,
  options: { start?: number; num?: number; token?: string; relevance?: boolean } = {},
): string {
  const url = new URL(`${arcgisPortalSharingUrl(portal)}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("f", "json");
  url.searchParams.set("start", String(options.start ?? 1));
  url.searchParams.set("num", String(options.num ?? 20));
  // Browsing a folder of content reads best newest first; a keyword search by relevance.
  url.searchParams.set("sortField", options.relevance ? "relevance" : "modified");
  url.searchParams.set("sortOrder", "desc");
  if (options.token) url.searchParams.set("token", options.token);
  return url.href;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok) throw new Error(`The portal request failed with ${response.status}.`);
  // ArcGIS reports failures as HTTP 200 with an `error` object.
  const json = (await response.json()) as T & ErrorEnvelope;
  if (json.error) throw new Error(json.error.message || "The portal request failed.");
  return json;
}

/**
 * Search a portal.
 *
 * @param portal - A normalized portal base.
 * @param query - From {@link buildPortalSearchQuery}.
 * @param options - Paging, the token and an abort signal.
 * @returns One page of results.
 */
export async function searchPortal(
  portal: string,
  query: string,
  options: {
    start?: number;
    num?: number;
    token?: string;
    relevance?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ArcGisPortalSearchResult> {
  const json = await getJson<Partial<ArcGisPortalSearchResult>>(
    buildPortalSearchUrl(portal, query, options),
    options.signal,
  );
  if (!Array.isArray(json.results)) throw new Error("The portal returned an invalid response.");
  return {
    results: json.results,
    total: Number(json.total) || 0,
    nextStart: Number(json.nextStart) || -1,
  };
}

/**
 * Read the signed-in user's id, organization, favorites group and groups.
 *
 * @param portal - A normalized portal base.
 * @param token - The user's access token.
 * @param signal - Aborts the request.
 * @returns The user.
 */
export async function fetchPortalUser(
  portal: string,
  token: string,
  signal?: AbortSignal,
): Promise<ArcGisPortalUser> {
  const url = new URL(`${arcgisPortalSharingUrl(portal)}/community/self`);
  url.searchParams.set("f", "json");
  url.searchParams.set("token", token);
  const json = await getJson<{
    username?: unknown;
    orgId?: unknown;
    favGroupId?: unknown;
    groups?: unknown;
  }>(url.href, signal);
  if (typeof json.username !== "string" || !json.username) {
    throw new Error("The portal did not return the signed-in user.");
  }
  const groups = Array.isArray(json.groups)
    ? json.groups
        .filter(
          (group): group is { id: string; title?: unknown } =>
            typeof group?.id === "string" && ID_RE.test(group.id),
        )
        .map((group) => ({
          id: group.id,
          title: typeof group.title === "string" && group.title ? group.title : group.id,
        }))
        .sort((a, b) => a.title.localeCompare(b.title))
    : [];
  return {
    username: json.username,
    orgId: typeof json.orgId === "string" ? json.orgId : undefined,
    favGroupId: typeof json.favGroupId === "string" ? json.favGroupId : undefined,
    groups,
  };
}

/** One layer of a web map the panel can add. */
export interface ArcGisPortalWebMapLayer {
  title: string;
  url: string;
  layerType: ArcGISLayerType;
}

const WEB_MAP_KIND_LAYER_TYPES: Record<string, ArcGISLayerType> = {
  feature: "feature",
  map: "map-service",
  image: "image-service",
};

/**
 * Read the layers of a Web Map item that the panel can add.
 *
 * @param portal - A normalized portal base.
 * @param itemId - The Web Map item id.
 * @param token - The user's access token, for a non-public map.
 * @param signal - Aborts the request.
 * @returns The map's feature, map service and image service layers, in order.
 */
export async function fetchPortalWebMapLayers(
  portal: string,
  itemId: string,
  token?: string,
  signal?: AbortSignal,
): Promise<ArcGisPortalWebMapLayer[]> {
  const url = new URL(
    `${arcgisPortalSharingUrl(portal)}/content/items/${encodeURIComponent(itemId)}/data`,
  );
  url.searchParams.set("f", "json");
  if (token) url.searchParams.set("token", token);
  const body = await getJson<unknown>(url.href, signal);
  return parseWebMapLayers(body).flatMap((layer) => {
    const layerType = WEB_MAP_KIND_LAYER_TYPES[layer.kind];
    return layerType ? [{ title: layer.title, url: layer.url, layerType }] : [];
  });
}

/** The item's extent as `[west, south, east, north]`, or null when it has none. */
export function portalItemBounds(
  item: Pick<ArcGisPortalItem, "extent">,
): [number, number, number, number] | null {
  const extent = item.extent;
  if (!Array.isArray(extent) || extent.length !== 2) return null;
  const [[west, south], [east, north]] = extent;
  const values = [west, south, east, north];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) {
    return null;
  }
  return [west, south, east, north];
}
