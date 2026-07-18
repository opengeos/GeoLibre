import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDesktopSettingsStore, type DesktopLayoutSettings } from "./useDesktopSettings";

export interface LayoutOptions {
  attributePanelVisible: boolean;
  compact: boolean;
  layerPanelVisible: boolean;
  showProjectInfo: boolean;
  statusBarVisible: boolean;
  stylePanelVisible: boolean;
  toolbarLabels: boolean;
  toolbarVisible: boolean;
}

const COMPACT_LAYOUT_VALUES = new Set(["compact", "embed", "iframe"]);
const ICON_TOOLBAR_VALUES = new Set(["icon", "icons", "icon-only"]);
const HIDDEN_PANEL_VALUES = new Set(["hidden", "hide", "none", "off"]);
const MAP_ONLY_VALUES = new Set(["", "true", "1", "yes", "on"]);

export function useLayoutOptions(): LayoutOptions {
  // Shallow equality keeps unrelated desktop-settings updates (which always
  // rebuild the layout object) from re-rendering every layout consumer.
  const layoutSettings = useDesktopSettingsStore(useShallow((s) => s.desktopSettings.layout));
  return useMemo(() => layoutOptionsFromLocation(layoutSettings), [layoutSettings]);
}

export function layoutOptionsFromLocation(layoutSettings: DesktopLayoutSettings): LayoutOptions {
  if (typeof window === "undefined") {
    return {
      attributePanelVisible: true,
      compact: false,
      statusBarVisible: true,
      toolbarVisible: true,
      ...layoutSettings,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const layout = normalizedParam(params.get("layout"));
  const panels = normalizedParam(params.get("panels"));
  const toolbar = normalizedParam(params.get("toolbar"));
  // `maponly` hides the entire chrome (toolbar, panels, status bar), leaving
  // only the map. The param can be a bare flag (`?maponly`) or an explicit
  // truthy value (`?maponly=true`).
  const mapOnly =
    params.has("maponly") && MAP_ONLY_VALUES.has(normalizedParam(params.get("maponly")));
  // `maponly` implies `compact` so the map fills its container (the `<main>`
  // element gets `min-h-0`). This also forces `toolbarLabels` and
  // `showProjectInfo` to false below, which is harmless since the toolbar is
  // hidden, but any other consumer of `compact` sees `true` in map-only mode.
  const compact = mapOnly || COMPACT_LAYOUT_VALUES.has(layout);
  const panelsHidden =
    mapOnly ||
    HIDDEN_PANEL_VALUES.has(panels) ||
    normalizedParam(params.get("hidePanels")) === "true";
  const toolbarLabels =
    !compact && !ICON_TOOLBAR_VALUES.has(toolbar) ? layoutSettings.toolbarLabels : false;
  const showProjectInfo = compact ? false : layoutSettings.showProjectInfo;
  const layerPanelVisible = panelsHidden ? false : layoutSettings.layerPanelVisible;
  const stylePanelVisible = panelsHidden ? false : layoutSettings.stylePanelVisible;
  // The attribute table is hidden by default and opened on demand from a
  // vector layer's context menu, so it has no persisted settings toggle; it
  // only needs to be unmounted when the embed chrome is hidden.
  const attributePanelVisible = !panelsHidden;

  return {
    attributePanelVisible,
    compact,
    layerPanelVisible,
    showProjectInfo,
    statusBarVisible: !mapOnly,
    stylePanelVisible,
    toolbarLabels,
    toolbarVisible: !mapOnly,
  };
}

function normalizedParam(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
