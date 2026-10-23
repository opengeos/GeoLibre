import type { CzmlPacket } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { isViteDevServer, type CzmlTimeWindow } from "./gods-eye-view-feeds";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";

export const OPEN_SKY_EDGE_URL = "https://tiles.geolibre.app/opensky/states";
export const ADSB_LOL_EDGE_URL = "https://tiles.geolibre.app/adsb-lol/military";
export const OPEN_SKY_DEV_URL = "/opensky/states";
export const ADSB_LOL_DEV_URL = "/adsb-lol/military";
export const ADSBDB_EDGE_BASE = "https://tiles.geolibre.app/adsbdb/aircraft";
export const ADSBDB_DEV_BASE = "/adsbdb/aircraft";
export const AIRCRAFT_ENRICHMENT_BUDGET = 8;

const EARTH_RADIUS_METERS = 6_378_137;
const KNOTS_TO_METERS_PER_SECOND = 0.514444;
const FEET_TO_METERS = 0.3048;
const FEET_PER_MINUTE_TO_METERS_PER_SECOND = FEET_TO_METERS / 60;
const ENRICHMENT_TTL_MS = 24 * 60 * 60_000;

export interface AircraftObservation {
  id: string;
  longitude: number;
  latitude: number;
  altitudeM: number;
  speedMps: number;
  courseDeg: number;
  observedAtMs: number;
  onGround: boolean;
  callsign?: string;
  originCountry?: string;
  verticalRateMps?: number;
  typeCode?: string;
  registration?: string;
  operator?: string;
}

interface AircraftEnrichment {
  typeCode?: string;
  registration?: string;
  manufacturer?: string;
  model?: string;
}

interface CachedEnrichment {
  expiresAt: number;
  value: AircraftEnrichment | null;
}

const enrichmentCache = new Map<string, CachedEnrichment>();

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeOpenSkyAircraft(
  row: unknown,
  snapshotTimeMs: number,
): AircraftObservation | null {
  if (!Array.isArray(row)) return null;
  const id = text(row[0])?.toLowerCase();
  const longitude = finite(row[5]);
  const latitude = finite(row[6]);
  if (!id || longitude === null || latitude === null) return null;
  const contactSeconds = finite(row[4]) ?? finite(row[3]);
  const altitudeM = finite(row[13]) ?? finite(row[7]) ?? 0;
  const speedMps = Math.max(0, finite(row[9]) ?? 0);
  const courseDeg = (((finite(row[10]) ?? 0) % 360) + 360) % 360;
  return {
    id,
    longitude,
    latitude,
    altitudeM,
    speedMps,
    courseDeg,
    observedAtMs: contactSeconds === null ? snapshotTimeMs : contactSeconds * 1000,
    onGround: row[8] === true,
    ...(text(row[1]) ? { callsign: text(row[1]) } : {}),
    ...(text(row[2]) ? { originCountry: text(row[2]) } : {}),
    ...(finite(row[11]) !== null ? { verticalRateMps: finite(row[11]) as number } : {}),
  };
}

export function normalizeAdsbLolAircraft(
  row: unknown,
  snapshotTimeMs: number,
): AircraftObservation | null {
  if (!row || typeof row !== "object") return null;
  const aircraft = row as Record<string, unknown>;
  const id = text(aircraft.hex)?.replace(/^~/, "").toLowerCase();
  const longitude = finite(aircraft.lon);
  const latitude = finite(aircraft.lat);
  if (!id || longitude === null || latitude === null) return null;
  const seenSeconds = finite(aircraft.seen_pos) ?? finite(aircraft.seen) ?? 0;
  const altitudeFeet = finite(aircraft.alt_geom) ?? finite(aircraft.alt_baro) ?? 0;
  return {
    id,
    longitude,
    latitude,
    altitudeM: altitudeFeet * FEET_TO_METERS,
    speedMps: Math.max(0, (finite(aircraft.gs) ?? 0) * KNOTS_TO_METERS_PER_SECOND),
    courseDeg: (((finite(aircraft.track) ?? 0) % 360) + 360) % 360,
    observedAtMs: snapshotTimeMs - Math.max(0, seenSeconds) * 1000,
    onGround: aircraft.alt_baro === "ground",
    ...(text(aircraft.flight) ? { callsign: text(aircraft.flight) } : {}),
    ...(finite(aircraft.baro_rate) !== null
      ? {
          verticalRateMps:
            (finite(aircraft.baro_rate) as number) * FEET_PER_MINUTE_TO_METERS_PER_SECOND,
        }
      : {}),
    ...(text(aircraft.t) ? { typeCode: text(aircraft.t) } : {}),
    ...(text(aircraft.r) ? { registration: text(aircraft.r) } : {}),
    ...(text(aircraft.ownOp) ? { operator: text(aircraft.ownOp) } : {}),
  };
}

/** Advance a WGS84 point along a great-circle course for dead reckoning. */
export function predictAircraftPosition(
  aircraft: AircraftObservation,
  elapsedSeconds: number,
): [longitude: number, latitude: number, altitude: number] {
  const seconds = Math.max(0, elapsedSeconds);
  const angularDistance = (aircraft.speedMps * seconds) / EARTH_RADIUS_METERS;
  const bearing = (aircraft.courseDeg * Math.PI) / 180;
  const latitude = (aircraft.latitude * Math.PI) / 180;
  const longitude = (aircraft.longitude * Math.PI) / 180;
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
  const longitudeDeg = (((((predictedLongitude * 180) / Math.PI + 180) % 360) + 360) % 360) - 180;
  return [
    longitudeDeg,
    (predictedLatitude * 180) / Math.PI,
    Math.max(0, aircraft.altitudeM + (aircraft.verticalRateMps ?? 0) * seconds),
  ];
}

function aircraftProperties(aircraft: AircraftObservation, enrichment?: AircraftEnrichment) {
  return {
    icao24: aircraft.id,
    ...(aircraft.callsign ? { callsign: aircraft.callsign } : {}),
    ...(aircraft.originCountry ? { originCountry: aircraft.originCountry } : {}),
    ...(aircraft.registration || enrichment?.registration
      ? { registration: aircraft.registration ?? enrichment?.registration }
      : {}),
    ...(aircraft.typeCode || enrichment?.typeCode
      ? { typeCode: aircraft.typeCode ?? enrichment?.typeCode }
      : {}),
    ...(aircraft.operator ? { operator: aircraft.operator } : {}),
    ...(enrichment?.manufacturer ? { manufacturer: enrichment.manufacturer } : {}),
    ...(enrichment?.model ? { model: enrichment.model } : {}),
    altitudeM: Math.round(aircraft.altitudeM),
    speedMps: Math.round(aircraft.speedMps * 10) / 10,
    courseDeg: Math.round(aircraft.courseDeg),
    onGround: aircraft.onGround,
    observedAt: new Date(aircraft.observedAtMs).toISOString(),
  };
}

export function aircraftToCzml(
  observations: readonly AircraftObservation[],
  now: Date,
  options: {
    name: string;
    idPrefix: string;
    color: [number, number, number, number];
    coastSeconds: number;
    enrichment?: ReadonlyMap<string, AircraftEnrichment>;
  },
): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [
    {
      id: "document",
      name: options.name,
      version: "1.0",
      clock: {
        interval: `${now.toISOString()}/${new Date(
          now.getTime() + options.coastSeconds * 1000,
        ).toISOString()}`,
        currentTime: now.toISOString(),
        multiplier: 1,
        range: "CLAMPED",
        step: "SYSTEM_CLOCK_MULTIPLIER",
      },
    },
  ];
  const features: FeatureCollection["features"] = [];
  for (const aircraft of observations) {
    const ageSeconds = Math.max(0, Math.min(120, (now.getTime() - aircraft.observedAtMs) / 1000));
    const current = predictAircraftPosition(aircraft, ageSeconds);
    const future = predictAircraftPosition(aircraft, ageSeconds + options.coastSeconds);
    const properties = aircraftProperties(aircraft, options.enrichment?.get(aircraft.id));
    const id = `${options.idPrefix}-${aircraft.id}`;
    packets.push({
      id,
      name: aircraft.callsign ?? aircraft.registration ?? aircraft.id.toUpperCase(),
      availability: `${now.toISOString()}/${new Date(
        now.getTime() + options.coastSeconds * 1000,
      ).toISOString()}`,
      position: {
        epoch: now.toISOString(),
        cartographicDegrees: [0, ...current, options.coastSeconds, ...future],
        interpolationAlgorithm: "LINEAR",
        interpolationDegree: 1,
      },
      properties,
      point: {
        pixelSize: aircraft.onGround ? 5 : 7,
        color: { rgba: options.color },
        outlineColor: { rgba: [0, 0, 0, 190] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: current },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

function viewportCenter(bounds: [number, number, number, number] | null): [number, number] {
  if (!bounds) return [0, 0];
  const [west, south, east, north] = bounds;
  const unwrappedEast = east < west ? east + 360 : east;
  return [(((west + unwrappedEast) / 2 + 180) % 360) - 180, (south + north) / 2];
}

function wrappedLongitudeDelta(longitude: number, center: number): number {
  return ((longitude - center + 540) % 360) - 180;
}

async function enrichAircraft(
  observations: readonly AircraftObservation[],
  bounds: [number, number, number, number] | null,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<Map<string, AircraftEnrichment>> {
  const now = Date.now();
  const [centerLon, centerLat] = viewportCenter(bounds);
  const candidates = observations
    .filter((aircraft) => /^[0-9a-f]{6}$/.test(aircraft.id))
    .sort(
      (a, b) =>
        wrappedLongitudeDelta(a.longitude, centerLon) ** 2 +
        (a.latitude - centerLat) ** 2 -
        (wrappedLongitudeDelta(b.longitude, centerLon) ** 2 + (b.latitude - centerLat) ** 2),
    )
    .slice(0, AIRCRAFT_ENRICHMENT_BUDGET);
  const values = new Map<string, AircraftEnrichment>();
  await Promise.all(
    candidates.map(async (aircraft) => {
      const cached = enrichmentCache.get(aircraft.id);
      if (cached && cached.expiresAt > now) {
        if (cached.value) values.set(aircraft.id, cached.value);
        return;
      }
      try {
        const base = isViteDevServer() ? ADSBDB_DEV_BASE : ADSBDB_EDGE_BASE;
        const response = await fetcher(`${base}/${aircraft.id}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as {
          response?: { aircraft?: Record<string, unknown> };
        };
        const source = payload.response?.aircraft;
        const value: AircraftEnrichment | null = source
          ? {
              ...(text(source.icao_type) ? { typeCode: text(source.icao_type) } : {}),
              ...(text(source.registration) ? { registration: text(source.registration) } : {}),
              ...(text(source.manufacturer) ? { manufacturer: text(source.manufacturer) } : {}),
              ...(text(source.type) ? { model: text(source.type) } : {}),
            }
          : null;
        enrichmentCache.set(aircraft.id, {
          value,
          expiresAt: now + ENRICHMENT_TTL_MS,
        });
        if (value) values.set(aircraft.id, value);
      } catch (error) {
        if (signal?.aborted) throw error;
        // A transport error, throttle, or upstream outage is not a confirmed
        // negative lookup. Leave it uncached so the next feed refresh retries.
      }
    }),
  );
  return values;
}

export function buildAircraftFeedUrl(
  kind: "opensky" | "military",
  dev = isViteDevServer(),
): string {
  if (kind === "opensky") return dev ? OPEN_SKY_DEV_URL : OPEN_SKY_EDGE_URL;
  return dev ? ADSB_LOL_DEV_URL : ADSB_LOL_EDGE_URL;
}

export async function fetchOpenSkyCzml(
  window: CzmlTimeWindow,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    bounds?: [number, number, number, number] | null;
  } = {},
): Promise<GodsEyeViewFeedPayload> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(buildAircraftFeedUrl("opensky"), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`OpenSky feed failed (${response.status})`);
  const payload = (await response.json()) as {
    time?: unknown;
    states?: unknown;
  };
  if (!Array.isArray(payload.states)) throw new Error("OpenSky returned a malformed response");
  const snapshotTimeMs =
    (finite(payload.time) ?? (window.current?.getTime() ?? Date.now()) / 1000) * 1000;
  const observations = payload.states.flatMap((row) => {
    const value = normalizeOpenSkyAircraft(row, snapshotTimeMs);
    return value ? [value] : [];
  });
  const enrichment = await enrichAircraft(
    observations,
    options.bounds ?? null,
    fetcher,
    options.signal,
  );
  return aircraftToCzml(observations, window.current ?? new Date(), {
    name: "Live Flights",
    idPrefix: "opensky",
    color: [53, 208, 255, 255],
    coastSeconds: 45,
    enrichment,
  });
}

export async function fetchMilitaryFlightsCzml(
  window: CzmlTimeWindow,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    bounds?: [number, number, number, number] | null;
  } = {},
): Promise<GodsEyeViewFeedPayload> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(buildAircraftFeedUrl("military"), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`adsb.lol feed failed (${response.status})`);
  const payload = (await response.json()) as {
    now?: unknown;
    total?: unknown;
    ac?: unknown;
  };
  if (!Array.isArray(payload.ac)) throw new Error("adsb.lol returned a malformed response");
  const nowValue = finite(payload.now);
  const snapshotTimeMs =
    nowValue === null
      ? (window.current?.getTime() ?? Date.now())
      : nowValue > 1e12
        ? nowValue
        : nowValue * 1000;
  const observations = payload.ac.flatMap((row) => {
    const value = normalizeAdsbLolAircraft(row, snapshotTimeMs);
    return value ? [value] : [];
  });
  const enrichment = await enrichAircraft(
    observations,
    options.bounds ?? null,
    fetcher,
    options.signal,
  );
  return aircraftToCzml(observations, window.current ?? new Date(), {
    name: "Military Flights",
    idPrefix: "adsblol",
    color: [255, 179, 0, 255],
    coastSeconds: 30,
    enrichment,
  });
}
