import { createPluginTranslator, pluginDisplayTitle } from "../../plugin-i18n";
import { getActiveRightPanel, isRightPanelCollapsed } from "../../right-panel-registry";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import { ElevationProfileControl } from "./core/ElevationProfileControl";
import { cesiumProfileMap } from "./cesium";
import type { ElevationProfileState } from "./core/types";
import type { LngLat } from "./elevation/geometry";
import type { UnitSystem } from "./elevation/format";
import { ELEVATION_LINE_PARAM, maybeHandleDeepLink } from "./utils/deep-link";

/**
 * Elevation Profile plugin.
 *
 * Opens a panel in GeoLibre's dockable side panel that lets the user draw a
 * line and charts the elevation profile along it — distance, ascent/descent,
 * and min/max stats, a metric/imperial toggle, hover readout, and CSV/SVG
 * export — sampling elevations from the active terrain on Cesium or the
 * key-less Open-Meteo API on MapLibre. Ported in-house from the
 * external `geolibre-elevation-profile` marketplace plugin so it ships as a
 * first-class built-in using GeoLibre's `GeoLibrePlugin` contract.
 *
 * The line, unit system, and collapsed state round-trip through the project
 * file, and a `?elevation-line=lng,lat;lng,lat` URL parameter restores a shared
 * profile on load.
 */
export const ELEVATION_PROFILE_PLUGIN_ID = "geolibre-elevation-profile";

const PANEL_ID = "elevation-profile-panel";
// The control's toolbar button is hidden (the dock owns opening and closing),
// so its corner is irrelevant; it only has to be a valid position.
const CONTROL_POSITION = "top-left";

// Module-level singletons, mirroring the other built-in control plugins (see
// maplibre-graticule / maplibre-swipe): one control instance per activation,
// whose state is cached on deactivate so a toggle off/on keeps the drawn
// profile.
let control: ElevationProfileControl | null = null;
let pendingState: Partial<ElevationProfileState> | null = null;
let unregisterPanel: (() => void) | null = null;
/** Stops re-labelling the control on language changes. */
let stopLocaleSync: (() => void) | null = null;

/** True when a cached state is absent or equals the untouched defaults. */
function isDefaultState(state: Partial<ElevationProfileState> | null): boolean {
  if (!state) return true;
  return (
    !state.collapsed &&
    (state.unitSystem ?? "metric") === "metric" &&
    !state.line &&
    !state.elevations
  );
}

function createControl(app: GeoLibreAppAPI): ElevationProfileControl {
  const globe = app.getCesiumScene?.();
  const next = new ElevationProfileControl({
    nativeMap: globe ? cesiumProfileMap(globe, app.fitBounds) : undefined,
    docked: true,
    unitSystem: pendingState?.unitSystem ?? "metric",
    // Bind the host's file save so CSV/SVG export uses Tauri's native dialog on
    // the desktop (and a browser download on the web); the control falls back
    // to a download when the host does not provide it.
    exportTextFile: app.exportTextFile
      ? (filename, content, options) => app.exportTextFile?.(filename, content, options)
      : undefined,
    getSelectedFeatures: app.getSelectedFeatures,
    translate: createPluginTranslator(app, ELEVATION_PROFILE_PLUGIN_ID),
    onSelectionChange: app.onSelectionChange
      ? (callback) => app.onSelectionChange?.(() => callback()) ?? (() => undefined)
      : undefined,
  });
  if (pendingState) next.setState(pendingState);
  return next;
}

// --- Docked panel -----------------------------------------------------------
// Only the panel docks. The drawn line, its vertices and the hover marker are
// map layers, so the control itself stays mounted on the map for as long as the
// plugin is active: another docked panel displacing this one runs its render
// cleanup, and that must not drop the profile. The dock adopts the panel
// element while it shows it and lets go of it when displaced.

function registerPanel(app: GeoLibreAppAPI): void {
  unregisterPanel?.();
  unregisterPanel =
    app.registerRightPanel?.({
      id: PANEL_ID,
      // The plugin's display name is already translated in every catalog.
      title: pluginDisplayTitle(app, ELEVATION_PROFILE_PLUGIN_ID, "Elevation Profile"),
      dock: "replace-style",
      defaultWidth: 340,
      deactivatePluginOnClose: true,
      render: (container) => {
        const panel = control?.getPanel();
        container.classList.add("geolibre-docked-map-control");
        if (panel) container.replaceChildren(panel);
        return () => {
          if (panel?.parentElement === container) panel.remove();
          container.classList.remove("geolibre-docked-map-control");
        };
      },
      // Collapsing to the rail hides the Finish button, so end any drawing.
      // The saved `collapsed` flag is read from the dock itself (see
      // isDockCollapsed): the registry fires onOpen only when the panel takes
      // the dock, not when it re-expands from its rail, so mirroring the two
      // hooks into the control would leave it stale.
      onCollapse: () => control?.collapse(),
    }) ?? null;
}

/** Whether the dock is showing this plugin's panel collapsed to its rail. */
function isDockCollapsed(): boolean {
  return getActiveRightPanel() === PANEL_ID && isRightPanelCollapsed();
}

/** Open or collapse the dock to match a restored `collapsed` flag. */
function syncDockCollapse(app: GeoLibreAppAPI, collapsed: boolean | undefined): void {
  if (!control || collapsed === undefined) return;
  if (collapsed) app.collapseRightPanel?.(PANEL_ID);
  else app.openRightPanel?.(PANEL_ID);
}

/** Remove the control and its docked panel, caching its state. */
function teardown(app: GeoLibreAppAPI): void {
  if (control) {
    // Capture the drawn line / unit so re-activating restores it, but not the
    // collapse: turning the plugin back on is a request to see the panel.
    pendingState = { ...control.getState(), collapsed: false };
    app.removeMapControl(control);
    control = null;
  }
  app.closeRightPanel?.(PANEL_ID);
  unregisterPanel?.();
  unregisterPanel = null;
  stopLocaleSync?.();
  stopLocaleSync = null;
}

function isLngLatArray(value: unknown): value is LngLat[] {
  return (
    Array.isArray(value) &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "number" &&
        typeof pair[1] === "number",
    )
  );
}

function isPluginState(value: unknown): value is Partial<ElevationProfileState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if ("collapsed" in candidate && typeof candidate.collapsed !== "boolean") {
    return false;
  }
  if (
    "unitSystem" in candidate &&
    candidate.unitSystem !== "metric" &&
    candidate.unitSystem !== "imperial"
  ) {
    return false;
  }
  if ("line" in candidate && candidate.line !== null && !isLngLatArray(candidate.line)) {
    return false;
  }
  if (
    "elevations" in candidate &&
    candidate.elevations !== null &&
    (!Array.isArray(candidate.elevations) ||
      !candidate.elevations.every(
        (elevation) => typeof elevation === "number" && Number.isFinite(elevation),
      ))
  ) {
    return false;
  }
  return true;
}

export const maplibreElevationProfilePlugin: GeoLibrePlugin = {
  id: ELEVATION_PROFILE_PLUGIN_ID,
  // The control draws its line and markers through the style API both 2D
  // engines share and samples elevations from tiles it fetches itself, so the
  // Mapbox renderer hosts it as MapLibre does; the globe gets its own adapter.
  engines: ["maplibre", "cesium", "mapbox"],
  name: "Elevation Profile",
  version: "0.1.0",
  urlParameterNames: [ELEVATION_LINE_PARAM],

  // The panel's `collapsed` flag round-trips through getProjectState, so the
  // saved project decides whether the dock opens or sits on its rail. Without
  // this exemption the host's restore-time sweep (`collapseRestoredRightPanel`
  // in plugin-manager.ts) collapses the dock on every project load, and since
  // the dock's onCollapse mirrors into the control, the next save would write
  // `collapsed: true` back and the user's preference would be lost for good.
  // maplibre-time-slider carries the same flag for the same reason.
  restoresPanelCollapseState: true,

  activate(app) {
    if (!app.registerRightPanel || !app.openRightPanel) return false;
    // Only a project file can ask for the panel closed: `restoreProjectState`
    // calls applyProjectState immediately before activate, so a saved
    // `collapsed: true` is already in pendingState here. Every other route in
    // (a first activation, a session deactivate, a New Project reset) opens it.
    const startCollapsed = pendingState?.collapsed ?? false;
    control = createControl(app);
    if (!app.addMapControl(control, CONTROL_POSITION)) {
      control = null;
      return false;
    }
    registerPanel(app);
    stopLocaleSync?.();
    stopLocaleSync = app.onLocaleChange?.(() => control?.refreshLabels()) ?? null;
    if (!app.openRightPanel(PANEL_ID)) {
      teardown(app);
      return false;
    }
    if (startCollapsed) app.collapseRightPanel?.(PANEL_ID);
  },

  // Deep link: GeoLibre auto-activates the plugin for a URL like
  // ?elevation-line=13.41,52.52;8.23,46.85 and dispatches the params here.
  handleUrlParameters(app, params) {
    if (!control) return;
    // The shared line is the point of the link, so show the panel even when the
    // restored project left it collapsed.
    app.openRightPanel?.(PANEL_ID);
    return maybeHandleDeepLink(control, params);
  },

  deactivate(app) {
    teardown(app);
  },

  getProjectState() {
    if (control) return { ...control.getState(), collapsed: isDockCollapsed() };
    // A default state (the New Project reset, or a plugin never opened) carries
    // nothing worth saving; omitting it keeps empty projects free of plugin
    // state, so the credential-strip prompt has nothing to count.
    return isDefaultState(pendingState) ? undefined : (pendingState ?? undefined);
  },

  applyProjectState(app, state) {
    if (!isPluginState(state)) {
      // A missing/invalid state (e.g. the "New Project" reset, which calls
      // applyProjectState(app, undefined) via restoreProjectState's
      // resetMissingSettings) must still clear any cached line/unit/collapse,
      // otherwise re-enabling the plugin on the new blank project would restore
      // the previous project's profile. Mirrors maplibre-swipe /
      // maplibre-graticule, whose normalizers reset to defaults on undefined.
      const cleared: ElevationProfileState = {
        collapsed: false,
        unitSystem: "metric",
        line: null,
        elevations: null,
      };
      pendingState = cleared;
      control?.setState(cleared);
      syncDockCollapse(app, false);
      return;
    }
    pendingState = state as Partial<ElevationProfileState> & {
      unitSystem?: UnitSystem;
    };
    control?.setState(pendingState);
    syncDockCollapse(app, pendingState.collapsed);
  },
};
