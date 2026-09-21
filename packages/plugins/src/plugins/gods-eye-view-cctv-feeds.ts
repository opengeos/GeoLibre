import type { CzmlPacket } from "@geolibre/core";
import type { Feature, Point } from "geojson";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";
import { isViteDevServer } from "./gods-eye-view-feeds";
import { viewportQueryBounds, type ViewBounds } from "./gods-eye-view-viewport-feeds";

export const CCTV_MAX_VIEW_SPAN_DEGREES = 5;
export const CCTV_QUERY_SNAP_DEGREES = 0.1;
export const CCTV_MAX_CAMERAS = 12;
export const CCTV_CATALOG_CACHE_MS = 15 * 60_000;
export const CCTV_CATALOG_FAILURE_CACHE_MS = 60_000;

export const TFL_CATALOG_URL = "https://api.tfl.gov.uk/Place/Type/JamCam";
export const CALGARY_CATALOG_URL = "https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500";
export const FINTRAFFIC_CATALOG_URL = "https://tie.digitraffic.fi/api/weathercam/v1/stations";
export const CCTV_CATALOG_EDGE_BASE = "https://tiles.geolibre.app/cctv/catalog";
export const CCTV_CATALOG_DEV_BASE = "/cctv/catalog";
export const CALGARY_FRAME_EDGE_BASE = "https://tiles.geolibre.app/cctv/calgary";
export const CALGARY_FRAME_DEV_BASE = "/cctv/calgary";
export const ONTARIO_FRAME_EDGE_BASE = "https://tiles.geolibre.app/cctv/ontario";
export const ONTARIO_FRAME_DEV_BASE = "/cctv/ontario";
export const NSW_FRAME_EDGE_BASE = "https://tiles.geolibre.app/cctv/nsw";
export const NSW_FRAME_DEV_BASE = "/cctv/nsw";

const TFL_IMAGE_ORIGIN = "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/";
const FINTRAFFIC_IMAGE_ORIGIN = "https://weathercam.digitraffic.fi/";
const DRIVEBC_IMAGE_ORIGIN = "https://www.drivebc.ca/images/";
const NSW_IMAGE_ORIGIN = "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
type CatalogCacheEntry =
  | { expiresAt: number; status: "fulfilled"; payload: unknown }
  | { expiresAt: number; status: "rejected"; error: unknown };

// Keep injected fetchers isolated so tests, embedded hosts, and the browser's
// native fetch cannot accidentally reuse one another's catalog responses.
const catalogCaches = new WeakMap<typeof fetch, Map<string, CatalogCacheEntry>>();

export interface CctvCamera {
  id: string;
  name: string;
  provider: string;
  longitude: number;
  latitude: number;
  snapshotUrl: string;
  attribution: string;
  refreshMs: number;
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validCoordinate(longitude: number | null, latitude: number | null): boolean {
  return (
    longitude !== null &&
    latitude !== null &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function catalogProxyUrl(provider: "ontario" | "drivebc" | "nsw", dev = isViteDevServer()): string {
  const base = dev
    ? `${globalThis.location?.origin ?? "http://localhost"}${CCTV_CATALOG_DEV_BASE}`
    : CCTV_CATALOG_EDGE_BASE;
  return `${base}/${provider}.json`;
}

function refreshedUrl(url: string, refreshMs: number, nowMs: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set("geolibre_frame", String(Math.floor(nowMs / refreshMs)));
  return parsed.toString();
}

export function normalizeTflCameras(payload: unknown): CctvCamera[] {
  if (!Array.isArray(payload)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of payload.slice(0, 2_000)) {
    if (!value || typeof value !== "object") continue;
    const place = value as Record<string, unknown>;
    const properties = Object.fromEntries(
      (Array.isArray(place.additionalProperties) ? place.additionalProperties : [])
        .filter((property): property is Record<string, unknown> =>
          Boolean(property && typeof property === "object"),
        )
        .map((property) => [String(property.key ?? ""), property.value]),
    );
    if (String(properties.available).toLowerCase() !== "true") continue;
    const longitude = finite(place.lon);
    const latitude = finite(place.lat);
    const image = text(properties.imageUrl);
    const rawId = text(place.id)?.replace(/^JamCams_/, "");
    if (!validCoordinate(longitude, latitude) || !image?.startsWith(TFL_IMAGE_ORIGIN) || !rawId) {
      continue;
    }
    cameras.push({
      id: `tfl-${rawId}`,
      name: text(place.commonName) ?? `TfL JamCam ${rawId}`,
      provider: "Transport for London",
      longitude: longitude as number,
      latitude: latitude as number,
      snapshotUrl: image,
      attribution: "Powered by TfL Open Data",
      refreshMs: 60_000,
    });
  }
  return cameras;
}

export function normalizeCalgaryCameras(payload: unknown, dev = isViteDevServer()): CctvCamera[] {
  if (!Array.isArray(payload)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of payload.slice(0, 1_000)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const point = row.point as { coordinates?: unknown } | undefined;
    const coordinates = Array.isArray(point?.coordinates) ? point.coordinates : [];
    const longitude = finite(coordinates[0]);
    const latitude = finite(coordinates[1]);
    const cameraUrl = row.camera_url as { url?: unknown; description?: unknown } | undefined;
    const sourceUrl = text(cameraUrl?.url)?.replace(/^http:\/\//i, "https://");
    let frameId: string | null = null;
    try {
      const parsed = new URL(sourceUrl ?? "");
      const match =
        parsed.protocol === "https:" && parsed.hostname === "trafficcam.calgary.ca"
          ? parsed.pathname.match(/^\/loc(\d{1,4})\.jpg$/i)
          : null;
      frameId = match?.[1] ?? null;
    } catch {
      frameId = null;
    }
    if (!validCoordinate(longitude, latitude) || !frameId) continue;
    const base = dev
      ? `${globalThis.location?.origin ?? "http://localhost"}${CALGARY_FRAME_DEV_BASE}`
      : CALGARY_FRAME_EDGE_BASE;
    cameras.push({
      id: `calgary-${frameId}`,
      name:
        text(row.camera_location) ?? text(cameraUrl?.description) ?? `Calgary Camera ${frameId}`,
      provider: "The City of Calgary",
      longitude: longitude as number,
      latitude: latitude as number,
      snapshotUrl: `${base}/${encodeURIComponent(frameId)}.jpg`,
      attribution:
        "Contains information licensed under the Open Government Licence – City of Calgary",
      refreshMs: 60_000,
    });
  }
  return cameras;
}

export function normalizeFintrafficCameras(payload: unknown): CctvCamera[] {
  if (!payload || typeof payload !== "object") return [];
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of features.slice(0, 2_000)) {
    if (!value || typeof value !== "object") continue;
    const feature = value as Record<string, unknown>;
    const geometry = feature.geometry as { coordinates?: unknown } | undefined;
    const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
    const longitude = finite(coordinates[0]);
    const latitude = finite(coordinates[1]);
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const stationId = text(properties.id);
    if (
      !validCoordinate(longitude, latitude) ||
      !stationId ||
      String(properties.collectionStatus).toUpperCase() !== "GATHERING"
    ) {
      continue;
    }
    const presets = Array.isArray(properties.presets) ? properties.presets : [];
    for (const presetValue of presets.slice(0, 20)) {
      if (!presetValue || typeof presetValue !== "object") continue;
      const preset = presetValue as Record<string, unknown>;
      const presetId = text(preset.id);
      if (
        preset.inCollection !== true ||
        !presetId ||
        !/^C\d{7}$/.test(presetId) ||
        !presetId.startsWith(stationId)
      ) {
        continue;
      }
      cameras.push({
        id: `fintraffic-${presetId.toLowerCase()}`,
        name: `${text(properties.name) ?? stationId} · ${presetId.slice(-2)}`,
        provider: "Fintraffic",
        longitude: longitude as number,
        latitude: latitude as number,
        snapshotUrl: `${FINTRAFFIC_IMAGE_ORIGIN}${presetId}.jpg`,
        attribution: "Fintraffic / digitraffic.fi (CC BY 4.0)",
        refreshMs: 10 * 60_000,
      });
    }
  }
  return cameras;
}

export function normalizeOntarioCameras(payload: unknown, dev = isViteDevServer()): CctvCamera[] {
  if (!Array.isArray(payload)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of payload.slice(0, 2_000)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const rawIdValue = row.Id ?? row.id;
    const rawId =
      typeof rawIdValue === "string" || typeof rawIdValue === "number"
        ? String(rawIdValue).trim()
        : "";
    const longitude = finite(row.Longitude ?? row.longitude);
    const latitude = finite(row.Latitude ?? row.latitude);
    if (
      !/^\d+$/.test(rawId) ||
      !validCoordinate(longitude, latitude) ||
      (latitude as number) < 41 ||
      (latitude as number) > 57.5 ||
      (longitude as number) < -95.6 ||
      (longitude as number) > -74
    ) {
      continue;
    }
    const views = Array.isArray(row.Views ?? row.views) ? (row.Views ?? row.views) : [];
    const enabled = (views as unknown[])
      .filter((view): view is Record<string, unknown> => Boolean(view && typeof view === "object"))
      .filter((view) => String(view.Status ?? view.status).toLowerCase() === "enabled")
      .map((view) => {
        const source = text(view.Url ?? view.url);
        const description = text(view.Description ?? view.description) ?? "";
        try {
          const parsed = new URL(source ?? "");
          const match = parsed.pathname.match(/^\/map\/Cctv\/([A-Za-z0-9_.-]{1,64})$/);
          const host = parsed.hostname.toLowerCase();
          if (parsed.protocol !== "https:" || host !== "511on.ca" || !match) {
            return null;
          }
          return {
            description,
            frameId: match[1],
          };
        } catch {
          return null;
        }
      })
      .filter((view): view is { description: string; frameId: string } => view !== null);
    const view =
      enabled.find((candidate) => !/^looking down[.!]?$/i.test(candidate.description)) ??
      enabled[0];
    if (!view) continue;
    const frameBase = dev
      ? `${globalThis.location?.origin ?? "http://localhost"}${ONTARIO_FRAME_DEV_BASE}`
      : ONTARIO_FRAME_EDGE_BASE;
    const location = text(row.Location ?? row.location);
    const roadway = text(row.Roadway ?? row.roadway);
    cameras.push({
      id: `ontario-${rawId}`,
      name: [location ?? roadway ?? `Ontario 511 Camera ${rawId}`, view.description]
        .filter(Boolean)
        .join(" · "),
      provider: "Ontario 511",
      longitude: longitude as number,
      latitude: latitude as number,
      snapshotUrl: `${frameBase}/${encodeURIComponent(view.frameId)}`,
      attribution: "Open Government Licence – Ontario",
      refreshMs: 60_000,
    });
  }
  return cameras;
}

export function normalizeDriveBcCameras(payload: unknown): CctvCamera[] {
  if (!Array.isArray(payload)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of payload.slice(0, 2_000)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const rawId = finite(row.id);
    const location = row.location as { coordinates?: unknown } | undefined;
    const coordinates = Array.isArray(location?.coordinates) ? location.coordinates : [];
    const longitude = finite(coordinates[0]);
    const latitude = finite(coordinates[1]);
    if (
      row.is_on !== true ||
      row.should_appear !== true ||
      rawId === null ||
      !Number.isSafeInteger(rawId) ||
      rawId <= 0 ||
      !validCoordinate(longitude, latitude) ||
      (latitude as number) < 48 ||
      (latitude as number) > 61 ||
      (longitude as number) < -139.1 ||
      (longitude as number) > -113.5
    ) {
      continue;
    }
    cameras.push({
      id: `drivebc-${rawId}`,
      name: text(row.name) ?? `DriveBC Camera ${rawId}`,
      provider: "DriveBC",
      longitude: longitude as number,
      latitude: latitude as number,
      snapshotUrl: `${DRIVEBC_IMAGE_ORIGIN}${rawId}.jpg`,
      attribution: "DriveBC, Open Government Licence – British Columbia",
      refreshMs: 10 * 60_000,
    });
  }
  return cameras;
}

export function normalizeNswCameras(payload: unknown, dev = isViteDevServer()): CctvCamera[] {
  if (!payload || typeof payload !== "object") return [];
  const features = (payload as { features?: unknown }).features;
  if (!Array.isArray(features)) return [];
  const cameras: CctvCamera[] = [];
  for (const value of features.slice(0, 1_000)) {
    if (!value || typeof value !== "object") continue;
    const feature = value as Record<string, unknown>;
    const rawId = text(feature.id);
    const geometry = feature.geometry as { coordinates?: unknown } | undefined;
    const coordinates = Array.isArray(geometry?.coordinates) ? geometry.coordinates : [];
    const longitude = finite(coordinates[0]);
    const latitude = finite(coordinates[1]);
    if (
      !rawId ||
      !/^[A-Za-z0-9-]{1,100}$/.test(rawId) ||
      !validCoordinate(longitude, latitude) ||
      (latitude as number) < -38 ||
      (latitude as number) > -28 ||
      (longitude as number) < 140.8 ||
      (longitude as number) > 154
    ) {
      continue;
    }
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const source = text(properties.href);
    let frameId: string | null = null;
    try {
      const parsed = new URL(source ?? "");
      const prefix = new URL(NSW_IMAGE_ORIGIN);
      const filename = parsed.pathname.startsWith(prefix.pathname)
        ? parsed.pathname.slice(prefix.pathname.length)
        : "";
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === prefix.hostname &&
        /^[a-z0-9_.&-]{1,100}\.(?:jpe?g)$/i.test(filename)
      ) {
        frameId = filename;
      }
    } catch {
      frameId = null;
    }
    if (!frameId) continue;
    const view = text(properties.view);
    const title = text(properties.title);
    const name = view && view.length <= 140 && !/[\r\n]/.test(view) ? view : title;
    const frameBase = dev
      ? `${globalThis.location?.origin ?? "http://localhost"}${NSW_FRAME_DEV_BASE}`
      : NSW_FRAME_EDGE_BASE;
    cameras.push({
      id: `nsw-${rawId}`,
      name: name ?? `Live Traffic NSW Camera ${rawId}`,
      provider: "Live Traffic NSW",
      longitude: longitude as number,
      latitude: latitude as number,
      snapshotUrl: `${frameBase}/${encodeURIComponent(frameId)}`,
      attribution: "Live Traffic NSW — Transport for NSW (CC BY 4.0)",
      refreshMs: 60_000,
    });
  }
  return cameras;
}

function selectViewportCameras(cameras: CctvCamera[], bounds: ViewBounds): CctvCamera[] {
  const [west, south, east, north] = bounds;
  const centerLongitude = west + (east - west) / 2;
  const centerLatitude = south + (north - south) / 2;
  const selected = cameras.filter(
    (camera) =>
      camera.longitude >= west &&
      camera.longitude <= east &&
      camera.latitude >= south &&
      camera.latitude <= north,
  );
  selected.sort((left, right) => {
    const leftDistance =
      (left.longitude - centerLongitude) ** 2 + (left.latitude - centerLatitude) ** 2;
    const rightDistance =
      (right.longitude - centerLongitude) ** 2 + (right.latitude - centerLatitude) ** 2;
    return leftDistance - rightDistance;
  });
  return selected.slice(0, CCTV_MAX_CAMERAS);
}

export function cctvCamerasToCzml(
  cameras: CctvCamera[],
  nowMs = Date.now(),
): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [{ id: "document", name: "Public CCTV Cameras", version: "1.0" }];
  const features: Feature<Point>[] = [];
  for (const camera of cameras) {
    const snapshot = refreshedUrl(camera.snapshotUrl, camera.refreshMs, nowMs);
    const properties = {
      name: camera.name,
      provider: camera.provider,
      snapshot,
      attribution: camera.attribution,
      privacy: "Public traffic/weather image; may contain people, vehicles, or license plates.",
    };
    packets.push({
      id: `cctv-${camera.id}`,
      name: camera.name,
      position: { cartographicDegrees: [camera.longitude, camera.latitude, 4] },
      properties,
      billboard: {
        image: snapshot,
        width: 80,
        height: 45,
        verticalOrigin: "BOTTOM",
        heightReference: "RELATIVE_TO_GROUND",
        pixelOffset: { cartesian2: [0, -8] },
        scaleByDistance: { nearFarScalar: [500, 0.8, 50_000, 0.25] },
        distanceDisplayCondition: { distanceDisplayCondition: [0, 300_000] },
      },
    });
    features.push({
      type: "Feature",
      id: `cctv-${camera.id}`,
      geometry: { type: "Point", coordinates: [camera.longitude, camera.latitude] },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

async function fetchCatalog<T>(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  normalize: (payload: unknown) => T,
  headers?: HeadersInit,
): Promise<T> {
  let catalogCache = catalogCaches.get(fetcher);
  if (!catalogCache) {
    catalogCache = new Map();
    catalogCaches.set(fetcher, catalogCache);
  }
  const cached = catalogCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.status === "rejected") throw cached.error;
    return cached.payload as T;
  }
  try {
    const response = await fetcher(url, { headers, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`CCTV catalog failed (${response.status})`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
      throw new Error("CCTV catalog is too large");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("CCTV catalog has no response body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("CCTV catalog is too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = normalize(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    catalogCache.set(url, {
      expiresAt: Date.now() + CCTV_CATALOG_CACHE_MS,
      status: "fulfilled",
      payload,
    });
    return payload;
  } catch (error) {
    if (!signal?.aborted) {
      catalogCache.set(url, {
        expiresAt: Date.now() + CCTV_CATALOG_FAILURE_CACHE_MS,
        status: "rejected",
        error,
      });
    }
    throw error;
  }
}

export async function fetchCctvCzml(
  bounds: ViewBounds | null,
  options: { fetch?: typeof fetch; signal?: AbortSignal; nowMs?: number } = {},
): Promise<GodsEyeViewFeedPayload> {
  const queryBounds = viewportQueryBounds(
    bounds,
    CCTV_MAX_VIEW_SPAN_DEGREES,
    CCTV_QUERY_SNAP_DEGREES,
  );
  if (!queryBounds) return cctvCamerasToCzml([], options.nowMs);
  const fetcher = options.fetch ?? fetch;
  // These providers expose only bounded global/city catalogs, not bbox APIs.
  // Cache each normalized catalog, then apply the snapped viewport locally.
  const results = await Promise.allSettled([
    fetchCatalog(TFL_CATALOG_URL, fetcher, options.signal, normalizeTflCameras),
    fetchCatalog(CALGARY_CATALOG_URL, fetcher, options.signal, normalizeCalgaryCameras),
    fetchCatalog(FINTRAFFIC_CATALOG_URL, fetcher, options.signal, normalizeFintrafficCameras, {
      Accept: "application/json",
      "Digitraffic-User": "GeoLibre/3.0 (+https://geolibre.org)",
    }),
    fetchCatalog(catalogProxyUrl("ontario"), fetcher, options.signal, normalizeOntarioCameras),
    fetchCatalog(catalogProxyUrl("drivebc"), fetcher, options.signal, normalizeDriveBcCameras),
    fetchCatalog(catalogProxyUrl("nsw"), fetcher, options.signal, normalizeNswCameras),
  ]);
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("CCTV request aborted", "AbortError");
  }
  const cameras = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error("Every CCTV provider failed");
  }
  return cctvCamerasToCzml(selectViewportCameras(cameras, queryBounds), options.nowMs);
}
