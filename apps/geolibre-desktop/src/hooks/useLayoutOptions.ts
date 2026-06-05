import { useMemo } from "react";
import {
  useDesktopSettingsStore,
  type DesktopLayoutSettings,
} from "./useDesktopSettings";

export interface LayoutOptions {
  attributePanelVisible: boolean;
  compact: boolean;
  layerPanelVisible: boolean;
  showProjectInfo: boolean;
  stylePanelVisible: boolean;
  toolbarLabels: boolean;
}

const COMPACT_LAYOUT_VALUES = new Set(["compact", "embed", "iframe"]);
const ICON_TOOLBAR_VALUES = new Set(["icon", "icons", "icon-only"]);
const HIDDEN_PANEL_VALUES = new Set(["hidden", "hide", "none", "off"]);

const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  attributePanelVisible: true,
  compact: false,
  layerPanelVisible: true,
  showProjectInfo: true,
  stylePanelVisible: true,
  toolbarLabels: true,
};

export function useLayoutOptions(): LayoutOptions {
  const layoutSettings = useDesktopSettingsStore((s) => s.desktopSettings.layout);
  return useMemo(
    () => layoutOptionsFromLocation(layoutSettings),
    [layoutSettings],
  );
}

function layoutOptionsFromLocation(
  layoutSettings: DesktopLayoutSettings,
): LayoutOptions {
  if (typeof window === "undefined") {
    return { ...DEFAULT_LAYOUT_OPTIONS, ...layoutSettings };
  }

  const params = new URLSearchParams(window.location.search);
  const layout = normalizedParam(params.get("layout"));
  const panels = normalizedParam(params.get("panels"));
  const toolbar = normalizedParam(params.get("toolbar"));
  const compact = COMPACT_LAYOUT_VALUES.has(layout);
  const panelsHidden =
    HIDDEN_PANEL_VALUES.has(panels) ||
    normalizedParam(params.get("hidePanels")) === "true";
  const toolbarLabels =
    !compact && !ICON_TOOLBAR_VALUES.has(toolbar)
      ? layoutSettings.toolbarLabels
      : false;
  const showProjectInfo = compact ? false : layoutSettings.showProjectInfo;
  const layerPanelVisible = panelsHidden
    ? false
    : layoutSettings.layerPanelVisible;
  const stylePanelVisible = panelsHidden
    ? false
    : layoutSettings.stylePanelVisible;
  const attributePanelVisible = panelsHidden
    ? false
    : layoutSettings.attributePanelVisible;

  return {
    attributePanelVisible,
    compact,
    layerPanelVisible,
    showProjectInfo,
    stylePanelVisible,
    toolbarLabels,
  };
}

function normalizedParam(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
