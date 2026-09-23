import type { CzmlPacket } from "@geolibre/core";
import type { Feature, Point } from "geojson";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";
import { isViteDevServer } from "./gods-eye-view-feeds";

/**
 * NASA FIRMS active fires from the keyless global 24 h VIIRS files.
 *
 * Upstream God's Eye View reads FIRMS through its keyed area API. A whole-world
 * snapshot does not need a MAP_KEY: FIRMS publishes the same trailing-24 h
 * detections as fixed CSVs per satellite. They send no CORS header, so the web
 * build reads them through the tiles worker (and the Vite relay in dev).
 */
export const FIRMS_EDGE_BASE = "https://tiles.geolibre.app/firms/viirs";
export const FIRMS_DEV_BASE = "/firms/viirs";

/** The three VIIRS satellites, relayed under these ids by the worker. */
export const FIRMS_SATELLITES = ["noaa-20", "noaa-21", "suomi-npp"] as const;
export type FirmsSatellite = (typeof FIRMS_SATELLITES)[number];

/**
 * Detections are binned to this grid before rendering. The three satellites
 * together report ~200k detections a day, far past what a CZML layer (and the
 * autosave snapshot) can carry; a 0.1 degree (~11 km) cell keeps each fire
 * complex visible as one point whose size follows its radiative power.
 */
export const FIRMS_CELL_DEGREES = 0.1;
/** Upper bound on rendered cells, strongest first; matches Bike Share's cap. */
export const FIRMS_MAX_CELLS = 8_000;

const FIRMS_SATELLITE_LABELS: Record<FirmsSatellite, string> = {
  "noaa-20": "NOAA-20",
  "noaa-21": "NOAA-21",
  "suomi-npp": "Suomi NPP",
};

/** One VIIRS detection, reduced to the fields the layer uses. */
export interface FirmsDetection {
  latitude: number;
  longitude: number;
  frp: number;
  confidence: string;
  acquiredAtMs: number;
  daynight: string;
  satellite: string;
}

/** Relay URL for one satellite's global 24 h file. */
export function firmsRequestUrl(satellite: FirmsSatellite, dev = isViteDevServer()): string {
  return `${dev ? FIRMS_DEV_BASE : FIRMS_EDGE_BASE}/${satellite}`;
}

/**
 * Convert FIRMS `acq_date` (`YYYY-MM-DD`) and `acq_time` (UTC `HHMM`, not
 * always zero-padded: "45" is 00:45) to epoch milliseconds, or `NaN`.
 */
export function firmsAcquisitionMs(acqDate: string, acqTime: string): number {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acqDate.trim());
  const time = acqTime.trim();
  if (!date || !/^\d{1,4}$/.test(time)) return Number.NaN;
  const hhmm = time.padStart(4, "0");
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2));
  if (hours > 23 || minutes > 59) return Number.NaN;
  return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hours, minutes);
}

/**
 * Parse a FIRMS VIIRS (or MODIS) CSV into detections.
 *
 * Columns are located by header name so a reordered product version still
 * parses. Malformed rows are skipped, and low-confidence detections are
 * dropped: FIRMS flags those as likely false alarms (sun glint, hot surfaces).
 * Returns `null` when the body is not FIRMS CSV at all (an error page).
 */
export function parseFirmsCsv(csv: string): FirmsDetection[] | null {
  const lines = csv.split(/\r?\n/);
  const header = (lines[0] ?? "")
    .trim()
    .toLowerCase()
    .split(",")
    .map((field) => field.trim());
  const column = new Map(header.map((name, index) => [name, index]));
  const iLat = column.get("latitude");
  const iLon = column.get("longitude");
  const iFrp = column.get("frp");
  const iDate = column.get("acq_date");
  const iTime = column.get("acq_time");
  if (
    iLat === undefined ||
    iLon === undefined ||
    iFrp === undefined ||
    iDate === undefined ||
    iTime === undefined
  ) {
    return null;
  }
  const iConfidence = column.get("confidence");
  const iDaynight = column.get("daynight");
  const iSatellite = column.get("satellite");

  const detections: FirmsDetection[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const cells = line.split(",");
    if (cells.length < header.length) continue;
    const confidence = cell(cells, iConfidence).toLowerCase();
    if (isLowConfidence(confidence)) continue;
    const latitude = Number(cells[iLat]);
    const longitude = Number(cells[iLon]);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) continue;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
    const acquiredAtMs = firmsAcquisitionMs(cell(cells, iDate), cell(cells, iTime));
    if (!Number.isFinite(acquiredAtMs)) continue;
    const frp = Number(cells[iFrp]);
    detections.push({
      latitude,
      longitude,
      frp: Number.isFinite(frp) && frp > 0 ? frp : 0,
      confidence,
      acquiredAtMs,
      daynight: cell(cells, iDaynight),
      satellite: satelliteName(cell(cells, iSatellite)),
    });
  }
  return detections;
}

/** FIRMS' per-row satellite codes; Suomi NPP is reported as a bare "N". */
const FIRMS_SATELLITE_CODES: Record<string, string> = {
  N: "Suomi NPP",
  N20: "NOAA-20",
  N21: "NOAA-21",
  T: "Terra",
  A: "Aqua",
};

/**
 * VIIRS reports confidence as a word (`low`/`nominal`/`high`, or `l`/`n`/`h`);
 * MODIS as 0-100, where FIRMS classes below 30 as low.
 */
function isLowConfidence(confidence: string): boolean {
  if (confidence === "low" || confidence === "l") return true;
  const percent = Number(confidence);
  return confidence !== "" && Number.isFinite(percent) && percent < 30;
}

function satelliteName(code: string): string {
  return FIRMS_SATELLITE_CODES[code.toUpperCase()] ?? code;
}

function cell(cells: readonly string[], index: number | undefined): string {
  return index === undefined ? "" : (cells[index] ?? "").trim();
}

interface FireCell {
  latSum: number;
  lonSum: number;
  detections: number;
  totalFrp: number;
  maxFrp: number;
  firstMs: number;
  lastMs: number;
  satellites: Set<string>;
  night: number;
}

/**
 * Bin detections into fire clusters (strongest total FRP first) and emit them
 * as CZML points with matching attribute features.
 */
export function firmsDetectionsToCzml(
  detections: readonly FirmsDetection[],
  options: { cellDegrees?: number; maxCells?: number } = {},
): GodsEyeViewFeedPayload {
  const size = options.cellDegrees ?? FIRMS_CELL_DEGREES;
  const maxCells = options.maxCells ?? FIRMS_MAX_CELLS;
  const cells = new Map<string, FireCell>();
  for (const detection of detections) {
    const key = `${Math.floor(detection.latitude / size)}:${Math.floor(detection.longitude / size)}`;
    let fire = cells.get(key);
    if (!fire) {
      fire = {
        latSum: 0,
        lonSum: 0,
        detections: 0,
        totalFrp: 0,
        maxFrp: 0,
        firstMs: detection.acquiredAtMs,
        lastMs: detection.acquiredAtMs,
        satellites: new Set(),
        night: 0,
      };
      cells.set(key, fire);
    }
    fire.latSum += detection.latitude;
    fire.lonSum += detection.longitude;
    fire.detections += 1;
    fire.totalFrp += detection.frp;
    fire.maxFrp = Math.max(fire.maxFrp, detection.frp);
    fire.firstMs = Math.min(fire.firstMs, detection.acquiredAtMs);
    fire.lastMs = Math.max(fire.lastMs, detection.acquiredAtMs);
    if (detection.satellite) fire.satellites.add(detection.satellite);
    if (detection.daynight.toUpperCase() === "N") fire.night += 1;
  }

  const ranked = [...cells.entries()]
    .sort(([, a], [, b]) => b.totalFrp - a.totalFrp || b.detections - a.detections)
    .slice(0, maxCells);
  const packets: CzmlPacket[] = [{ id: "document", name: "Active Fires", version: "1.0" }];
  const features: Feature<Point>[] = [];
  for (const [key, fire] of ranked) {
    const longitude = round(fire.lonSum / fire.detections, 4);
    const latitude = round(fire.latSum / fire.detections, 4);
    const id = `firms-fire-${key}`;
    const name = `Active fire (${fire.detections} detection${fire.detections === 1 ? "" : "s"})`;
    const properties = {
      name,
      detections: fire.detections,
      totalFrpMw: round(fire.totalFrp, 1),
      maxFrpMw: round(fire.maxFrp, 1),
      firstDetected: new Date(fire.firstMs).toISOString(),
      lastDetected: new Date(fire.lastMs).toISOString(),
      nightDetections: fire.night,
      satellites: [...fire.satellites].sort().join(", "),
      source: "NASA FIRMS VIIRS",
    };
    packets.push({
      id,
      name,
      position: { cartographicDegrees: [longitude, latitude, 0] },
      properties,
      point: {
        pixelSize: firePixelSize(fire.totalFrp),
        color: { rgba: fireColor(fire.totalFrp) },
        outlineColor: { rgba: [60, 20, 0, 200] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** 4 px for a smoulder, up to 18 px for a >10 GW complex (log scale). */
function firePixelSize(totalFrp: number): number {
  return Math.round(Math.min(18, Math.max(4, 4 + 3 * Math.log10(1 + totalFrp))));
}

/** Yellow for weak detections through orange to deep red for intense fires. */
function fireColor(totalFrp: number): [number, number, number, number] {
  const t = Math.min(1, Math.log10(1 + totalFrp) / 4);
  return [255, Math.round(220 - 190 * t), Math.round(60 - 50 * t), 235];
}

/**
 * Fetch every VIIRS satellite's 24 h file and merge them into fire clusters.
 *
 * A satellite whose file fails is skipped so one late upload does not blank
 * the layer; the fetch throws only when none of them could be read.
 */
export async function fetchActiveFiresCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal; dev?: boolean } = {},
): Promise<GodsEyeViewFeedPayload> {
  const request = options.fetch ?? fetch;
  const results = await Promise.allSettled(
    FIRMS_SATELLITES.map(async (satellite) => {
      const response = await request(firmsRequestUrl(satellite, options.dev), {
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error(
          `NASA FIRMS ${FIRMS_SATELLITE_LABELS[satellite]} failed (${response.status})`,
        );
      }
      const detections = parseFirmsCsv(await response.text());
      if (!detections) {
        throw new Error(`NASA FIRMS ${FIRMS_SATELLITE_LABELS[satellite]} returned no CSV`);
      }
      return detections;
    }),
  );
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
  const detections: FirmsDetection[] = [];
  let lastError: unknown = null;
  let succeeded = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      succeeded += 1;
      for (const detection of result.value) detections.push(detection);
    } else {
      lastError = result.reason;
    }
  }
  if (succeeded === 0) {
    throw lastError instanceof Error ? lastError : new Error("NASA FIRMS unavailable");
  }
  return firmsDetectionsToCzml(detections);
}
