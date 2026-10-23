import type { CzmlPacket } from "@geolibre/core";
import type { Feature, Point } from "geojson";
import { predictAircraftPosition } from "./gods-eye-view-aircraft-feeds";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";
import type { ViewBounds } from "./gods-eye-view-viewport-feeds";

/**
 * Live AIS vessels from AISStream.io.
 *
 * AISStream is a push feed: one WebSocket per client, subscribed to bounding
 * boxes, streaming every position report inside them. It accepts browser
 * origins, so the user's own key goes straight to it with no relay; the only
 * host the CSPs need is `wss://stream.aisstream.io`.
 *
 * The feed engine is poll-based, so the socket lives here, outside `FeedState`:
 * {@link AisStreamClient} keeps the latest report per vessel, and the engine's
 * ordinary refresh reads a snapshot of it into CZML.
 */
export const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
/** Wider views stream more reports than a browser tab should parse. */
export const AIS_MAX_VIEW_SPAN_DEGREES = 30;
export const AIS_QUERY_SNAP_DEGREES = 0.5;
/** A vessel not heard from in this long has left the area or gone silent. */
export const AIS_VESSEL_TTL_MS = 15 * 60_000;
export const AIS_MAX_VESSELS = 3_000;
/** How far ahead a vessel is dead-reckoned between refreshes. */
export const AIS_COAST_SECONDS = 10 * 60;
const KNOTS_TO_MPS = 0.514444;
/** Below this speed a vessel is moored or drifting; reckoning would only jitter it. */
const MOVING_THRESHOLD_KNOTS = 0.5;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/**
 * AISStream answers a rejected key by closing the socket without a word. A
 * socket that closes this soon after subscribing, having delivered nothing,
 * counts as a rejection; two in a row stop the reconnect loop.
 */
const SILENT_CLOSE_WINDOW_MS = 15_000;
const SILENT_CLOSES_BEFORE_REJECTED = 2;
const MESSAGE_TYPES = ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"];
/** Static reports outlive position pruning, so they get their own ceiling. */
const MAX_STATIC_RECORDS = 10_000;

export interface VesselObservation {
  mmsi: string;
  name?: string;
  latitude: number;
  longitude: number;
  speedKnots: number;
  courseDeg: number;
  headingDeg?: number;
  navigationalStatus?: number;
  shipType?: number;
  callSign?: string;
  destination?: string;
  aisClass: "A" | "B";
  observedAtMs: number;
}

interface VesselStatic {
  name?: string;
  shipType?: number;
  callSign?: string;
  destination?: string;
}

type ParsedAisMessage =
  | { kind: "position"; vessel: VesselObservation }
  | { kind: "static"; mmsi: string; details: VesselStatic }
  | { kind: "confirmed" }
  | { kind: "error"; message: string }
  | { kind: "ignored" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // AIS pads fixed-width text with spaces and uses `@` as its null character.
  const text = value.replace(/@+$/, "").trim();
  return text || undefined;
}

function parseTime(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  // "2026-09-24 16:47:13.17057372 +0000 UTC" → an ISO instant Date can read.
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?/.exec(value);
  if (!match) return fallback;
  const parsed = Date.parse(`${match[1]}T${match[2]}${(match[3] ?? "").slice(0, 4)}Z`);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalize one AISStream frame.
 *
 * @param text - The frame as text (AISStream sends JSON, in binary frames).
 * @param receivedAtMs - Fallback observation time when the frame has none.
 */
export function parseAisMessage(text: string, receivedAtMs: number): ParsedAisMessage {
  let envelope: Record<string, unknown> | null;
  try {
    envelope = record(JSON.parse(text));
  } catch {
    return { kind: "ignored" };
  }
  if (!envelope) return { kind: "ignored" };
  if (typeof envelope.error === "string") return { kind: "error", message: envelope.error };
  const type = envelope.MessageType;
  // Only an accepted key is ever confirmed; a rejected one gets a bare close.
  if (type === "SubscriptionConfirmation") return { kind: "confirmed" };
  const body = typeof type === "string" ? record(record(envelope.Message)?.[type]) : null;
  const meta = record(envelope.MetaData);
  if (!body) return { kind: "ignored" };
  const mmsiValue = finite(body.UserID) ?? finite(meta?.MMSI);
  if (mmsiValue === undefined || mmsiValue <= 0) return { kind: "ignored" };
  const mmsi = String(Math.trunc(mmsiValue));

  if (type === "ShipStaticData") {
    return {
      kind: "static",
      mmsi,
      details: {
        name: cleanText(body.Name) ?? cleanText(meta?.ShipName),
        shipType: finite(body.Type),
        callSign: cleanText(body.CallSign),
        destination: cleanText(body.Destination),
      },
    };
  }
  if (type !== "PositionReport" && type !== "StandardClassBPositionReport") {
    return { kind: "ignored" };
  }
  const latitude = finite(body.Latitude);
  const longitude = finite(body.Longitude);
  // 91/181 are AIS's "position not available" sentinels.
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0)
  ) {
    return { kind: "ignored" };
  }
  const sog = finite(body.Sog);
  const cog = finite(body.Cog);
  const heading = finite(body.TrueHeading);
  const navigationalStatus = finite(body.NavigationalStatus);
  return {
    kind: "position",
    vessel: {
      mmsi,
      name: cleanText(meta?.ShipName),
      latitude,
      longitude,
      // 102.3 knots is "not available"; 360° is "course not available".
      speedKnots: sog !== undefined && sog < 102.3 ? sog : 0,
      courseDeg: cog !== undefined && cog < 360 ? cog : (heading ?? 0),
      ...(heading !== undefined && heading < 360 ? { headingDeg: heading } : {}),
      ...(navigationalStatus !== undefined ? { navigationalStatus } : {}),
      aisClass: type === "PositionReport" ? "A" : "B",
      observedAtMs: parseTime(meta?.time_utc, receivedAtMs),
    },
  };
}

/** The AIS ship-type code as a category shared by the color and the table. */
export function vesselCategory(shipType: number | undefined): string {
  if (shipType === undefined) return "Unknown";
  if (shipType === 30) return "Fishing";
  if (shipType === 31 || shipType === 32 || shipType === 52) return "Tug";
  if (shipType === 35) return "Military";
  if (shipType === 36 || shipType === 37) return "Pleasure craft";
  if (shipType >= 40 && shipType <= 49) return "High-speed craft";
  if (shipType === 50 || shipType === 51 || shipType === 53 || shipType === 55) return "Service";
  if (shipType >= 60 && shipType <= 69) return "Passenger";
  if (shipType >= 70 && shipType <= 79) return "Cargo";
  if (shipType >= 80 && shipType <= 89) return "Tanker";
  return "Other";
}

const CATEGORY_COLORS: Record<string, [number, number, number, number]> = {
  Cargo: [34, 197, 94, 240],
  Tanker: [239, 68, 68, 240],
  Passenger: [59, 130, 246, 240],
  Fishing: [249, 115, 22, 240],
  Tug: [168, 85, 247, 240],
  Military: [148, 163, 184, 240],
  "Pleasure craft": [236, 72, 153, 240],
  "High-speed craft": [234, 179, 8, 240],
  Service: [20, 184, 166, 240],
};
const DEFAULT_VESSEL_COLOR: [number, number, number, number] = [226, 232, 240, 230];

const NAVIGATIONAL_STATUS = [
  "Under way using engine",
  "At anchor",
  "Not under command",
  "Restricted manoeuvrability",
  "Constrained by draught",
  "Moored",
  "Aground",
  "Engaged in fishing",
  "Under way sailing",
];

function vesselProperties(vessel: VesselObservation) {
  const category = vesselCategory(vessel.shipType);
  const status =
    vessel.navigationalStatus !== undefined
      ? NAVIGATIONAL_STATUS[vessel.navigationalStatus]
      : undefined;
  return {
    mmsi: vessel.mmsi,
    ...(vessel.name ? { vesselName: vessel.name } : {}),
    category,
    ...(vessel.callSign ? { callSign: vessel.callSign } : {}),
    ...(vessel.destination ? { destination: vessel.destination } : {}),
    ...(status ? { navigationalStatus: status } : {}),
    speedKnots: Math.round(vessel.speedKnots * 10) / 10,
    courseDeg: Math.round(vessel.courseDeg),
    ...(vessel.headingDeg !== undefined ? { headingDeg: vessel.headingDeg } : {}),
    aisClass: vessel.aisClass,
    observedAt: new Date(vessel.observedAtMs).toISOString(),
  };
}

/**
 * One point per vessel, dead-reckoned along its course so it moves between
 * refreshes instead of jumping at each one. `HOLD` extrapolation keeps a vessel
 * visible, at its last predicted spot, if the clock runs past the coast window.
 */
export function vesselsToCzml(
  vessels: readonly VesselObservation[],
  now: Date,
  coastSeconds = AIS_COAST_SECONDS,
): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [{ id: "document", name: "Live AIS Vessels", version: "1.0" }];
  const features: Feature<Point>[] = [];
  for (const vessel of vessels) {
    const moving = vessel.speedKnots >= MOVING_THRESHOLD_KNOTS;
    const track = {
      id: vessel.mmsi,
      latitude: vessel.latitude,
      longitude: vessel.longitude,
      altitudeM: 0,
      speedMps: moving ? vessel.speedKnots * KNOTS_TO_MPS : 0,
      courseDeg: vessel.courseDeg,
      onGround: true,
      observedAtMs: vessel.observedAtMs,
    };
    const ageSeconds = Math.max(
      0,
      Math.min(AIS_VESSEL_TTL_MS / 1000, (now.getTime() - vessel.observedAtMs) / 1000),
    );
    const current = predictAircraftPosition(track, ageSeconds);
    const future = predictAircraftPosition(track, ageSeconds + coastSeconds);
    const properties = vesselProperties(vessel);
    const id = `ais-${vessel.mmsi}`;
    packets.push({
      id,
      name: vessel.name ?? `MMSI ${vessel.mmsi}`,
      position: {
        epoch: now.toISOString(),
        cartographicDegrees: [0, ...current, coastSeconds, ...future],
        interpolationAlgorithm: "LINEAR",
        interpolationDegree: 1,
        forwardExtrapolationType: "HOLD",
        backwardExtrapolationType: "HOLD",
      },
      properties,
      point: {
        pixelSize: vessel.aisClass === "A" ? 7 : 5,
        color: { rgba: CATEGORY_COLORS[properties.category] ?? DEFAULT_VESSEL_COLOR },
        outlineColor: { rgba: [8, 15, 24, 220] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: current.slice(0, 2) },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

/** The part of the browser `WebSocket` the client uses, so tests can fake it. */
export interface AisSocket {
  binaryType: string;
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type AisConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "keyRejected";

export interface AisSnapshot {
  state: AisConnectionState;
  vessels: VesselObservation[];
}

export interface AisStreamClientOptions {
  createSocket?: (url: string) => AisSocket;
  now?: () => number;
  /** Called when the connection state changes, not on every report. */
  onStateChange?: (state: AisConnectionState) => void;
}

const SOCKET_OPEN = 1;

function inBounds(vessel: VesselObservation, bounds: ViewBounds): boolean {
  const [west, south, east, north] = bounds;
  return (
    vessel.longitude >= west &&
    vessel.longitude <= east &&
    vessel.latitude >= south &&
    vessel.latitude <= north
  );
}

/**
 * One AISStream WebSocket, held open while the layer is on.
 *
 * `update` is idempotent: the engine calls it on every refresh with the current
 * key and view, and it only acts on a change. A new view is a resubscription on
 * the same socket, which AISStream supports; a new key is a new socket.
 */
export class AisStreamClient {
  private readonly createSocket: (url: string) => AisSocket;
  private readonly now: () => number;
  private readonly onStateChange?: (state: AisConnectionState) => void;
  private socket: AisSocket | null = null;
  private key: string | null = null;
  private bounds: ViewBounds | null = null;
  private state: AisConnectionState = "idle";
  private readonly vessels = new Map<string, VesselObservation>();
  private readonly statics = new Map<string, VesselStatic>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private silentCloses = 0;
  private subscribedAt = 0;
  private receivedSinceSubscribe = false;
  /**
   * Whether AISStream has ever answered this key. Only an unproven key can be
   * diagnosed as rejected: once it has worked, a close is a network problem.
   */
  private keyVerified = false;

  constructor(options: AisStreamClientOptions = {}) {
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as AisSocket);
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  /** Connect, resubscribe, or reconnect as the key and view require. */
  update(key: string, bounds: ViewBounds): void {
    const boundsChanged =
      !this.bounds || this.bounds.some((value, index) => value !== bounds[index]);
    if (key !== this.key) {
      this.stop();
      this.key = key;
      this.bounds = bounds;
      this.connect();
      return;
    }
    // A rejected key stays rejected until the user supplies another one.
    if (this.state === "keyRejected") return;
    if (!boundsChanged) return;
    this.bounds = bounds;
    for (const [mmsi, vessel] of this.vessels) {
      if (!inBounds(vessel, bounds)) this.vessels.delete(mmsi);
    }
    if (this.socket?.readyState === SOCKET_OPEN) this.subscribe();
    else if (!this.socket && !this.reconnectTimer) this.connect();
  }

  /** Close the socket and forget everything, including the key. */
  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened can throw; it is gone either way.
      }
    }
    this.key = null;
    this.bounds = null;
    this.vessels.clear();
    this.statics.clear();
    this.reconnectAttempts = 0;
    this.silentCloses = 0;
    this.keyVerified = false;
    this.setState("idle");
  }

  /** The current connection state and live vessels, newest first, pruned. */
  snapshot(): AisSnapshot {
    const cutoff = this.now() - AIS_VESSEL_TTL_MS;
    for (const [mmsi, vessel] of this.vessels) {
      if (vessel.observedAtMs < cutoff) this.vessels.delete(mmsi);
    }
    const vessels = [...this.vessels.values()]
      .sort((a, b) => b.observedAtMs - a.observedAtMs)
      .slice(0, AIS_MAX_VESSELS)
      .map((vessel) => ({ ...vessel, ...this.staticFor(vessel.mmsi, vessel.name) }));
    return { state: this.state, vessels };
  }

  private staticFor(mmsi: string, fallbackName?: string): VesselStatic {
    const details = this.statics.get(mmsi);
    if (!details) return {};
    return {
      name: details.name ?? fallbackName,
      ...(details.shipType !== undefined ? { shipType: details.shipType } : {}),
      ...(details.callSign ? { callSign: details.callSign } : {}),
      ...(details.destination ? { destination: details.destination } : {}),
    };
  }

  private setState(state: AisConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private connect(): void {
    if (!this.key || !this.bounds) return;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    // A socket that never subscribes must not inherit the previous socket's
    // subscription time, or a failed reconnect would count as a silent rejection.
    this.subscribedAt = 0;
    this.receivedSinceSubscribe = false;
    let socket: AisSocket;
    try {
      socket = this.createSocket(AISSTREAM_URL);
    } catch (error) {
      console.warn("[God's Eye View] AISStream connection failed", error);
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.subscribe();
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data);
    };
    socket.onerror = () => {
      // The close event that always follows carries the handling.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const silent =
        !this.keyVerified &&
        !this.receivedSinceSubscribe &&
        this.subscribedAt > 0 &&
        this.now() - this.subscribedAt < SILENT_CLOSE_WINDOW_MS;
      this.silentCloses = silent ? this.silentCloses + 1 : 0;
      if (this.silentCloses >= SILENT_CLOSES_BEFORE_REJECTED) {
        this.setState("keyRejected");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private subscribe(): void {
    if (!this.socket || !this.key || !this.bounds) return;
    const [west, south, east, north] = this.bounds;
    this.subscribedAt = this.now();
    this.receivedSinceSubscribe = false;
    this.socket.send(
      JSON.stringify({
        APIKey: this.key,
        // AISStream orders each corner as [latitude, longitude].
        BoundingBoxes: [
          [
            [south, west],
            [north, east],
          ],
        ],
        FilterMessageTypes: MESSAGE_TYPES,
      }),
    );
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.key) return;
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private receive(data: unknown): void {
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : ArrayBuffer.isView(data)
            ? new TextDecoder().decode(data)
            : null;
    if (text === null) return;
    const message = parseAisMessage(text, this.now());
    if (message.kind === "error") {
      console.warn("[God's Eye View] AISStream error:", message.message);
      if (/key/i.test(message.message)) {
        this.setState("keyRejected");
        const socket = this.socket;
        this.socket = null;
        if (socket) {
          socket.onclose = null;
          socket.close();
        }
      }
      return;
    }
    if (message.kind === "ignored") return;
    this.receivedSinceSubscribe = true;
    this.keyVerified = true;
    this.reconnectAttempts = 0;
    this.silentCloses = 0;
    this.setState("live");
    if (message.kind === "confirmed") return;
    if (message.kind === "static") {
      const merged = { ...this.statics.get(message.mmsi), ...message.details };
      // Re-insert so the Map's insertion order doubles as recency for eviction.
      this.statics.delete(message.mmsi);
      this.statics.set(message.mmsi, merged);
      if (this.statics.size > MAX_STATIC_RECORDS) {
        const oldest = this.statics.keys().next().value;
        if (oldest !== undefined) this.statics.delete(oldest);
      }
      return;
    }
    if (this.bounds && !inBounds(message.vessel, this.bounds)) return;
    // Re-insert so the Map's order is recency, and evict the stalest report once
    // a busy area outgrows the cap between two snapshots.
    this.vessels.delete(message.vessel.mmsi);
    this.vessels.set(message.vessel.mmsi, message.vessel);
    if (this.vessels.size > AIS_MAX_VESSELS) {
      const oldest = this.vessels.keys().next().value;
      if (oldest !== undefined) this.vessels.delete(oldest);
    }
  }
}
