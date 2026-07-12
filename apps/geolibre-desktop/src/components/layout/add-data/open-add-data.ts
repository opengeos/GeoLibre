import type { AddDataKind } from "./types";

/** Window event letting any panel open the Add Data dialog at a given kind. */
export const OPEN_ADD_DATA_EVENT = "geolibre:open-add-data";

/**
 * Open the Add Data dialog preselected to `kind` from anywhere in the app,
 * without prop-drilling (mirrors {@link openSettingsSection}). TopToolbar owns
 * the dialog and its kind state and listens for this event. Used by the Browser
 * panel's per-source "New connection" action.
 *
 * @param kind - The Add Data source to open (e.g. "wms", "wfs", "xyz").
 */
export function openAddData(kind: AddDataKind): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_ADD_DATA_EVENT, { detail: { kind } }),
  );
}
