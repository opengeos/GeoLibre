import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../../types";
import { ElevationProfileControl } from "./core/ElevationProfileControl";
import type { ElevationProfileState } from "./core/types";
import type { LngLat } from "./elevation/geometry";
import type { UnitSystem } from "./elevation/format";
import { ELEVATION_LINE_PARAM, maybeHandleDeepLink } from "./utils/deep-link";

/**
 * Elevation Profile plugin.
 *
 * Adds a map control that lets the user draw a line and charts the elevation
 * profile along it — distance, ascent/descent, and min/max stats, a
 * metric/imperial toggle, hover readout, and CSV/SVG export — sampling
 * elevations from the key-less Open-Meteo API. Ported in-house from the
 * external `geolibre-elevation-profile` marketplace plugin so it ships as a
 * first-class built-in; the control code is unchanged, only the plugin entry is
 * rebound onto GeoLibre's built-in `GeoLibrePlugin` contract.
 *
 * The line, unit system, and collapsed state round-trip through the project
 * file, and a `?elevation-line=lng,lat;lng,lat` URL parameter restores a shared
 * profile on load.
 */
export const ELEVATION_PROFILE_PLUGIN_ID = "geolibre-elevation-profile";

// Module-level singletons, mirroring the other built-in control plugins (see
// maplibre-graticule / maplibre-swipe): one control instance whose state
// survives deactivate → activate so a toggle off/on keeps the drawn profile.
let control: ElevationProfileControl | null = null;
let position: GeoLibreMapControlPosition = "top-left";
let pendingState: Partial<ElevationProfileState> | null = null;

function createControl(app: GeoLibreAppAPI): ElevationProfileControl {
  const next = new ElevationProfileControl({
    collapsed: pendingState?.collapsed ?? true,
    unitSystem: pendingState?.unitSystem ?? "metric",
    // Bind the host's file save so CSV/SVG export uses Tauri's native dialog on
    // the desktop (and a browser download on the web); the control falls back
    // to a download when the host does not provide it.
    exportTextFile: app.exportTextFile
      ? (filename, content, options) => app.exportTextFile?.(filename, content, options)
      : undefined,
  });
  if (pendingState) next.setState(pendingState);
  return next;
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
  return true;
}

export const maplibreElevationProfilePlugin: GeoLibrePlugin = {
  id: ELEVATION_PROFILE_PLUGIN_ID,
  name: "Elevation Profile",
  version: "0.1.0",
  urlParameterNames: [ELEVATION_LINE_PARAM],

  activate(app) {
    control = control ?? createControl(app);
    const added = app.addMapControl(control, position);
    if (!added) {
      control = null;
      return false;
    }
  },

  // Deep link: GeoLibre auto-activates the plugin for a URL like
  // ?elevation-line=13.41,52.52;8.23,46.85 and dispatches the params here.
  handleUrlParameters(_app, params) {
    if (control) return maybeHandleDeepLink(control, params);
  },

  deactivate(app) {
    if (!control) return;
    // Capture the drawn line / unit / collapse so re-activating restores it.
    pendingState = control.getState();
    app.removeMapControl(control);
    control = null;
  },

  getMapControlPosition() {
    return position;
  },

  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    if (!control) return;
    app.removeMapControl(control);
    const added = app.addMapControl(control, position);
    if (!added) {
      pendingState = control.getState();
      control = null;
      return false;
    }
  },

  getProjectState() {
    return control?.getState() ?? pendingState ?? undefined;
  },

  applyProjectState(_app, state) {
    if (!isPluginState(state)) {
      // A missing/invalid state (e.g. the "New Project" reset, which calls
      // applyProjectState(app, undefined) via restoreProjectState's
      // resetMissingSettings) must still clear any cached line/unit/collapse,
      // otherwise re-enabling the plugin on the new blank project would restore
      // the previous project's profile. Mirrors maplibre-swipe /
      // maplibre-graticule, whose normalizers reset to defaults on undefined.
      const cleared: ElevationProfileState = {
        collapsed: true,
        unitSystem: "metric",
        line: null,
      };
      pendingState = cleared;
      control?.setState(cleared);
      return;
    }
    pendingState = state as Partial<ElevationProfileState> & {
      unitSystem?: UnitSystem;
    };
    control?.setState(pendingState);
  },
};
