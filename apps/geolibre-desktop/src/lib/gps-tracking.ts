/**
 * Pure helpers for the GPS Tracking tool (issue #1316): filtering incoming
 * geolocation fixes, computing track statistics, shaping GeoJSON for the live
 * overlays and the saved track/waypoint layers, and serializing tracks to GPX.
 *
 * Everything here is side-effect free so it can be unit tested without a DOM or
 * the app store. The React dialog (GpsTrackingDialog.tsx) owns the
 * `watchPosition` subscription, map markers/sources, and store wiring and
 * delegates the data shaping to these functions.
 *
 * A saved track/capture layer is an ordinary `geojson` GeoLibreLayer tagged via
 * `metadata` (see {@link GPS_TRACK_FLAG} / {@link GPS_CAPTURE_FLAG}), so it
 * rides through `.geolibre.json` save/load like any other inline layer.
 */
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
  Polygon,
  Position,
} from "geojson";

/** One geolocation fix, flattened from a `GeolocationPosition`. */
export interface GpsFix {
  lng: number;
  lat: number;
  /** Horizontal accuracy radius in meters (95% confidence). */
  accuracy: number;
  /** Meters above the WGS84 ellipsoid, when the device reports it. */
  altitude: number | null;
  /** Degrees clockwise from true north, when moving and reported. */
  heading: number | null;
  /** Ground speed in m/s, when reported. */
  speed: number | null;
  /** Fix time in epoch milliseconds. */
  timestamp: number;
}

/** User-tunable logging/capture filters (QGIS-style GPS options). */
export interface GpsTrackingSettings {
  /** Minimum meters between logged track fixes. 0 logs every fix. */
  minDistanceM: number;
  /** Minimum seconds between logged track fixes. 0 logs every fix. */
  minTimeS: number;
  /**
   * Accuracy gate in meters: fixes with a worse (larger) accuracy radius are
   * not logged to the track, and point capture warns instead of saving.
   * 0 disables the gate.
   */
  maxAccuracyM: number;
}

export const DEFAULT_GPS_SETTINGS: GpsTrackingSettings = {
  minDistanceM: 0,
  minTimeS: 0,
  maxAccuracyM: 0,
};

/** Bounds applied when normalizing persisted settings. */
const MAX_MIN_DISTANCE_M = 10_000;
const MAX_MIN_TIME_S = 3_600;
const MAX_ACCURACY_M = 100_000;

function clampNumber(raw: unknown, max: number): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

/**
 * Validate settings restored from localStorage (or any untrusted source),
 * falling back to defaults for missing or out-of-range values.
 */
export function normalizeGpsSettings(raw: unknown): GpsTrackingSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_GPS_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    minDistanceM: clampNumber(r.minDistanceM, MAX_MIN_DISTANCE_M),
    minTimeS: clampNumber(r.minTimeS, MAX_MIN_TIME_S),
    maxAccuracyM: clampNumber(r.maxAccuracyM, MAX_ACCURACY_M),
  };
}

/** Flatten a `GeolocationPosition` into a plain, serializable {@link GpsFix}. */
export function fixFromPosition(pos: GeolocationPosition): GpsFix {
  const c = pos.coords;
  return {
    lng: c.longitude,
    lat: c.latitude,
    accuracy: c.accuracy,
    altitude: c.altitude ?? null,
    // A NaN heading (some browsers report it while stationary) is "unknown".
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    timestamp: pos.timestamp,
  };
}

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in meters between two [lng, lat] positions. */
export function haversineMeters(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** True when a fix passes the accuracy gate (used for both logging and capture). */
export function fixMeetsAccuracy(fix: GpsFix, settings: GpsTrackingSettings): boolean {
  return settings.maxAccuracyM <= 0 || fix.accuracy <= settings.maxAccuracyM;
}

/**
 * Decide whether `next` should be appended to the track log after `prev` (the
 * last logged fix, or null at the start of a recording). Applies the accuracy
 * gate, then the minimum-time and minimum-distance filters.
 */
export function shouldLogFix(
  prev: GpsFix | null,
  next: GpsFix,
  settings: GpsTrackingSettings,
): boolean {
  if (!fixMeetsAccuracy(next, settings)) return false;
  if (!prev) return true;
  if (settings.minTimeS > 0 && next.timestamp - prev.timestamp < settings.minTimeS * 1000) {
    return false;
  }
  if (
    settings.minDistanceM > 0 &&
    haversineMeters([prev.lng, prev.lat], [next.lng, next.lat]) < settings.minDistanceM
  ) {
    return false;
  }
  return true;
}

/**
 * A recorded track as continuous runs of fixes. Pausing and resuming the
 * recording starts a new segment, so the gap travelled while paused is never
 * drawn or measured as if it had been walked (mirrors GPX's `<trkseg>`).
 */
export type GpsTrackSegments = GpsFix[][];

/**
 * Segments with enough points to form a line. A 0/1-point segment (e.g. a
 * single stray fix between a resume and the next pause) has no drawable or
 * measurable extent and is dropped from geometry, stats, and GPX alike.
 */
export function lineSegments(segments: GpsTrackSegments): GpsFix[][] {
  return segments.filter((s) => s.length >= 2);
}

/** Total logged fixes across all segments. */
export function trackPointCount(segments: GpsTrackSegments): number {
  return segments.reduce((n, s) => n + s.length, 0);
}

export interface TrackStats {
  /**
   * Path length in meters, summed over consecutive fixes within each segment.
   * Gaps between segments (paused stretches) contribute nothing.
   */
  distanceM: number;
  /** Seconds between the first and last logged fix, pauses included. */
  durationS: number;
  pointCount: number;
}

export function trackStats(segments: GpsTrackSegments): TrackStats {
  let distanceM = 0;
  for (const fixes of segments) {
    for (let i = 1; i < fixes.length; i += 1) {
      const a = fixes[i - 1];
      const b = fixes[i];
      distanceM += haversineMeters([a.lng, a.lat], [b.lng, b.lat]);
    }
  }
  const all = segments.flat();
  const durationS = all.length >= 2 ? (all[all.length - 1].timestamp - all[0].timestamp) / 1000 : 0;
  return { distanceM, durationS, pointCount: all.length };
}

/** A fix's GeoJSON coordinate, carrying altitude as the third value if known. */
function fixPosition(fix: GpsFix): Position {
  return fix.altitude != null ? [fix.lng, fix.lat, fix.altitude] : [fix.lng, fix.lat];
}

/** `metadata` flags tagging layers created by the GPS Tracking tool. */
export const GPS_TRACK_FLAG = "gpsTrack";
export const GPS_CAPTURE_FLAG = "gpsCapture";

/** Minimal structural view of a layer — avoids coupling this module to the store. */
export interface GpsLayerLike {
  type: string;
  metadata?: Record<string, unknown> | null;
}

/** True when a layer holds points captured by the GPS Tracking tool. */
export function isGpsCaptureLayer(layer: GpsLayerLike): boolean {
  return layer.type === "geojson" && layer.metadata?.[GPS_CAPTURE_FLAG] === true;
}

/**
 * Build the track feature saved to a layer: a LineString for a single
 * continuous recording, a MultiLineString when pauses split it into several
 * segments. Per-vertex timestamps ride along as an ISO-string `times`
 * property (flat for a LineString, nested per segment for a MultiLineString)
 * so the recording remains GPX-exportable after a project save/load round trip.
 */
export function trackFeature(segments: GpsTrackSegments): Feature<LineString | MultiLineString> {
  const kept = lineSegments(segments);
  const stats = trackStats(kept);
  const all = kept.flat();
  const times = kept.map((seg) => seg.map((f) => new Date(f.timestamp).toISOString()));
  return {
    type: "Feature",
    geometry:
      kept.length === 1
        ? { type: "LineString", coordinates: kept[0].map(fixPosition) }
        : {
            type: "MultiLineString",
            coordinates: kept.map((seg) => seg.map(fixPosition)),
          },
    properties: {
      gpx_kind: "track",
      point_count: stats.pointCount,
      segment_count: kept.length,
      distance_m: Math.round(stats.distanceM * 10) / 10,
      duration_s: Math.round(stats.durationS),
      start_time: all.length ? new Date(all[0].timestamp).toISOString() : null,
      end_time: all.length ? new Date(all[all.length - 1].timestamp).toISOString() : null,
      times: kept.length === 1 ? times[0] : times,
    },
  };
}

/** The FeatureCollection saved as a track layer (a single track feature). */
export function trackFeatureCollection(segments: GpsTrackSegments): FeatureCollection {
  return { type: "FeatureCollection", features: [trackFeature(segments)] };
}

/**
 * Geometry-only rendering of the in-progress track for the live map source.
 * Deliberately carries no timestamps or stats: it is rebuilt on every fix, so
 * it stays as cheap as possible (see the per-fix redraw in GpsTrackingDialog).
 */
export function trackPreview(segments: GpsTrackSegments): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: lineSegments(segments).map((seg) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: seg.map(fixPosition) },
      properties: {},
    })),
  };
}

/** Build the Point feature saved when capturing the current position. */
export function capturePointFeature(fix: GpsFix): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: fixPosition(fix) },
    properties: {
      time: new Date(fix.timestamp).toISOString(),
      accuracy_m: Math.round(fix.accuracy * 10) / 10,
      ...(fix.altitude != null ? { ele: fix.altitude } : {}),
      ...(fix.speed != null ? { speed_mps: fix.speed } : {}),
      ...(fix.heading != null ? { heading_deg: fix.heading } : {}),
    },
  };
}

/**
 * Approximate the fix's accuracy radius as a polygon in degrees, for the
 * translucent accuracy circle drawn under the position marker. Good enough at
 * marker scale; not intended for analysis.
 */
export function accuracyCircle(fix: GpsFix, steps = 64): Feature<Polygon> {
  const latRad = (fix.lat * Math.PI) / 180;
  const degPerMeterLat = 180 / (Math.PI * EARTH_RADIUS_M);
  const degPerMeterLng = degPerMeterLat / Math.max(Math.cos(latRad), 1e-6);
  const ring: Position[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([
      fix.lng + Math.cos(a) * fix.accuracy * degPerMeterLng,
      fix.lat + Math.sin(a) * fix.accuracy * degPerMeterLat,
    ]);
  }
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {},
  };
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function gpxTrkpt(fix: GpsFix, indent: string): string {
  const lines = [`${indent}<trkpt lat="${fix.lat}" lon="${fix.lng}">`];
  if (fix.altitude != null) lines.push(`${indent}  <ele>${fix.altitude}</ele>`);
  lines.push(
    `${indent}  <time>${new Date(fix.timestamp).toISOString()}</time>`,
    `${indent}</trkpt>`,
  );
  return lines.join("\n");
}

/**
 * Serialize a recorded track to a GPX 1.1 document: one `<trk>` with a
 * `<trkseg>` per continuous segment (pause/resume boundaries), per-point
 * elevation and timestamps. The complement of the reader in `gpx.ts`, which
 * is import-only.
 */
export function buildTrackGpx(segments: GpsTrackSegments, name: string): string {
  const segs = lineSegments(segments).map((seg) =>
    [`    <trkseg>`, seg.map((f) => gpxTrkpt(f, "      ")).join("\n"), `    </trkseg>`].join("\n"),
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="GeoLibre" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <trk>`,
    `    <name>${escapeXml(name)}</name>`,
    segs.join("\n"),
    `  </trk>`,
    `</gpx>`,
    ``,
  ].join("\n");
}

/** "873 m" below 1 km, "1.24 km" above. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** "m:ss" below an hour, "h:mm:ss" above. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** Ground speed in km/h with one decimal, e.g. "4.7". */
export function formatSpeedKmh(speedMps: number): string {
  return (speedMps * 3.6).toFixed(1);
}
