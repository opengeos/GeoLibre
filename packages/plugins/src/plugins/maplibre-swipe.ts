import {
  SwipeControl,
  type SwipeControlOptions,
  type SwipeState,
} from "maplibre-gl-swipe";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

let swipeControlPosition: GeoLibreMapControlPosition = "top-left";

let swipeControl: SwipeControl | null = null;
let unsubscribeBasemap: (() => void) | null = null;

export const maplibreSwipePlugin: GeoLibrePlugin = {
  id: "maplibre-gl-swipe",
  name: "Layer Swipe",
  version: "0.7.1",
  activate: (app: GeoLibreAppAPI) => {
    swipeControl = new SwipeControl(getSwipeControlOptions(app));

    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) {
      swipeControl = null;
      return false;
    }
    setTimeout(() => swipeControl?.expand(), 0);

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
      app.addMapControl(swipeControl, swipeControlPosition);
    });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (!swipeControl) return;
    app.removeMapControl(swipeControl);
    swipeControl = null;
  },
  getMapControlPosition: () => swipeControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    swipeControlPosition = position;
    if (!swipeControl) return;
    app.removeMapControl(swipeControl);
    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) return false;
    setTimeout(() => swipeControl?.expand(), 0);
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
    collapsed: previousState?.collapsed ?? false,
    title: "Layer Swipe",
    panelWidth: 300,
    maxHeight: 480,
    active: previousState?.active ?? true,
    leftLayers: previousState?.leftLayers ?? [],
    rightLayers: previousState?.rightLayers ?? [],
    basemapStyle: app.getActiveBasemap(),
    excludeLayers: ["gl-draw-*", "measure-*"],
  };
}
