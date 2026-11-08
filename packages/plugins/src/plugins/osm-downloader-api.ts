import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";

/**
 * Browser-readable relay for the public Overpass API. The upstream rejects
 * some otherwise valid browser origins (including Cloudflare Pages previews)
 * with a CORS-less 406 response, so clients cannot reliably call it directly.
 */
export const OVERPASS_DEFAULT_ENDPOINT = "https://tiles.geolibre.app/overpass";
export const OVERPASS_DEV_ENDPOINT = "/overpass";
export const OVERPASS_REQUEST_TIMEOUT_MS = 90_000;
export const OSM_MAP_API_ENDPOINT = "https://api.openstreetmap.org/api/0.6/map.json";
export const MAX_OSM_MAP_API_AREA_SQUARE_DEGREES = 0.25;
export const OSM_CUSTOM_TAG_MAX_LENGTH = 255;
// Keep these mirrored limits aligned with isAllowedOverpassQuery in workers/tiles/src/overpass-query.ts.
export const MAX_ALL_QUERY_AREA_SQUARE_DEGREES = 0.25;
export const MAX_QUERY_AREA_SQUARE_DEGREES = 4;

export type OsmDownloadPreset =
  | "all"
  | "buildings"
  | "roads"
  | "amenities"
  | "waterways"
  | "landuse"
  | "custom";

export interface OsmDownloadFilter {
  preset: OsmDownloadPreset;
  key?: string;
  value?: string;
}

/** Maximum query area for a filter preset, in unprojected square degrees. */
export function osmDownloadAreaLimit(preset: OsmDownloadPreset): number {
  return preset === "all" ? MAX_ALL_QUERY_AREA_SQUARE_DEGREES : MAX_QUERY_AREA_SQUARE_DEGREES;
}

/** Validated bbox area, or null when the WGS84 bounds cannot be queried. */
export function osmDownloadBoundsArea(bbox: [number, number, number, number]): number | null {
  const [west, south, east, north] = bbox;
  if (
    !bbox.every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east > west + 360 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return null;
  }
  return (east - west) * (north - south);
}

/** Whether the bbox is valid and small enough for the selected OSM preset. */
export function canDownloadOsmBounds(
  bbox: [number, number, number, number],
  preset: OsmDownloadPreset,
): boolean {
  const area = osmDownloadBoundsArea(bbox);
  return area !== null && area <= osmDownloadAreaLimit(preset);
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number } | null>;
  members?: Array<{
    type: "node" | "way" | "relation";
    ref: number;
    role?: string;
    lat?: number;
    lon?: number;
    geometry?: Array<{ lat: number; lon: number } | null>;
  }>;
}

export interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
}

interface OsmApiElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: Array<{
    type: "node" | "way" | "relation";
    ref: number;
    role?: string;
  }>;
}

interface OsmApiResponse {
  elements?: OsmApiElement[];
}

export type OverpassFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

/**
 * Accepted Overpass endpoint URLs: `https://` on a hostname or bracketed IPv6
 * literal, or plain `http://` on loopback, with an optional port and path and
 * no credentials, whitespace, query, or fragment. The same source string is the
 * `osm.overpassUrl` pattern in schema/deployment.schema.json, the client policy
 * parser, and docker/deployment_policy.py; tests fail when they drift.
 */
export const OVERPASS_URL_PATTERN = new RegExp(
  "^(?:https://(?:[A-Za-z0-9.-]+|\\[[0-9A-Fa-f:.]+\\])|http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\]))(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$",
);

let configuredOverpassEndpoint: string | undefined;

/**
 * Set the deployment's Overpass API endpoint, used in place of the public relay.
 *
 * Called once at startup with the `osm.overpassUrl` deployment setting
 * (`VITE_GEOLIBRE_OVERPASS_URL`). A blank or undefined value clears it; a value
 * that does not match {@link OVERPASS_URL_PATTERN} is ignored with a warning, so
 * a typo falls back to the default endpoint rather than breaking every download.
 *
 * @param value - The configured Overpass interpreter URL, or undefined.
 */
export function setOverpassEndpoint(value: string | undefined): void {
  const trimmed = value?.trim() ?? "";
  if (trimmed && !OVERPASS_URL_PATTERN.test(trimmed)) {
    console.warn(
      "[osm] ignoring invalid Overpass endpoint; expected https:// (or http:// on loopback)",
    );
    configuredOverpassEndpoint = undefined;
    return;
  }
  configuredOverpassEndpoint = trimmed || undefined;
}

/**
 * Resolve the Overpass endpoint used when a caller does not pass one.
 *
 * A deployment-configured endpoint wins; otherwise Vite development uses its
 * same-origin relay (including LAN/Tailscale URLs) and production uses the
 * public GeoLibre relay.
 *
 * @param dev - Whether this is a Vite development build.
 * @param configured - The deployment endpoint; defaults to the value set by
 *   {@link setOverpassEndpoint}.
 * @returns The endpoint URL to POST Overpass QL to.
 */
export function defaultOverpassEndpoint(
  dev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV),
  configured: string | undefined = configuredOverpassEndpoint,
): string {
  if (configured) return configured;
  return dev ? OVERPASS_DEV_ENDPOINT : OVERPASS_DEFAULT_ENDPOINT;
}

const PRESET_TAGS: Record<Exclude<OsmDownloadPreset, "all" | "custom">, string> = {
  buildings: '"building"',
  roads: '"highway"',
  amenities: '"amenity"',
  waterways: '"waterway"',
  landuse: '"landuse"',
};

const PRESET_TAG_KEYS: Record<Exclude<OsmDownloadPreset, "all" | "custom">, string> = {
  buildings: "building",
  roads: "highway",
  amenities: "amenity",
  waterways: "waterway",
  landuse: "landuse",
};

function matchesOsmDownloadFilter(
  tags: Record<string, string> | undefined,
  filter: OsmDownloadFilter,
): boolean {
  if (!tags) return false;
  if (filter.preset === "all") return Object.keys(tags).length > 0;
  if (filter.preset === "custom") {
    const key = filter.key?.trim() ?? "";
    const value = filter.value?.trim() ?? "";
    return Boolean(
      key && Object.prototype.hasOwnProperty.call(tags, key) && (!value || tags[key] === value),
    );
  }
  return PRESET_TAG_KEYS[filter.preset] in tags;
}

/** Escape a user-entered tag key/value for an Overpass quoted string. */
export function escapeOverpassString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ");
}

/** Render WGS84 coordinates without exponent notation rejected by the relay grammar. */
function formatOverpassCoordinate(value: number): string {
  const rendered = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(rendered);
  if (!match) return rendered;
  const [, sign, integer, fraction = "", exponentText] = match;
  const digits = integer + fraction;
  const decimalIndex = integer.length + Number(exponentText);
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

/** Build a bounded Overpass QL query that returns complete element geometry. */
export function buildOsmDownloadQuery(
  bbox: [number, number, number, number],
  filter: OsmDownloadFilter,
): string {
  const [west, south, east, north] = bbox;
  const area = osmDownloadBoundsArea(bbox);
  if (area === null) throw new Error("Invalid bounding box");
  const areaLimit = osmDownloadAreaLimit(filter.preset);
  if (area > areaLimit) {
    const scope = filter.preset === "all" ? "All-features downloads" : "OSM downloads";
    throw new Error(`${scope} are limited to ${areaLimit} square degrees`);
  }

  // The "all" option still means all *tagged* features. Selecting bare
  // `nwr(bbox)` would also return the many untagged nodes that only define way
  // geometry, making even a modest urban query unnecessarily huge.
  let tagFilter = '[~"."~"."]';
  if (filter.preset === "custom") {
    const key = filter.key?.trim() ?? "";
    const value = filter.value?.trim() ?? "";
    if (!key) throw new Error("A tag key is required");
    if (key.length > OSM_CUSTOM_TAG_MAX_LENGTH || value.length > OSM_CUSTOM_TAG_MAX_LENGTH) {
      throw new Error(`Tag keys and values are limited to ${OSM_CUSTOM_TAG_MAX_LENGTH} characters`);
    }
    tagFilter = `["${escapeOverpassString(key)}"${
      value ? `="${escapeOverpassString(value)}"` : ""
    }]`;
  } else if (filter.preset !== "all") {
    tagFilter = `[${PRESET_TAGS[filter.preset]}]`;
  }

  // Overpass cannot express an unwrapped longitude above 180. Split a
  // renderer-neutral antimeridian-crossing view into its east and west halves.
  const boxes =
    east <= 180
      ? [[south, west, north, east]]
      : [
          [south, west, north, 180],
          [south, -180, north, east - 360],
        ].filter(([, boxWest, , boxEast]) => boxWest < boxEast);
  const formattedBoxes = boxes.map((box) => box.map(formatOverpassCoordinate).join(","));
  const selectors = formattedBoxes.map((box) => `nwr${tagFilter}(${box});`).join("");
  return `[out:json][timeout:60];${
    formattedBoxes.length > 1 ? `(${selectors});` : selectors
  }out geom;`;
}

/**
 * Run a bounded Overpass query and convert its JSON response to GeoJSON.
 *
 * Without `options.endpoint` the query goes to {@link defaultOverpassEndpoint}
 * (the deployment-configured endpoint when set), and a small area that hits a
 * 429 or 5xx response falls back to the OSM editing API's `map.json`, which
 * serves the same OSM data. An explicit `options.endpoint` never falls back.
 */
export async function downloadOsmGeoJson(
  bbox: [number, number, number, number],
  filter: OsmDownloadFilter,
  options: {
    endpoint?: string;
    signal?: AbortSignal;
    fetchImpl?: OverpassFetch;
    timeoutMs?: number;
  } = {},
): Promise<FeatureCollection> {
  const query = buildOsmDownloadQuery(bbox, filter);
  const endpoint = options.endpoint ?? defaultOverpassEndpoint();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as OverpassFetch);
  const requestController = new AbortController();
  const abortFromCaller = () => requestController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => requestController.abort(new DOMException("Overpass request timed out", "TimeoutError")),
    options.timeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: `data=${encodeURIComponent(query)}`,
      signal: requestController.signal,
    });
    if (!response.ok) {
      // Read the failed body before any fallback so its connection is released on every path.
      let detail = "";
      try {
        detail = (await response.text())
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        // The status is still useful when a proxy supplies no readable body.
      }
      if (
        options.endpoint === undefined &&
        [429, 502, 503, 504].includes(response.status) &&
        (osmDownloadBoundsArea(bbox) ?? Infinity) <= MAX_OSM_MAP_API_AREA_SQUARE_DEGREES
      ) {
        const [west, south, east, north] = bbox;
        const mapUrl = new URL(OSM_MAP_API_ENDPOINT);
        mapUrl.searchParams.set("bbox", [west, south, east, north].join(","));
        try {
          const mapResponse = await fetchImpl(mapUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: requestController.signal,
          });
          if (mapResponse.ok) {
            return osmApiJsonToGeoJson((await mapResponse.json()) as OsmApiResponse, filter);
          }
        } catch (fallbackError) {
          // Preserve the original Overpass response unless the caller cancelled or timed out.
          if (requestController.signal.aborted) throw fallbackError;
        }
      }
      throw new Error(`Overpass request failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    const payload = (await response.json()) as OverpassResponse;
    if (payload.remark) throw new Error(payload.remark);
    return overpassJsonToGeoJson(payload);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Convert OSM map API JSON to filtered GeoJSON, resolving way-node references locally. */
export function osmApiJsonToGeoJson(
  payload: OsmApiResponse,
  filter: OsmDownloadFilter,
): FeatureCollection {
  const elements = payload.elements ?? [];
  const nodes = new Map(
    elements
      .filter((element): element is OsmApiElement & { type: "node" } => element.type === "node")
      .map((node) => [node.id, node]),
  );
  const ways = new Map(
    elements
      .filter((element): element is OsmApiElement & { type: "way" } => element.type === "way")
      .map((way) => [way.id, way]),
  );
  const wayGeometry = (way: OsmApiElement | undefined) =>
    way?.nodes?.map((nodeId) => {
      const node = nodes.get(nodeId);
      return node && isValidPosition(node) ? { lat: node.lat, lon: node.lon } : null;
    });

  const selected: OverpassElement[] = elements
    .filter((element) => matchesOsmDownloadFilter(element.tags, filter))
    .map((element) => {
      if (element.type === "node") return element;
      if (element.type === "way") {
        return { ...element, geometry: wayGeometry(element) };
      }
      return {
        ...element,
        members: element.members?.map((member) => {
          const node = member.type === "node" ? nodes.get(member.ref) : undefined;
          return {
            ...member,
            ...(node && isValidPosition(node) ? { lat: node.lat, lon: node.lon } : {}),
            ...(member.type === "way" ? { geometry: wayGeometry(ways.get(member.ref)) } : {}),
          };
        }),
      };
    });
  return overpassJsonToGeoJson({ elements: selected });
}

function isValidPosition(point: { lat?: number; lon?: number } | null | undefined): point is {
  lat: number;
  lon: number;
} {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.lon) &&
    Number.isFinite(point.lat) &&
    point.lon! >= -180 &&
    point.lon! <= 180 &&
    point.lat! >= -90 &&
    point.lat! <= 90
  );
}

function coordinates(geometry: Array<{ lat: number; lon: number } | null> | undefined): Position[] {
  if (!geometry) return [];
  const complete = geometry.every(isValidPosition);
  if (!complete) {
    return [];
  }
  return geometry.map((point) => [point.lon, point.lat]);
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isClosed(line: Position[]): boolean {
  return line.length >= 4 && samePosition(line[0], line[line.length - 1]);
}

const AREA_KEYS = new Set([
  "aeroway",
  "amenity",
  "building",
  "building:part",
  "landuse",
  "leisure",
  "man_made",
  "military",
  "office",
  "place",
  "shop",
  "tourism",
]);

/** Follow OSM's common area conventions without turning every closed way into a polygon. */
function wayIsArea(tags: Record<string, string>): boolean {
  if (tags.area === "yes") return true;
  if (tags.area === "no") return false;
  if (tags.natural && !["coastline", "cliff", "ridge", "tree_row"].includes(tags.natural))
    return true;
  if (tags.water || tags.waterway === "riverbank") return true;
  return Object.keys(tags).some((key) => AREA_KEYS.has(key));
}

/** Join relation member-way fragments whose endpoints touch, reversing as needed. */
function joinSegments(segments: Position[][]): Position[][] {
  const pending = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment]);
  const joined: Position[][] = [];
  while (pending.length) {
    const line = pending.shift()!;
    let changed = true;
    while (changed && !isClosed(line)) {
      changed = false;
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        const first = line[0];
        const last = line[line.length - 1];
        const candidateFirst = candidate[0];
        const candidateLast = candidate[candidate.length - 1];
        if (samePosition(last, candidateFirst)) line.push(...candidate.slice(1));
        else if (samePosition(last, candidateLast)) line.push(...candidate.slice(0, -1).reverse());
        else if (samePosition(first, candidateLast)) line.unshift(...candidate.slice(0, -1));
        else if (samePosition(first, candidateFirst)) line.unshift(...candidate.slice(1).reverse());
        else continue;
        pending.splice(index, 1);
        changed = true;
        break;
      }
    }
    joined.push(line);
  }
  return joined;
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1]) {
      const crossing = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < crossing) inside = !inside;
    }
  }
  return inside;
}

function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(sum / 2);
}

function relationGeometry(element: OverpassElement): Geometry | null {
  const members = element.members ?? [];
  const relationType = element.tags?.type;
  if (relationType === "multipolygon" || relationType === "boundary") {
    const outers = joinSegments(
      members
        .filter((member) => member.role !== "inner")
        .map((member) => coordinates(member.geometry)),
    ).filter(isClosed);
    const inners = joinSegments(
      members
        .filter((member) => member.role === "inner")
        .map((member) => coordinates(member.geometry)),
    ).filter(isClosed);
    if (outers.length) {
      const polygons: Position[][][] = outers.map((outer) => [outer]);
      for (const inner of inners) {
        const outerIndex = outers
          .map((outer, index) => ({ index, area: ringArea(outer) }))
          .filter(({ index }) => inner.some((point) => pointInRing(point, outers[index])))
          .sort((a, b) => a.area - b.area)[0]?.index;
        // A valid multipolygon hole lies inside one outer. Malformed unmatched
        // inner rings are omitted instead of being attached to unrelated data.
        if (outerIndex >= 0) polygons[outerIndex].push(inner);
      }
      return { type: "MultiPolygon", coordinates: polygons } satisfies MultiPolygon;
    }
    // Do not turn an incomplete area relation into misleading mixed-role
    // linework. Without a closed outer ring there is no valid polygon to show.
    return null;
  }

  const lines = members
    .map((member) => coordinates(member.geometry))
    .filter((line) => line.length >= 2);
  if (lines.length)
    return { type: "MultiLineString", coordinates: lines } satisfies MultiLineString;
  const points = members
    .filter(isValidPosition)
    .map((member) => [member.lon!, member.lat!] as Position);
  if (points.length === 1) return { type: "Point", coordinates: points[0] } satisfies Point;
  if (points.length > 1) return { type: "MultiPoint", coordinates: points };
  return null;
}

function elementFeature(element: OverpassElement): Feature | null {
  let geometry: Geometry | null = null;
  if (element.type === "node" && isValidPosition(element)) {
    geometry = { type: "Point", coordinates: [element.lon!, element.lat!] } satisfies Point;
  } else if (element.type === "way") {
    const line = coordinates(element.geometry);
    if (line.length >= 2) {
      geometry =
        isClosed(line) && wayIsArea(element.tags ?? {})
          ? ({ type: "Polygon", coordinates: [line] } satisfies Polygon)
          : ({ type: "LineString", coordinates: line } satisfies LineString);
    }
  } else if (element.type === "relation") {
    geometry = relationGeometry(element);
  }
  if (!geometry) return null;
  return {
    type: "Feature",
    id: `${element.type}/${element.id}`,
    geometry,
    properties: {
      ...(element.tags ?? {}),
      osm_id: element.id,
      osm_type: element.type,
    },
  };
}

/** Convert Overpass `out geom` JSON to a feature collection suitable for GeoLibre. */
export function overpassJsonToGeoJson(payload: OverpassResponse): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: (payload.elements ?? [])
      .map(elementFeature)
      .filter((feature): feature is Feature => feature !== null),
  };
}
