import type { MapCanvasIdentifyEditActions } from "@geolibre/map";

/**
 * The Identify edit actions a layout offers. The read-only viewer offers none,
 * since both actions start an editor session on the identified layer.
 *
 * @param actions - The actions from `useIdentifyEditActions`.
 * @param viewer - Whether the app runs in the `layout=viewer` preset.
 * @returns The actions to hand the map canvases, or undefined for none.
 */
export function identifyEditActionsForLayout(
  actions: MapCanvasIdentifyEditActions,
  viewer: boolean,
): MapCanvasIdentifyEditActions | undefined {
  return viewer ? undefined : actions;
}
