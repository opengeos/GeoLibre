import {
  BasemapControl,
  type BasemapControlEventPayload,
  type BasemapControlOptions,
} from "maplibre-gl-basemap-control";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const BASEMAP_CONTROL_POSITION = "top-right";

let basemapControl: BasemapControl | null = null;

export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-basemap-control",
  name: "Basemap Control",
  version: "0.2.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) {
      basemapControl = new BasemapControl(getBasemapControlOptions(app));
      basemapControl.on("basemapchange", (event) => {
        handleBasemapChange(app, event);
      });
    }

    const added = app.addMapControl(
      basemapControl,
      BASEMAP_CONTROL_POSITION,
    );
    if (!added) {
      basemapControl = null;
      return false;
    }
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) return;
    app.removeMapControl(basemapControl);
    basemapControl = null;
  },
};

function getBasemapControlOptions(
  app: GeoLibreAppAPI,
): BasemapControlOptions {
  return {
    collapsed: true,
    position: BASEMAP_CONTROL_POSITION,
    title: "Basemaps",
  };
}

function handleBasemapChange(
  app: GeoLibreAppAPI,
  event: BasemapControlEventPayload,
): void {
  if (event.type !== "basemapchange") return;
  const { source } = event.basemap;
  if (source.type !== "style" && source.type !== "vector-style") return;
  app.setBasemap(source.url);
}

function getBasemapIdForStyleUrl(url: string): string | undefined {
  if (url === "https://tiles.openfreemap.org/styles/positron") {
    return "openfreemap-positron";
  }
  if (url === "https://tiles.openfreemap.org/styles/bright") {
    return "openfreemap-bright";
  }
  if (url === "https://tiles.openfreemap.org/styles/liberty") {
    return "openfreemap-liberty";
  }
  if (url === "https://tiles.openfreemap.org/styles/dark") {
    return "openfreemap-dark";
  }
  if (url === "https://tiles.openfreemap.org/styles/fiord") {
    return "openfreemap-fiord";
  }
  return undefined;
}
