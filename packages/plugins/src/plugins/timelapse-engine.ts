/**
 * Pure playback and persistence math for the Timelapse plugin, kept free of
 * DOM/MapLibre so it can be unit tested directly.
 */

import { EOX_S2CLOUDLESS_PROVIDER_ID, type TimelapseFrame } from "./timelapse-providers";

/** Allowed playback cadences, in seconds spent on each year. */
export const TIMELAPSE_SPEED_STEPS = [0.25, 0.5, 1, 2, 3] as const;

/** The default playback cadence (one second per year). */
export const DEFAULT_SECONDS_PER_YEAR = 1;

/**
 * The next frame to show after `current`, or `null` when playback should stop
 * (past the last frame with looping off, or nothing to step through).
 */
export function nextFrameIndex(current: number, count: number, loop: boolean): number | null {
  if (count <= 1) return null;
  const next = current + 1;
  if (next < count) return next;
  return loop ? 0 : null;
}

/**
 * Snap an arbitrary value to the nearest allowed speed step, defaulting to
 * {@link DEFAULT_SECONDS_PER_YEAR} for non-numeric input.
 */
export function clampSecondsPerYear(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SECONDS_PER_YEAR;
  }
  let nearest: number = TIMELAPSE_SPEED_STEPS[0];
  for (const step of TIMELAPSE_SPEED_STEPS) {
    if (Math.abs(step - value) < Math.abs(nearest - value)) nearest = step;
  }
  return nearest;
}

/** The frame index whose year matches, clamped into range (default 0). */
export function frameIndexForYear(frames: readonly TimelapseFrame[], year: unknown): number {
  if (typeof year !== "number" || !Number.isFinite(year)) return 0;
  const index = frames.findIndex((frame) => frame.year === year);
  if (index >= 0) return index;
  // A year outside the provider's range (e.g. from an older project after the
  // provider dropped a year) clamps to the nearest end rather than resetting.
  if (frames.length > 0 && year > frames[frames.length - 1].year) {
    return frames.length - 1;
  }
  return 0;
}

/** What the Timelapse plugin persists in the project file. */
export interface TimelapseProjectState {
  providerId: string;
  year: number;
  secondsPerYear: number;
  loop: boolean;
}

/**
 * Normalize untrusted project JSON into a valid {@link TimelapseProjectState},
 * or `null` when it isn't one. Clamps the year into the provider's frame range
 * and the speed onto an allowed step; a persisted `playing` flag (which is
 * never written, but could appear in a hand-edited file) is dropped so a
 * loaded project never starts animating on its own.
 */
export function normalizeTimelapseProjectState(
  state: unknown,
  frames: readonly TimelapseFrame[],
): TimelapseProjectState | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as Record<string, unknown>;
  const frameIndex = frameIndexForYear(frames, candidate.year);
  // With no frames to clamp against (an async provider's catalog is not
  // available yet at project-restore time), keep the persisted year verbatim —
  // the control clamps it against the real frames when the plugin activates.
  const fallbackYear =
    typeof candidate.year === "number" && Number.isFinite(candidate.year) ? candidate.year : 0;
  return {
    providerId:
      typeof candidate.providerId === "string" && candidate.providerId
        ? candidate.providerId
        : EOX_S2CLOUDLESS_PROVIDER_ID,
    year: frames.length > 0 ? (frames[frameIndex]?.year ?? 0) : fallbackYear,
    secondsPerYear: clampSecondsPerYear(candidate.secondsPerYear),
    loop: typeof candidate.loop === "boolean" ? candidate.loop : true,
  };
}
