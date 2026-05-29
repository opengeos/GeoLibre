import { SwipeControl, type SwipeControlOptions } from "maplibre-gl-swipe";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const SWIPE_CONTROL_POSITION = "top-right";

let swipeControl: SwipeControl | null = null;

export const maplibreSwipePlugin: GeoLibrePlugin = {
  id: "maplibre-gl-swipe",
  name: "Layer Swipe",
  version: "0.7.1",
  activate: (app: GeoLibreAppAPI) => {
    if (!swipeControl) {
      swipeControl = new SwipeControl(getSwipeControlOptions(app));
    }

    const added = app.addMapControl(swipeControl, SWIPE_CONTROL_POSITION);
    if (!added) {
      swipeControl = null;
      return false;
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!swipeControl) return;
    app.removeMapControl(swipeControl);
    swipeControl = null;
  },
};

function getSwipeControlOptions(app: GeoLibreAppAPI): SwipeControlOptions {
  return {
    orientation: "vertical",
    position: 50,
    showPanel: true,
    collapsed: true,
    title: "Layer Swipe",
    panelWidth: 300,
    maxHeight: 480,
    active: true,
    basemapStyle: app.getActiveBasemap(),
    excludeLayers: ["gl-draw-*", "measure-*"],
  };
}
