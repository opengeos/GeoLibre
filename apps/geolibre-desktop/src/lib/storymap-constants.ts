import type { StoryActiveSlideMode } from "@geolibre/core";

/** Basemap style for the story-map inset minimap (in-app and export). */
export const STORY_INSET_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

/**
 * Synthetic step ids for the optional start/closing slides (#998). Shared by the
 * presenter, the HTML export template, and the handout so the three stay in sync.
 */
export const STORY_START_STEP_ID = "__story_start__";
export const STORY_END_STEP_ID = "__story_end__";

/**
 * The solid background a blank/black start/closing slide paints over the map, or
 * null when the slide keeps the map visible (global/adjacent). Blank matches the
 * panel theme background (`.glsm-light`/`.glsm-dark`). Shared by the in-app
 * presenter and the PDF handout so the slide treatment stays consistent (#998).
 */
export function storySlideCoverColor(
  mode: StoryActiveSlideMode,
  theme: "light" | "dark",
): string | null {
  if (mode === "black") return "#000000";
  if (mode === "blank") return theme === "light" ? "#fafafa" : "#444444";
  return null;
}

/**
 * Camera used by the `"global"` start/closing slide mode (#998): a zoomed-out,
 * untilted view of the whole map. Shared by the in-app presenter, the standalone
 * HTML export, and the PDF handout so all three frame the globe the same way.
 */
export const STORY_GLOBAL_VIEW = {
  center: [0, 20] as [number, number],
  zoom: 0.6,
  pitch: 0,
  bearing: 0,
};
