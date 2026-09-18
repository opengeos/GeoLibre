/**
 * Recognizing a click on MapLibre's `GlobeControl` toggle button.
 *
 * Projection changes are persisted into project preferences from this click
 * rather than from MapLibre's `projectiontransition` event: style
 * initialization and project reconciliation emit that event too, so a stale one
 * can overwrite the projection of a project that has just loaded.
 *
 * `GlobeControl.onAdd` labels its button with one of two class names depending
 * on what a click would do -- `maplibregl-ctrl-globe` to switch *to* the globe,
 * `maplibregl-ctrl-globe-enabled` to switch away -- and swaps them on every
 * `styledata` / `projectiontransition`. Both are internal to `maplibre-gl` and
 * unexported, so the selector below is a mirror of them.
 * `tests/globe-control-toggle.test.ts` builds a real `GlobeControl` and fails if
 * the mirror stops matching, which is what makes a `maplibre-gl` bump surface
 * the drift; without it a renamed class would silently stop persisting the
 * user's projection with no build error.
 */
export const GLOBE_CONTROL_TOGGLE_SELECTOR =
  ".maplibregl-ctrl-globe, .maplibregl-ctrl-globe-enabled";

/**
 * Whether a click landed on the GlobeControl toggle (or the icon inside it).
 *
 * Duck-typed rather than `instanceof Element` so it also holds for a target
 * from another realm, and so the test can hand it a parsed document's node.
 */
export function isGlobeControlToggleClick(target: EventTarget | null): boolean {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.closest(GLOBE_CONTROL_TOGGLE_SELECTOR) !== null;
}
