import {
  applyGroupEffects,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { MapCanvas, type MapDiagnosticEvent } from "./MapCanvas";
import { createMapEngineHandleWithFactory } from "./engine/handle";
import { createMapEngineClientForController } from "./engine/maplibre-engine";
import { loadRegisteredMapEngine } from "./engine/registry";
import type { MapEngine, MapEngineClient, MapEngineId, Unsubscribe } from "./engine/types";
import type { MapController } from "./map-controller";

export interface EngineCanvasProps {
  readonly engineId: MapEngineId;
  /** Primary keeps the existing identify/photo behavior until those ports migrate. */
  readonly primary?: boolean;
  /** Required for secondary panes; omitted for the primary store camera. */
  readonly viewId?: string;
  readonly ionToken?: string;
  readonly engineRef?: React.MutableRefObject<MapEngineClient | null>;
  readonly onEngineReady?: () => void;
  readonly onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
}

interface LegacyPrimaryProps {
  readonly engineRef?: React.MutableRefObject<MapEngineClient | null>;
  readonly onEngineReady?: () => void;
  readonly onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
}

const LegacyPrimaryEngineCanvas = memo(function LegacyPrimaryEngineCanvas({
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
}: LegacyPrimaryProps) {
  const controllerRef = useRef<MapController | null>(null);
  const clientRef = useRef<MapEngineClient | null>(null);
  const onEngineReadyRef = useRef(onEngineReady);
  onEngineReadyRef.current = onEngineReady;

  const publishEngine = (): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    clientRef.current ??= createMapEngineClientForController(controller);
    if (engineRef) engineRef.current = clientRef.current;
    onEngineReadyRef.current?.();
  };

  useEffect(
    () => () => {
      if (engineRef) engineRef.current = null;
      clientRef.current = null;
    },
    [engineRef],
  );

  return (
    <MapCanvas
      controllerRef={controllerRef}
      onMapDiagnosticEvent={onMapDiagnosticEvent}
      onControllerReady={publishEngine}
    />
  );
});

interface StoreEngineCanvasProps extends EngineCanvasProps {
  readonly primary: boolean;
}

const StoreEngineCanvas = memo(function StoreEngineCanvas({
  engineId,
  primary,
  viewId,
  ionToken,
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
}: StoreEngineCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedEngineRef = useRef<MapEngine | null>(null);
  const currentViewIdRef = useRef(viewId);
  currentViewIdRef.current = viewId;
  const [ready, setReady] = useState(false);

  const syncView = useAppStore((state) => state.mapLayout.syncView);
  const globalView = useAppStore((state) => state.mapView);
  const pane = useAppStore((state) =>
    viewId ? state.secondaryMapViews.find((entry) => entry.id === viewId) : undefined,
  );
  const layers = useAppStore((state) => state.layers);
  const layerGroups = useAppStore((state) => state.layerGroups);
  const mapPreferences = useAppStore((state) => state.preferences.map);
  const basemapStyleUrl = useAppStore((state) => state.basemapStyleUrl);
  const basemapVisible = useAppStore((state) => state.basemapVisible);
  const basemapOpacity = useAppStore((state) => state.basemapOpacity);
  const setPointerCoords = useAppStore((state) => state.setPointerCoords);

  const paneLayers = useMemo<GeoLibreLayer[]>(() => {
    const visibility = pane?.layerVisibility;
    const withOverrides = !visibility
      ? layers
      : layers.map((layer) => {
          const override = visibility[layer.id];
          return override === undefined || override === layer.visible
            ? layer
            : { ...layer, visible: override };
        });
    return applyGroupEffects(withOverrides, layerGroups);
  }, [layerGroups, layers, pane?.layerVisibility]);
  const paneLayersRef = useRef(paneLayers);
  paneLayersRef.current = paneLayers;
  const onEngineReadyRef = useRef(onEngineReady);
  onEngineReadyRef.current = onEngineReady;
  const onDiagnosticRef = useRef(onMapDiagnosticEvent);
  onDiagnosticRef.current = onMapDiagnosticEvent;
  const ionTokenRef = useRef(ionToken);
  ionTokenRef.current = ionToken;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mountedEngineRef.current) return;
    const engine = createMapEngineHandleWithFactory(engineId, async () => {
      if (engineId === "cesium") {
        const { createCesiumEngine } = await import("./engine/cesium-engine");
        return createCesiumEngine({ ionToken: ionTokenRef.current });
      }
      return loadRegisteredMapEngine(engineId);
    });
    mountedEngineRef.current = engine;
    if (engineRef) engineRef.current = engine;

    const unsubscribes: Unsubscribe[] = [
      engine.on("load", () => {
        setReady(true);
        onEngineReadyRef.current?.();
      }),
      engine.on("error", (event) => onDiagnosticRef.current?.(event)),
      engine.on("moveend", ({ view, userDriven }) => {
        const state = useAppStore.getState();
        if (primary) {
          if (!state.ui.storymapPresenting) state.setMapView(view, userDriven);
          return;
        }
        const liveViewId = currentViewIdRef.current;
        if (!liveViewId) return;
        if (state.mapLayout.syncView) state.setMapView(view, userDriven);
        state.setSecondaryMapView(liveViewId, view, userDriven);
      }),
    ];
    if (primary) {
      unsubscribes.push(
        engine.on("pointermove", ({ lngLat }) => setPointerCoords(lngLat)),
        engine.on("pointerleave", () => setPointerCoords(null)),
      );
    }

    const state = useAppStore.getState();
    const livePane = viewId
      ? state.secondaryMapViews.find((entry) => entry.id === viewId)
      : undefined;
    const initialView: MapViewState =
      !primary && !state.mapLayout.syncView && livePane ? livePane.view : state.mapView;
    engine.configure({
      preferences: state.preferences.map,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
    });
    if (!primary && engineId === "maplibre") {
      engine.controls.setBuiltInState("layer-control", { visible: false });
    }
    engine.syncLayers(paneLayersRef.current);
    void engine.mount(container, initialView).catch((error: unknown) => {
      onDiagnosticRef.current?.({
        message: error instanceof Error ? error.message : String(error),
      });
    });

    let resizeFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        engine.invoke("viewport.resize", undefined);
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      for (const unsubscribe of unsubscribes) unsubscribe();
      engine.destroy();
      if (engineRef) engineRef.current = null;
      mountedEngineRef.current = null;
    };
  }, [engineId, engineRef, primary, setPointerCoords, viewId]);

  useEffect(() => {
    mountedEngineRef.current?.configure({
      preferences: mapPreferences,
      basemapStyleUrl,
      basemapVisible,
      basemapOpacity,
    });
  }, [basemapOpacity, basemapStyleUrl, basemapVisible, mapPreferences]);

  useEffect(() => {
    mountedEngineRef.current?.syncLayers(paneLayers);
  }, [paneLayers]);

  useEffect(() => {
    if (!ready) return;
    if (primary || syncView) mountedEngineRef.current?.applyView(globalView);
  }, [globalView, primary, ready, syncView]);

  useEffect(() => {
    if (!ready || primary || syncView || !pane?.view) return;
    mountedEngineRef.current?.applyView(pane.view);
  }, [pane?.view, primary, ready, syncView]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-testid={
        engineId === "cesium"
          ? "cesium-canvas"
          : engineId === "arcgis-scene"
            ? "arcgis-scene-canvas"
            : primary
              ? "map-canvas"
              : "secondary-map-canvas"
      }
      data-engine-id={engineId}
      data-engine-ready={ready ? "true" : "false"}
      data-view-id={viewId}
    />
  );
});

export const EngineCanvas = memo(function EngineCanvas(props: EngineCanvasProps) {
  const primary = props.primary ?? false;
  if (primary && props.engineId === "maplibre") {
    return (
      <LegacyPrimaryEngineCanvas
        engineRef={props.engineRef}
        onEngineReady={props.onEngineReady}
        onMapDiagnosticEvent={props.onMapDiagnosticEvent}
      />
    );
  }
  return <StoreEngineCanvas {...props} primary={primary} />;
});
