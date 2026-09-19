import type { Feature, FeatureCollection, Geometry } from "geojson";

/**
 * IGN's Géoplateforme WFS. `data.geopf.fr` is the public successor to
 * `wxs.ign.fr`; the LiDAR HD tile index is published there as the
 * `IGNF_LIDAR-HD_METADONNEE:metadata` feature type, one feature per 1km x 1km
 * survey tile ("dalle").
 */
export const IGN_LIDAR_HD_WFS_ENDPOINT = "https://data.geopf.fr/wfs";
export const IGN_LIDAR_HD_TYPENAME = "IGNF_LIDAR-HD_METADONNEE:metadata";
export const IGN_LIDAR_HD_REQUEST_TIMEOUT_MS = 30_000;
// The layer covers all of metropolitan France and overseas territories
// (500k+ tiles nationally), so an unbounded query would scan the whole
// index. Bound both the query footprint and the page size a single search
// can return.
export const IGN_LIDAR_HD_MAX_QUERY_AREA_SQUARE_DEGREES = 2;
export const IGN_LIDAR_HD_MAX_RESULT_COUNT = 500;

/** One LiDAR HD survey tile from the WFS metadata layer. */
export interface IgnLidarHdTile {
  /** WFS feature id, e.g. "metadata.123456". */
  id: string;
  /** Tile grid coordinate, e.g. "0644-6860" (coordonnees_nw). */
  tileCoord: string | null;
  /** Acquisition mission code, e.g. "22LHDKE" (code_mission). */
  missionCode: string | null;
  /** Survey start date, "YYYY-MM-DD" (date_debut_acquisition). */
  acquisitionStart: string | null;
  /** Survey end date, "YYYY-MM-DD" (date_fin_acquisition). */
  acquisitionEnd: string | null;
  /** Point count for the tile (nombre_points), when published. */
  pointCount: number | null;
  /** HTTPS URL to the tile's COPC LAZ point cloud (url_npl), when published. */
  downloadUrl: string | null;
  /** Filename derived from downloadUrl, e.g. "LHD_FXX_0644_6860_..._IGN69.copc.laz". */
  filename: string | null;
  /** Tile footprint, as returned by the WFS (WGS84). */
  geometry: Geometry;
}

export interface IgnLidarHdSearchResult {
  tiles: IgnLidarHdTile[];
  /** Tile footprints as a FeatureCollection, ready for addGeoJsonLayer. */
  footprints: FeatureCollection;
  /** Total tiles the WFS matched, which may exceed tiles.length. */
  matched: number;
  /** True when the server-reported match count exceeds the returned page. */
  truncated: boolean;
}

interface RawIgnLidarFeature {
  id?: string;
  geometry?: Geometry | null;
  properties?: {
    coordonnees_nw?: unknown;
    code_mission?: unknown;
    date_debut_acquisition?: unknown;
    date_fin_acquisition?: unknown;
    nombre_points?: unknown;
    url_npl?: unknown;
  } | null;
}

interface RawIgnLidarFeatureCollection {
  features?: RawIgnLidarFeature[] | null;
  totalFeatures?: number | null;
  numberMatched?: number | null;
}

/** Whether a WFS-supplied URL is safe to use as a download link. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** date_debut_acquisition/date_fin_acquisition come back as "YYYY-MM-DDZ". */
function dateOrNull(value: unknown): string | null {
  const text = stringOrNull(value);
  return text ? text.replace(/Z$/, "") : null;
}

/** Render a WGS84 coordinate without exponent notation, which BBOX rejects. */
function formatDegree(value: number): string {
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

function validateBbox(bbox: [number, number, number, number]): [number, number, number, number] {
  const [west, south, east, north] = bbox;
  if (
    !bbox.every(Number.isFinite) ||
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    throw new Error("Invalid bounding box");
  }
  const area = (east - west) * (north - south);
  if (area > IGN_LIDAR_HD_MAX_QUERY_AREA_SQUARE_DEGREES) {
    throw new Error(
      `IGN LiDAR HD searches are limited to ${IGN_LIDAR_HD_MAX_QUERY_AREA_SQUARE_DEGREES} square degrees`,
    );
  }
  return bbox;
}

/**
 * Build a bounded WFS 2.0.0 GetFeature URL for the LiDAR HD tile index.
 *
 * The service reports its CRS as EPSG:4326 but, contrary to the WFS 2.0.0
 * axis-order convention, actually honors BBOX in lon,lat order. CRS84 is
 * requested explicitly instead of EPSG:4326 so the axis order is unambiguous
 * regardless of how a given deployment interprets the EPSG code.
 */
export function buildIgnLidarHdWfsUrl(
  bbox: [number, number, number, number],
  options: { count?: number } = {},
): string {
  const [west, south, east, north] = validateBbox(bbox);
  const count = Math.min(
    options.count ?? IGN_LIDAR_HD_MAX_RESULT_COUNT,
    IGN_LIDAR_HD_MAX_RESULT_COUNT,
  );
  const crs = "urn:ogc:def:crs:OGC:1.3:CRS84";
  const params = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    TYPENAMES: IGN_LIDAR_HD_TYPENAME,
    OUTPUTFORMAT: "application/json",
    SRSNAME: crs,
    COUNT: String(count),
    BBOX: [west, south, east, north].map(formatDegree).join(",") + `,${crs}`,
  });
  return `${IGN_LIDAR_HD_WFS_ENDPOINT}?${params.toString()}`;
}

function mapIgnLidarFeature(raw: RawIgnLidarFeature, index: number): IgnLidarHdTile | null {
  if (!raw.geometry) return null;
  const properties = raw.properties ?? {};
  const rawUrl = stringOrNull(properties.url_npl);
  const downloadUrl = rawUrl && isHttpsUrl(rawUrl) ? rawUrl : null;
  const pointCount =
    typeof properties.nombre_points === "number" && Number.isFinite(properties.nombre_points)
      ? properties.nombre_points
      : null;
  return {
    id: stringOrNull(raw.id) ?? `ign-lidar-hd-tile-${index}`,
    tileCoord: stringOrNull(properties.coordonnees_nw),
    missionCode: stringOrNull(properties.code_mission),
    acquisitionStart: dateOrNull(properties.date_debut_acquisition),
    acquisitionEnd: dateOrNull(properties.date_fin_acquisition),
    pointCount,
    downloadUrl,
    filename: downloadUrl ? (downloadUrl.split("/").pop() ?? null) : null,
    geometry: raw.geometry,
  };
}

/** Parse a WFS GetFeature JSON response into tiles and a footprint layer. */
export function parseIgnLidarHdFeatureCollection(
  payload: RawIgnLidarFeatureCollection,
): IgnLidarHdSearchResult {
  const rawFeatures = payload.features ?? [];
  const tiles: IgnLidarHdTile[] = [];
  const footprintFeatures: Feature[] = [];
  rawFeatures.forEach((raw, index) => {
    const tile = mapIgnLidarFeature(raw, index);
    if (!tile) return;
    tiles.push(tile);
    footprintFeatures.push({
      type: "Feature",
      id: tile.id,
      geometry: tile.geometry,
      properties: {
        tileCoord: tile.tileCoord,
        missionCode: tile.missionCode,
        acquisitionStart: tile.acquisitionStart,
        acquisitionEnd: tile.acquisitionEnd,
        pointCount: tile.pointCount,
        downloadUrl: tile.downloadUrl,
      },
    });
  });
  const matched = payload.numberMatched ?? payload.totalFeatures ?? tiles.length;
  return {
    tiles,
    footprints: { type: "FeatureCollection", features: footprintFeatures },
    matched,
    truncated: matched > tiles.length,
  };
}

export type IgnLidarHdFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

/** Query the IGN LiDAR HD WFS for tiles intersecting a WGS84 bounding box. */
export async function fetchIgnLidarHdTiles(
  bbox: [number, number, number, number],
  options: {
    count?: number;
    signal?: AbortSignal;
    fetchImpl?: IgnLidarHdFetch;
    timeoutMs?: number;
  } = {},
): Promise<IgnLidarHdSearchResult> {
  const url = buildIgnLidarHdWfsUrl(bbox, { count: options.count });
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as IgnLidarHdFetch);
  const requestController = new AbortController();
  const abortFromCaller = () => requestController.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () =>
      requestController.abort(new DOMException("IGN LiDAR HD request timed out", "TimeoutError")),
    options.timeoutMs ?? IGN_LIDAR_HD_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, { signal: requestController.signal });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text())
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      } catch {
        // The status is still useful when the service supplies no readable body.
      }
      throw new Error(
        `IGN LiDAR HD request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const payload = (await response.json()) as RawIgnLidarFeatureCollection;
    return parseIgnLidarHdFeatureCollection(payload);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
