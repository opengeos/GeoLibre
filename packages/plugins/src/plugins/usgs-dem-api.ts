/**
 * USGS The National Map (TNM) Elevation / DEM API client.
 *
 * Provides querying, filtering, and footprint generation for digital elevation
 * models from USGS The National Map (TNM) API services and 24K Topo Quad queries.
 */

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

/** Default USGS TNM Access API products endpoint. */
export const USGS_TNM_PRODUCTS_ENDPOINT = "https://tnmaccess.nationalmap.gov/api/v1/products";

/** Default USGS 24K Topo Quad Lookup endpoint. */
export const USGS_24K_QUAD_ENDPOINT =
  "https://carto.nationalmap.gov/arcgis/rest/services/USTopoAvailability/MapServer/0/query";

/** Regular expression for valid HTTP(S) URLs. */
export const HTTP_URL_RE = /^https?:\/\//i;

/** Common USGS DEM dataset definitions and human-friendly display names. */
export interface UsgsDemDatasetInfo {
  id: string;
  name: string;
  resolution: string;
  description: string;
}

export const USGS_DEM_DATASETS: readonly UsgsDemDatasetInfo[] = [
  {
    id: "dem-1m",
    name: "Digital Elevation Model (DEM) 1 meter",
    resolution: "1 meter (~1/30 arc-sec)",
    description: "High-resolution 1-meter bare-earth digital elevation model derived from LiDAR.",
  },
  {
    id: "ned-1-3",
    name: "National Elevation Dataset (NED) 1/3 arc-second",
    resolution: "1/3 arc-second (~10 meters)",
    description:
      "Standard seamless elevation dataset for the contiguous United States, Hawaii, and parts of Alaska.",
  },
  {
    id: "ned-1",
    name: "National Elevation Dataset (NED) 1 arc-second",
    resolution: "1 arc-second (~30 meters)",
    description: "Seamless nationwide coverage for the United States and territories.",
  },
  {
    id: "ned-1-9",
    name: "National Elevation Dataset (NED) 1/9 arc-second",
    resolution: "1/9 arc-second (~3 meters)",
    description: "High-resolution elevation data covering selected project areas.",
  },
  {
    id: "dem-1-3",
    name: "Digital Elevation Model (DEM) 1/3 arc-second",
    resolution: "1/3 arc-second (~10 meters)",
    description: "USGS 3DEP standard DEM 1/3 arc-second tiles.",
  },
  {
    id: "dem-1",
    name: "Digital Elevation Model (DEM) 1 arc-second",
    resolution: "1 arc-second (~30 meters)",
    description: "USGS 3DEP standard DEM 1 arc-second tiles.",
  },
  {
    id: "dem-1-9",
    name: "Digital Elevation Model (DEM) 1/9 arc-second",
    resolution: "1/9 arc-second (~3 meters)",
    description: "USGS 3DEP standard DEM 1/9 arc-second tiles.",
  },
  {
    id: "dem-2",
    name: "Digital Elevation Model (DEM) 2 arc-second",
    resolution: "2 arc-second (~60 meters)",
    description: "USGS standard DEM 2 arc-second elevation tiles (Alaska).",
  },
  {
    id: "alaska-5m",
    name: "Alaska 5 meter DEM",
    resolution: "5 meters",
    description: "High-resolution bare-earth DEM coverage across Alaska from IfSAR.",
  },
  {
    id: "opr-dem",
    name: "Original Product Resolution (OPR) Digital Elevation Model (DEM)",
    resolution: "Variable (Original source)",
    description: "Source-resolution digital elevation models produced by lidar or IfSAR surveys.",
  },
  {
    id: "lpc",
    name: "Lidar Point Cloud (LPC)",
    resolution: "Point Cloud (LAS/LAZ)",
    description: "USGS 3DEP raw point cloud source data.",
  },
] as const;

/** A normalized USGS DEM product item. */
export interface UsgsDemItem {
  id: string;
  sourceId: string;
  title: string;
  dataset: string;
  format: string;
  downloadUrl: string;
  metaUrl: string | null;
  previewUrl: string | null;
  sizeBytes: number | null;
  prettyFileSize: string | null;
  publicationDate: string | null;
  lastUpdated: string | null;
  spatialReference: string | null;
  /** Extent [west, south, east, north] in WGS84 degrees, or null when the API gave none. */
  bbox: [number, number, number, number] | null;
  raw: unknown;
}

/** GeoJSON footprint feature properties for USGS DEM items. */
export interface UsgsDemFootprintProps {
  id: string;
  sourceId: string;
  title: string;
  dataset: string;
  format: string;
  downloadUrl: string;
  metaUrl: string | null;
  previewUrl: string | null;
  fileSize: string | null;
  publicationDate: string | null;
  lastUpdated: string | null;
  spatialReference: string | null;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Result from a USGS DEM catalog search. */
export interface UsgsDemSearchResult {
  items: UsgsDemItem[];
  total: number;
  offset: number;
  messages: string[];
}

/** Search options for querying USGS DEMs. */
export interface UsgsDemSearchOptions {
  /** [west, south, east, north] bounding box in EPSG:4326 degrees. */
  bbox?: [number, number, number, number];
  /** Array of [lng, lat] vertices forming a closed polygon. */
  polygon?: [number, number][];
  /** List of dataset names to search. Defaults to DEM 1m, 1/3 arc-sec, 1 arc-sec. */
  datasets?: string[];
  /** Allowed formats (e.g. `["GeoTIFF"]` or `["IMG"]` or `["All"]`). */
  prodFormats?: string[];
  /** Maximum number of records to return (defaults to 100). */
  max?: number;
  /** Offset for pagination (0-based or 1-based, TNM API uses offset index). */
  offset?: number;
  /** Date type filter (e.g. "dateCreated", "lastUpdated"). */
  dateType?: string;
  /** Start date filter in YYYY-MM-DD format. */
  start?: string;
  /** End date filter in YYYY-MM-DD format. */
  end?: string;
  /** Whether to filter out redundant/duplicate DEM records. Defaults to true. */
  filterRedundant?: boolean;
  /** Custom endpoint override. */
  endpoint?: string;
  /** AbortSignal to cancel in-flight request. */
  signal?: AbortSignal;
}

export type UsgsDemFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetch: UsgsDemFetch = async (url, signal) => fetch(url, { signal });

/**
 * Extracts a normalized DEM name from raw USGS product titles to detect
 * partial or redundant duplicates (mirroring Python dem_getter behavior).
 */
export function extractRawDemName(title: string): string {
  if (!title) return "";
  let clean = title.trim();
  // Strip common USGS product prefixes and metadata suffixes
  clean = clean.replace(/^USGS\s+(?:NED|3DEP|1\/3\s+arc-second|1\s+arc-second|1m\s+)?/i, "");
  clean = clean.replace(/\s+(?:GeoTIFF|IMG|ArcGrid|1x1\s+degree|Shapefile).*$/i, "");
  // Normalize 1m DEM naming pattern like USGS_one_meter_x..._y...
  const match1m = clean.match(/x\d+y\d+/i);
  if (match1m) {
    return match1m[0].toLowerCase();
  }
  return clean.toLowerCase();
}

/**
 * Filters out redundant or duplicate DEM items from a list of products.
 */
export function filterRedundantDemItems(items: UsgsDemItem[]): UsgsDemItem[] {
  const seen = new Map<string, UsgsDemItem>();

  for (const item of items) {
    const key = extractRawDemName(item.title) || item.title || item.id;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }

    // Keep the one with a newer publication date or GeoTIFF format if preferred
    const existingDate = existing.publicationDate
      ? new Date(existing.publicationDate).getTime()
      : 0;
    const itemDate = item.publicationDate ? new Date(item.publicationDate).getTime() : 0;

    if (
      itemDate > existingDate ||
      (!existing.downloadUrl.endsWith(".tif") && item.downloadUrl.endsWith(".tif"))
    ) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

/**
 * Builds the USGS TNM Access API query URL from search options.
 */
export function buildUsgsDemSearchUrl(options: UsgsDemSearchOptions = {}): string {
  const base = (options.endpoint ?? USGS_TNM_PRODUCTS_ENDPOINT).replace(/\/+$/, "");
  const params = new URLSearchParams();

  // Datasets
  if (options.datasets && options.datasets.length > 0) {
    params.set("datasets", options.datasets.join(","));
  } else {
    params.set(
      "datasets",
      "Digital Elevation Model (DEM) 1 meter,National Elevation Dataset (NED) 1/3 arc-second,National Elevation Dataset (NED) 1 arc-second",
    );
  }

  // Bounding box: minX,minY,maxX,maxY (west, south, east, north)
  if (options.bbox) {
    const [w, s, e, n] = options.bbox;
    params.set("bbox", `${w},${s},${e},${n}`);
  }

  // Polygon
  if (options.polygon && options.polygon.length >= 3) {
    const coordsStr = JSON.stringify({
      type: "Polygon",
      coordinates: [options.polygon],
    });
    params.set("polygon", coordsStr);
  }

  // Formats
  if (
    options.prodFormats &&
    options.prodFormats.length > 0 &&
    !options.prodFormats.includes("All")
  ) {
    params.set("prodFormats", options.prodFormats.join(","));
  }

  // Limit / Paging
  if (options.max !== undefined && Number.isFinite(options.max)) {
    params.set("max", String(Math.max(1, options.max)));
  } else {
    params.set("max", "100");
  }

  if (options.offset !== undefined && Number.isFinite(options.offset)) {
    params.set("offset", String(Math.max(0, options.offset)));
  }

  // Date filters
  if (options.dateType) {
    params.set("dateType", options.dateType);
  }
  if (options.start) {
    params.set("start", options.start);
  }
  if (options.end) {
    params.set("end", options.end);
  }

  return `${base}?${params.toString()}`;
}

/**
 * Parses raw JSON body from the USGS TNM Access API.
 */
export function parseSearchResponse(
  body: unknown,
  filterRedundant: boolean = true,
): UsgsDemSearchResult {
  if (!body || typeof body !== "object") {
    return { items: [], total: 0, offset: 0, messages: [] };
  }

  const raw = body as {
    total?: number;
    items?: unknown[];
    offset?: number;
    messages?: string[];
  };

  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const normalizedItems: UsgsDemItem[] = [];

  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;

    const downloadUrl = String(item.downloadURL ?? item.downloadUrl ?? "");
    if (!downloadUrl) continue;
    // Fall back to the download URL so an id is stable across searches.
    const sourceId = String(item.sourceId ?? item.id ?? item.metaUrl ?? downloadUrl);
    const title = String(item.title ?? "USGS DEM");
    const dataset = String(item.datasetName ?? item.dataset ?? "USGS DEM");
    const format = String(item.format ?? item.prodFormat ?? "GeoTIFF");
    const metaUrl = item.metaUrl ? String(item.metaUrl) : null;
    const previewUrl = item.previewUrl
      ? String(item.previewUrl)
      : item.thumbUrl
        ? String(item.thumbUrl)
        : null;

    const sizeBytes = typeof item.sizeInBytes === "number" ? item.sizeInBytes : null;
    const prettyFileSize = item.prettyFileSize ? String(item.prettyFileSize) : null;
    const publicationDate = item.publicationDate ? String(item.publicationDate) : null;
    const lastUpdated = item.lastUpdated ? String(item.lastUpdated) : null;
    const spatialReference = item.spatialReference ? String(item.spatialReference) : null;

    // Bounds: API returns boundingBox: { minX, minY, maxX, maxY } or extent
    // Missing or non-numeric bounds stay unknown (null) rather than becoming a
    // whole-world footprint.
    let bbox: [number, number, number, number] | null = null;
    const boundingBox = item.boundingBox as Record<string, unknown> | undefined;
    if (boundingBox) {
      // Number(null) and Number("") are 0, so only numbers and non-blank
      // strings count as coordinates.
      const coord = (value: unknown): number =>
        typeof value === "number" || (typeof value === "string" && value.trim() !== "")
          ? Number(value)
          : NaN;
      const minX = coord(boundingBox.minX ?? boundingBox.west);
      const minY = coord(boundingBox.minY ?? boundingBox.south);
      const maxX = coord(boundingBox.maxX ?? boundingBox.east);
      const maxY = coord(boundingBox.maxY ?? boundingBox.north);
      if (
        Number.isFinite(minX) &&
        Number.isFinite(minY) &&
        Number.isFinite(maxX) &&
        Number.isFinite(maxY)
      ) {
        bbox = [minX, minY, maxX, maxY];
      }
    }

    normalizedItems.push({
      id: sourceId,
      sourceId,
      title,
      dataset,
      format,
      downloadUrl,
      metaUrl,
      previewUrl,
      sizeBytes,
      prettyFileSize,
      publicationDate,
      lastUpdated,
      spatialReference,
      bbox,
      raw: item,
    });
  }

  const items = filterRedundant ? filterRedundantDemItems(normalizedItems) : normalizedItems;
  const total = typeof raw.total === "number" ? raw.total : items.length;
  const offset = typeof raw.offset === "number" ? raw.offset : 0;
  const messages = Array.isArray(raw.messages) ? raw.messages.map(String) : [];

  return { items, total, offset, messages };
}

/**
 * Searches the USGS TNM API for Digital Elevation Models.
 */
export async function searchUsgsDem(
  options: UsgsDemSearchOptions = {},
  fetchImpl: UsgsDemFetch = defaultFetch,
): Promise<UsgsDemSearchResult> {
  const url = buildUsgsDemSearchUrl(options);
  const response = await fetchImpl(url, options.signal);

  if (!response.ok) {
    throw new Error(`USGS DEM search failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  const filterRedundant = options.filterRedundant ?? true;
  return parseSearchResponse(body, filterRedundant);
}

/**
 * Queries the USGS Topo Availability MapServer to get bounding box geometry
 * for a 24K Topo Quad name and state (e.g. "Mount St. Helens", "WA").
 */
export async function get24kQuadGeometry(
  quadName: string,
  stateName: string,
  fetchImpl: UsgsDemFetch = defaultFetch,
): Promise<{ bbox: [number, number, number, number]; geometry?: Polygon | MultiPolygon } | null> {
  const cleanQuad = quadName.trim();
  const cleanState = stateName.trim();
  if (!cleanQuad || !cleanState) return null;

  const whereClause = `CELL_NAME='${cleanQuad.replace(/'/g, "''")}' AND PRIMARY_STATE='${cleanState.toUpperCase().replace(/'/g, "''")}'`;
  const params = new URLSearchParams({
    where: whereClause,
    outFields: "CELL_NAME,PRIMARY_STATE",
    returnGeometry: "true",
    f: "geojson",
  });

  const url = `${USGS_24K_QUAD_ENDPOINT}?${params.toString()}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`USGS 24K Quad query failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    type?: string;
    features?: Array<{
      type?: string;
      geometry?: Polygon | MultiPolygon;
      bbox?: [number, number, number, number];
    }>;
  };

  if (!body.features || body.features.length === 0) {
    return null;
  }

  const first = body.features[0];
  if (!first) return null;

  if (first.bbox && first.bbox.length === 4) {
    return {
      bbox: [first.bbox[0], first.bbox[1], first.bbox[2], first.bbox[3]],
      geometry: first.geometry,
    };
  }

  if (first.geometry && first.geometry.type === "Polygon") {
    const coords = first.geometry.coordinates[0];
    if (coords && coords.length > 0) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of coords) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return {
        bbox: [minX, minY, maxX, maxY],
        geometry: first.geometry,
      };
    }
  }

  return null;
}

/**
 * Generates a GeoJSON Polygon feature for a DEM item's bounding box footprint.
 */
export function footprintFeature(
  item: UsgsDemItem,
): Feature<Polygon, UsgsDemFootprintProps> | null {
  if (!item.bbox) return null;
  const [w, s, e, n] = item.bbox;
  if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)) {
    return null;
  }

  const coordinates: [number, number][][] = [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ];

  return {
    type: "Feature",
    id: item.id,
    properties: {
      id: item.id,
      sourceId: item.sourceId,
      title: item.title,
      dataset: item.dataset,
      format: item.format,
      downloadUrl: item.downloadUrl,
      metaUrl: item.metaUrl,
      previewUrl: item.previewUrl,
      fileSize: item.prettyFileSize,
      publicationDate: item.publicationDate,
      lastUpdated: item.lastUpdated,
      spatialReference: item.spatialReference,
      west: w,
      south: s,
      east: e,
      north: n,
    },
    geometry: {
      type: "Polygon",
      coordinates,
    },
  };
}

/**
 * Builds a FeatureCollection of all valid footprint features for a list of DEM items.
 */
export function footprintCollection(
  items: UsgsDemItem[],
): FeatureCollection<Polygon, UsgsDemFootprintProps> {
  const features: Feature<Polygon, UsgsDemFootprintProps>[] = [];
  for (const item of items) {
    const feat = footprintFeature(item);
    if (feat) {
      features.push(feat);
    }
  }
  return {
    type: "FeatureCollection",
    features,
  };
}
