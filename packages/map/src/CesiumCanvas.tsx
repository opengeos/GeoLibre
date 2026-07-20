import {
  applyGroupEffects,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArcGISSceneEngine } from "./engine/arcgis-scene-engine";
import type { MapEngine } from "./engine/types";

export interface CesiumCanvasProps {
  /** Id of the `secondaryMapViews` entry this pane renders. */
  viewId: string;
  ionToken?: string;
}

export const CesiumCanvas = memo(function CesiumCanvas({ viewId }: CesiumCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  const syncView = useAppStore((s) => s.mapLayout.syncView);
  const globalView = useAppStore((s) => s.mapView);
  const entryView = useAppStore((s) => s.secondaryMapViews.find((p) => p.id === viewId)?.view);

  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const layerVisibility = useAppStore(
    (s) => s.secondaryMapViews.find((p) => p.id === viewId)?.layerVisibility,
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
  }, [layers, layerVisibility, layerGroups]);

  useEffect(() => {
    if (!containerRef.current || engineRef.current) return;
    const engine = new ArcGISSceneEngine(viewIdRef.current);
    engineRef.current = engine;
    let destroyed = false;

    void (async () => {
      try {
        const state = useAppStore.getState();
        const pane = state.secondaryMapViews.find((p) => p.id === viewIdRef.current);
        const initialView = state.mapLayout.syncView ? state.mapView : (pane?.view ?? state.mapView);

        await engine.mount(containerRef.current!, initialView);
        if (destroyed) {
          engine.destroy();
          return;
        }

        engine.on("moveend", () => {
          const view = engine.readView();
          const live = useAppStore.getState();
          const sameCamera = (a: MapViewState, b: MapViewState) =>
            Math.abs(a.center[0] - b.center[0]) < 1e-5 &&
            Math.abs(a.center[1] - b.center[1]) < 1e-5 &&
            Math.abs(a.zoom - b.zoom) < 0.02 &&
            Math.abs(a.bearing - b.bearing) < 0.1 &&
            Math.abs(a.pitch - b.pitch) < 0.1;

          if (live.mapLayout.syncView && !sameCamera(view, live.mapView)) {
            live.setMapView(view, true);
          }
          const paneView = live.secondaryMapViews.find((p) => p.id === viewIdRef.current)?.view;
          if (!paneView || !sameCamera(view, paneView)) {
            live.setSecondaryMapView(viewIdRef.current, view, true);
          }
        });

        engine.syncLayers(paneLayers);

        if (!destroyed) setReady(true);
      } catch (err) {
        if (!destroyed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      destroyed = true;
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || !engineRef.current) return;
    engineRef.current.syncLayers(paneLayers);
  }, [ready, paneLayers]);

  useEffect(() => {
    if (!ready || !engineRef.current || !syncView) return;
    engineRef.current.applyView(globalView);
  }, [
    ready,
    syncView,
    globalView.center[0],
    globalView.center[1],
    globalView.zoom,
    globalView.bearing,
    globalView.pitch,
  ]);

  useEffect(() => {
    if (!ready || !engineRef.current || syncView || !entryView) return;
    engineRef.current.applyView(entryView);
  }, [
    ready,
    syncView,
    entryView?.center[0],
    entryView?.center[1],
    entryView?.zoom,
    entryView?.bearing,
    entryView?.pitch,
  ]);

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
