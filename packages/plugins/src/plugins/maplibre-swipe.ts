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

/**
 * Plugin id for the Layer Swipe control. Exported so the app can coordinate it
 * with split view (the two comparison modes are mutually exclusive — see #844).
 */
export const SWIPE_PLUGIN_ID = "maplibre-gl-swipe";

let swipeControlPosition: GeoLibreMapControlPosition = "top-left";

let swipeControl: SwipeControl | null = null;
let savedSwipeState: SwipeState | null = null;
let unsubscribeBasemap: (() => void) | null = null;

export const maplibreSwipePlugin: GeoLibrePlugin = {
  id: SWIPE_PLUGIN_ID,
  name: "Layer Swipe",
  version: "0.9.1",
  activate: (app: GeoLibreAppAPI) => {
    swipeControl = new SwipeControl(
      getSwipeControlOptions(app, savedSwipeState ?? undefined),
    );

    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) {
      swipeControl = null;
      return false;
    }
    expandSwipeControl(savedSwipeState ?? undefined);

    // The control reads the basemap style only on construction, so recreate it
    // when the active basemap changes to keep its basemap-layer grouping in
    // sync. The previous slider state is carried over to avoid a visible reset.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!swipeControl) return;
      const previousState = swipeControl.getState();
      savedSwipeState = previousState;
      app.removeMapControl(swipeControl);
      swipeControl = new SwipeControl(
        getSwipeControlOptions(app, previousState),
      );
      app.addMapControl(swipeControl, swipeControlPosition);
      expandSwipeControl(previousState);
    });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (!swipeControl) return;
    savedSwipeState = swipeControl.getState();
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
    const currentState = swipeControl.getState();
    savedSwipeState = currentState;
    app.removeMapControl(swipeControl);
    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) {
      swipeControl = null;
      return false;
    }
    expandSwipeControl(currentState);
  },
  getProjectState: () => swipeControl?.getState() ?? savedSwipeState ?? undefined,
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    const nextState = normalizeSwipeProjectState(state);
    const currentState = swipeControl?.getState() ?? savedSwipeState;
    if (areSwipeStatesEqual(currentState, nextState)) return false;

    savedSwipeState = nextState;
    if (!swipeControl) return true;

    app.removeMapControl(swipeControl);
    swipeControl = new SwipeControl(
      getSwipeControlOptions(app, savedSwipeState ?? undefined),
    );
    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) {
      swipeControl = null;
      return false;
    }
    expandSwipeControl(savedSwipeState ?? undefined);
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
    // Upper bound only; the control also shrinks the panel to the available map height.
    maxHeight: 900,
    active: previousState?.active ?? true,
    leftLayers: previousState?.leftLayers ?? [],
    rightLayers: previousState?.rightLayers ?? [],
    // True only on first activation; restoring saved/project state keeps the user's selection.
    selectVisibleByDefault: previousState === undefined,
    basemapStyle: app.getActiveBasemap(),
    excludeLayers: ["gl-draw-*", "measure-*", "geolibre-highlight-*"],
    // Only list layers that are currently visible in the main Layers panel
    // (plus any already selected), and keep the lists in sync as visibility
    // changes, so the swipe panel mirrors the active working set (#843).
    visibleLayersOnly: true,
  };
}

function expandSwipeControl(state?: SwipeState): void {
  if (state?.collapsed === true) return;
  setTimeout(() => swipeControl?.expand(), 0);
}

function normalizeSwipeProjectState(state: unknown): SwipeState | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as Partial<SwipeState>;

  return {
    orientation:
      candidate.orientation === "horizontal" ? "horizontal" : "vertical",
    position: normalizePosition(candidate.position),
    collapsed: normalizeBoolean(candidate.collapsed, false),
    active: normalizeBoolean(candidate.active, true),
    leftLayers: normalizeLayerIds(candidate.leftLayers),
    rightLayers: normalizeLayerIds(candidate.rightLayers),
    isDragging: false,
  };
}

function normalizePosition(position: unknown): number {
  if (!Number.isFinite(position)) return 50;
  return Math.min(100, Math.max(0, Number(position)));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeLayerIds(layerIds: unknown): string[] {
  return Array.isArray(layerIds)
    ? layerIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
}

function areSwipeStatesEqual(
  left: SwipeState | null | undefined,
  right: SwipeState | null | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
