import {
  OvertureMapsControl,
  type OvertureMapsControlOptions,
  type OvertureMapsState,
} from "maplibre-gl-overture-maps";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let overturePosition: GeoLibreMapControlPosition = "top-left";

const OVERTURE_OPTIONS = {
  collapsed: false,
  title: "Overture Maps",
  panelWidth: 340,
  className: "geolibre-overture-control",
} satisfies Omit<OvertureMapsControlOptions, "position">;

let overtureControl: OvertureMapsControl | null = null;
// Holds the panel state while the control is detached so re-activating or
// repositioning it restores the user's release, visibility, and opacity.
let pendingState: Partial<OvertureMapsState> | null = null;

function getOvertureControlOptions(): OvertureMapsControlOptions {
  return {
    ...OVERTURE_OPTIONS,
    ...(pendingState?.collapsed != null
      ? { collapsed: pendingState.collapsed }
      : {}),
    ...(pendingState?.panelWidth != null
      ? { panelWidth: pendingState.panelWidth }
      : {}),
    ...(pendingState?.release ? { release: pendingState.release } : {}),
    position: overturePosition,
  };
}

function createOvertureControl(): OvertureMapsControl {
  const control = new OvertureMapsControl(getOvertureControlOptions());
  if (pendingState) {
    control.setState(pendingState);
  }
  return control;
}

function isOvertureMapsState(
  value: unknown,
): value is Partial<OvertureMapsState> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const maplibreOvertureMapsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-overture-maps",
  name: "Overture Maps",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    if (!overtureControl) {
      overtureControl = createOvertureControl();
    }
    const added = app.addMapControl(overtureControl, overturePosition);
    if (!added) {
      overtureControl = null;
      return false;
    }
    // Open the panel on activation. Deferring past the current click avoids
    // the menu click that activated the plugin being treated as a
    // click-outside that immediately re-collapses the panel.
    setTimeout(() => overtureControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!overtureControl) return;
    pendingState = overtureControl.getState();
    app.removeMapControl(overtureControl);
    overtureControl = null;
  },
  getMapControlPosition: () => overturePosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    overturePosition = position;
    if (!overtureControl) return;
    app.removeMapControl(overtureControl);
    const added = app.addMapControl(overtureControl, overturePosition);
    if (!added) {
      pendingState = overtureControl.getState();
      overtureControl = null;
      return false;
    }
    setTimeout(() => overtureControl?.expand(), 0);
  },
  getProjectState: () =>
    overtureControl?.getState() ?? pendingState ?? undefined,
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    if (!isOvertureMapsState(state)) return false;
    pendingState = state;
    overtureControl?.setState(state);
  },
};
