import { useEffect, useState } from "react";

/**
 * The viewport width at/below which GeoLibre treats the layout as "mobile":
 * side panels default to collapsed and, when expanded, overlay the map instead
 * of squeezing it. Kept in sync with the `md` Tailwind breakpoint (768px) used
 * for the panels' responsive classes.
 */
const MOBILE_VIEWPORT_QUERY = "(max-width: 767px)";

/**
 * One-shot check of whether the viewport is currently phone-width. Safe to call
 * during render for initial state; use {@link useIsMobileViewport} when the value
 * must stay in sync with resize/rotation.
 *
 * Returns:
 *   True when running in a browser whose viewport is <= 767px wide.
 */
export function getIsMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
  );
}

/**
 * Reactively track whether the viewport is phone-width, updating on resize and
 * device rotation.
 *
 * Returns:
 *   True while the viewport is <= 767px wide.
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobileViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    const onChange = () => setIsMobile(query.matches);
    // Sync once in case the viewport changed between render and effect.
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
