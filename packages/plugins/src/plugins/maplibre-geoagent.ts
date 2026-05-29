import {
  GeoAgentControl,
  type GeoAgentControlOptions,
} from "maplibre-gl-geoagent";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let geoAgentPosition: GeoLibreMapControlPosition = "top-left";

const GEOAGENT_OPTIONS = {
  title: "GeoAgent",
  collapsed: false,
  allowCodeExecutionDefault: false,
  allowDestructiveToolsDefault: false,
  showPermissionToggles: true,
  storagePrefix: "geolibre.geoagent",
} satisfies Omit<GeoAgentControlOptions, "position">;

let geoAgentControl: GeoAgentControl | null = null;

export const maplibreGeoAgentPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geoagent",
  name: "GeoAgent",
  version: "0.4.2",
  activate: (app: GeoLibreAppAPI) => {
    if (!geoAgentControl) {
      geoAgentControl = new GeoAgentControl(getGeoAgentOptions());
    }

    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) {
      geoAgentControl = null;
      return false;
    }
    setTimeout(() => geoAgentControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!geoAgentControl) return;
    app.removeMapControl(geoAgentControl);
    geoAgentControl = null;
  },
  getMapControlPosition: () => geoAgentPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    geoAgentPosition = position;
    if (!geoAgentControl) return;
    app.removeMapControl(geoAgentControl);
    const added = app.addMapControl(geoAgentControl, geoAgentPosition);
    if (!added) return false;
    setTimeout(() => geoAgentControl?.expand(), 0);
  },
};

function getGeoAgentOptions(): GeoAgentControlOptions {
  return {
    ...GEOAGENT_OPTIONS,
    position: geoAgentPosition,
  };
}
