/**
 * Screen wake-lock management and resilient track checkpoint persistence for
 * mobile/field GPS track logging.
 *
 * Delegates Screen Wake Lock acquisition/re-acquire/dedupe to the shared
 * {@link createWakeLockController} helper in `./wake-lock`, and provides
 * throttled checkpoint persistence so an unexpected mobile WebView reload or
 * background eviction does not lose recorded fixes without causing O(n^2)
 * serialization on every GPS fix.
 */

import type { GpsFix, GpsTrackSegments } from "./gps-tracking";
import {
  createWakeLockController,
  type WakeLockNavigatorLike,
  type WakeLockSentinelLike,
} from "./wake-lock";

export type { WakeLockNavigatorLike, WakeLockSentinelLike };

export const GPS_TRACK_CHECKPOINT_KEY = "geolibre.gpsTracking.activeCheckpoint";
export const GPS_CHECKPOINT_THROTTLE_MS = 5_000;
const MAX_CHECKPOINT_FIXES = 25_000;

export interface WakeLockDocumentLike {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface GpsWakeLockController {
  /** Begin holding the screen wake lock (idempotent, deduplicates in-flight requests). */
  start(): Promise<boolean>;
  /** Release the screen wake lock and detach visibility listeners. */
  stop(): Promise<void>;
  /** Whether a wake lock sentinel is currently held. */
  isHeld(): boolean;
}

/**
 * Create a lifecycle-safe Screen Wake Lock controller backed by the shared
 * {@link createWakeLockController} implementation.
 */
export function createGpsWakeLockController(deps?: {
  nav?: WakeLockNavigatorLike | null;
  doc?: WakeLockDocumentLike | null;
}): GpsWakeLockController {
  let held = false;
  let inner: ReturnType<typeof createWakeLockController> | null = null;

  const ensureInner = () => {
    if (inner) return inner;
    const nav = deps?.nav === null ? {} : deps?.nav;
    const doc =
      deps?.doc === null
        ? ({
            visibilityState: "visible",
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          } as unknown as Pick<
            Document,
            "visibilityState" | "addEventListener" | "removeEventListener"
          >)
        : (deps?.doc as
            | Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
            | undefined);
    inner = createWakeLockController({
      navigator: nav,
      document: doc,
      onChange: (active) => {
        held = active;
      },
    });
    return inner;
  };

  return {
    async start(): Promise<boolean> {
      const ok = await ensureInner().acquire();
      held = ok;
      return ok;
    },
    async stop(): Promise<void> {
      const current = inner;
      inner = null;
      held = false;
      if (current) {
        await current.release();
        current.dispose();
      }
    },
    isHeld(): boolean {
      return held;
    },
  };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isValidFix(value: unknown): value is GpsFix {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.lng === "number" &&
    Number.isFinite(candidate.lng) &&
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lat) &&
    typeof candidate.accuracy === "number" &&
    Number.isFinite(candidate.accuracy) &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  );
}

/**
 * Persist an in-progress track recording so a mobile WebView suspension or
 * reload can recover logged fixes. Truncates oldest fixes if above the safety
 * cap so storage quota is never exceeded.
 */
export function saveGpsTrackCheckpoint(
  segments: GpsTrackSegments,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const nonEmpty = segments.filter((seg) => seg.length > 0);
  if (nonEmpty.length === 0) {
    clearGpsTrackCheckpoint(storage);
    return true;
  }
  let remaining = MAX_CHECKPOINT_FIXES;
  const bounded: GpsTrackSegments = [];
  // Keep the most recent fixes if the recording exceeds the cap.
  for (let i = nonEmpty.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const seg = nonEmpty[i];
    if (seg.length <= remaining) {
      bounded.unshift(seg);
      remaining -= seg.length;
    } else {
      bounded.unshift(seg.slice(seg.length - remaining));
      remaining = 0;
    }
  }
  try {
    storage.setItem(
      GPS_TRACK_CHECKPOINT_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), segments: bounded }),
    );
    return true;
  } catch {
    return false;
  }
}

export interface ThrottledCheckpointSaver {
  /** Save at most once per `intervalMs`; returns `null` when throttled. */
  schedule(segments: GpsTrackSegments): boolean | null;
  /** Flush immediately regardless of throttle interval. */
  flush(segments: GpsTrackSegments): boolean;
  /** Reset throttle state (e.g. when clearing a track). */
  reset(): void;
}

/**
 * Throttle GPS track checkpoint writes to avoid O(n^2) JSON serialization on
 * high-frequency fixes while still allowing immediate flushes on pagehide /
 * visibilitychange / stop.
 */
export function createThrottledCheckpointSaver(options?: {
  intervalMs?: number;
  storage?: StorageLike | null;
  now?: () => number;
  onSaveResult?: (ok: boolean) => void;
}): ThrottledCheckpointSaver {
  const intervalMs = options?.intervalMs ?? GPS_CHECKPOINT_THROTTLE_MS;
  const now = options?.now ?? Date.now;
  let lastSavedAt = -Infinity;

  const writeNow = (segments: GpsTrackSegments): boolean => {
    const ok = saveGpsTrackCheckpoint(
      segments,
      options?.storage !== undefined ? options.storage : defaultStorage(),
    );
    lastSavedAt = now();
    options?.onSaveResult?.(ok);
    return ok;
  };

  return {
    schedule(segments: GpsTrackSegments): boolean | null {
      if (now() - lastSavedAt < intervalMs) return null;
      return writeNow(segments);
    },
    flush(segments: GpsTrackSegments): boolean {
      return writeNow(segments);
    },
    reset(): void {
      lastSavedAt = -Infinity;
    },
  };
}

/** Restore a previously checkpointed track recording, or null if absent/invalid. */
export function loadGpsTrackCheckpoint(
  storage: StorageLike | null = defaultStorage(),
): GpsTrackSegments | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GPS_TRACK_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; segments?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.segments)) return null;
    const segments: GpsTrackSegments = [];
    for (const seg of parsed.segments) {
      if (!Array.isArray(seg)) continue;
      const valid = seg.filter(isValidFix).map((fix) => ({
        lng: fix.lng,
        lat: fix.lat,
        accuracy: fix.accuracy,
        satellites: typeof fix.satellites === "number" ? fix.satellites : null,
        altitude: typeof fix.altitude === "number" ? fix.altitude : null,
        heading: typeof fix.heading === "number" ? fix.heading : null,
        speed: typeof fix.speed === "number" ? fix.speed : null,
        timestamp: fix.timestamp,
      }));
      if (valid.length > 0) segments.push(valid);
    }
    return segments.length > 0 ? segments : null;
  } catch {
    return null;
  }
}

/** Remove any stored active GPS track checkpoint. */
export function clearGpsTrackCheckpoint(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(GPS_TRACK_CHECKPOINT_KEY);
  } catch {
    // Ignore storage removal errors.
  }
}
