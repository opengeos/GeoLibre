import {
  applyGroupEffects,
  useAppStore,
  type MapViewState,
} from "@geolibre/core";
import { memo, useEffect, useRef } from "react";
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";

export interface SecondaryMapCanvasProps {
  /** Id of the `secondaryMapViews` entry this pane renders. */
  viewId: string;
  /**
   * Optional ref handed back the live controller, so the surrounding grid can
   * reach the map (e.g. to resize it when the layout changes).
   */
  controllerRef?: React.MutableRefObject<MapController | null>;
}

/**
 * A non-primary map pane in the multi-map grid. It renders the *shared* store
 * layers with its own basemap and camera, deliberately omitting the heavy
 * single-map wiring (identify, highlight, draw, deck.gl, the layer control) that
 * lives on the primary {@link MapCanvas}. The layer control is suppressed so the
 * pane never writes the shared layer/basemap state back to the global store.
 *
 * Camera synchronization is intentionally routed through the global `mapView`:
 * when `mapLayout.syncView` is on, this pane mirrors the global camera (which the
 * primary map already reads and writes), so panning any pane moves them all.
 * When sync is off, the pane uses its own saved camera (`secondaryMapViews[i]`).
 */
export const SecondaryMapCanvas = memo(function SecondaryMapCanvas({
  viewId,
  controllerRef,
}: SecondaryMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  // Read the current viewId through a ref so the setup effect can stay
  // dependency-free (recreating the map on every render would lose its camera).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  const entry = useAppStore((s) =>
    s.secondaryMapViews.find((pane) => pane.id === viewId),
  );
  const syncView = useAppStore((s) => s.mapLayout.syncView);
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);

  // Camera primitives, split out so the apply effects depend on values rather
  // than object identity (a new `mapView` object with equal values is a no-op).
  const globalView = useAppStore((s) => s.mapView);
  const entryView = entry?.view;
  const basemapStyleUrl = entry?.basemapStyleUrl;
  const basemapVisible = entry?.basemapVisible ?? true;
  const basemapOpacity = entry?.basemapOpacity ?? 1;

  // Create the map exactly once. The deps are intentionally empty; everything
  // it reads is captured from the latest store state at mount time.
  useEffect(() => {
    if (!containerRef.current || controller.current) return;
    const state = useAppStore.getState();
    const pane = state.secondaryMapViews.find(
      (p) => p.id === viewIdRef.current,
    );
    const initialView: MapViewState | undefined = state.mapLayout.syncView
      ? state.mapView
      : pane?.view;

    const mc = createMapController();
    const map = mc.init(containerRef.current, {
      styleUrl: pane?.basemapStyleUrl,
      mapView: initialView,
      mapPreferences: state.preferences.map,
      // No layer control: the shared layers/basemap are owned by the primary
      // map and the global store, so a second control here would fight them.
      controlVisibility: { "layer-control": false },
    });
    controller.current = mc;
    if (controllerRef) controllerRef.current = mc;

    const updateView = (event?: { originalEvent?: unknown }) => {
      const view = mc.readView();
      const userDriven = Boolean(event?.originalEvent);
      const live = useAppStore.getState();
      if (live.mapLayout.syncView) {
        // The shared camera lives in the global mapView; mirror this pane's move
        // there so the primary and sibling panes follow.
        live.setMapView(view, userDriven);
      }
      // Always keep this pane's own saved camera current so turning sync off (or
      // saving the project) preserves where the pane is looking.
      live.setSecondaryMapView(viewIdRef.current, view, userDriven);
    };
    map.on("moveend", updateView);

    map.on("load", () => {
      const live = useAppStore.getState();
      mc.waitAndSyncLayers(applyGroupEffects(live.layers, live.layerGroups));
      const current = live.secondaryMapViews.find(
        (p) => p.id === viewIdRef.current,
      );
      mc.setBasemapVisible(current?.basemapVisible ?? true);
      mc.setBasemapOpacity(current?.basemapOpacity ?? 1);
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
      if (controllerRef) controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile the shared layers onto this pane whenever they change.
  useEffect(() => {
    controller.current?.waitAndSyncLayers(
      applyGroupEffects(layers, layerGroups),
    );
  }, [layers, layerGroups]);

  // Per-pane basemap.
  const prevBasemap = useRef(basemapStyleUrl);
  useEffect(() => {
    if (basemapStyleUrl === undefined) return;
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
