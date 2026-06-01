import { useMemo } from "react";

export interface LayoutOptions {
  compact: boolean;
  panelsVisible: boolean;
  showProjectInfo: boolean;
  toolbarLabels: boolean;
}

const COMPACT_LAYOUT_VALUES = new Set(["compact", "embed", "iframe"]);
const ICON_TOOLBAR_VALUES = new Set(["icon", "icons", "icon-only"]);
const HIDDEN_PANEL_VALUES = new Set(["hidden", "hide", "none", "off"]);

const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  compact: false,
  panelsVisible: true,
  showProjectInfo: true,
  toolbarLabels: true,
};

export function useLayoutOptions(): LayoutOptions {
  return useMemo(() => layoutOptionsFromLocation(), []);
}

function layoutOptionsFromLocation(): LayoutOptions {
  if (typeof window === "undefined") return DEFAULT_LAYOUT_OPTIONS;

  const params = new URLSearchParams(window.location.search);
  const layout = normalizedParam(params.get("layout"));
  const panels = normalizedParam(params.get("panels"));
  const toolbar = normalizedParam(params.get("toolbar"));
  const compact = COMPACT_LAYOUT_VALUES.has(layout);
  const panelsVisible =
    !HIDDEN_PANEL_VALUES.has(panels) &&
    normalizedParam(params.get("hidePanels")) !== "true";
  const toolbarLabels = !compact && !ICON_TOOLBAR_VALUES.has(toolbar);

  return {
    compact,
    panelsVisible,
    showProjectInfo: !compact,
    toolbarLabels,
  };
}

function normalizedParam(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}
