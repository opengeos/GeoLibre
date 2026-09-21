import type { CzmlPacket } from "@geolibre/core";
import type { Feature, FeatureCollection, Point } from "geojson";
import { PbfReader } from "pbf";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";

/**
 * Entur's keyless national GTFS-Realtime VehiclePositions feed.
 *
 * The feed selection and compact wire decoder follow the normalization approach
 * used by the MIT-licensed bilawalsidhu/gods-eye-view project. GeoLibre reads
 * Entur directly because the endpoint explicitly allows browser CORS requests.
 */
export const ENTUR_TRANSIT_URL = "https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions";
export const ENTUR_CLIENT_NAME = "GeoLibre-Gods-Eye-View";
export const GTFS_MAX_ENTITIES = 50_000;
export const GTFS_MAX_STRING_CHARS = 256;
export const GTFS_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const EARTH_RADIUS_METERS = 6_378_137;
const TRANSIT_COAST_SECONDS = 45;

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
  mode: "bus" | "rail";
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

function enturMode(routeId: string | null): TransitVehicle["mode"] {
  // GTFS-Realtime carries no route type. Entur codes identify these known rail
  // operators, but metro, tram, ferry, and unknown operators use bus styling.
  const railCodes = new Set(["VYG", "GJB", "SJN", "FLT", "GOA", "NSB", "VYT", "FLB"]);
  return routeId && railCodes.has(routeId.split(":")[0]) ? "rail" : "bus";
}

function normalizeVehicleEntity(entity: GtfsFeedEntity): TransitVehicle | null {
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
    mode: enturMode(routeId),
  };
}

/** Decode the bounded subset of GTFS-Realtime used by the Transit feed. */
export function decodeGtfsRealtimeVehicles(bytes: Uint8Array | ArrayBuffer): TransitSnapshot {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > GTFS_MAX_RESPONSE_BYTES) {
    throw new Error("Entur GTFS-Realtime response exceeds the 8 MiB limit");
  }
  const message = new PbfReader(view).readFields<GtfsFeedMessage>(readFeedMessage, {
    header: {},
    entities: [],
    truncated: false,
  });
  const byId = new Map<string, TransitVehicle>();
  for (const entity of message.entities) {
    const vehicle = normalizeVehicleEntity(entity);
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
): GodsEyeViewFeedPayload {
  const stop = new Date(now.getTime() + TRANSIT_COAST_SECONDS * 1000);
  // No document `clock`: the feed does not set `ownsClockWindow`, and the CZML
  // synchronizer elects the first loaded document that carries one. A refresh
  // reuses this layer id, so the elected owner never changes and the clock
  // would stay clamped to the first 45-second coast window while later
  // snapshots — whose entities only become available after it — went unseen.
  const packets: CzmlPacket[] = [{ id: "document", name: "Live Transit", version: "1.0" }];
  const features: Feature[] = [];
  for (const vehicle of vehicles) {
    const ageSeconds = vehicle.observedAtMs
      ? Math.max(0, Math.min(60, (now.getTime() - vehicle.observedAtMs) / 1000))
      : 0;
    const current = predictPosition(vehicle, ageSeconds);
    const future = predictPosition(vehicle, ageSeconds + TRANSIT_COAST_SECONDS);
    const id = `transit-entur-${vehicle.id}`;
    const properties = {
      vehicleId: vehicle.id,
      operator: "Entur",
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
        pixelSize: vehicle.mode === "rail" ? 8 : 7,
        color: {
          rgba: vehicle.mode === "rail" ? [217, 166, 255, 255] : [83, 226, 167, 255],
        },
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
    throw new Error("Entur GTFS-Realtime response exceeds the 8 MiB limit");
  }
  if (!response.body) {
    // Synthetic and nonstandard Response implementations may not expose a
    // stream. Their arrayBuffer API cannot stop mid-read, so this fallback can
    // only enforce the cap after buffering (unless content-length rejected it).
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > GTFS_MAX_RESPONSE_BYTES) {
      throw new Error("Entur GTFS-Realtime response exceeds the 8 MiB limit");
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
        throw new Error("Entur GTFS-Realtime response exceeds the 8 MiB limit");
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

/** Fetch and decode Entur's browser-accessible national vehicle feed. */
export async function fetchTransitCzml(
  options: { signal?: AbortSignal; fetch?: typeof fetch; now?: Date } = {},
): Promise<GodsEyeViewFeedPayload> {
  const response = await (options.fetch ?? fetch)(ENTUR_TRANSIT_URL, {
    signal: options.signal,
    headers: { "ET-Client-Name": ENTUR_CLIENT_NAME },
  });
  if (!response.ok) throw new Error(`Entur transit request failed (${response.status})`);
  const snapshot = decodeGtfsRealtimeVehicles(await readBoundedResponse(response));
  if (snapshot.truncated) {
    throw new Error(`Entur transit feed exceeds the ${GTFS_MAX_ENTITIES} entity limit`);
  }
  return transitVehiclesToCzml(snapshot.vehicles, options.now ?? new Date());
}
