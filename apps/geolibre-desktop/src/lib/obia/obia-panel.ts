// The registry subpath rather than the package barrel, as in
// persisted-right-panel.ts: the barrel pulls in every built-in plugin. This
// module stays free of the i18n bundle so menus and commands can import it
// (the registration hook lives in hooks/useRegisterObiaPanel.ts).
import { openRightPanel } from "@geolibre/plugins/right-panel-registry";

/** Stable id of the Object-Based Analysis right panel. */
export const OBIA_PANEL_ID = "obia-workbench";

/** Show and expand the workbench, adding it to the rail if it was not there. */
export function openObiaWorkbench(): void {
  openRightPanel(OBIA_PANEL_ID);
}
