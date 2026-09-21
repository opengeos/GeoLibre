import type { CzmlPacket } from "@geolibre/core";
import type { Feature, FeatureCollection, Point } from "geojson";
import { PbfReader } from "pbf";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";
import { isViteDevServer } from "./gods-eye-view-feeds";

/**
 * Keyless, openly licensed GTFS-Realtime VehiclePositions feeds.
 *
 * The registry and compact wire decoder follow the normalization approach used
 * by the MIT-licensed bilawalsidhu/gods-eye-view project. GeoLibre reads Entur
 * directly and reaches the six non-CORS operators through fixed relay routes.
 */
export const ENTUR_TRANSIT_URL = "https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions";
export const ENTUR_CLIENT_NAME = "GeoLibre-Gods-Eye-View";
export const TRANSIT_EDGE_BASE = "https://tiles.geolibre.app/transit/vehicles";
export const TRANSIT_DEV_BASE = "/transit/vehicles";
export const GTFS_MAX_ENTITIES = 50_000;
/**
 * Ceiling on the merged vehicle count across every provider.
 *
 * `GTFS_MAX_ENTITIES` bounds one feed, not the fan-out: seven feeds each just
 * under that cap would hand Cesium and deck.gl ~350k packets every refresh.
 * 100k is roughly ten times the real-world combined count, so a misbehaving
 * upstream is bounded without ever trimming a healthy snapshot.
 */
export const TRANSIT_MAX_MERGED_VEHICLES = 100_000;
export const GTFS_MAX_STRING_CHARS = 256;
export const GTFS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const EARTH_RADIUS_METERS = 6_378_137;
const TRANSIT_COAST_SECONDS = 45;

export type TransitMode = "bus" | "tram" | "subway" | "rail" | "ferry" | "unknown";

export interface TransitFeedDefinition {
  id: string;
  name: string;
  operator: string;
  attribution: string;
  directUrl?: string;
  headers?: Readonly<Record<string, string>>;
  defaultMode: TransitMode;
  routeMode?: (routeId: string | null) => TransitMode;
}

function mbtaRouteMode(routeId: string | null): TransitMode {
  if (!routeId) return "unknown";
  if (/^(Red|Orange|Blue)\b/.test(routeId)) return "subway";
  if (/^(Green|Mattapan)/.test(routeId)) return "tram";
  if (/^CR-/.test(routeId)) return "rail";
  if (/^Boat-/.test(routeId)) return "ferry";
  return "bus";
}

function enturRouteMode(routeId: string | null): TransitMode {
  return routeId && ENTUR_RAIL_OPERATOR_CODES.has(routeId.split(":")[0]) ? "rail" : "bus";
}

function hslRouteMode(routeId: string | null): TransitMode {
  if (!routeId) return "unknown";
  if (/^31M/.test(routeId)) return "subway";
  if (/^10(0[1-9]|10|15)/.test(routeId)) return "tram";
  if (/^1019/.test(routeId)) return "ferry";
  if (/^300[0-9A-Z]/.test(routeId)) return "rail";
  return "bus";
}

function metroTransitRouteMode(routeId: string | null): TransitMode {
  if (routeId === "901" || routeId === "902") return "tram";
  if (routeId === "888") return "rail";
  return routeId ? "bus" : "unknown";
}

/** The seven keyless, openly licensed VehiclePositions feeds used upstream. */
export const TRANSIT_FEEDS = [
  {
    id: "mbta",
    name: "MBTA",
    operator: "Massachusetts Bay Transportation Authority",
    attribution: "MBTA / MassDOT",
    defaultMode: "bus",
    routeMode: mbtaRouteMode,
  },
  {
    id: "capmetro-austin",
    name: "CapMetro",
    operator: "Capital Metropolitan Transportation Authority",
    attribution: "Capital Metropolitan Transportation Authority, data.texas.gov",
    defaultMode: "bus",
  },
  {
    id: "metrotransit-msp",
    name: "Metro Transit",
    operator: "Metro Transit (Metropolitan Council)",
    attribution: "Metro Transit, Metropolitan Council",
    defaultMode: "bus",
    routeMode: metroTransitRouteMode,
  },
  {
    id: "hsl-helsinki",
    name: "HSL",
    operator: "Helsinki Region Transport (HSL)",
    attribution: "HSL (Helsinki Region Transport), CC BY 4.0",
    defaultMode: "bus",
    routeMode: hslRouteMode,
  },
  {
    id: "ovapi-nl",
    name: "OVapi",
    operator: "Stichting OpenGeo (NDOV data)",
    attribution: "OVapi / Stichting OpenGeo",
    defaultMode: "bus",
  },
  {
    id: "entur-norway",
    name: "Entur",
    operator: "Entur",
    attribution: "Entur, data under NLOD",
    directUrl: ENTUR_TRANSIT_URL,
    headers: { "ET-Client-Name": ENTUR_CLIENT_NAME },
    defaultMode: "bus",
    routeMode: enturRouteMode,
  },
  {
    id: "translink-seq",
    name: "TransLink",
    operator: "TransLink (Queensland Government)",
    attribution: "TransLink, Queensland Government, CC BY 4.0",
    defaultMode: "bus",
  },
] as const satisfies readonly TransitFeedDefinition[];

export type TransitFeedId = (typeof TRANSIT_FEEDS)[number]["id"];

/** Look up a registered feed, failing loudly rather than yielding `undefined`. */
function transitFeedById(id: TransitFeedId): TransitFeedDefinition {
  const feed = TRANSIT_FEEDS.find((candidate) => candidate.id === id);
  if (!feed) throw new Error(`TRANSIT_FEEDS is missing the ${id} entry`);
  return feed;
}

/**
 * Entur, the feed the exported decoder helpers default to.
 *
 * Resolved by `id` rather than by array position so reordering or inserting a
 * registry entry cannot silently repoint those public defaults. The id is typed
 * against the registry, so renaming the entry is a compile error rather than an
 * `undefined` that only surfaces as a `TypeError` at the call site.
 */
const ENTUR_FEED = transitFeedById("entur-norway");

interface GtfsTripDescriptor {
  tripId?: string | null;
  routeId?: string | null;
  oversize?: boolean;
}

interface GtfsPosition {
  latitude?: number;
  longitude?: number;
  bearing?: number;
  speed?: number;
}

interface GtfsVehicleDescriptor {
  id?: string | null;
  label?: string | null;
  oversize?: boolean;
}

interface GtfsVehiclePosition {
  trip?: GtfsTripDescriptor;
  position?: GtfsPosition;
  timestamp?: number;
  stopId?: string | null;
  vehicle?: GtfsVehicleDescriptor;
  oversize?: boolean;
}

interface GtfsFeedEntity {
  id?: string | null;
  isDeleted?: boolean;
  vehicle?: GtfsVehiclePosition;
  oversize?: boolean;
}

interface GtfsFeedHeader {
  version?: string | null;
  timestamp?: number;
  oversize?: boolean;
}

interface GtfsFeedMessage {
  header: GtfsFeedHeader;
  entities: GtfsFeedEntity[];
  truncated: boolean;
}

export interface TransitVehicle {
  id: string;
  longitude: number;
  latitude: number;
  bearing: number | null;
  speedMps: number | null;
  observedAtMs: number | null;
  routeId: string | null;
  tripId: string | null;
  label: string | null;
  stopId: string | null;
  mode: TransitMode;
}

export interface TransitSnapshot {
  version: string | null;
  timestampMs: number | null;
  decodedEntityCount: number;
  truncated: boolean;
  vehicles: TransitVehicle[];
}

function readBoundedString(pbf: PbfReader, target: { oversize?: boolean }): string | null {
  const value = pbf.readString();
  if (value.length <= GTFS_MAX_STRING_CHARS) return value;
  target.oversize = true;
  return null;
}

function readFeedHeader(tag: number, header: GtfsFeedHeader, pbf: PbfReader): void {
  if (tag === 1) header.version = readBoundedString(pbf, header);
  else if (tag === 3) header.timestamp = pbf.readVarint();
}

function readTripDescriptor(tag: number, trip: GtfsTripDescriptor, pbf: PbfReader): void {
  if (tag === 1) trip.tripId = readBoundedString(pbf, trip);
  else if (tag === 5) trip.routeId = readBoundedString(pbf, trip);
}

function readPosition(tag: number, position: GtfsPosition, pbf: PbfReader): void {
  if (tag === 1) position.latitude = pbf.readFloat();
  else if (tag === 2) position.longitude = pbf.readFloat();
  else if (tag === 3) position.bearing = pbf.readFloat();
  else if (tag === 5) position.speed = pbf.readFloat();
}

function readVehicleDescriptor(tag: number, vehicle: GtfsVehicleDescriptor, pbf: PbfReader): void {
  if (tag === 1) vehicle.id = readBoundedString(pbf, vehicle);
  else if (tag === 2) vehicle.label = readBoundedString(pbf, vehicle);
}

function readVehiclePosition(tag: number, vehicle: GtfsVehiclePosition, pbf: PbfReader): void {
  if (tag === 1) vehicle.trip = pbf.readMessage(readTripDescriptor, {});
  else if (tag === 2) vehicle.position = pbf.readMessage(readPosition, {});
  else if (tag === 5) vehicle.timestamp = pbf.readVarint();
  else if (tag === 7) vehicle.stopId = readBoundedString(pbf, vehicle);
  else if (tag === 8) vehicle.vehicle = pbf.readMessage(readVehicleDescriptor, {});
}

function readFeedEntity(tag: number, entity: GtfsFeedEntity, pbf: PbfReader): void {
  if (tag === 1) entity.id = readBoundedString(pbf, entity);
  else if (tag === 2) entity.isDeleted = pbf.readBoolean();
  else if (tag === 4) entity.vehicle = pbf.readMessage(readVehiclePosition, {});
}

function readFeedMessage(tag: number, message: GtfsFeedMessage, pbf: PbfReader): void {
  if (tag === 1) message.header = pbf.readMessage(readFeedHeader, {});
  else if (tag === 2) {
    if (message.entities.length >= GTFS_MAX_ENTITIES) {
      message.truncated = true;
      return;
    }
    message.entities.push(pbf.readMessage(readFeedEntity, {}));
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Entur operator codes known to run rail. Best effort — extend as needed. */
const ENTUR_RAIL_OPERATOR_CODES = new Set(["VYG", "GJB", "SJN", "FLT", "GOA", "NSB", "VYT", "FLB"]);

function normalizeVehicleEntity(
  entity: GtfsFeedEntity,
  feed: TransitFeedDefinition,
): TransitVehicle | null {
  if (entity.isDeleted === true) return null;
  const vehicle = entity.vehicle;
  const position = vehicle?.position;
  if (!vehicle || !position) return null;
  // One oversize string drops the whole record rather than just that field: a
  // 256-character id or label means the payload is malformed or hostile, and
  // the rest of it has not earned any more trust than the part that failed.
  if (entity.oversize || vehicle.oversize || vehicle.trip?.oversize || vehicle.vehicle?.oversize) {
    return null;
  }
  const latitude = finite(position.latitude);
  const longitude = finite(position.longitude);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6)
  ) {
    return null;
  }
  const id = text(vehicle.vehicle?.id) ?? text(entity.id);
  if (!id) return null;
  const routeId = text(vehicle.trip?.routeId);
  const bearing = finite(position.bearing);
  const speed = finite(position.speed);
  return {
    id,
    longitude,
    latitude,
    bearing: bearing === null ? null : ((bearing % 360) + 360) % 360,
    speedMps: speed === null || speed < 0 ? null : speed,
    observedAtMs:
      Number.isFinite(vehicle.timestamp) && (vehicle.timestamp as number) > 0
        ? (vehicle.timestamp as number) * 1000
        : null,
    routeId,
    tripId: text(vehicle.trip?.tripId),
    label: text(vehicle.vehicle?.label),
    stopId: text(vehicle.stopId),
    mode: feed.routeMode?.(routeId) ?? feed.defaultMode,
  };
}

/** Decode the bounded subset of GTFS-Realtime used by the Transit feed. */
export function decodeGtfsRealtimeVehicles(bytes: Uint8Array | ArrayBuffer): TransitSnapshot {
  return decodeTransitFeed(bytes, ENTUR_FEED);
}

/** Decode and normalize one registered GTFS-Realtime feed. */
export function decodeTransitFeed(
  bytes: Uint8Array | ArrayBuffer,
  feed: TransitFeedDefinition,
): TransitSnapshot {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > GTFS_MAX_RESPONSE_BYTES) {
    throw new Error(`${feed.name} GTFS-Realtime response exceeds the 8 MiB limit`);
  }
  const message = new PbfReader(view).readFields<GtfsFeedMessage>(readFeedMessage, {
    header: {},
    entities: [],
    truncated: false,
  });
  const byId = new Map<string, TransitVehicle>();
  for (const entity of message.entities) {
    const vehicle = normalizeVehicleEntity(entity, feed);
    if (!vehicle) continue;
    const existing = byId.get(vehicle.id);
    if (!existing || (vehicle.observedAtMs ?? 0) >= (existing.observedAtMs ?? 0)) {
      byId.set(vehicle.id, vehicle);
    }
  }
  const headerTimestamp = finite(message.header.timestamp);
  return {
    version: text(message.header.version),
    timestampMs: headerTimestamp !== null && headerTimestamp > 0 ? headerTimestamp * 1000 : null,
    decodedEntityCount: message.entities.length,
    truncated: message.truncated,
    vehicles: [...byId.values()],
  };
}

function predictPosition(
  vehicle: TransitVehicle,
  elapsedSeconds: number,
): [longitude: number, latitude: number, altitude: number] {
  // A speed without a course cannot be projected responsibly. Keep that
  // vehicle at its reported coordinate until a later snapshot supplies both.
  const speed = vehicle.bearing === null ? 0 : (vehicle.speedMps ?? 0);
  const bearing = ((vehicle.bearing ?? 0) * Math.PI) / 180;
  const angularDistance = (Math.max(0, elapsedSeconds) * speed) / EARTH_RADIUS_METERS;
  const latitude = (vehicle.latitude * Math.PI) / 180;
  const longitude = (vehicle.longitude * Math.PI) / 180;
  const predictedLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const predictedLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(predictedLatitude),
    );
  return [
    (((((predictedLongitude * 180) / Math.PI + 180) % 360) + 360) % 360) - 180,
    (predictedLatitude * 180) / Math.PI,
    3,
  ];
}

/** Convert current vehicle observations into a short interpolated CZML window. */
export function transitVehiclesToCzml(
  vehicles: readonly TransitVehicle[],
  now: Date,
  feed: TransitFeedDefinition = ENTUR_FEED,
): GodsEyeViewFeedPayload {
  const stop = new Date(now.getTime() + TRANSIT_COAST_SECONDS * 1000);
  // No document `clock`: the feed does not set `ownsClockWindow`, and the CZML
  // synchronizer elects the first loaded document that carries one. A refresh
  // reuses this layer id, so the elected owner never changes and the clock
  // would stay clamped to the first 45-second coast window while later
  // snapshots — whose entities only become available after it — went unseen.
  const packets: CzmlPacket[] = [{ id: "document", name: "Live Transit", version: "1.0" }];
  const features: Feature[] = [];
  const modeColors: Record<TransitMode, [number, number, number, number]> = {
    bus: [83, 226, 167, 255],
    tram: [255, 194, 74, 255],
    subway: [255, 69, 56, 255],
    rail: [217, 166, 255, 255],
    ferry: [95, 214, 255, 255],
    unknown: [216, 221, 229, 255],
  };
  const modePixelSizes: Record<TransitMode, number> = {
    bus: 7,
    tram: 7,
    subway: 8,
    rail: 8,
    ferry: 8,
    unknown: 7,
  };
  for (const vehicle of vehicles) {
    const ageSeconds = vehicle.observedAtMs
      ? Math.max(0, Math.min(60, (now.getTime() - vehicle.observedAtMs) / 1000))
      : 0;
    const current = predictPosition(vehicle, ageSeconds);
    const future = predictPosition(vehicle, ageSeconds + TRANSIT_COAST_SECONDS);
    const id = `transit-${feed.id}-${vehicle.id}`;
    const properties = {
      vehicleId: vehicle.id,
      provider: feed.name,
      operator: feed.operator,
      attribution: feed.attribution,
      mode: vehicle.mode,
      ...(vehicle.label ? { label: vehicle.label } : {}),
      ...(vehicle.routeId ? { routeId: vehicle.routeId } : {}),
      ...(vehicle.tripId ? { tripId: vehicle.tripId } : {}),
      ...(vehicle.stopId ? { stopId: vehicle.stopId } : {}),
      ...(vehicle.speedMps !== null ? { speedMps: Math.round(vehicle.speedMps * 10) / 10 } : {}),
      ...(vehicle.bearing !== null ? { bearing: Math.round(vehicle.bearing) } : {}),
      ...(vehicle.observedAtMs ? { observedAt: new Date(vehicle.observedAtMs).toISOString() } : {}),
    };
    packets.push({
      id,
      name: vehicle.label ?? vehicle.routeId ?? vehicle.id,
      availability: `${now.toISOString()}/${stop.toISOString()}`,
      position: {
        epoch: now.toISOString(),
        cartographicDegrees: [0, ...current, TRANSIT_COAST_SECONDS, ...future],
        interpolationAlgorithm: "LINEAR",
        interpolationDegree: 1,
      },
      properties,
      point: {
        pixelSize: modePixelSizes[vehicle.mode],
        color: { rgba: modeColors[vehicle.mode] },
        outlineColor: { rgba: [0, 0, 0, 190] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: current } satisfies Point,
      properties,
    });
  }
  return {
    packets,
    attributes: { type: "FeatureCollection", features } as FeatureCollection,
  };
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > GTFS_MAX_RESPONSE_BYTES) {
    throw new Error("GTFS-Realtime response exceeds the 8 MiB limit");
  }
  if (!response.body) {
    // Synthetic and nonstandard Response implementations may not expose a
    // stream. Their arrayBuffer API cannot stop mid-read, so this fallback can
    // only enforce the cap after buffering (unless content-length rejected it).
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > GTFS_MAX_RESPONSE_BYTES) {
      throw new Error("GTFS-Realtime response exceeds the 8 MiB limit");
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > GTFS_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GTFS-Realtime response exceeds the 8 MiB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function transitRequestUrl(feed: TransitFeedDefinition, dev = isViteDevServer()): string {
  if (feed.directUrl) return feed.directUrl;
  return `${dev ? TRANSIT_DEV_BASE : TRANSIT_EDGE_BASE}/${feed.id}`;
}

async function fetchTransitFeed(
  feed: TransitFeedDefinition,
  options: {
    signal?: AbortSignal;
    fetch: typeof fetch;
    now: Date;
    dev?: boolean;
  },
): Promise<GodsEyeViewFeedPayload> {
  const response = await options.fetch(transitRequestUrl(feed, options.dev), {
    signal: options.signal,
    headers: feed.headers,
  });
  if (!response.ok) throw new Error(`${feed.name} transit request failed (${response.status})`);
  const snapshot = decodeTransitFeed(await readBoundedResponse(response), feed);
  if (snapshot.truncated) {
    throw new Error(`${feed.name} transit feed exceeds the ${GTFS_MAX_ENTITIES} entity limit`);
  }
  return transitVehiclesToCzml(snapshot.vehicles, options.now, feed);
}

/** Fetch all seven public operators, preserving the feeds that succeed. */
export async function fetchTransitCzml(
  options: {
    signal?: AbortSignal;
    fetch?: typeof fetch;
    now?: Date;
    dev?: boolean;
  } = {},
): Promise<GodsEyeViewFeedPayload> {
  const now = options.now ?? new Date();
  const results = await Promise.allSettled(
    TRANSIT_FEEDS.map((feed) =>
      fetchTransitFeed(feed, {
        signal: options.signal,
        fetch: options.fetch ?? fetch,
        now,
        dev: options.dev,
      }),
    ),
  );
  const successes = results.filter(
    (result): result is PromiseFulfilledResult<GodsEyeViewFeedPayload> =>
      result.status === "fulfilled",
  );
  if (successes.length === 0) {
    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    throw firstFailure?.reason ?? new Error("Every transit provider failed");
  }
  // Take whole providers, in registry order, while the merged budget lasts. The
  // first provider is always kept: a single feed cannot exceed the per-feed cap,
  // so it always fits, and an empty result here would look like a healthy feed
  // with no vehicles.
  const merged: GodsEyeViewFeedPayload[] = [];
  let vehicles = 0;
  for (const result of successes) {
    const count = result.value.attributes.features.length;
    if (merged.length > 0 && vehicles + count > TRANSIT_MAX_MERGED_VEHICLES) continue;
    vehicles += count;
    merged.push(result.value);
  }
  return {
    packets: [
      { id: "document", name: "Live Transit", version: "1.0" },
      ...merged.flatMap((payload) => payload.packets.slice(1)),
    ],
    attributes: {
      type: "FeatureCollection",
      features: merged.flatMap((payload) => payload.attributes.features),
    },
  };
}
