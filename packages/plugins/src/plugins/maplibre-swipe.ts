import {
  SwipeControl,
  type SwipeControlOptions,
  type SwipeState,
} from "maplibre-gl-swipe";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

const SWIPE_CONTROL_POSITION = "top-right";

let swipeControl: SwipeControl | null = null;
let unsubscribeBasemap: (() => void) | null = null;

export const maplibreSwipePlugin: GeoLibrePlugin = {
  id: "maplibre-gl-swipe",
  name: "Layer Swipe",
  version: "0.7.1",
  activate: (app: GeoLibreAppAPI) => {
    swipeControl = new SwipeControl(getSwipeControlOptions(app));

    const added = app.addMapControl(swipeControl, SWIPE_CONTROL_POSITION);
    if (!added) {
      swipeControl = null;
      return false;
    }

    // The control reads the basemap style only on construction, so recreate it
    // when the active basemap changes to keep its basemap-layer grouping in
    // sync. The previous slider state is carried over to avoid a visible reset.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!swipeControl) return;
      const previousState = swipeControl.getState();
      app.removeMapControl(swipeControl);
      swipeControl = new SwipeControl(
        getSwipeControlOptions(app, previousState),
      );
      app.addMapControl(swipeControl, SWIPE_CONTROL_POSITION);
    });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (!swipeControl) return;
    app.removeMapControl(swipeControl);
    swipeControl = null;
  },
};

function getSwipeControlOptions(
  app: GeoLibreAppAPI,
  previousState?: SwipeState,
): SwipeControlOptions {
  return {
    orientation: previousState?.orientation ?? "vertical",
    position: previousState?.position ?? 50,
    showPanel: true,
    collapsed: previousState?.collapsed ?? true,
    title: "Layer Swipe",
    panelWidth: 300,
    maxHeight: 480,
    active: previousState?.active ?? true,
    leftLayers: previousState?.leftLayers,
    rightLayers: previousState?.rightLayers,
    basemapStyle: app.getActiveBasemap(),
    excludeLayers: ["gl-draw-*", "measure-*"],
  };
}
