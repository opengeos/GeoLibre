/**
 * Screen wake-lock management and resilient track checkpoint persistence for
 * mobile/field GPS track logging.
 *
 * When a user records a GPS track on a phone or tablet, locking the screen or
 * backgrounding the WebView can suspend location delivery or reload the page.
 * This module:
 * 1. Holds a Screen Wake Lock (`navigator.wakeLock.request("screen")`) while
 *    recording and automatically re-acquires it when returning to the
 *    foreground (`visibilitychange`).
 * 2. Checkpoints active track segments to storage so an unexpected mobile
 *    WebView reload or background eviction does not lose recorded fixes.
 */

import type { GpsFix, GpsTrackSegments } from "./gps-tracking";

export const GPS_TRACK_CHECKPOINT_KEY = "geolibre.gpsTracking.activeCheckpoint";
const MAX_CHECKPOINT_FIXES = 25_000;

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
  removeEventListener?(type: "release", listener: () => void): void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

export interface WakeLockDocumentLike {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface GpsWakeLockController {
  /** Begin holding the screen wake lock (idempotent). */
  start(): Promise<boolean>;
  /** Release the screen wake lock and detach visibility listeners. */
  stop(): Promise<void>;
  /** Whether a wake lock sentinel is currently held. */
  isHeld(): boolean;
}

/**
 * Create a lifecycle-safe Screen Wake Lock controller that acquires the screen
 * lock while active, re-acquires it after foreground visibility transitions,
 * and cleanly releases it on stop.
 */
export function createGpsWakeLockController(deps?: {
  nav?: WakeLockNavigatorLike | null;
  doc?: WakeLockDocumentLike | null;
}): GpsWakeLockController {
  const nav =
    deps?.nav !== undefined
      ? deps.nav
      : typeof navigator !== "undefined"
        ? (navigator as unknown as WakeLockNavigatorLike)
        : null;
  const doc =
    deps?.doc !== undefined
      ? deps.doc
      : typeof document !== "undefined"
        ? (document as unknown as WakeLockDocumentLike)
        : null;

  let active = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let listenerAttached = false;

  const requestLock = async (): Promise<boolean> => {
    if (!active || !nav?.wakeLock?.request) return false;
    if (sentinel && !sentinel.released) return true;
    try {
      const next = await nav.wakeLock.request("screen");
      if (!active) {
        await next.release().catch(() => undefined);
        return false;
      }
      sentinel = next;
      return true;
    } catch {
      return false;
    }
  };

  const onVisibilityChange = () => {
    if (active && doc?.visibilityState === "visible") {
      void requestLock();
    }
  };

  return {
    async start(): Promise<boolean> {
      active = true;
      if (doc && !listenerAttached) {
        doc.addEventListener("visibilitychange", onVisibilityChange);
        listenerAttached = true;
      }
      return requestLock();
    },
    async stop(): Promise<void> {
      active = false;
      if (doc && listenerAttached) {
        doc.removeEventListener("visibilitychange", onVisibilityChange);
        listenerAttached = false;
      }
      const current = sentinel;
      sentinel = null;
      if (current && !current.released) {
        await current.release().catch(() => undefined);
      }
    },
    isHeld(): boolean {
      return Boolean(sentinel && !sentinel.released);
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
