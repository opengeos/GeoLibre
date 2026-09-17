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

export const OVERPASS_DEFAULT_ENDPOINT = "https://overpass-api.de/api/interpreter";
export const OVERPASS_REQUEST_TIMEOUT_MS = 75_000;
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

export type OverpassFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

const PRESET_TAGS: Record<Exclude<OsmDownloadPreset, "all" | "custom">, string> = {
  buildings: '"building"',
  roads: '"highway"',
  amenities: '"amenity"',
  waterways: '"waterway"',
  landuse: '"landuse"',
};

/** Escape a user-entered tag key/value for an Overpass quoted string. */
export function escapeOverpassString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ");
}

/** Build a bounded Overpass QL query that returns complete element geometry. */
export function buildOsmDownloadQuery(
  bbox: [number, number, number, number],
  filter: OsmDownloadFilter,
): string {
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
    throw new Error("Invalid bounding box");
  }
  const area = (east - west) * (north - south);
  const areaLimit =
    filter.preset === "all" ? MAX_ALL_QUERY_AREA_SQUARE_DEGREES : MAX_QUERY_AREA_SQUARE_DEGREES;
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
      ? [`${south},${west},${north},${east}`]
      : [`${south},${west},${north},180`, `${south},-180,${north},${east - 360}`];
  const selectors = boxes.map((box) => `nwr${tagFilter}(${box});`).join("");
  return `[out:json][timeout:60];${boxes.length > 1 ? `(${selectors});` : selectors}out geom;`;
}

/** Run a bounded Overpass query and convert its JSON response to GeoJSON. */
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
  const endpoint = options.endpoint ?? OVERPASS_DEFAULT_ENDPOINT;
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
      let detail = "";
      try {
        detail = (await response.text())
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        // The status is still useful when a proxy supplies no readable body.
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

function coordinates(geometry: Array<{ lat: number; lon: number } | null> | undefined): Position[] {
  if (!geometry) return [];
  const complete = geometry.every(
    (point): point is { lat: number; lon: number } =>
      point !== null && Number.isFinite(point.lon) && Number.isFinite(point.lat),
  );
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
  }

  const lines = members
    .map((member) => coordinates(member.geometry))
    .filter((line) => line.length >= 2);
  if (lines.length)
    return { type: "MultiLineString", coordinates: lines } satisfies MultiLineString;
  const points = members
    .filter((member) => Number.isFinite(member.lon) && Number.isFinite(member.lat))
    .map((member) => [member.lon!, member.lat!] as Position);
  if (points.length === 1) return { type: "Point", coordinates: points[0] } satisfies Point;
  if (points.length > 1) return { type: "MultiPoint", coordinates: points };
  return null;
}

function elementFeature(element: OverpassElement): Feature | null {
  let geometry: Geometry | null = null;
  if (element.type === "node" && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
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
