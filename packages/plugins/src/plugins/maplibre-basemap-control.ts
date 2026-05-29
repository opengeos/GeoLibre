import {
  BasemapControl,
  type BasemapControlEventPayload,
  type BasemapControlOptions,
} from "maplibre-gl-basemap-control";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let basemapControlPosition: GeoLibreMapControlPosition = "top-left";

let basemapControl: BasemapControl | null = null;

export const maplibreBasemapControlPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-basemap-control",
  name: "Basemaps",
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
      basemapControlPosition,
    );
    if (!added) {
      basemapControl = null;
      return false;
    }
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    setTimeout(() => basemapControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!basemapControl) return;
    app.removeMapControl(basemapControl);
    basemapControl = null;
  },
  getMapControlPosition: () => basemapControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    basemapControlPosition = position;
    if (!basemapControl) return;
    app.removeMapControl(basemapControl);
    const added = app.addMapControl(basemapControl, basemapControlPosition);
    if (!added) return false;
    basemapControl.setState({
      activeBasemapId: getBasemapIdForStyleUrl(app.getActiveBasemap()),
    });
    setTimeout(() => basemapControl?.expand(), 0);
  },
};

function getBasemapControlOptions(
  app: GeoLibreAppAPI,
): BasemapControlOptions {
  return {
    collapsed: false,
    position: basemapControlPosition,
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
