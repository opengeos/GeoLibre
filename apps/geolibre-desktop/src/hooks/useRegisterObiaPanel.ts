import { useEffect } from "react";
import { registerRightPanel } from "@geolibre/plugins/right-panel-registry";
import i18n from "../i18n";
import { OBIA_PANEL_ID } from "../lib/obia/obia-panel";

/**
 * Register the Object-Based Analysis workbench as a dockable right panel on the
 * Style rail. Unlike Browser and Comments it is not shown by default and its
 * visibility is not persisted: the panel joins the rail only once the user opens
 * it (Processing → Object-Based Analysis), and closing it from its header
 * removes it again. Its React content is portalled into a dedicated host by the
 * shell, so `render` is a no-op.
 */
export function useRegisterObiaPanel(): void {
  useEffect(
    () =>
      registerRightPanel({
        id: OBIA_PANEL_ID,
        // i18n.t (not the hook) so registration has no render-time dependency.
        title: () => i18n.t("obia.title"),
        dock: "replace-style",
        defaultWidth: 400,
        render: () => {},
      }),
    [],
  );
}
