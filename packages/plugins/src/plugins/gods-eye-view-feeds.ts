import type { CzmlPacket } from "@geolibre/core";
import type { FeatureCollection } from "geojson";

export const USGS_EARTHQUAKE_FEED_BASE =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
export const CELESTRAK_TLE_BASE = "https://celestrak.org/NORAD/elements/gp.php";

const EARTH_RADIUS_METERS = 6_378_137;
const EARTH_GRAVITATIONAL_PARAMETER = 3.986004418e14;
const TWO_PI = Math.PI * 2;
const SECONDS_PER_DAY = 86_400;

export const CELESTRAK_CORE_GROUPS = [
  { group: "stations", classification: "stations" },
  { group: "visual", classification: "visual" },
  { group: "gps-ops", classification: "gps" },
  { group: "glo-ops", classification: "glonass" },
  { group: "galileo", classification: "galileo" },
  { group: "geo", classification: "geo" },
] as const;

export type SatelliteClassification = (typeof CELESTRAK_CORE_GROUPS)[number]["classification"];

export interface UsgsFeatureCollection {
  features?: Array<{
    id?: unknown;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
    properties?: { mag?: unknown; place?: unknown; time?: unknown } | null;
  } | null> | null;
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
  classification?: SatelliteClassification;
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

/**
 * Materialize one read-only attribute-table row for every CZML entity packet.
 *
 * A moving entity has no single GeoJSON geometry, so its row keeps the first
 * sampled position as a stable table/selection anchor. The packet id remains
 * the feature id, matching the Cesium entity id used by Identify and selection.
 */
export function czmlPacketsToAttributeGeoJson(packets: readonly CzmlPacket[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: packets.flatMap((packet, index) => {
      if (packet.id === "document") return [];
      const properties: Record<string, unknown> = {};
      if (typeof packet.name === "string") properties.name = packet.name;
      if (typeof packet.availability === "string") properties.availability = packet.availability;
      if (packet.properties && typeof packet.properties === "object") {
        Object.assign(properties, packet.properties);
      }
      const id = typeof packet.id === "string" || typeof packet.id === "number" ? packet.id : index;
      const position = packet.position as
        | { epoch?: unknown; cartesian?: unknown; cartographicDegrees?: unknown }
        | undefined;
      const cartographicValues = Array.isArray(position?.cartographicDegrees)
        ? position.cartographicDegrees
        : null;
      const cartesianValues = Array.isArray(position?.cartesian) ? position.cartesian : null;
      const coordinateOffset = typeof position?.epoch === "string" ? 1 : 0;
      let coordinates = cartographicValues?.slice(coordinateOffset, coordinateOffset + 3) ?? [];
      if (coordinates.length !== 3 && cartesianValues) {
        const [x, y, z] = cartesianValues.slice(coordinateOffset, coordinateOffset + 3);
        if ([x, y, z].every((value) => Number.isFinite(value))) {
          const radius = Math.hypot(x as number, y as number, z as number);
          coordinates = [
            degrees(Math.atan2(y as number, x as number)),
            degrees(Math.asin((z as number) / radius)),
            radius - EARTH_RADIUS_METERS,
          ];
        }
      }
      const geometry =
        coordinates.length === 3 && coordinates.every((value) => Number.isFinite(value))
          ? { type: "Point" as const, coordinates: coordinates as number[] }
          : { type: "GeometryCollection" as const, geometries: [] };
      return [{ type: "Feature" as const, id, geometry, properties }];
    }),
  };
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
      // Real time unless a caller asks otherwise, matching the plugin's own
      // default speed: the feeds describe when things actually happen.
      multiplier: window.multiplier ?? 1,
      range: "LOOP_STOP",
      step: "SYSTEM_CLOCK_MULTIPLIER",
    },
  };
}

/** Convert the USGS GeoJSON response to an inline, time-aware CZML document. */
export function usgsGeoJsonToCzml(
  value: UsgsFeatureCollection | null | undefined,
  window: CzmlTimeWindow,
): CzmlPacket[] {
  const packets: CzmlPacket[] = [documentPacket("USGS Earthquakes", window)];
  // The feed is public JSON parsed straight off the wire, so neither the
  // collection nor its entries are guaranteed to have the documented shape.
  const features = Array.isArray(value?.features) ? value.features : [];
  for (const [index, feature] of features.entries()) {
    if (!feature || typeof feature !== "object") continue;
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
      // Altitude is pinned to the surface. USGS reports depth in kilometres
      // *below* ground, so the honest position is underground, where the globe
      // would hide the marker behind terrain; the depth is carried in
      // `properties` instead, where Identify can read it.
      position: { cartographicDegrees: [longitude, latitude, 0] },
      properties: {
        magnitude: mag,
        depthKm,
        place,
        time: event.toISOString(),
      },
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
export function parseTle(text: string, classification?: SatelliteClassification): TleRecord[] {
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
      classification,
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
): {
  longitude: number;
  latitude: number;
  altitude: number;
  cartesian: [number, number, number];
} {
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
    cartesian: [xEcef, yEcef, zEci],
  };
}

/** Seconds for one revolution, derived from the TLE's mean motion. */
export function orbitalPeriodSeconds(tle: TleRecord): number {
  return SECONDS_PER_DAY / tle.meanMotionRevolutionsPerDay;
}

/**
 * Pre-sample parsed TLEs into Cesium-interpolated CZML moving entities.
 *
 * The reference God's Eye View keeps the full catalog readable by drawing an
 * orbit and persistent label only for the ISS. Its samples extend half an
 * orbit past both clock boundaries so Cesium never clips that ring into a stub.
 * Other satellites need samples only inside the animation window.
 */
export function tleRecordsToCzml(
  records: readonly TleRecord[],
  options: SatelliteSampleOptions,
): CzmlPacket[] {
  const stepSeconds = Math.max(30, options.stepSeconds ?? 120);
  const maxSatellites = Math.max(1, options.maxSatellites ?? 75);
  const packets: CzmlPacket[] = [documentPacket("CelesTrak Satellites", options)];
  for (const tle of records.slice(0, maxSatellites)) {
    const periodSeconds = orbitalPeriodSeconds(tle);
    const isIss = tle.catalogNumber === "25544";
    const halfOrbitSeconds = Math.ceil(periodSeconds / 2);
    // Whole steps, so samples still land exactly on both clock boundaries.
    const paddingSeconds = isIss ? Math.ceil(halfOrbitSeconds / stepSeconds) * stepSeconds : 0;
    const epoch = new Date(options.start.getTime() - paddingSeconds * 1000);
    const sampledUntil = new Date(options.stop.getTime() + paddingSeconds * 1000);
    const samples: number[] = [];
    for (let time = epoch.getTime(); time <= sampledUntil.getTime(); time += stepSeconds * 1000) {
      const at = new Date(time);
      const position = sampleSatellitePosition(tle, at);
      samples.push((time - epoch.getTime()) / 1000, ...position.cartesian);
    }
    const colors: Record<SatelliteClassification, [number, number, number, number]> = {
      stations: [255, 246, 229, 255],
      visual: [159, 179, 196, 255],
      gps: [79, 216, 255, 255],
      glonass: [79, 216, 255, 255],
      galileo: [79, 216, 255, 255],
      geo: [200, 155, 255, 255],
    };
    const classification = tle.classification ?? "visual";
    const packet: CzmlPacket = {
      id: `celestrak-${tle.catalogNumber}`,
      name: tle.name,
      availability: `${iso(epoch)}/${iso(sampledUntil)}`,
      position: {
        epoch: iso(epoch),
        referenceFrame: "FIXED",
        interpolationAlgorithm: "LAGRANGE",
        interpolationDegree: 5,
        // Cartesian samples stay continuous across the antimeridian. Interpolating
        // longitude directly makes +179° → -179° cut a chord through the globe.
        cartesian: samples,
      },
      properties: {
        catalogNumber: tle.catalogNumber,
        inclinationDeg: tle.inclinationDeg,
        orbitalPeriodMinutes: Number((periodSeconds / 60).toFixed(2)),
        ...(tle.classification ? { group: tle.classification } : {}),
      },
      point: {
        pixelSize: isIss
          ? 12
          : classification === "stations"
            ? 8
            : classification === "geo"
              ? 5
              : 6,
        color: { rgba: isIss ? [255, 68, 68, 255] : colors[classification] },
        outlineColor: { rgba: [255, 255, 255, 77] },
        outlineWidth: isIss ? 2 : 0,
      },
    };
    // The ISS is the one satellite with a standing name, as in the reference
    // app. Cesium labels perform no collision avoidance whatsoever, so labelling
    // the fleet piled hundreds of names on top of each other — and on top of the
    // ISS's — the moment the camera came in close. Every other satellite names
    // itself on hover and on Identify instead, which is also where its
    // catalogue number, inclination and period already live.
    if (isIss) {
      packet.label = {
        text: "ISS",
        font: "600 14px sans-serif",
        style: "FILL_AND_OUTLINE",
        fillColor: { rgba: [255, 255, 255, 255] },
        outlineColor: { rgba: [0, 0, 0, 255] },
        outlineWidth: 3,
        showBackground: true,
        backgroundColor: { rgba: [0, 0, 0, 210] },
        backgroundPadding: { cartesian2: [6, 4] },
        pixelOffset: { cartesian2: [0, -21] },
        // Do not scale the label by distance: shrinking a 14px label at the
        // display cutoff makes it technically present but unreadable over
        // aerial imagery.
        distanceDisplayCondition: { distanceDisplayCondition: [0, 30_000_000] },
      };
    }
    if (isIss) {
      packet.path = {
        show: true,
        width: 1,
        leadTime: halfOrbitSeconds,
        trailTime: halfOrbitSeconds,
        material: { solidColor: { color: { rgba: [0, 180, 255, 150] } } },
      };
    }
    packets.push(packet);
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
  const group = options.group ?? "stations";
  const classification = CELESTRAK_CORE_GROUPS.find(
    (entry) => entry.group === group,
  )?.classification;
  const records = parseTle(await response.text(), classification);
  if (records.length === 0) throw new Error("CelesTrak feed contained no valid TLE records");
  return tleRecordsToCzml(records, options);
}

/** Load and de-duplicate the same six core CelesTrak groups as God's Eye View. */
export async function fetchCelestrakSatelliteCatalogCzml(
  options: SatelliteSampleOptions & { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<CzmlPacket[]> {
  const fetcher = options.fetch ?? fetch;
  const results = await Promise.allSettled(
    CELESTRAK_CORE_GROUPS.map(async ({ group, classification }) => {
      const response = await fetcher(buildCelestrakTleUrl(group), { signal: options.signal });
      if (!response.ok) throw new Error(`${group} failed (${response.status})`);
      return parseTle(await response.text(), classification);
    }),
  );
  options.signal?.throwIfAborted();
  const byCatalogNumber = new Map<string, TleRecord>();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const record of result.value) {
      if (!byCatalogNumber.has(record.catalogNumber)) {
        byCatalogNumber.set(record.catalogNumber, record);
      }
    }
  }
  if (byCatalogNumber.size === 0) {
    throw new Error("CelesTrak core catalog contained no valid TLE records");
  }
  return tleRecordsToCzml([...byCatalogNumber.values()], options);
}
