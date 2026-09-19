import { useEffect, useRef, useState, type RefObject } from "react";
import {
  applyGroupEffects,
  createPointerElevationResolver,
  DEFAULT_BASEMAP,
  getActiveEllipsoid,
  redactUrlCredentials,
  useAppStore,
  type PointerElevationResolver,
} from "@geolibre/core";
import type { MapEventOf, StyleSpecification, Popup } from "mapbox-gl";
import type { MapEngine } from "./map-engine";
import type { MapDiagnosticEvent } from "./map-diagnostic";
import { MapboxEngine, redactMapboxError } from "./mapbox-engine";
import { prepareMapboxStandard } from "./mapbox-standard-style";
import { styleUsesUnsupportedSource } from "./mapbox-layers";
import { resolveMapStyle } from "./map-controller";
import { isGlobeControlToggleClick } from "./globe-control-toggle";
import {
  attachFeatureSelection,
  type FeatureSelectionMap,
  type FeatureSelectionState,
} from "./map-feature-selection";
import { createMapResizeScheduler } from "./map-resize";
import { refreshMapboxPointerElevationAfterStyleLoad } from "./mapbox-pointer-elevation";

export interface MapboxCanvasProps {
  accessToken: string;
  viewId?: string;
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  canUseRemoteElevation?: () => boolean;
}

/** The namespace and its CSS load only when a Mapbox pane is mounted. */
export function MapboxCanvas({
  accessToken,
  viewId,
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
  canUseRemoteElevation,
}: MapboxCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const readyCallback = useRef(onEngineReady);
  readyCallback.current = onEngineReady;
  const diagnosticCallback = useRef(onMapDiagnosticEvent);
  diagnosticCallback.current = onMapDiagnosticEvent;
  const canUseRemoteElevationRef = useRef(canUseRemoteElevation);
  canUseRemoteElevationRef.current = canUseRemoteElevation;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let engine: MapboxEngine | undefined;
    const cleanupTasks: Array<() => void> = [];
    const cleanup = () => {
      for (const dispose of cleanupTasks.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          // The native map may already have removed a listener/control.
        }
      }
    };
    setError(null);
    void Promise.all([import("mapbox-gl"), import("mapbox-gl/dist/mapbox-gl.css")])
      .then(async ([module]) => {
        if (cancelled || !container.current) return;
        const gl = module.default;
        const state = useAppStore.getState();
        const pane = state.secondaryMapViews.find((p) => p.id === viewId);
        const view =
          viewId && !state.mapLayout.syncView ? (pane?.view ?? state.mapView) : state.mapView;
        const resolvedStyle = (url: string): string | StyleSpecification => {
          const style = resolveMapStyle(url);
          if (typeof style === "string") return style;
          // The offline PMTiles basemap resolves to a style whose source uses
          // the `pmtiles://` protocol, registered with maplibre-gl only. Mapbox
          // has no handler for it, so fall back rather than load a blank map.
          if (styleUsesUnsupportedSource(style)) {
            console.warn(
              `Basemap "${redactUrlCredentials(
                url,
              )}" uses a MapLibre-only source protocol; the Mapbox renderer falls back to the default basemap.`,
            );
            return DEFAULT_BASEMAP;
          }
          const { projection, ...rest } = style;
          return {
            ...rest,
            ...(projection ? { projection: { name: projection.type } } : {}),
          } as StyleSpecification;
        };
        const initialStyle = await prepareMapboxStandard(
          resolvedStyle(state.preferences.map.mapboxStyleUrl ?? state.basemapStyleUrl),
          accessToken,
        );
        if (cancelled || !container.current) return;
        const map = new gl.Map({
          container: container.current,
          accessToken,
          ...view,
          style: initialStyle,
          projection: state.preferences.map.projection,
          attributionControl: false,
          preserveDrawingBuffer: true,
          trackResize: false,
        });
        engine = new MapboxEngine(map, gl, accessToken, {
          // Split/grid panes share the primary pane's layer control; a second
          // one would write the same store state back from another map.
          controlVisibility: viewId ? { "layer-control": false } : undefined,
          // They share the swipe panel's layer-name bridge too, which is a
          // window global with room for one publisher.
          ownsLayerLabels: !viewId,
          onDiagnostic: (event) => diagnosticCallback.current?.(event),
        });
        const current = engine;
        const featureSelection: FeatureSelectionState = {
          active: { current: false },
          cancel: { current: null },
        };
        const detachFeatureSelection = viewId
          ? () => {}
          : attachFeatureSelection(map as unknown as FeatureSelectionMap, {
              state: featureSelection,
              featureIdAtPoint: (layer, point) => current.featureIdAtPoint(layer.id, point),
              onDiagnostic: (event) => diagnosticCallback.current?.(event),
            });
        // Arm the global-listener cleanup before any engine/store setup that
        // can throw, so a rejected initialization cannot leak the selection
        // request listener until this effect happens to run again.
        cleanupTasks.push(detachFeatureSelection);
        let applying = false;
        let popup: Popup | undefined;
        let pointerElevation: PointerElevationResolver | undefined;
        let previousSelectedFeatureKey: string | null = null;
        const update = (next: typeof state, previous?: typeof state) => {
          if (cancelled) return;
          const targetPane = next.secondaryMapViews.find((p) => p.id === viewId);
          const previousPane = previous?.secondaryMapViews.find((p) => p.id === viewId);
          applying = true;
          try {
            if (
              !previous ||
              (next.preferences.map.mapboxStyleUrl ?? next.basemapStyleUrl) !==
                (previous.preferences.map.mapboxStyleUrl ?? previous.basemapStyleUrl)
            ) {
              if (previous)
                current.setResolvedStyle(
                  resolvedStyle(next.preferences.map.mapboxStyleUrl ?? next.basemapStyleUrl),
                );
            }
            if (!previous || next.preferences.map !== previous.preferences.map)
              current.applyMapPreferences(next.preferences.map);
            if (!previous || next.basemapVisible !== previous.basemapVisible)
              current.setBasemapVisible(next.basemapVisible);
            if (!previous || next.basemapOpacity !== previous.basemapOpacity)
              current.setBasemapOpacity(next.basemapOpacity);
            if (!previous || next.blankBackgroundColor !== previous.blankBackgroundColor)
              current.setBlankBackgroundColor(next.blankBackgroundColor);
            if (
              !previous ||
              next.layers !== previous.layers ||
              next.layerGroups !== previous.layerGroups ||
              targetPane?.layerVisibility !== previousPane?.layerVisibility
            ) {
              const layers = targetPane
                ? next.layers.map((layer) => ({
                    ...layer,
                    visible: targetPane.layerVisibility[layer.id] ?? layer.visible,
                  }))
                : next.layers;
              current.syncLayers(applyGroupEffects(layers, next.layerGroups));
            }
            if (
              !previous ||
              next.mapView !== previous.mapView ||
              targetPane?.view !== previousPane?.view ||
              next.mapLayout.syncView !== previous.mapLayout.syncView
            ) {
              current.applyView(
                viewId && !next.mapLayout.syncView
                  ? (targetPane?.view ?? next.mapView)
                  : next.mapView,
              );
            }
            if (
              !viewId &&
              (!previous ||
                next.layers !== previous.layers ||
                next.selectedFeatureId !== previous.selectedFeatureId ||
                next.selectedFeatureIds !== previous.selectedFeatureIds ||
                next.selectedLayerId !== previous.selectedLayerId ||
                next.ui.zoomToSelectedFeature !== previous.ui.zoomToSelectedFeature)
            ) {
              const ids =
                next.selectedFeatureIds.length > 0
                  ? next.selectedFeatureIds
                  : next.selectedFeatureId
                    ? [next.selectedFeatureId]
                    : [];
              const nextKey =
                next.selectedLayerId && ids.length > 0
                  ? `${next.selectedLayerId}:${ids.join("\u0000")}`
                  : null;
              const fit = Boolean(
                next.ui.zoomToSelectedFeature && nextKey && nextKey !== previousSelectedFeatureKey,
              );
              previousSelectedFeatureKey = nextKey;
              current.highlightFeature(
                next.layers.find((l) => l.id === next.selectedLayerId),
                ids.length > 0 ? ids : null,
                { fit },
              );
            }
            if (!viewId && (!previous || next.identifyLayerId !== previous.identifyLayerId)) {
              popup?.remove();
              if (next.identifyLayerId) featureSelection.cancel.current?.();
              if (!featureSelection.active.current)
                map.getCanvas().style.cursor = next.identifyLayerId ? "crosshair" : "";
            }
            if (
              !viewId &&
              previous &&
              next.preferences.map.showPointerElevation !==
                previous.preferences.map.showPointerElevation
            ) {
              if (!next.preferences.map.showPointerElevation) {
                pointerElevation?.invalidate();
                next.setPointerElevation(null);
              } else if (next.pointerCoords) {
                pointerElevation?.update(next.pointerCoords);
              }
            }
            if (!viewId && previous && next.projectGeneration !== previous.projectGeneration) {
              pointerElevation?.invalidate();
              next.setPointerElevation(null);
            }
          } finally {
            applying = false;
          }
        };
        const unsubscribe = useAppStore.subscribe(update);
        cleanupTasks.push(unsubscribe);
        if (!viewId) {
          pointerElevation = createPointerElevationResolver({
            getMap: () => ({
              getTerrain: () => {
                const terrain = map.getTerrain();
                if (!terrain) return terrain;
                return {
                  exaggeration: typeof terrain.exaggeration === "number" ? terrain.exaggeration : 1,
                };
              },
              queryTerrainElevation: (point) => map.queryTerrainElevation(point) ?? null,
            }),
            isEarth: () => getActiveEllipsoid().id === "earth",
            isEnabled: () => useAppStore.getState().preferences.map.showPointerElevation,
            canUseRemote: () => canUseRemoteElevationRef.current?.() ?? false,
            emit: (elevation) => useAppStore.getState().setPointerElevation(elevation),
          });
          cleanupTasks.push(() => pointerElevation?.dispose());
          const point = useAppStore.getState().pointerCoords;
          if (point) pointerElevation.update(point);
        }
        update(state);
        update(useAppStore.getState(), state);
        const handleStyleLoad = () => {
          if (viewId || cancelled) return;
          const next = useAppStore.getState();
          refreshMapboxPointerElevationAfterStyleLoad(pointerElevation, next.pointerCoords);
          const ids =
            next.selectedFeatureIds.length > 0
              ? next.selectedFeatureIds
              : next.selectedFeatureId
                ? [next.selectedFeatureId]
                : [];
          current.highlightFeature(
            next.layers.find((layer) => layer.id === next.selectedLayerId),
            ids.length > 0 ? ids : null,
          );
        };
        map.on("style.load", handleStyleLoad);
        cleanupTasks.push(() => map.off("style.load", handleStyleLoad));
        const handleMoveEnd = (
          event: MapEventOf<"moveend"> & {
            flightCameraToken?: number;
            storyCameraToken?: number;
            originalEvent?: unknown;
          },
        ) => {
          if (applying || cancelled) return;
          // The flight simulator owns the camera while it flies and places it
          // every animation frame, tagging each write. Syncing those into the
          // store would overwrite the project's saved view ~60 times a second
          // (MapCanvas skips them the same way).
          if (event?.flightCameraToken !== undefined) return;
          if (event?.storyCameraToken !== undefined || useAppStore.getState().ui.storymapPresenting)
            return;
          const next = useAppStore.getState(),
            camera = current.readView();
          // Shared view first (as SecondaryMapCanvas does): each setter notifies
          // subscribers separately, and a synchronized pane reading the changed
          // pane against a stale `mapView` would jump to the old camera first.
          if (!viewId || next.mapLayout.syncView)
            next.setMapView(camera, Boolean(event?.originalEvent));
          if (viewId) next.setSecondaryMapView(viewId, camera, Boolean(event?.originalEvent));
          if (!viewId) next.setCameraAltitude(current.readCameraAltitude());
        };
        map.on("moveend", handleMoveEnd);
        cleanupTasks.push(() => map.off("moveend", handleMoveEnd));
        // Persist clicks on the engine's globe toggle into project preferences,
        // as MapCanvas does for MapLibre's GlobeControl, so a project reopens in
        // the projection it was saved in. The control's own handler runs on the
        // button before this container listener and `setProjection` is
        // synchronous, so `readProjection()` already reflects the toggle. A
        // split pane's toggle stays local to that pane, as on MapLibre.
        const handleGlobeToggleClick = (event: MouseEvent) => {
          if (viewId || cancelled || !isGlobeControlToggleClick(event.target)) return;
          const projection = current.readProjection();
          // Functional update so a concurrent preference change between read
          // and write is not clobbered by a stale snapshot.
          useAppStore.setState((s) => {
            if (s.preferences.map.projection === projection) return s;
            return {
              preferences: {
                ...s.preferences,
                map: { ...s.preferences.map, projection },
              },
              isDirty: true,
            };
          });
        };
        map.getContainer().addEventListener("click", handleGlobeToggleClick);
        cleanupTasks.push(() =>
          map.getContainer().removeEventListener("click", handleGlobeToggleClick),
        );
        const handleMouseMove = (e: MapEventOf<"mousemove">) => {
          if (!viewId) {
            const point = e.lngLat.toArray() as [number, number];
            useAppStore.getState().setPointerCoords(point);
            pointerElevation?.update(point);
          }
        };
        const handleMouseOut = () => {
          if (!viewId) {
            pointerElevation?.invalidate();
            useAppStore.getState().setPointerCoords(null);
          }
        };
        const handleClick = (e: MapEventOf<"click">) => {
          if (viewId || featureSelection.active.current) return;
          const next = useAppStore.getState();
          if (!next.identifyLayerId) return;
          const match = current.identifyFeatures(
            e.lngLat.toArray(),
            next.layers.some((l) => l.id === next.identifyLayerId)
              ? next.identifyLayerId
              : undefined,
          )[0];
          popup?.remove();
          if (!match) {
            next.selectFeature(null);
            return;
          }
          next.selectLayer(match.layerId);
          next.selectFeature(match.featureId);
          const content = document.createElement("div");
          const title = document.createElement("strong");
          title.textContent = next.layers.find((l) => l.id === match.layerId)?.name ?? "";
          content.append(title);
          for (const [key, value] of Object.entries(match.properties)) {
            const row = document.createElement("div");
            row.textContent = `${key}: ${
              typeof value === "object" ? JSON.stringify(value) : String(value)
            }`;
            content.append(row);
          }
          popup = new gl.Popup({ maxWidth: "360px" })
            .setLngLat(e.lngLat)
            .setDOMContent(content)
            .addTo(map);
        };
        map.on("mousemove", handleMouseMove);
        map.on("mouseout", handleMouseOut);
        map.on("click", handleClick);
        cleanupTasks.push(() => {
          map.off("mousemove", handleMouseMove);
          map.off("mouseout", handleMouseOut);
          map.off("click", handleClick);
        });
        const handleLoad = () => {
          if (cancelled) return;
          if (engineRef) engineRef.current = current;
          if (!viewId) useAppStore.getState().setCameraAltitude(current.readCameraAltitude());
          readyCallback.current?.();
        };
        map.on("load", handleLoad);
        cleanupTasks.push(() => map.off("load", handleLoad));
        const disposeResizeScheduler = createMapResizeScheduler({
          getMap: () => map,
          container: container.current,
        });
        cleanupTasks.push(disposeResizeScheduler);
        const themeObserver = new MutationObserver(() => {
          current.setBlankBackgroundColor(useAppStore.getState().blankBackgroundColor);
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        });
        cleanupTasks.push(() => themeObserver.disconnect());
        cleanupTasks.push(() => {
          popup?.remove();
        });
      })
      .catch((error) => {
        cleanup();
        if (engineRef && engineRef.current === engine) engineRef.current = null;
        engine?.destroy();
        engine = undefined;
        if (!cancelled) {
          const message = redactMapboxError(String(error));
          setError(message);
          diagnosticCallback.current?.({ message, source: "Mapbox" });
        }
      });
    return () => {
      cancelled = true;
      cleanup();
      if (engineRef && engineRef.current === engine) engineRef.current = null;
      engine?.destroy();
    };
  }, [accessToken, viewId, engineRef]);
  return (
    <div className="relative h-full w-full" data-testid="mapbox-canvas">
      <div ref={container} className="h-full w-full" />
      {error && (
        <div
          role="alert"
          className="absolute bottom-10 end-2 z-10 max-h-32 max-w-[75%] overflow-auto rounded border border-input bg-background p-2 text-xs text-foreground shadow"
        >
          {error}
        </div>
      )}
    </div>
  );
}
