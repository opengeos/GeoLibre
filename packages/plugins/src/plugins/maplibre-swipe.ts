import type { Map as MapLibreMap } from "maplibre-gl";
import {
  SwipeControl,
  type SwipeControlOptions,
  type SwipeLayerProvider,
  type SwipeLayerSide,
  type SwipeState,
} from "maplibre-gl-swipe";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";
import { INTERNAL_HELPER_LAYER_PATTERNS } from "./internal-layers";
import {
  getCogRasterMainVisibility,
  getSwipeCogRasters,
  setCogRasterMainVisibility,
  subscribeSwipeCogChanges,
  type SwipeCogRasterSnapshot,
} from "./maplibre-components";
import { SwipeCogMirror } from "./swipe-cog-mirror";

/**
 * Plugin id for the Layer Swipe control. Exported so the app can coordinate it
 * with split view (the two comparison modes are mutually exclusive — see #844).
 */
export const SWIPE_PLUGIN_ID = "maplibre-gl-swipe";

let swipeControlPosition: GeoLibreMapControlPosition = "top-left";

let swipeControl: SwipeControl | null = null;
let savedSwipeState: SwipeState | null = null;
let unsubscribeBasemap: (() => void) | null = null;

// --- COG raster swipe integration ------------------------------------------
// GeoLibre renders COG rasters on a deck.gl overlay, so they are MapLibre custom
// layers that the swipe control cannot see through getStyle(). This provider
// (passed to SwipeControl via the layerProvider option) lists them in the swipe
// panel and renders each per its side assignment: right/both/none rasters are
// mirrored onto the swipe comparison map (which the control already clips to the
// swipe region), and right-only rasters are hidden on the main map. See #1240.

// The comparison-map raster mirror, recreated whenever the swipe control makes a
// fresh comparison map (basemap change, re-activation).
let cogMirror: SwipeCogMirror | null = null;
// The main-map visibility this provider last forced per raster id (with the
// opacity to restore when showing it again), so it only toggles on change and
// can restore visibility on teardown.
const cogMainForced = new Map<string, { visible: boolean; opacity: number }>();
// Side assignments accumulated during one _updateLayerVisibility pass (the
// control calls applySide once per provider layer); reconciled together so the
// comparison mirror syncs in a single pass.
const cogPendingSides = new Map<string, SwipeLayerSide>();
let cogPendingComparisonMap: MapLibreMap | undefined;
let cogReconcileScheduled = false;
let unsubscribeCogRasterChanges: (() => void) | null = null;

const cogSwipeProvider: SwipeLayerProvider = {
  getLayers: () =>
    getSwipeCogRasters().map((raster) => ({
      id: raster.id,
      type: "raster",
      visible: raster.visible,
    })),
  applySide: (id, side, comparisonMap) => {
    cogPendingSides.set(id, side);
    cogPendingComparisonMap = comparisonMap;
    scheduleCogReconcile();
  },
  detachComparison: () => {
    teardownCogSwipe();
  },
};

function scheduleCogReconcile(): void {
  if (cogReconcileScheduled) return;
  cogReconcileScheduled = true;
  // Coalesce the per-layer applySide calls of one visibility pass into a single
  // reconcile so the mirror syncs its whole set at once.
  queueMicrotask(reconcileCogSwipe);
}

function reconcileCogSwipe(): void {
  cogReconcileScheduled = false;
  const sides = new Map(cogPendingSides);
  cogPendingSides.clear();
  const comparisonMap = cogPendingComparisonMap;

  // Rebuild the mirror when the comparison map changes identity (or drop it when
  // there is none).
  if (!comparisonMap) {
    cogMirror?.destroy();
    cogMirror = null;
  } else if (!cogMirror || cogMirror.getMap() !== comparisonMap) {
    cogMirror?.destroy();
    cogMirror = new SwipeCogMirror(comparisonMap);
  }

  const rasters = getSwipeCogRasters();

  // Drop bookkeeping for rasters removed from the store while swiping (the loop
  // below only visits still-present rasters, so their entries would otherwise
  // linger until teardown).
  const rasterIds = new Set(rasters.map((raster) => raster.id));
  for (const id of [...cogMainForced.keys()]) {
    if (!rasterIds.has(id)) cogMainForced.delete(id);
  }

  const sideFor = (raster: SwipeCogRasterSnapshot): SwipeLayerSide =>
    sides.get(raster.id) ?? "none";

  // A raster shows on the comparison (right) side for right/both, and for none
  // (unselected) so it stays full-screen like an unswiped layer. Left-only
  // rasters are omitted, so the comparison map shows the basemap there.
  const onComparison = (side: SwipeLayerSide): boolean =>
    side === "right" || side === "both" || side === "none";

  if (cogMirror) {
    void cogMirror.sync(
      rasters.filter((raster) => raster.visible && onComparison(sideFor(raster))),
    );
  }

  // Main map: hide right-only rasters (shown on the comparison side instead);
  // keep every other visible raster on the main map. Rasters the user hid are
  // left untouched (their store `visible` is false). Compare against the
  // control's LIVE visibility, not a cached value: the store-diff subscription
  // in maplibre-components also toggles the control (a Layers-panel visibility
  // flip), so a cached target can drift and leave a right-only raster shown.
  for (const raster of rasters) {
    if (!raster.visible) {
      cogMainForced.delete(raster.id);
      continue;
    }
    const wantVisible = sideFor(raster) !== "right";
    if (getCogRasterMainVisibility(raster.id) !== wantVisible) {
      setCogRasterMainVisibility(raster.id, wantVisible, raster.opacity);
    }
    cogMainForced.set(raster.id, {
      visible: wantVisible,
      opacity: raster.opacity,
    });
  }
}

function teardownCogSwipe(): void {
  cogMirror?.destroy();
  cogMirror = null;
  cogPendingSides.clear();
  cogPendingComparisonMap = undefined;
  cogReconcileScheduled = false;
  // Restore any raster this provider hid on the main map.
  for (const [id, forced] of cogMainForced) {
    if (!forced.visible) setCogRasterMainVisibility(id, true, forced.opacity);
  }
  cogMainForced.clear();
}

export const maplibreSwipePlugin: GeoLibrePlugin = {
  id: SWIPE_PLUGIN_ID,
  name: "Layer Swipe",
  version: "0.9.1",
  activate: (app: GeoLibreAppAPI) => {
    swipeControl = new SwipeControl(getSwipeControlOptions(app, savedSwipeState ?? undefined));

    const added = app.addMapControl(swipeControl, swipeControlPosition);
    if (!added) {
      swipeControl = null;
      return false;
    }
    expandSwipeControl(savedSwipeState ?? undefined);

    // Keep the swipe panel's COG raster rows and comparison-map mirror in sync
    // as rasters are added, removed, or restyled while the swipe is active.
    unsubscribeCogRasterChanges = subscribeSwipeCogChanges(() => {
      swipeControl?.refreshLayers();
    });

    // The control reads the basemap style only on construction, so recreate it
    // when the active basemap changes to keep its basemap-layer grouping in
    // sync. The previous slider state is carried over to avoid a visible reset.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!swipeControl) return;
      const previousState = swipeControl.getState();
      savedSwipeState = previousState;
      app.removeMapControl(swipeControl);
      swipeControl = new SwipeControl(getSwipeControlOptions(app, previousState));
      app.addMapControl(swipeControl, swipeControlPosition);
      expandSwipeControl(previousState);
    });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    unsubscribeCogRasterChanges?.();
    unsubscribeCogRasterChanges = null;
    // Restore any main-map raster this provider hid; removeMapControl's
    // detachComparison also tears the mirror down, but that only runs when a
    // comparison map exists.
    teardownCogSwipe();
    if (!swipeControl) return;
    savedSwipeState = swipeControl.getState();
    app.removeMapControl(swipeControl);
    swipeControl = null;
  },
  getMapControlPosition: () => swipeControlPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
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
    swipeControl = new SwipeControl(getSwipeControlOptions(app, savedSwipeState ?? undefined));
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
    // Hide plugin chrome layers (drawing/measure helpers, selection footprints,
    // highlight outlines, Vantor footprints) so they don't clutter the swipe
    // layer list. Shared with the Components control grid via
    // INTERNAL_HELPER_LAYER_PATTERNS so the excluded set stays consistent. These
    // globs are re-applied on every live refresh, so layers added after the
    // control mounts (e.g. Vantor footprints on search) are excluded too.
    excludeLayers: [...INTERNAL_HELPER_LAYER_PATTERNS],
    // List only currently visible layers (plus any already selected), kept in sync live (#843).
    visibleLayersOnly: true,
    // Surface deck.gl COG rasters (invisible to getStyle()) in the panel and
    // render them per side: right/both on the comparison map, right-only hidden
    // on the main map. See #1240 and swipe-cog-mirror.ts.
    layerProvider: cogSwipeProvider,
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
    orientation: candidate.orientation === "horizontal" ? "horizontal" : "vertical",
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
