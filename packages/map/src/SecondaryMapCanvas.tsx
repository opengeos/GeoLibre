import {
  applyGroupEffects,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import { memo, useEffect, useMemo, useRef } from "react";
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";

export interface SecondaryMapCanvasProps {
  /** Id of the `secondaryMapViews` entry this pane renders. */
  viewId: string;
}

/**
 * A non-primary map pane in the multi-map grid. It renders the *shared* store
 * layers on the *shared* (global) basemap, deliberately omitting the heavy
 * single-map wiring (identify, highlight, draw, deck.gl, the layer control) that
 * lives on the primary {@link MapCanvas}. The layer control is suppressed so the
 * pane never writes the shared layer/basemap state back to the global store.
 *
 * Each pane may override which layers are visible: a layer's effective
 * visibility here is `secondaryMapViews[i].layerVisibility[layerId]` when set,
 * otherwise the primary map's `layer.visible`. This lets different panes show
 * different layers over the same data.
 *
 * Camera synchronization is intentionally routed through the global `mapView`:
 * when `mapLayout.syncView` is on, this pane mirrors the global camera (which the
 * primary map already reads and writes), so panning any pane moves them all.
 * When sync is off, the pane uses its own saved camera (`secondaryMapViews[i]`).
 */
export const SecondaryMapCanvas = memo(function SecondaryMapCanvas({
  viewId,
}: SecondaryMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  // Read the current viewId through a ref so the setup effect can stay
  // dependency-free (recreating the map on every render would lose its camera).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  const entry = useAppStore((s) => s.secondaryMapViews.find((pane) => pane.id === viewId));
  const syncView = useAppStore((s) => s.mapLayout.syncView);
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);

  // The basemap is shared with the primary map (the global store fields).
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);

  // Camera primitives, split out so the apply effects depend on values rather
  // than object identity (a new `mapView` object with equal values is a no-op).
  const globalView = useAppStore((s) => s.mapView);
  const entryView = entry?.view;
  const layerVisibility = entry?.layerVisibility;

  // The shared layers with this pane's per-layer visibility overrides applied.
  const paneLayers = useMemo<GeoLibreLayer[]>(() => {
    if (!layerVisibility) return layers;
    return layers.map((layer) => {
      const override = layerVisibility[layer.id];
      return override === undefined || override === layer.visible
        ? layer
        : { ...layer, visible: override };
    });
  }, [layers, layerVisibility]);

  // Create the map exactly once. The deps are intentionally empty; everything
  // it reads is captured from the latest store state at mount time.
  useEffect(() => {
    if (!containerRef.current || controller.current) return;
    const state = useAppStore.getState();
    const pane = state.secondaryMapViews.find((p) => p.id === viewIdRef.current);
    const initialView: MapViewState | undefined = state.mapLayout.syncView
      ? state.mapView
      : pane?.view;

    const mc = createMapController();
    const map = mc.init(containerRef.current, {
      styleUrl: state.basemapStyleUrl,
      mapView: initialView,
      mapPreferences: state.preferences.map,
      // No layer control: the shared layers/basemap are owned by the primary
      // map and the global store, so a second control here would fight them.
      controlVisibility: { "layer-control": false },
    });
    controller.current = mc;

    const sameCamera = (a: MapViewState, b: MapViewState) =>
      a.center[0] === b.center[0] &&
      a.center[1] === b.center[1] &&
      a.zoom === b.zoom &&
      a.bearing === b.bearing &&
      a.pitch === b.pitch;

    const updateView = (event?: { originalEvent?: unknown }) => {
      const view = mc.readView();
      const userDriven = Boolean(event?.originalEvent);
      const live = useAppStore.getState();
      // A programmatic `applyView` (camera sync / initial load) fires "moveend"
      // with the same camera it was just given. Skip the global write when the
      // value is unchanged so a synced pane's echo doesn't cascade back through
      // every sibling pane's sync effect.
      if (live.mapLayout.syncView && !sameCamera(view, live.mapView)) {
        // The shared camera lives in the global mapView; mirror this pane's move
        // there so the primary and sibling panes follow.
        live.setMapView(view, userDriven);
      }
      // Always keep this pane's own saved camera current so turning sync off (or
      // saving the project) preserves where the pane is looking. The store skips
      // value-identical writes, so a programmatic echo here is a no-op.
      live.setSecondaryMapView(viewIdRef.current, view, userDriven);
    };
    map.on("moveend", updateView);

    // Only the basemap visibility/opacity needs to wait for the style here; the
    // layer-sync effect below already defers its own work to the style load, so
    // syncing layers here too would just duplicate that pass.
    map.on("load", () => {
      const live = useAppStore.getState();
      mc.setBasemapVisible(live.basemapVisible);
      mc.setBasemapOpacity(live.basemapOpacity);
    });

    let resizeFrame: number | null = null;
    const resizeMap = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        mc.getMap()?.resize();
      });
    };
    const resizeObserver = new ResizeObserver(resizeMap);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      mc.destroy();
      controller.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile the shared layers (with this pane's overrides) whenever they or
  // the overrides change.
  useEffect(() => {
    controller.current?.waitAndSyncLayers(applyGroupEffects(paneLayers, layerGroups));
  }, [paneLayers, layerGroups]);

  // Basemap is shared with the primary map; follow the global store fields.
  const prevBasemap = useRef(basemapStyleUrl);
  useEffect(() => {
    if (prevBasemap.current !== basemapStyleUrl) {
      prevBasemap.current = basemapStyleUrl;
      controller.current?.setStyle(basemapStyleUrl);
    }
  }, [basemapStyleUrl]);
  useEffect(() => {
    controller.current?.setBasemapVisible(basemapVisible);
  }, [basemapVisible]);
  useEffect(() => {
    controller.current?.setBasemapOpacity(basemapOpacity);
  }, [basemapOpacity]);

  // Map preferences (projection, zoom/pitch limits, bounds) are shared with the
  // primary map; re-apply them when they change so a pane doesn't keep the
  // values captured at mount.
  useEffect(() => {
    controller.current?.applyMapPreferences(mapPreferences);
  }, [mapPreferences]);

  // Synced: follow the global (shared) camera. Depend on primitives so an
  // equal-valued mapView object does not re-apply.
  useEffect(() => {
    if (!syncView) return;
    controller.current?.applyView(globalView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    syncView,
    globalView.center[0],
    globalView.center[1],
    globalView.zoom,
    globalView.bearing,
    globalView.pitch,
  ]);

  // Not synced: follow this pane's own saved camera (e.g. external edits).
  useEffect(() => {
    if (syncView || !entryView) return;
    controller.current?.applyView(entryView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    syncView,
    entryView?.center[0],
    entryView?.center[1],
    entryView?.zoom,
    entryView?.bearing,
    entryView?.pitch,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-testid="secondary-map-canvas"
      data-view-id={viewId}
    />
  );
});
