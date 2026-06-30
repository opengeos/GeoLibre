/** Basemap style for the story-map inset minimap (in-app and export). */
export const STORY_INSET_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

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
