import { useAppStore, type DeploymentCapability } from "@geolibre/core";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { arePanelsHidden, isDrawRequested, isMapOnly, normalizedParam } from "../lib/layout-params";
import { useDesktopSettingsStore, type DesktopLayoutSettings } from "./useDesktopSettings";

export interface LayoutOptions {
  attributePanelVisible: boolean;
  /**
   * Whether the bottom panels sit under the map column (the side docks keep the
   * full height) instead of spanning the window. A persisted layout setting.
   */
  bottomPanelsUnderMap: boolean;
  compact: boolean;
  layerPanelVisible: boolean;
  /**
   * Whether the embed chrome hides every side panel (`?maponly`,
   * `?panels=hidden`, `?hidePanels=true`). Unlike `layerPanelVisible` /
   * `stylePanelVisible` (which the in-app settings also toggle), this gates the
   * whole side-dock surface — including the plugin/Browser panels and their
   * shared rail — so a map-only embed shows nothing but the map.
   */
  panelsHidden: boolean;
  /** Start the Layers and Style panels on their rails without hiding them. */
  panelsCollapsed: boolean;
  showProjectInfo: boolean;
  statusBarVisible: boolean;
  stylePanelVisible: boolean;
  toolbarLabels: boolean;
  toolbarVisible: boolean;
  /** Read-only embed chrome with Layers and map navigation, but no authoring UI. */
  viewer: boolean;
  /**
   * Whether the read-only viewer lets the geometry editor run (`?layout=viewer`
   * with `?draw`), so a host page can offer drawing without the authoring
   * chrome. Needs the deployment's `project:edit` capability; always false
   * outside the viewer, where the editor is not blocked in the first place.
   */
  viewerDrawing: boolean;
}

const COMPACT_LAYOUT_VALUES = new Set(["compact", "embed", "iframe"]);
const ICON_TOOLBAR_VALUES = new Set(["icon", "icons", "icon-only"]);
const HIDDEN_TOOLBAR_VALUES = new Set(["hidden", "hide", "none", "off"]);

export function useLayoutOptions(): LayoutOptions {
  // Shallow equality keeps unrelated desktop-settings updates (which always
  // rebuild the layout object) from re-rendering every layout consumer.
  const layoutSettings = useDesktopSettingsStore(useShallow((s) => s.desktopSettings.layout));
  const capabilities = useAppStore((s) => s.deploymentCapabilities);
  return useMemo(
    () => layoutOptionsFromLocation(layoutSettings, capabilities),
    [layoutSettings, capabilities],
  );
}

/**
 * Whether a query string asks for the read-only `layout=viewer` chrome.
 *
 * Args:
 *   search: The URL's query string.
 *
 * Returns:
 *   True for a viewer launch.
 */
export function isViewerLayout(search: string): boolean {
  return normalizedParam(new URLSearchParams(search).get("layout")) === "viewer";
}

export function layoutOptionsFromLocation(
  layoutSettings: DesktopLayoutSettings,
  capabilities: ReadonlySet<DeploymentCapability>,
): LayoutOptions {
  if (typeof window === "undefined") {
    return {
      attributePanelVisible: true,
      compact: false,
      panelsHidden: false,
      panelsCollapsed: false,
      statusBarVisible: true,
      toolbarVisible: true,
      viewer: false,
      viewerDrawing: false,
      ...layoutSettings,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const layout = normalizedParam(params.get("layout"));
  const panels = normalizedParam(params.get("panels"));
  const toolbar = normalizedParam(params.get("toolbar"));
  // `maponly` hides the entire chrome (toolbar, panels, status bar), leaving
  // only the map.
  const mapOnly = isMapOnly(params);
  const viewer = isViewerLayout(window.location.search);
  // `maponly` implies `compact` so the map fills its container (the `<main>`
  // element gets `min-h-0`). This also forces `toolbarLabels` and
  // `showProjectInfo` to false below, which is harmless since the toolbar is
  // hidden, but any other consumer of `compact` sees `true` in map-only mode.
  const compact = mapOnly || viewer || COMPACT_LAYOUT_VALUES.has(layout);
  const panelsHidden = arePanelsHidden(params);
  const panelsCollapsed = !panelsHidden && panels === "collapsed";
  const toolbarLabels =
    !compact && !ICON_TOOLBAR_VALUES.has(toolbar) ? layoutSettings.toolbarLabels : false;
  const showProjectInfo = compact ? false : layoutSettings.showProjectInfo;
  const layerPanelVisible = panelsHidden ? false : viewer ? true : layoutSettings.layerPanelVisible;
  const stylePanelVisible = panelsHidden || viewer ? false : layoutSettings.stylePanelVisible;
  // The attribute table is hidden by default and opened on demand from a
  // vector layer's context menu, so it has no persisted settings toggle; it
  // only needs to be unmounted when the embed chrome is hidden.
  const attributePanelVisible = !panelsHidden && !viewer;

  return {
    attributePanelVisible,
    bottomPanelsUnderMap: layoutSettings.bottomPanelsUnderMap,
    compact,
    layerPanelVisible,
    panelsHidden,
    panelsCollapsed,
    showProjectInfo,
    statusBarVisible: !mapOnly,
    stylePanelVisible,
    toolbarLabels,
    toolbarVisible: !mapOnly && !HIDDEN_TOOLBAR_VALUES.has(toolbar),
    viewer,
    viewerDrawing: viewer && isDrawRequested(params) && capabilities.has("project:edit"),
  };
}
