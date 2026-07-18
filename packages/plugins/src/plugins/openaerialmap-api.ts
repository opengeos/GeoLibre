/**
 * OpenAerialMap (OAM) catalog client.
 *
 * OAM exposes a public metadata API at https://api.openaerialmap.org/meta that
 * returns openly-licensed aerial/satellite imagery matching a bounding box.
 * Each result carries:
 *
 * - `uuid` — the source Cloud-Optimized GeoTIFF on S3. Supports HTTP range
 *   requests but is not CORS-enabled for arbitrary origins, so it cannot feed a
 *   browser-side COG reader; it is, however, directly *downloadable* and is the
 *   input to the tile server used for visualization (below).
 * - `properties.thumbnail` — a small PNG preview shown in the results list.
 *
 * To *visualize* an image we build an XYZ tile template pointing straight at
 * OAM's dynamic tiler (titiler.hotosm.org), which reads the COG server-side and
 * returns web-mercator PNG tiles with permissive CORS. The per-image
 * `properties.tms` URL (on tiles.openaerialmap.org) is deliberately not used: it
 * 302-redirects to the same tiler but the redirect response carries no CORS
 * header, so a browser blocks the tile before the redirect is followed.
 *
 * The metadata endpoint itself is only CORS-enabled for the official OAM web app
 * origin, so a plain browser fetch from another origin may be blocked. On the
 * GeoLibre desktop app the plugin routes the request through the native
 * (CORS-bypassing) fetch; on the web build a proxy is required.
 */

import type { Feature, MultiPolygon, Polygon } from "geojson";

/** Default OpenAerialMap metadata API base URL. */
export const OAM_DEFAULT_ENDPOINT = "https://api.openaerialmap.org";

/**
 * OAM's dynamic COG tiler. Building tile URLs against it directly (rather than
 * following the per-image `properties.tms` redirect) keeps the requests
 * CORS-enabled — see the module doc comment.
 */
const OAM_TILER_BASE = "https://titiler.hotosm.org";

/** A single OpenAerialMap image, normalized from the raw `/meta` response. */
export interface OamImage {
  /** Stable OAM record id. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Data provider / source (e.g. "Maxar"). */
  provider: string;
  /** Capture platform (e.g. "satellite", "uav"). */
  platform: string;
  /** Ground sample distance in meters, when known. */
  gsd: number | null;
  /** Acquisition start timestamp (ISO 8601), when known. */
  acquisitionStart: string | null;
  /** Acquisition end timestamp (ISO 8601), when known. */
  acquisitionEnd: string | null;
  /** Preview thumbnail URL, when available. */
  thumbnailUrl: string | null;
  /** XYZ tile template ({z}/{x}/{y}) for visualization, when available. */
  tileUrl: string | null;
  /** Source COG URL, used for download. */
  cogUrl: string | null;
  /** WGS84 bounds [west, south, east, north], when available. */
  bbox: [number, number, number, number] | null;
  /**
   * Exact footprint polygon (from the record's `geojson` geometry), when the
   * API provides one. Preferred over {@link bbox} for the on-map footprint so a
   * non-rectangular scene traces its true outline rather than its bounding box.
   */
  geometry: Polygon | MultiPolygon | null;
  /**
   * The raw `/meta` record this image was normalized from, kept verbatim so the
   * panel's Metadata view can surface every field the API returns (not just the
   * ones normalized above).
   */
  raw: unknown;
}

/**
 * Properties carried on a footprint feature. `id` maps a map click back to a
 * result; the rest populate the footprints layer's attribute table with the
 * image's key metadata. All values are flat primitives (GeoJSON-safe).
 */
export interface OamFootprintProps {
  /** The {@link OamImage.id} this footprint belongs to. */
  id: string;
  /** The image title. */
  title: string;
  /** Data provider / source. */
  provider: string;
  /** Capture platform (e.g. "satellite", "uav"), or empty when unknown. */
  platform: string;
  /** Acquisition date (YYYY-MM-DD), preferring the end timestamp, or null. */
  acquired: string | null;
  /** Ground sample distance in meters, or null. */
  gsd: number | null;
  /** Human-readable resolution (e.g. "30.0 cm/px"), or null. */
  resolution: string | null;
  /** Source COG URL, or null. */
  cogUrl: string | null;
  /** Preview thumbnail URL, or null. */
  thumbnailUrl: string | null;
  /** Whether the image can be visualized (has a tile template). */
  hasTile: boolean;
}

/** A page of OpenAerialMap search results. */
export interface OamSearchResult {
  /** Normalized images for this page. */
  images: OamImage[];
  /** Total number of images matching the query across all pages. */
  found: number;
  /** 1-indexed page number this result represents. */
  page: number;
  /** Page size used for the query. */
  limit: number;
}

/** Options describing an OpenAerialMap query. */
export interface OpenAerialMapSearchOptions {
  /** WGS84 bounding box [west, south, east, north] to search within. */
  bbox?: [number, number, number, number];
  /** Maximum results per page. @default 20 */
  limit?: number;
  /** 1-indexed page number. @default 1 */
  page?: number;
  /** Overrides the API base URL. @default {@link OAM_DEFAULT_ENDPOINT} */
  endpoint?: string;
  /** Aborts the request (e.g. when a newer search supersedes this one). */
  signal?: AbortSignal;
}

/** Minimal fetch shape so tests can stub without a DOM. */
export type OamFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Default fetch, forwarding an optional abort signal. */
const defaultFetch: OamFetch = (url, signal) => fetch(url, signal ? { signal } : undefined);

/** Strips a single trailing slash from an endpoint base. */
const TRAILING_SLASH_RE = /\/$/;

/**
 * Builds a web-mercator XYZ tile template that renders a COG through OAM's
 * tiler. The `{z}/{x}/{y}` tokens are filled in by MapLibre.
 *
 * @param cogUrl - Source Cloud-Optimized GeoTIFF URL
 * @returns An XYZ tile template, or null when no COG URL is available
 */
export function buildTitilerTemplate(cogUrl: string | null): string | null {
  if (!cogUrl) return null;
  return `${OAM_TILER_BASE}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=${encodeURIComponent(
    cogUrl,
  )}`;
}

/**
 * Builds the metadata API request URL for a query.
 *
 * @param options - Bounding box, paging, and endpoint
 * @returns The fully-formed `/meta` URL
 */
export function buildSearchUrl(options: OpenAerialMapSearchOptions = {}): string {
  const endpoint = (options.endpoint ?? OAM_DEFAULT_ENDPOINT).replace(TRAILING_SLASH_RE, "");
  const params = new URLSearchParams({
    limit: String(options.limit ?? 20),
    page: String(options.page ?? 1),
    // Newest imagery first.
    order_by: "acquisition_end",
    sort: "desc",
  });
  if (options.bbox) params.set("bbox", options.bbox.join(","));
  return `${endpoint}/meta?${params.toString()}`;
}

/** Reads a finite number from an unknown value, else null. */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads a count from a number or a numeric string (some APIs stringify it). */
function asCount(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return asNumber(value);
}

/** Reads a non-empty string from an unknown value, else null. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Matches an absolute http(s) URL. */
export const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Reads an http(s) URL from an unknown value, else null. Guards against a
 * `javascript:`/`data:` value reaching an `<a href>` (used for the download link).
 */
function asHttpUrl(value: unknown): string | null {
  const url = asString(value);
  return url && HTTP_URL_RE.test(url) ? url : null;
}

/** Reads a [w, s, e, n] tuple of finite numbers, else null. */
function asBbox(value: unknown): [number, number, number, number] | null {
  // Require exactly 4 elements: a 6-element (3D) GeoJSON bbox would otherwise be
  // misread as [minx, miny, minz, maxx] and produce a garbage box.
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [w, s, e, n] = value;
  if (
    typeof w === "number" &&
    typeof s === "number" &&
    typeof e === "number" &&
    typeof n === "number" &&
    [w, s, e, n].every(Number.isFinite)
  ) {
    return [w, s, e, n];
  }
  return null;
}

/**
 * Reads a GeoJSON Polygon/MultiPolygon geometry from an unknown value, else
 * null. The OAM record's `geojson` is the scene footprint geometry; only these
 * two area types are accepted (a Point/LineString could never be a footprint).
 */
function asPolygonGeometry(value: unknown): Polygon | MultiPolygon | null {
  if (!value || typeof value !== "object") return null;
  const geom = value as { type?: unknown; coordinates?: unknown };
  if (
    (geom.type === "Polygon" || geom.type === "MultiPolygon") &&
    Array.isArray(geom.coordinates)
  ) {
    return geom as Polygon | MultiPolygon;
  }
  return null;
}

/** Normalizes one raw `/meta` result record into an {@link OamImage}. */
function normalizeImage(raw: unknown): OamImage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const props = (record.properties ?? {}) as Record<string, unknown>;
  const geojson = (record.geojson ?? {}) as Record<string, unknown>;

  const id = asString(record._id) ?? asString(record.uuid);
  if (!id) return null;

  // Guarded to http(s): cogUrl becomes a clicked `<a href>` (download) and the
  // input to the tile-template URL.
  const cogUrl = asHttpUrl(record.uuid);

  return {
    id,
    title: asString(record.title) ?? "Untitled image",
    provider: asString(record.provider) ?? "Unknown",
    platform: asString(record.platform) ?? "",
    gsd: asNumber(record.gsd) ?? asNumber(props.gsd),
    acquisitionStart: asString(record.acquisition_start),
    acquisitionEnd: asString(record.acquisition_end),
    thumbnailUrl: asHttpUrl(props.thumbnail),
    tileUrl: buildTitilerTemplate(cogUrl),
    cogUrl,
    bbox: asBbox(record.bbox) ?? asBbox(geojson.bbox),
    geometry: asPolygonGeometry(record.geojson),
    raw,
  };
}

/**
 * Builds a GeoJSON footprint feature for an image, used to draw the result
 * outline on the map. Prefers the exact {@link OamImage.geometry}; falls back to
 * a rectangle traced from {@link OamImage.bbox}. Returns null when the image has
 * neither (it cannot be located on the map).
 *
 * @param image - A normalized image
 * @returns A footprint feature carrying the image id, or null
 */
export function footprintFeature(
  image: OamImage,
): Feature<Polygon | MultiPolygon, OamFootprintProps> | null {
  const acquired = (image.acquisitionEnd ?? image.acquisitionStart)?.slice(0, 10) ?? null;
  const resolution =
    image.gsd == null
      ? null
      : image.gsd < 1
        ? `${(image.gsd * 100).toFixed(1)} cm/px`
        : `${image.gsd.toFixed(2)} m/px`;
  const properties: OamFootprintProps = {
    id: image.id,
    title: image.title,
    provider: image.provider,
    platform: image.platform,
    acquired,
    gsd: image.gsd,
    resolution,
    cogUrl: image.cogUrl,
    thumbnailUrl: image.thumbnailUrl,
    hasTile: image.tileUrl != null,
  };
  if (image.geometry) {
    return { type: "Feature", geometry: image.geometry, properties };
  }
  if (image.bbox) {
    const [w, s, e, n] = image.bbox;
    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
      properties,
    };
  }
  return null;
}

/**
 * Normalizes a raw `/meta` response body into an {@link OamSearchResult}.
 *
 * @param body - Parsed JSON body from the metadata API
 * @param page - The 1-indexed page this body represents
 * @param limit - The page size used for the query
 * @returns Normalized images plus the total match count
 */
export function parseSearchResponse(body: unknown, page: number, limit: number): OamSearchResult {
  const parsed = (body ?? {}) as {
    meta?: { found?: unknown };
    results?: unknown;
  };
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const images = results.map(normalizeImage).filter((image): image is OamImage => image !== null);
  return {
    images,
    found: asCount(parsed.meta?.found) ?? images.length,
    page,
    limit,
  };
}

/**
 * Searches the OpenAerialMap catalog for imagery.
 *
 * @param options - Bounding box, paging, and endpoint
 * @param fetchImpl - Fetch-like function (defaults to the global `fetch`)
 * @returns A page of normalized images plus the total match count
 * @throws When the request fails (network, CORS, or a non-OK response)
 */
export async function searchOpenAerialMap(
  options: OpenAerialMapSearchOptions = {},
  fetchImpl: OamFetch = defaultFetch,
): Promise<OamSearchResult> {
  const limit = options.limit ?? 20;
  const page = options.page ?? 1;
  const response = await fetchImpl(buildSearchUrl({ ...options, limit, page }), options.signal);
  if (!response.ok) {
    throw new Error(`OpenAerialMap request failed (${response.status})`);
  }
  return parseSearchResponse(await response.json(), page, limit);
}
