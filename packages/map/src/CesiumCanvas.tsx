import {
  applyGroupEffects,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isSameView } from "./cesium-camera";
import { CesiumEngine } from "./engine/cesium-engine";

export interface CesiumCanvasProps {
  /** Id of the `secondaryMapViews` entry this pane renders (label/telemetry). */
  viewId: string;
  /** Optional Cesium Ion token for world imagery and terrain. */
  ionToken?: string;
}

/**
 * Compatibility host retained until every pane mounts through `EngineCanvas`.
 * Viewer ownership and all Cesium APIs live inside `CesiumEngine`; this React
 * wrapper only mirrors the canonical store into the engine-neutral contract.
 */
export const CesiumCanvas = memo(function CesiumCanvas({
  viewId,
  ionToken,
}: CesiumCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CesiumEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncView = useAppStore((state) => state.mapLayout.syncView);
  const globalView = useAppStore((state) => state.mapView);
  const entryView = useAppStore(
    (state) => state.secondaryMapViews.find((pane) => pane.id === viewId)?.view,
  );
  const layers = useAppStore((state) => state.layers);
  const layerGroups = useAppStore((state) => state.layerGroups);
  const layerVisibility = useAppStore(
    (state) => state.secondaryMapViews.find((pane) => pane.id === viewId)?.layerVisibility,
  );
  const paneLayers = useMemo<GeoLibreLayer[]>(() => {
    const withOverrides = !layerVisibility
      ? layers
      : layers.map((layer) => {
          const override = layerVisibility[layer.id];
          return override === undefined || override === layer.visible
            ? layer
            : { ...layer, visible: override };
        });
    return applyGroupEffects(withOverrides, layerGroups);
  }, [layerGroups, layers, layerVisibility]);

  const paneLayersRef = useRef(paneLayers);
  paneLayersRef.current = paneLayers;
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;
  const ionTokenRef = useRef(ionToken);
  ionTokenRef.current = ionToken;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || engineRef.current) return;
    const engine = new CesiumEngine({ ionToken: ionTokenRef.current });
    engineRef.current = engine;

    const unsubscribeLoad = engine.on("load", ({ reason }) => {
      if (reason === "mount") setReady(true);
    });
    const unsubscribeError = engine.on("error", ({ message }) => setError(message));
    const unsubscribeMove = engine.on("moveend", ({ view, userDriven }) => {
      const live = useAppStore.getState();
      if (live.mapLayout.syncView && !isSameView(view, live.mapView)) {
        live.setMapView(view, userDriven);
      }
      const paneView = live.secondaryMapViews.find(
        (pane) => pane.id === viewIdRef.current,
      )?.view;
      if (!paneView || !isSameView(view, paneView)) {
        live.setSecondaryMapView(viewIdRef.current, view, userDriven);
      }
    });

    const state = useAppStore.getState();
    const pane = state.secondaryMapViews.find((entry) => entry.id === viewIdRef.current);
    const initialView = state.mapLayout.syncView
      ? state.mapView
      : (pane?.view ?? state.mapView);
    engine.syncLayers(paneLayersRef.current);
    void engine.mount(container, initialView).catch(() => undefined);

    return () => {
      unsubscribeLoad();
      unsubscribeError();
      unsubscribeMove();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    engineRef.current?.syncLayers(paneLayers);
  }, [paneLayers, ready]);

  useEffect(() => {
    if (!ready || !syncView) return;
    engineRef.current?.applyView(globalView);
  }, [globalView, ready, syncView]);

  useEffect(() => {
    if (!ready || syncView || !entryView) return;
    engineRef.current?.applyView(entryView);
  }, [entryView, ready, syncView]);

  return (
    <div className="relative h-full w-full" data-testid="cesium-canvas" data-view-id={viewId}>
      <div ref={containerRef} className="h-full w-full" />
      {error ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
});
