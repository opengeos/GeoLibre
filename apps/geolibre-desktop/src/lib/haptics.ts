export type HapticStyle = "light" | "medium" | "selection";

const HAPTIC_DURATION_MS: Record<HapticStyle, number> = {
  selection: 6,
  light: 10,
  medium: 20,
};

/**
 * Trigger a subtle tactile haptic pulse on supported touch devices while
 * respecting `prefers-reduced-motion: reduce` (GeoLibre#3537 Phase 5).
 */
export function triggerHaptic(
  style: HapticStyle = "light",
  options?: {
    navigator?: { vibrate?: (pattern: number | number[]) => boolean };
    matchMedia?: (query: string) => { matches: boolean };
  },
): boolean {
  const mm =
    options?.matchMedia ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? (q: string) => window.matchMedia(q)
      : undefined);
  if (mm?.("(prefers-reduced-motion: reduce)").matches) return false;

  const nav =
    options?.navigator ??
    (typeof navigator !== "undefined"
      ? (navigator as { vibrate?: (pattern: number | number[]) => boolean })
      : undefined);
  if (typeof nav?.vibrate !== "function") return false;
  try {
    return Boolean(nav.vibrate(HAPTIC_DURATION_MS[style]));
  } catch {
    return false;
  }
}
