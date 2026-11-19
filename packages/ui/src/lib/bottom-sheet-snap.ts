/** Snap detent identifiers for {@link BottomSheet}, ordered from shortest to tallest. */
export type BottomSheetDetent = "peek" | "half" | "full";

/** Default fraction of the available container height each detent occupies. */
export const BOTTOM_SHEET_DETENT_RATIOS: Readonly<Record<BottomSheetDetent, number>> = {
  peek: 0.24,
  half: 0.5,
  full: 0.92,
};

/**
 * Fraction of the container height below which a slow downward drag dismisses
 * a dismissible sheet instead of snapping back to the lowest detent.
 */
export const BOTTOM_SHEET_DISMISS_RATIO = 0.14;

/**
 * Downward/upward release velocity (px/ms) treated as an intentional flick to
 * the adjacent detent (or dismiss).
 */
export const BOTTOM_SHEET_FLICK_VELOCITY_PX_PER_MS = 0.45;

/**
 * Maximum pause (ms) between the last pointer move and release for a stored
 * drag velocity to still count as an active flick. Holding stationary longer
 * than this expires the velocity to 0 so the sheet snaps by position instead.
 */
export const BOTTOM_SHEET_VELOCITY_STALE_MS = 120;

/** Expire stale drag velocity when the user paused before lifting the pointer. */
export function resolveReleaseVelocity(
  storedVelocityY: number,
  lastMoveTimeMs: number,
  releaseTimeMs: number,
): number {
  if (!Number.isFinite(lastMoveTimeMs) || !Number.isFinite(releaseTimeMs) || lastMoveTimeMs <= 0) {
    return 0;
  }
  if (releaseTimeMs - lastMoveTimeMs > BOTTOM_SHEET_VELOCITY_STALE_MS) return 0;
  return storedVelocityY;
}

/** Canonical order of detents from lowest to highest. */
export const BOTTOM_SHEET_DETENT_ORDER: readonly BottomSheetDetent[] = ["peek", "half", "full"];

export interface ResolveNextDetentOptions {
  /** Sheet height in CSS pixels at pointer release. */
  currentHeightPx: number;
  /** Height of the sheet's bounding container in CSS pixels. */
  containerHeight: number;
  /**
   * Release velocity along the vertical axis in px/ms. Positive values mean
   * dragging downward (shrinking the sheet); negative values mean dragging
   * upward (expanding the sheet).
   */
  velocityY: number;
  /** Enabled detents for this sheet instance. */
  detents: readonly BottomSheetDetent[];
  /** Whether swiping past the lowest detent dismisses the sheet. */
  dismissible: boolean;
  /** Optional per-detent ratio overrides. */
  ratios?: Partial<Record<BottomSheetDetent, number>>;
}

/** Return the enabled detents sorted from shortest to tallest, falling back to `["half"]`. */
export function sortDetents(detents: readonly BottomSheetDetent[]): BottomSheetDetent[] {
  const unique = new Set(detents);
  const sorted = BOTTOM_SHEET_DETENT_ORDER.filter((detent) => unique.has(detent));
  return sorted.length > 0 ? sorted : ["half"];
}

/** Convert a detent into CSS pixels for the given container height. */
export function detentToHeightPx(
  detent: BottomSheetDetent,
  containerHeight: number,
  ratios?: Partial<Record<BottomSheetDetent, number>>,
): number {
  const safeHeight = Math.max(0, containerHeight);
  const ratio = ratios?.[detent] ?? BOTTOM_SHEET_DETENT_RATIOS[detent];
  return Math.round(safeHeight * Math.min(1, Math.max(0.05, ratio)));
}

/** Clamp a live drag height to a sensible range inside the container. */
export function clampSheetHeight(
  heightPx: number,
  containerHeight: number,
  minHeightPx = 0,
  maxRatio = BOTTOM_SHEET_DETENT_RATIOS.full,
): number {
  const maxPx = Math.max(minHeightPx, Math.round(Math.max(0, containerHeight) * maxRatio));
  return Math.min(maxPx, Math.max(minHeightPx, heightPx));
}

/**
 * Decide which detent (or `"dismiss"`) a bottom sheet settles on when the user
 * releases a drag gesture.
 */
export function resolveNextDetent({
  currentHeightPx,
  containerHeight,
  velocityY,
  detents,
  dismissible,
  ratios,
}: ResolveNextDetentOptions): BottomSheetDetent | "dismiss" {
  const ordered = sortDetents(detents);
  if (containerHeight <= 0) return ordered[0];

  const heights = ordered.map((d) => detentToHeightPx(d, containerHeight, ratios));
  const lowestIndex = 0;
  const highestIndex = ordered.length - 1;

  // Find the detent closest to where the drag ended so flicks step cleanly
  // relative to the user's current position rather than jumping two stops.
  let nearestIndex = 0;
  let nearestDistance = Math.abs(currentHeightPx - heights[0]);
  for (let i = 1; i < heights.length; i += 1) {
    const distance = Math.abs(currentHeightPx - heights[i]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  // Fast downward flick: step down one detent, or dismiss from the lowest stop.
  if (velocityY >= BOTTOM_SHEET_FLICK_VELOCITY_PX_PER_MS) {
    if (nearestIndex === lowestIndex) {
      return dismissible ? "dismiss" : ordered[lowestIndex];
    }
    return ordered[nearestIndex - 1];
  }

  // Fast upward flick: step up one detent.
  if (velocityY <= -BOTTOM_SHEET_FLICK_VELOCITY_PX_PER_MS) {
    return ordered[Math.min(highestIndex, nearestIndex + 1)];
  }

  // Slow drag past the dismiss threshold closes a dismissible sheet.
  if (dismissible && currentHeightPx < containerHeight * BOTTOM_SHEET_DISMISS_RATIO) {
    return "dismiss";
  }

  return ordered[nearestIndex];
}

/** Step one detent higher or lower (used by keyboard / handle-tap cycling). */
export function stepDetent(
  current: BottomSheetDetent,
  direction: "up" | "down",
  detents: readonly BottomSheetDetent[],
): BottomSheetDetent {
  const ordered = sortDetents(detents);
  const index = ordered.indexOf(current);
  if (index === -1) return ordered[0];
  if (direction === "up") {
    return ordered[Math.min(ordered.length - 1, index + 1)];
  }
  return ordered[Math.max(0, index - 1)];
}
