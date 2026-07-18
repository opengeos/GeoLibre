import type { Map as MapLibreMap } from "maplibre-gl";
import type { FeatureCollection, Geometry, Position } from "geojson";

/**
 * Records an animated camera "tour" across a sequence of keyframes to a video
 * file by capturing the live MapLibre canvas.
 *
 * The map canvas is created with `preserveDrawingBuffer: true` (see
 * `packages/map/src/map-controller.ts`), so `canvas.captureStream()` works
 * without any constructor change. Recording flies the camera from each keyframe
 * to the next with `map.flyTo` while a `MediaRecorder` samples the canvas; the
 * result is a WebM blob the caller saves to disk.
 */

/** A single camera stop in a tour. */
export interface TourKeyframe {
  /** Stable id for list keys and reordering. */
  id: string;
  /** Map center as `[lng, lat]`. */
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /**
   * Milliseconds the camera holds completely still on this view before it
   * begins moving on. Applies to every keyframe, including the first (an opening
   * pause) and the last (how long the closing view stays frozen before the tour
   * ends).
   */
  holdMs: number;
  /**
   * Milliseconds to animate FROM this keyframe TO the next one. Unused for the
   * last keyframe, which has no successor to transition toward; the UI greys its
   * Transition field out, and the recorder never reads it.
   */
  transitionMs: number;
}

// Frame-rate, hold, and per-segment transition bounds, shared by the dialog UI
// and the configuration parser so a hand-edited or stale file is clamped to the
// same range the controls enforce.
/** Default frames per second sampled from the canvas. */
export const DEFAULT_FPS = 30;
/**
 * Target video bitrate (bits per second). MediaRecorder's implicit default is
 * conservative (~2.5 Mbps), which visibly blurs detailed map imagery and text;
 * ~12 Mbps keeps the recording crisp at typical canvas sizes while staying a
 * reasonable file size. Browsers clamp this to their supported range, so an
 * over-ambitious value is capped rather than rejected.
 */
const DEFAULT_VIDEO_BITS_PER_SECOND = 12_000_000;
/** Lowest selectable frame rate. */
export const MIN_FPS = 10;
/** Highest selectable frame rate. */
export const MAX_FPS = 60;
/** Default seconds to animate into the next keyframe for a newly added stop. */
export const DEFAULT_SEGMENT_SECONDS = 4;
/** Shortest allowed transition between two keyframes, in seconds. */
export const MIN_SEGMENT_SECONDS = 0.5;
/** Longest allowed transition between two keyframes, in seconds. */
export const MAX_SEGMENT_SECONDS = 30;
/** Default seconds a newly added keyframe holds still before moving on. */
export const DEFAULT_HOLD_SECONDS = 0;
/** Shortest allowed hold on a keyframe, in seconds (0 = no pause). */
export const MIN_HOLD_SECONDS = 0;
/** Longest allowed hold on a keyframe, in seconds. */
export const MAX_HOLD_SECONDS = 60;

// Camera bounds MapLibre supports, used to clamp values read from a saved
// configuration so a hand-edited file can't carry an out-of-range camera.
const MAX_ZOOM = 24;
const MAX_PITCH = 85;
/**
 * Upper bound on keyframes accepted from a file, far beyond any real tour, so a
 * crafted or accidentally huge JSON can't make the parser allocate a giant
 * array and the dialog mint an id per entry in a loop.
 */
const MAX_KEYFRAMES = 500;
/**
 * Upper bound on the raw config text before parsing. A real tour (even the
 * 500-keyframe maximum) is well under 100 KB, so 1 MB is generous while still
 * rejecting a pathological file before `JSON.parse` allocates it.
 */
const MAX_CONFIG_TEXT_LENGTH = 1_000_000;

/**
 * Hold applied to the first keyframe when migrating a legacy (v1) tour that had
 * no per-keyframe holds, so the opening frame of a reloaded old tour stays as
 * steady as it used to be before holds were configurable.
 */
export const START_HOLD_MS = 400;
/** Hold applied to the last keyframe when migrating a legacy (v1) tour. */
export const END_HOLD_MS = 600;
/** How long to wait for the encoder's final `onstop` before giving up. */
export const STOP_TIMEOUT_MS = 10_000;

/** WebM codecs tried in order; the first the browser supports is used. */
export const TOUR_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Pick the first supported recording MIME type from a candidate list. Returns
 * `null` when none are supported. Kept pure (the support check is injected) so
 * it can be unit tested without a DOM.
 */
export function pickSupportedMimeType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return null;
}

/**
 * Total wall-clock duration of a tour in milliseconds: every keyframe's hold
 * plus the transition leading out of every keyframe except the last (which has
 * no successor to move toward). A lone keyframe still has a meaningful hold, so
 * it contributes its hold (only the cross-keyframe transitions need two or more).
 */
export function estimateTourDurationMs(
  keyframes: readonly Pick<TourKeyframe, "holdMs" | "transitionMs">[],
): number {
  if (keyframes.length === 0) return 0;
  const holds = keyframes.reduce((sum, kf) => sum + Math.max(0, kf.holdMs), 0);
  if (keyframes.length < 2) return holds;
  const transitions = keyframes
    .slice(0, -1)
    .reduce((sum, kf) => sum + Math.max(0, kf.transitionMs), 0);
  return holds + transitions;
}

// --- Tour configuration (save / load) ---------------------------------------

/** `type` marker identifying a saved Record Map Tour configuration file. */
export const TOUR_CONFIG_TYPE = "geolibre-tour";
/**
 * Schema version of the saved tour configuration file. Bumped to 2 when the
 * single `durationMs` (transition into a keyframe) was split into a per-keyframe
 * `holdMs` + `transitionMs` (transition out of a keyframe). v1 files are still
 * read and migrated on load (see {@link parseTourConfig}).
 */
export const TOUR_CONFIG_VERSION = 2;

/**
 * A keyframe as stored in a tour configuration file: the camera plus its hold
 * and outgoing transition, without the session-local `id`, which is regenerated
 * on load so reloaded keyframes never collide with each other or existing rows.
 */
export type TourKeyframeData = Omit<TourKeyframe, "id">;

/** The on-disk shape of a saved tour configuration. */
export interface TourConfig {
  type: string;
  version: number;
  /** Frames per second to sample when recording. */
  fps: number;
  keyframes: TourKeyframeData[];
}

/** Parsed and validated contents of a tour configuration file. */
export interface ParsedTourConfig {
  fps: number;
  keyframes: TourKeyframeData[];
}

export interface PathTourOptions {
  keyframeCount: number;
  zoom: number;
  pitch: number;
  holdSeconds: number;
  transitionSeconds: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;

function isFiniteLngLat(position: Position): position is [number, number] {
  return (
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    Math.abs(position[1]) <= 90
  );
}

function bearingBetween(a: [number, number], b: [number, number]): number {
  const lon1 = (a[0] * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lon2 = (b[0] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const hav = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}

function interpolateLngLat(
  a: [number, number],
  b: [number, number],
  fraction: number,
): [number, number] {
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
}

function collectLineStrings(geometry: Geometry | null): [number, number][][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates.filter(isFiniteLngLat).map((p) => [p[0], p[1]])];
    case "MultiLineString":
      return geometry.coordinates.map((line) =>
        line.filter(isFiniteLngLat).map((p) => [p[0], p[1]]),
      );
    case "GeometryCollection":
      return geometry.geometries.flatMap(collectLineStrings);
    default:
      return [];
  }
}

export function countPathCoordinates(geojson: FeatureCollection): number {
  return geojson.features
    .flatMap((feature) => collectLineStrings(feature.geometry))
    .reduce((count, line) => count + line.length, 0);
}

function flattenPath(geojson: FeatureCollection): [number, number][] {
  const points: [number, number][] = [];
  for (const feature of geojson.features) {
    for (const line of collectLineStrings(feature.geometry)) {
      if (line.length < 2) continue;
      if (points.length > 0) {
        const last = points[points.length - 1];
        const first = line[0];
        if (last[0] !== first[0] || last[1] !== first[1]) points.push(first);
        points.push(...line.slice(1));
      } else {
        points.push(...line);
      }
    }
  }
  return points;
}

function samplePathAtDistances(
  path: [number, number][],
  count: number,
): { point: [number, number]; bearing: number }[] {
  const segments: { start: [number, number]; end: [number, number]; length: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const length = distanceMeters(path[i], path[i + 1]);
    if (length > 0) segments.push({ start: path[i], end: path[i + 1], length });
  }
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (segments.length === 0 || total <= 0) return [];

  let segmentIndex = 0;
  let distanceBeforeSegment = 0;
  return Array.from({ length: count }, (_, index) => {
    const target = count === 1 ? 0 : (total * index) / (count - 1);
    while (
      segmentIndex < segments.length - 1 &&
      distanceBeforeSegment + segments[segmentIndex].length < target
    ) {
      distanceBeforeSegment += segments[segmentIndex].length;
      segmentIndex += 1;
    }
    const segment = segments[segmentIndex];
    const fraction =
      segment.length === 0
        ? 0
        : clampNumber((target - distanceBeforeSegment) / segment.length, 0, 1);
    return {
      point: interpolateLngLat(segment.start, segment.end, fraction),
      bearing: bearingBetween(segment.start, segment.end),
    };
  });
}

export function generateTourKeyframesFromPath(
  geojson: FeatureCollection,
  options: PathTourOptions,
): TourKeyframeData[] {
  const path = flattenPath(geojson);
  const count = clampNumber(Math.round(options.keyframeCount), 2, MAX_KEYFRAMES);
  const samples = samplePathAtDistances(path, count);
  if (samples.length < 2) return [];
  return samples.map((sample) => ({
    center: [roundTo(sample.point[0], 6), roundTo(sample.point[1], 6)],
    zoom: roundTo(clampNumber(options.zoom, 0, MAX_ZOOM), 3),
    pitch: roundTo(clampNumber(options.pitch, 0, MAX_PITCH), 1),
    bearing: roundTo(normalizeBearing(sample.bearing), 1),
    holdMs: clampHoldMs(options.holdSeconds * 1000),
    transitionMs: clampTransitionMs(options.transitionSeconds * 1000),
  }));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp a hold duration (ms) into the supported range. */
function clampHoldMs(value: number): number {
  return clampNumber(Math.round(value), MIN_HOLD_SECONDS * 1000, MAX_HOLD_SECONDS * 1000);
}

/** Clamp a transition duration (ms) into the supported range. */
function clampTransitionMs(value: number): number {
  return clampNumber(Math.round(value), MIN_SEGMENT_SECONDS * 1000, MAX_SEGMENT_SECONDS * 1000);
}

/** Round to a fixed number of decimals, matching the capture precision. */
function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Normalize a bearing onto `(-180, 180]` so a hand-edited value like 270 maps
 * to -90 (west) rather than being clipped to 180 (south) by a plain clamp.
 */
function normalizeBearing(bearing: number): number {
  const mod = ((bearing % 360) + 360) % 360; // [0, 360)
  return mod > 180 ? mod - 360 : mod; // (-180, 180]
}

/**
 * Serialize a tour (its keyframes and frame rate) to a pretty-printed JSON
 * string suitable for saving to a `.json` file and reloading later. The
 * session-local keyframe ids are dropped; {@link parseTourConfig} regenerates
 * them on load.
 */
export function serializeTourConfig(keyframes: readonly TourKeyframe[], fps: number): string {
  const config: TourConfig = {
    type: TOUR_CONFIG_TYPE,
    version: TOUR_CONFIG_VERSION,
    fps: clampNumber(Math.round(fps), MIN_FPS, MAX_FPS),
    // Drop the id; clamp hold and transition on write too (mirroring
    // parseKeyframe) so save/load is symmetric and a programmatic caller can't
    // persist an out-of-range value.
    keyframes: keyframes.map(({ id: _id, holdMs, transitionMs, ...rest }) => ({
      ...rest,
      holdMs: clampHoldMs(holdMs),
      transitionMs: clampTransitionMs(transitionMs),
    })),
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Read a finite number from raw config data, falling back when absent. */
function num(value: unknown, fallback = 0): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

/** The camera portion of a keyframe, shared by the v1 and v2 parse paths. */
type ParsedCamera = Pick<TourKeyframeData, "center" | "zoom" | "pitch" | "bearing">;

/**
 * Validate a single keyframe's structure and normalize its camera to MapLibre's
 * supported ranges, returning the camera plus the raw record so the caller can
 * read its timing fields (which differ between the v1 and v2 formats).
 */
function parseCameraFields(raw: unknown): {
  camera: ParsedCamera;
  kf: Record<string, unknown>;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("Tour configuration has an invalid keyframe.");
  }
  const kf = raw as Record<string, unknown>;
  const center = kf.center;
  if (
    !Array.isArray(center) ||
    center.length !== 2 ||
    !Number.isFinite(center[0]) ||
    !Number.isFinite(center[1]) ||
    // Longitude wrapping is left to MapLibre, but a latitude outside ±90 is not
    // a real coordinate, so reject it with a meaningful error rather than
    // letting MapLibre silently clip it.
    Math.abs(center[1] as number) > 90
  ) {
    throw new Error("Tour configuration keyframe has an invalid center.");
  }
  // Clamp the camera to MapLibre's supported ranges so a hand-edited file can't
  // push a keyframe outside what the map accepts; bearing is wrapped (not
  // clamped) so a value past ±180 stays the same compass direction.
  return {
    camera: {
      center: [roundTo(center[0] as number, 6), roundTo(center[1] as number, 6)],
      zoom: roundTo(clampNumber(num(kf.zoom), 0, MAX_ZOOM), 3),
      pitch: roundTo(clampNumber(num(kf.pitch), 0, MAX_PITCH), 1),
      bearing: roundTo(normalizeBearing(num(kf.bearing)), 1),
    },
    kf,
  };
}

/** Validate and normalize a single v2 keyframe (hold + outgoing transition). */
function parseKeyframe(raw: unknown): TourKeyframeData {
  const { camera, kf } = parseCameraFields(raw);
  return {
    ...camera,
    holdMs: clampHoldMs(num(kf.holdMs, DEFAULT_HOLD_SECONDS * 1000)),
    transitionMs: clampTransitionMs(num(kf.transitionMs, DEFAULT_SEGMENT_SECONDS * 1000)),
  };
}

/**
 * Migrate legacy (v1) keyframes to the v2 hold/transition model. In v1 each
 * keyframe carried a single `durationMs`: the time to animate INTO it from the
 * previous keyframe. v2 instead stores, per keyframe, a `holdMs` (a still pause
 * on the view) and a `transitionMs` (the time to animate OUT to the next one).
 *
 * The conversion preserves playback: keyframe i's outgoing transition becomes
 * keyframe i+1's old incoming `durationMs`, and the last keyframe gets the
 * default transition (it has no successor, so the value is unused). v1 had only
 * implicit holds at the very start and end of the tour, so those map onto the
 * first and last keyframes' holds and every other hold is zero.
 */
function migrateLegacyKeyframes(rawKeyframes: unknown[]): TourKeyframeData[] {
  const parsed = rawKeyframes.map(parseCameraFields);
  return parsed.map(({ camera }, index) => {
    const next = parsed[index + 1]?.kf;
    const transitionMs = next
      ? clampTransitionMs(num(next.durationMs, DEFAULT_SEGMENT_SECONDS * 1000))
      : clampTransitionMs(DEFAULT_SEGMENT_SECONDS * 1000);
    const isFirst = index === 0;
    const isLast = index === parsed.length - 1;
    // A lone keyframe is both the first and the last, so it inherits both of v1's
    // implicit holds (it is unrecordable on its own, but keep the total faithful).
    const holdMs =
      isFirst && isLast
        ? START_HOLD_MS + END_HOLD_MS
        : isFirst
          ? START_HOLD_MS
          : isLast
            ? END_HOLD_MS
            : 0;
    return { ...camera, holdMs: clampHoldMs(holdMs), transitionMs };
  });
}

/**
 * Parse a saved tour configuration file. Validates the marker, requires at
 * least one keyframe, and clamps the frame rate and every segment duration into
 * the supported range so a hand-edited or stale file can never push values
 * outside what the controls allow. Throws an `Error` with a human-readable
 * message on any structural problem; callers show a translated fallback.
 */
export function parseTourConfig(text: string): ParsedTourConfig {
  // Reject an oversized file before JSON.parse so a pathological input can't be
  // fully allocated just to be rejected by the later keyframe-count check.
  if (text.length > MAX_CONFIG_TEXT_LENGTH) {
    throw new Error("Tour configuration file is too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Tour configuration file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Tour configuration file is not a tour.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type !== TOUR_CONFIG_TYPE) {
    throw new Error("File is not a GeoLibre tour configuration.");
  }
  // Reject a file written by a newer, incompatible format so its data isn't
  // silently misread. A missing version is accepted (the format is then inferred
  // from the keyframe fields below), but any present version we don't recognize
  // is rejected: it must be an integer in [1, TOUR_CONFIG_VERSION], so a newer
  // number, a value below 1 (0/-1), or a malformed non-number like "2" all fail.
  if (
    obj.version !== undefined &&
    (typeof obj.version !== "number" ||
      !Number.isInteger(obj.version) ||
      obj.version < 1 ||
      obj.version > TOUR_CONFIG_VERSION)
  ) {
    throw new Error(
      `Tour configuration version ${String(obj.version)} is not supported (expected ${TOUR_CONFIG_VERSION}).`,
    );
  }
  if (!Array.isArray(obj.keyframes) || obj.keyframes.length === 0) {
    throw new Error("Tour configuration has no keyframes.");
  }
  // Capture the narrowed array so the field-detection closures below keep their
  // element type (a closure loses the narrowing on the `obj.keyframes` property).
  const rawKeyframes: unknown[] = obj.keyframes;
  if (rawKeyframes.length > MAX_KEYFRAMES) {
    throw new Error(
      `Tour configuration has too many keyframes (${rawKeyframes.length}; max ${MAX_KEYFRAMES}).`,
    );
  }
  const fps = clampNumber(
    Math.round(Number.isFinite(obj.fps) ? (obj.fps as number) : DEFAULT_FPS),
    MIN_FPS,
    MAX_FPS,
  );
  // Read the legacy (v1) format and migrate it to the current hold/transition
  // model. `version: 1` is authoritative: a file that declares it takes the
  // migration path even if some keyframe happens to carry v2 fields (the author
  // opted into v1 semantics). When the version is omitted, the format is inferred
  // from the keyframes: legacy only if at least one keyframe has the old
  // `durationMs` AND none has the new `holdMs`/`transitionMs`. Requiring the
  // absence of v2 fields means a hand-edited file mixing both formats is read as
  // v2 (keeping its persisted holds) rather than silently migrated to defaults.
  const hasField = (name: string) =>
    rawKeyframes.some((kf) => kf !== null && typeof kf === "object" && name in kf);
  const isLegacy =
    obj.version === 1 ||
    (obj.version === undefined &&
      hasField("durationMs") &&
      !hasField("transitionMs") &&
      !hasField("holdMs"));
  const keyframes = isLegacy
    ? migrateLegacyKeyframes(rawKeyframes)
    : rawKeyframes.map(parseKeyframe);
  return { fps, keyframes };
}

/** Raised when the browser cannot record the canvas (no MediaRecorder / codec). */
export class TourRecordingUnsupportedError extends Error {
  constructor(message = "Canvas recording is not supported in this browser.") {
    super(message);
    this.name = "TourRecordingUnsupportedError";
  }
}

/** True when the current browser can record a canvas to WebM. */
export function isTourRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickSupportedMimeType(TOUR_MIME_CANDIDATES, (t) => MediaRecorder.isTypeSupported(t)) !== null
  );
}

export interface RecordTourOptions {
  map: MapLibreMap;
  keyframes: TourKeyframe[];
  /** Frames per second sampled from the canvas. */
  fps: number;
  /** Aborts the tour early; the partial recording up to that point is kept. */
  signal?: AbortSignal;
  /** Reports progress in `[0, 1]` as each segment completes. */
  onProgress?: (fraction: number) => void;
}

/** Resolve after `ms`, but immediately if the signal is already aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fly to one keyframe over `durationMs` and resolve when the camera settles.
 * Resolves on the map's `moveend`, with a timeout fallback in case it does not
 * fire, and early if the tour is aborted (the abort handler calls `map.stop()`).
 * The duration is the source keyframe's outgoing transition, passed in by the
 * caller rather than read off the target keyframe.
 */
function flyToKeyframe(
  map: MapLibreMap,
  kf: TourKeyframe,
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    // Already aborted on entry (a stop between the loop's check and here): the
    // map.stop() moveend has already fired, so resolve now rather than waiting
    // out the timeout fallback.
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off("moveend", finish);
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    // moveend can fail to fire if the move is interrupted; the timeout
    // guarantees the segment always completes. The buffer scales with the
    // duration so a throttled tab whose move settles slightly late doesn't trip
    // the fallback before moveend fires (which would blend two animations).
    const duration = Math.max(0, durationMs);
    const timer = setTimeout(finish, duration + Math.max(500, duration * 0.25));
    map.once("moveend", finish);
    signal?.addEventListener("abort", finish, { once: true });
    map.flyTo({
      center: kf.center,
      zoom: kf.zoom,
      pitch: kf.pitch,
      bearing: kf.bearing,
      duration,
      // Run the animation even when the OS requests reduced motion, otherwise
      // flyTo would jump instantly and the recording would be a slideshow.
      essential: true,
    });
  });
}

/** MapLibre interaction handlers disabled for the duration of a recording. */
const INTERACTION_HANDLERS = [
  "dragPan",
  "scrollZoom",
  "boxZoom",
  "dragRotate",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
] as const;

/**
 * Disable user map interaction while recording so a stray scroll or drag cannot
 * interrupt the flyTo animation. Returns a function that restores each handler
 * to the enabled state it had before.
 */
function freezeMapInteractions(map: MapLibreMap): () => void {
  const handlers = INTERACTION_HANDLERS.map((key) => map[key]);
  const wasEnabled = handlers.map((handler) => handler.isEnabled());
  for (const handler of handlers) handler.disable();
  return () => {
    handlers.forEach((handler, i) => {
      if (wasEnabled[i]) handler.enable();
    });
  };
}

/**
 * Record an animated camera tour and resolve with a WebM blob.
 *
 * Throws {@link TourRecordingUnsupportedError} when the browser cannot record
 * the canvas, or a plain `Error` when fewer than two keyframes are supplied.
 */
export async function recordTour({
  map,
  keyframes,
  fps,
  signal,
  onProgress,
}: RecordTourOptions): Promise<Blob> {
  if (keyframes.length < 2) {
    throw new Error("A tour needs at least two keyframes.");
  }
  const mimeType = pickSupportedMimeType(
    TOUR_MIME_CANDIDATES,
    (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  );
  // mimeType is null when MediaRecorder is undefined (the callback returns false
  // for every candidate), so this also covers the no-MediaRecorder case.
  if (!mimeType) {
    throw new TourRecordingUnsupportedError();
  }

  const canvas = map.getCanvas();
  if (typeof canvas.captureStream !== "function") {
    throw new TourRecordingUnsupportedError();
  }

  const stream = canvas.captureStream(fps);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
    });
  } catch {
    // The constructor can still reject a codec that isTypeSupported accepted;
    // stop the capture so it isn't leaked when we never reach the finally below,
    // and report it as unsupported so the dialog shows the right message.
    for (const track of stream.getTracks()) track.stop();
    throw new TourRecordingUnsupportedError();
  }

  // Aborting interrupts the in-flight camera move so the tour stops promptly
  // instead of finishing the current segment. Registered only after the
  // recorder is constructed, so a setup failure above does not leave a stale
  // map.stop() listener attached to the signal.
  const stopOnAbort = () => map.stop();
  signal?.addEventListener("abort", stopOnAbort, { once: true });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  // Set when the recorder errors mid-tour so the animation loop breaks early
  // instead of flying through the rest of the keyframes after the recording has
  // already failed.
  let recorderFailed = false;
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => {
      // Surface the browser's own diagnosis (e.g. SecurityError) rather than a
      // generic message, so a field failure is debuggable.
      const cause = (event as Event & { error?: DOMException }).error;
      recorderFailed = true;
      map.stop(); // halt the in-flight move so the loop stops promptly
      reject(
        new Error(`Recording failed: ${cause?.message ?? "unknown error"}`, {
          cause,
        }),
      );
    };
  });

  // Pump repaints for the whole recording so the captured stream keeps getting
  // fresh frames even during the still holds (a paused canvas emits nothing).
  // The same loop drives progress from elapsed wall-clock against the planned
  // tour length, so it advances smoothly (including the lone segment of a
  // two-keyframe tour) rather than jumping at segment boundaries. Progress is
  // throttled to whole-percent changes to avoid a re-render every frame.
  const totalMs = estimateTourDurationMs(keyframes);
  let startedAt = 0;
  let lastPercent = -1;
  let rafId = 0;
  const pump = () => {
    map.triggerRepaint();
    if (startedAt && totalMs > 0) {
      const percent = Math.min(100, Math.round(((performance.now() - startedAt) / totalMs) * 100));
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.(percent / 100);
      }
    }
    rafId = requestAnimationFrame(pump);
  };

  // Freeze user interaction so a stray scroll or drag can't interrupt the flyTo
  // (which would fire an early moveend and start the next segment from the wrong
  // camera). Restored in the finally below.
  let restoreInteractions = () => {};
  try {
    restoreInteractions = freezeMapInteractions(map);
    // Park on the first keyframe before the recorder starts so the opening
    // frame is the intended view, not wherever the user left the map.
    const first = keyframes[0];
    map.jumpTo({
      center: first.center,
      zoom: first.zoom,
      pitch: first.pitch,
      bearing: first.bearing,
    });

    // Flush encoded chunks every second so memory stays flat over long tours
    // instead of buffering the whole video until stop(). Start the recorder
    // before the progress pump so the elapsed clock tracks actual capture.
    recorder.start(1000);
    startedAt = performance.now();
    rafId = requestAnimationFrame(pump);

    // Walk the keyframes: hold still on each view for its `holdMs`, then (unless
    // it is the last) animate to the next over the current keyframe's
    // `transitionMs`. The first keyframe's hold is the opening pause and the
    // last keyframe's hold is the closing freeze, so there is no separate fixed
    // start/end hold anymore — the user controls all of it.
    for (let i = 0; i < keyframes.length; i++) {
      if (signal?.aborted || recorderFailed) break;
      await delay(Math.max(0, keyframes[i].holdMs), signal);
      if (i < keyframes.length - 1 && !signal?.aborted && !recorderFailed) {
        await flyToKeyframe(map, keyframes[i + 1], keyframes[i].transitionMs, signal);
      }
    }

    if (!signal?.aborted && !recorderFailed) {
      onProgress?.(1);
    }
  } finally {
    restoreInteractions();
    cancelAnimationFrame(rafId);
    if (recorder.state !== "inactive") recorder.stop();
    signal?.removeEventListener("abort", stopOnAbort);
    // recorder.stop() finalizes the file but does not stop the canvas capture,
    // so end the stream's tracks to release it.
    for (const track of stream.getTracks()) track.stop();
  }

  // Guard against a browser that never fires onstop (a page-unload race, a
  // torn-down stream) leaving this await hung and the dialog stuck "saving".
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Recording timed out waiting for the encoder.")),
      STOP_TIMEOUT_MS,
    );
    void finished.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  return await Promise.race([finished, timeout]);
}
