import {
  GeoAgentControl,
  type GeoAgentControlOptions,
} from "maplibre-gl-geoagent";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const GEOAGENT_OPTIONS = {
  title: "GeoAgent",
  collapsed: true,
  position: "top-left",
  allowCodeExecutionDefault: false,
  allowDestructiveToolsDefault: false,
  showPermissionToggles: true,
  storagePrefix: "geolibre.geoagent",
} satisfies GeoAgentControlOptions;

let geoAgentControl: GeoAgentControl | null = null;

export const maplibreGeoAgentPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geoagent",
  name: "MapLibre GeoAgent",
  version: "0.4.2",
  activate: (app: GeoLibreAppAPI) => {
    if (!geoAgentControl) {
      geoAgentControl = new GeoAgentControl(GEOAGENT_OPTIONS);
    }

    const added = app.addMapControl(
      geoAgentControl,
      GEOAGENT_OPTIONS.position,
    );
    if (!added) {
      geoAgentControl = null;
      return false;
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!geoAgentControl) return;
    app.removeMapControl(geoAgentControl);
    geoAgentControl = null;
  },
};
