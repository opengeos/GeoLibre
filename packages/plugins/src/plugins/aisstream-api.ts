import type { Feature, FeatureCollection, Point } from "geojson";

export const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

export type AisBounds = [west: number, south: number, east: number, north: number];

export interface AisPositionProperties {
  observed_at: string;
  mmsi: number;
  vessel_name?: string;
  message_type: string;
  speed_knots?: number;
  course_degrees?: number;
  heading_degrees?: number;
  navigation_status?: number;
}

export type AisPositionFeature = Feature<Point, AisPositionProperties>;

const POSITION_TYPES = [
  "PositionReport",
  "StandardClassBPositionReport",
  "ExtendedClassBPositionReport",
] as const;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Build the subscription payload expected by AISStream's public WebSocket API. */
export function buildAisStreamSubscription(apiKey: string, bounds: AisBounds): object {
  const [west, south, east, north] = bounds;
  if (!apiKey.trim()) throw new Error("An AISStream API key is required.");
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    throw new Error("The map bounds are invalid.");
  }
  return {
    APIKey: apiKey.trim(),
    BoundingBoxes: [[[south, west], [north, east]]],
    FilterMessageTypes: [...POSITION_TYPES],
  };
}

/** Convert one AISStream position message to GeoLibre's canonical point shape. */
export function normalizeAisStreamMessage(value: unknown): AisPositionFeature | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  const messageType = nonEmptyString(envelope.MessageType);
  const metadata = envelope.MetaData as Record<string, unknown> | undefined;
  const messages = envelope.Message as Record<string, unknown> | undefined;
  const report = messageType && messages?.[messageType];
  if (!messageType || !POSITION_TYPES.includes(messageType as (typeof POSITION_TYPES)[number])) {
    return null;
  }
  if (!report || typeof report !== "object") return null;
  const body = report as Record<string, unknown>;
  const latitude = finiteNumber(metadata?.latitude) ?? finiteNumber(body.Latitude);
  const longitude = finiteNumber(metadata?.longitude) ?? finiteNumber(body.Longitude);
  const mmsi = finiteNumber(metadata?.MMSI) ?? finiteNumber(body.UserID);
  const observedRaw = nonEmptyString(metadata?.time_utc);
  const observedMs = observedRaw ? Date.parse(observedRaw) : Number.NaN;
  if (
    latitude === undefined ||
    longitude === undefined ||
    mmsi === undefined ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(observedMs)
  ) {
    return null;
  }

  const properties: AisPositionProperties = {
    observed_at: new Date(observedMs).toISOString(),
    mmsi,
    message_type: messageType,
  };
  const vesselName = nonEmptyString(metadata?.ShipName);
  if (vesselName) properties.vessel_name = vesselName;
  const speed = finiteNumber(body.Sog);
  const course = finiteNumber(body.Cog);
  const heading = finiteNumber(body.TrueHeading);
  const navigationStatus = finiteNumber(body.NavigationalStatus);
  if (speed !== undefined) properties.speed_knots = speed;
  if (course !== undefined) properties.course_degrees = course;
  if (heading !== undefined && heading <= 359) properties.heading_degrees = heading;
  if (navigationStatus !== undefined) properties.navigation_status = navigationStatus;

  return {
    type: "Feature",
    id: `${mmsi}-${observedMs}`,
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties,
  };
}

/** Parse and normalize a WebSocket event without letting malformed traffic escape. */
export function parseAisStreamEvent(data: unknown): AisPositionFeature | null {
  try {
    const value = typeof data === "string" ? JSON.parse(data) : data;
    return normalizeAisStreamMessage(value);
  } catch {
    return null;
  }
}

export function aisFeatureCollection(features: AisPositionFeature[]): FeatureCollection<Point> {
  return { type: "FeatureCollection", features };
}
