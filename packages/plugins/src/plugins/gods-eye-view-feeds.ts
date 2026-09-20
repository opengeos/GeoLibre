import type { CzmlPacket } from "@geolibre/core";

export const USGS_EARTHQUAKE_FEED_BASE =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
export const CELESTRAK_TLE_BASE = "https://celestrak.org/NORAD/elements/gp.php";

const EARTH_RADIUS_METERS = 6_378_137;
const EARTH_GRAVITATIONAL_PARAMETER = 3.986004418e14;
const TWO_PI = Math.PI * 2;

export interface UsgsFeatureCollection {
  features?: Array<{
    id?: unknown;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
    properties?: { mag?: unknown; place?: unknown; time?: unknown } | null;
  }>;
}

export interface TleRecord {
  name: string;
  catalogNumber: string;
  epoch: Date;
  inclinationDeg: number;
  raanDeg: number;
  eccentricity: number;
  argumentOfPerigeeDeg: number;
  meanAnomalyDeg: number;
  meanMotionRevolutionsPerDay: number;
}

export interface CzmlTimeWindow {
  start: Date;
  stop: Date;
  current?: Date;
  multiplier?: number;
}

export interface SatelliteSampleOptions extends CzmlTimeWindow {
  stepSeconds?: number;
  maxSatellites?: number;
}

export function buildUsgsFeedUrl(period = "day", magnitude = "all"): string {
  return `${USGS_EARTHQUAKE_FEED_BASE}/${encodeURIComponent(magnitude)}_${encodeURIComponent(period)}.geojson`;
}

export function buildCelestrakTleUrl(group = "stations"): string {
  const url = new URL(CELESTRAK_TLE_BASE);
  url.searchParams.set("GROUP", group);
  url.searchParams.set("FORMAT", "tle");
  return url.toString();
}

function iso(value: Date): string {
  return value.toISOString();
}

function documentPacket(name: string, window: CzmlTimeWindow): CzmlPacket {
  return {
    id: "document",
    name,
    version: "1.0",
    clock: {
      interval: `${iso(window.start)}/${iso(window.stop)}`,
      currentTime: iso(window.current ?? window.start),
      multiplier: window.multiplier ?? 60,
      range: "LOOP_STOP",
      step: "SYSTEM_CLOCK_MULTIPLIER",
    },
  };
}

/** Convert the USGS GeoJSON response to an inline, time-aware CZML document. */
export function usgsGeoJsonToCzml(
  value: UsgsFeatureCollection,
  window: CzmlTimeWindow,
): CzmlPacket[] {
  const packets: CzmlPacket[] = [documentPacket("USGS Earthquakes", window)];
  for (const [index, feature] of (value.features ?? []).entries()) {
    const coordinates = feature.geometry?.coordinates;
    const magnitude = feature.properties?.mag;
    const eventTime = feature.properties?.time;
    if (
      feature.geometry?.type !== "Point" ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !coordinates.slice(0, 2).every((coordinate) => typeof coordinate === "number") ||
      typeof eventTime !== "number" ||
      !Number.isFinite(eventTime)
    ) {
      continue;
    }
    const longitude = coordinates[0] as number;
    const latitude = coordinates[1] as number;
    const depthKm = typeof coordinates[2] === "number" ? coordinates[2] : 0;
    const mag = typeof magnitude === "number" && Number.isFinite(magnitude) ? magnitude : 0;
    const event = new Date(eventTime);
    if (Number.isNaN(event.getTime())) continue;
    const availableFrom = new Date(eventTime - 30 * 60_000);
    const availableUntil = new Date(eventTime + 48 * 60 * 60_000);
    const place =
      typeof feature.properties?.place === "string" && feature.properties.place.trim()
        ? feature.properties.place.trim()
        : `M ${mag.toFixed(1)}`;
    packets.push({
      id: `usgs-${typeof feature.id === "string" ? feature.id : index}`,
      name: place,
      availability: `${iso(availableFrom)}/${iso(availableUntil)}`,
      position: { cartographicDegrees: [longitude, latitude, Math.max(0, -depthKm * 1000)] },
      point: {
        pixelSize: Math.min(24, Math.max(6, 6 + mag * 2)),
        color: { rgba: [255, Math.max(32, 190 - Math.round(mag * 22)), 32, 230] },
        outlineColor: { rgba: [255, 255, 255, 220] },
        outlineWidth: 1.5,
      },
    });
  }
  return packets;
}

function parseTleEpoch(line1: string): Date | null {
  const raw = line1.slice(18, 32).trim();
  if (!/^\d{5}\.\d+$/.test(raw)) return null;
  const shortYear = Number(raw.slice(0, 2));
  const dayOfYear = Number(raw.slice(2));
  if (!Number.isFinite(dayOfYear) || dayOfYear < 1 || dayOfYear >= 367) return null;
  const year = shortYear < 57 ? 2000 + shortYear : 1900 + shortYear;
  return new Date(Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000);
}

/** Parse ordinary three-line (name + line 1 + line 2) CelesTrak TLE text. */
export function parseTle(text: string): TleRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const records: TleRecord[] = [];
  for (let index = 0; index < lines.length;) {
    const hasName = !lines[index].startsWith("1 ");
    const name = hasName ? lines[index].trim() : "Satellite";
    const line1 = lines[index + (hasName ? 1 : 0)];
    const line2 = lines[index + (hasName ? 2 : 1)];
    index += hasName ? 3 : 2;
    if (!line1?.startsWith("1 ") || !line2?.startsWith("2 ")) continue;
    const epoch = parseTleEpoch(line1);
    const catalogNumber = line1.slice(2, 7).trim();
    const inclinationDeg = Number(line2.slice(8, 16));
    const raanDeg = Number(line2.slice(17, 25));
    const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
    const argumentOfPerigeeDeg = Number(line2.slice(34, 42));
    const meanAnomalyDeg = Number(line2.slice(43, 51));
    const meanMotionRevolutionsPerDay = Number(line2.slice(52, 63));
    if (
      !epoch ||
      !catalogNumber ||
      ![
        inclinationDeg,
        raanDeg,
        eccentricity,
        argumentOfPerigeeDeg,
        meanAnomalyDeg,
        meanMotionRevolutionsPerDay,
      ].every(Number.isFinite) ||
      eccentricity < 0 ||
      eccentricity >= 1 ||
      meanMotionRevolutionsPerDay <= 0
    ) {
      continue;
    }
    records.push({
      name,
      catalogNumber,
      epoch,
      inclinationDeg,
      raanDeg,
      eccentricity,
      argumentOfPerigeeDeg,
      meanAnomalyDeg,
      meanMotionRevolutionsPerDay,
    });
  }
  return records;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function degrees(radiansValue: number): number {
  return (radiansValue * 180) / Math.PI;
}

function normalizeRadians(value: number): number {
  return ((value % TWO_PI) + TWO_PI) % TWO_PI;
}

function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number): number {
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const delta =
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  return eccentricAnomaly;
}

function gmstRadians(date: Date): number {
  const julianDate = date.getTime() / 86_400_000 + 2_440_587.5;
  const centuries = (julianDate - 2_451_545) / 36_525;
  const degreesValue =
    280.46061837 +
    360.98564736629 * (julianDate - 2_451_545) +
    0.000387933 * centuries * centuries -
    (centuries * centuries * centuries) / 38_710_000;
  return normalizeRadians(radians(degreesValue));
}

/**
 * Lightweight two-body propagation suitable for a short CZML preview arc.
 * TLE perturbation terms are intentionally omitted; Phase 1 needs a dependency-free
 * moving globe entity, not precision orbit determination.
 */
export function sampleSatellitePosition(
  tle: TleRecord,
  at: Date,
): { longitude: number; latitude: number; altitude: number } {
  const meanMotion = (tle.meanMotionRevolutionsPerDay * TWO_PI) / 86_400;
  const semiMajorAxis = Math.cbrt(EARTH_GRAVITATIONAL_PARAMETER / meanMotion ** 2);
  const elapsedSeconds = (at.getTime() - tle.epoch.getTime()) / 1000;
  const meanAnomaly = normalizeRadians(radians(tle.meanAnomalyDeg) + meanMotion * elapsedSeconds);
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, tle.eccentricity);
  const xOrbital = semiMajorAxis * (Math.cos(eccentricAnomaly) - tle.eccentricity);
  const yOrbital =
    semiMajorAxis * Math.sqrt(1 - tle.eccentricity ** 2) * Math.sin(eccentricAnomaly);
  const argument = radians(tle.argumentOfPerigeeDeg);
  const inclination = radians(tle.inclinationDeg);
  const raan = radians(tle.raanDeg);
  const xArgument = xOrbital * Math.cos(argument) - yOrbital * Math.sin(argument);
  const yArgument = xOrbital * Math.sin(argument) + yOrbital * Math.cos(argument);
  const xEci = xArgument * Math.cos(raan) - yArgument * Math.cos(inclination) * Math.sin(raan);
  const yEci = xArgument * Math.sin(raan) + yArgument * Math.cos(inclination) * Math.cos(raan);
  const zEci = yArgument * Math.sin(inclination);
  const theta = gmstRadians(at);
  const xEcef = xEci * Math.cos(theta) + yEci * Math.sin(theta);
  const yEcef = -xEci * Math.sin(theta) + yEci * Math.cos(theta);
  const radius = Math.hypot(xEcef, yEcef, zEci);
  return {
    longitude: degrees(Math.atan2(yEcef, xEcef)),
    latitude: degrees(Math.atan2(zEci, Math.hypot(xEcef, yEcef))),
    altitude: Math.max(0, radius - EARTH_RADIUS_METERS),
  };
}

/** Pre-sample parsed TLEs into Cesium-interpolated CZML moving entities. */
export function tleRecordsToCzml(
  records: readonly TleRecord[],
  options: SatelliteSampleOptions,
): CzmlPacket[] {
  const stepSeconds = Math.max(30, options.stepSeconds ?? 120);
  const maxSatellites = Math.max(1, options.maxSatellites ?? 75);
  const packets: CzmlPacket[] = [documentPacket("CelesTrak Satellites", options)];
  for (const tle of records.slice(0, maxSatellites)) {
    const samples: number[] = [];
    for (
      let time = options.start.getTime();
      time <= options.stop.getTime();
      time += stepSeconds * 1000
    ) {
      const at = new Date(time);
      const position = sampleSatellitePosition(tle, at);
      samples.push(
        (time - options.start.getTime()) / 1000,
        position.longitude,
        position.latitude,
        position.altitude,
      );
    }
    packets.push({
      id: `celestrak-${tle.catalogNumber}`,
      name: tle.name,
      availability: `${iso(options.start)}/${iso(options.stop)}`,
      position: {
        epoch: iso(options.start),
        interpolationAlgorithm: "LAGRANGE",
        interpolationDegree: 5,
        cartographicDegrees: samples,
      },
      point: {
        pixelSize: 7,
        color: { rgba: [0, 210, 255, 255] },
        outlineColor: { rgba: [255, 255, 255, 220] },
        outlineWidth: 1,
      },
      path: {
        show: true,
        width: 1,
        leadTime: 1800,
        trailTime: 1800,
        material: { solidColor: { color: { rgba: [0, 180, 255, 150] } } },
      },
    });
  }
  return packets;
}

export async function fetchUsgsEarthquakeCzml(
  window: CzmlTimeWindow,
  options: { fetch?: typeof fetch; signal?: AbortSignal; period?: string; magnitude?: string } = {},
): Promise<CzmlPacket[]> {
  const response = await (options.fetch ?? fetch)(
    buildUsgsFeedUrl(options.period, options.magnitude),
    { signal: options.signal },
  );
  if (!response.ok) throw new Error(`USGS feed failed (${response.status})`);
  return usgsGeoJsonToCzml((await response.json()) as UsgsFeatureCollection, window);
}

export async function fetchCelestrakSatelliteCzml(
  options: SatelliteSampleOptions & { fetch?: typeof fetch; signal?: AbortSignal; group?: string },
): Promise<CzmlPacket[]> {
  const response = await (options.fetch ?? fetch)(buildCelestrakTleUrl(options.group), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`CelesTrak feed failed (${response.status})`);
  const records = parseTle(await response.text());
  if (records.length === 0) throw new Error("CelesTrak feed contained no valid TLE records");
  return tleRecordsToCzml(records, options);
}
