import { useEffect, useRef, useState, type RefObject } from "react";
import {
  applyGroupEffects,
  createPointerElevationResolver,
  DEFAULT_BASEMAP,
  effectiveLayerRenderState,
  getActiveEllipsoid,
  IDENTIFY_ALL_LAYERS_ID,
  isPopupClickEnabled,
  redactUrlCredentials,
  resolveLayerCapabilities,
  resolvePopupMaxWidth,
  useAppStore,
  type PointerElevationResolver,
} from "@geolibre/core";
import type { MapEventOf, StyleSpecification } from "mapbox-gl";
import type { MapEngine } from "./map-engine";
import { applySelectionHighlight, resolveHighlightIds, selectionFitKey } from "./map-selection";
import {
  createIdentifyPopupState,
  consumePendingIdentifyRestore,
  removeIdentifyPopup as removeIdentifyPopupLifecycle,
  restoreIdentifySelection,
  type IdentifyPopupState,
  type PopupLike,
} from "./map-identify-lifecycle";
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
import { createIdentifyPopupElement, identifyPopupShellMaxWidth } from "./feature-popup";
import {
  createGlobalIdentifyPopupElement,
  DEFAULT_IDENTIFY_ALL_LABELS,
  type GlobalIdentifyHit,
  type MapCanvasIdentifyAllLabels,
} from "./identify-all-popup";

export interface MapboxCanvasProps {
  accessToken: string;
  viewId?: string;
  engineRef?: RefObject<MapEngine | null>;
  onEngineReady?: () => void;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  canUseRemoteElevation?: () => boolean;
  /** Translated headings for the grouped "Identify visible layers" popup. */
  identifyAllLabels?: MapCanvasIdentifyAllLabels;
}

/** The namespace and its CSS load only when a Mapbox pane is mounted. */
export function MapboxCanvas({
  accessToken,
  viewId,
  engineRef,
  onEngineReady,
  onMapDiagnosticEvent,
  canUseRemoteElevation,
  identifyAllLabels = DEFAULT_IDENTIFY_ALL_LABELS,
}: MapboxCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const readyCallback = useRef(onEngineReady);
  readyCallback.current = onEngineReady;
  const diagnosticCallback = useRef(onMapDiagnosticEvent);
  diagnosticCallback.current = onMapDiagnosticEvent;
  const canUseRemoteElevationRef = useRef(canUseRemoteElevation);
  canUseRemoteElevationRef.current = canUseRemoteElevation;
  const identifyAllLabelsRef = useRef(identifyAllLabels);
  identifyAllLabelsRef.current = identifyAllLabels;
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
        const setIdentifyCursor = (active: boolean) => {
          // Mapbox's grab cursor belongs to the interactive canvas container,
          // not the canvas itself. Use its supported crosshair mode so every
          // map surface agrees while Identify owns pointer clicks.
          map.getContainer().classList.toggle("mapboxgl-crosshair", active);
          map.getCanvas().style.cursor = active ? "crosshair" : "";
        };
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
              onEnd: () => {
                if (!cancelled) setIdentifyCursor(Boolean(useAppStore.getState().identifyLayerId));
              },
            });
        // Arm the global-listener cleanup before any engine/store setup that
        // can throw, so a rejected initialization cannot leak the selection
        // request listener until this effect happens to run again.
        cleanupTasks.push(detachFeatureSelection);
        let applying = false;
        let popup: PopupLike | undefined;
        let identifyPopupState: IdentifyPopupState | undefined;
        let pointerElevation: PointerElevationResolver | undefined;
        let previousSelectedFeatureKey: string | null = null;
        // The layer "Identify visible layers" selected, so an empty click only
        // retires a selection this mode made (as MapCanvas does).
        let globalIdentifyActivatedLayerId: string | null = null;
        const removeIdentifyPopup = (
          options: { restore?: boolean; forceRestore?: boolean } = {},
        ) => {
          const openPopup = popup;
          const popupState = identifyPopupState;
          popup = undefined;
          identifyPopupState = undefined;
          removeIdentifyPopupLifecycle(openPopup, popupState, options);
        };
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
              previousSelectedFeatureKey = applySelectionHighlight(
                current,
                next.layers,
                next.selectedLayerId,
                next.selectedFeatureId,
                next.selectedFeatureIds,
                next.ui.zoomToSelectedFeature,
                previousSelectedFeatureKey,
                // Read-once Identify restore marker; primary canvas only
                // (see map-identify-lifecycle.ts).
                consumePendingIdentifyRestore(selectionFitKey(next)),
              );
            }
            if (!viewId && previous && next.projectGeneration !== previous.projectGeneration) {
              // The new project owns its own selection. Drop the old popup and
              // its ownership record without restoring a layer from the project
              // that was just replaced.
              removeIdentifyPopup({ restore: false });
              globalIdentifyActivatedLayerId = null;
            } else if (!viewId && identifyPopupState && next.layers !== previous?.layers) {
              const identifiedLayer = next.layers.find(
                (layer) => layer.id === identifyPopupState?.identifiedLayerId,
              );
              if (!identifiedLayer || !isPopupClickEnabled(identifiedLayer.popup)) {
                // removeLayer chooses a fallback selected layer before
                // subscribers run. Force the earlier user selection back when
                // it still exists instead of leaving that arbitrary fallback.
                // Restoring also drops the popup's feature selection.
                removeIdentifyPopup({ forceRestore: !identifiedLayer });
              }
            }
            if (!viewId && (!previous || next.identifyLayerId !== previous.identifyLayerId)) {
              removeIdentifyPopup();
              // A layer "Identify visible layers" selected before the mode
              // changed is the user's from here on, as MapCanvas resets it.
              globalIdentifyActivatedLayerId = null;
              if (next.identifyLayerId) featureSelection.cancel.current?.();
              if (!featureSelection.active.current)
                setIdentifyCursor(Boolean(next.identifyLayerId));
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
          const ids = resolveHighlightIds(next);
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
        // "Identify visible layers": every eligible layer's hits at the point,
        // grouped by layer in one popup, as MapCanvas shows them on MapLibre.
        const showIdentifyAll = (lngLat: [number, number]) => {
          const next = useAppStore.getState();
          const groupById = new Map(next.layerGroups.map((group) => [group.id, group]));
          const eligible = new Map(
            next.layers
              .filter(
                (candidate) =>
                  effectiveLayerRenderState(candidate, groupById).visible &&
                  resolveLayerCapabilities(candidate).query &&
                  isPopupClickEnabled(candidate.popup),
              )
              .map((candidate) => [candidate.id, candidate]),
          );
          // The engine already collapses one feature drawn by several style
          // layers (fill and outline) into one hit per layer and feature.
          const hits: GlobalIdentifyHit[] = current.identifyFeatures(lngLat).flatMap((hit) => {
            const layer = eligible.get(hit.layerId);
            if (!layer) return [];
            return [
              {
                layer,
                properties: hit.properties,
                featureId: hit.featureId,
                ...(hit.geometry
                  ? {
                      feature: {
                        type: "Feature" as const,
                        properties: hit.properties,
                        geometry: hit.geometry,
                        ...(hit.featureId === null ? {} : { id: hit.featureId }),
                      },
                    }
                  : {}),
              },
            ];
          });
          const order = new Map(next.layers.map((candidate, index) => [candidate.id, index]));
          hits.sort((a, b) => (order.get(b.layer.id) ?? -1) - (order.get(a.layer.id) ?? -1));
          removeIdentifyPopup();
          if (hits.length === 0) {
            next.selectFeature(null);
            // A layer the user picked in the Layers panel is theirs to keep.
            if (
              globalIdentifyActivatedLayerId !== null &&
              useAppStore.getState().selectedLayerId === globalIdentifyActivatedLayerId
            )
              next.selectLayer(null);
            globalIdentifyActivatedLayerId = null;
            return;
          }
          const activate = (hit: GlobalIdentifyHit) => {
            const store = useAppStore.getState();
            store.selectLayer(hit.layer.id);
            store.selectFeature(hit.featureId);
            globalIdentifyActivatedLayerId = hit.layer.id;
          };
          activate(hits[0]);
          // One popup holds several layers, so it takes the widest width any
          // of them asked for.
          const widest = hits.reduce<number | undefined>((widestSoFar, hit) => {
            const configured = resolvePopupMaxWidth(hit.layer.popup);
            if (configured === undefined) return widestSoFar;
            return widestSoFar === undefined ? configured : Math.max(widestSoFar, configured);
          }, undefined);
          const content = createGlobalIdentifyPopupElement(
            hits,
            map.getZoom(),
            activate,
            identifyAllLabelsRef.current,
            widest,
          );
          popup = new gl.Popup({
            className: "geolibre-identify-popup",
            closeButton: true,
            closeOnClick: false,
            maxWidth: identifyPopupShellMaxWidth(widest ? { maxWidth: widest } : undefined),
          })
            .setLngLat(lngLat)
            .setDOMContent(content)
            .addTo(map);
        };
        const handleClick = (e: MapEventOf<"click">) => {
          if (viewId || featureSelection.active.current) return;
          const next = useAppStore.getState();
          if (!next.identifyLayerId) return;
          const identifyAll = next.identifyLayerId === IDENTIFY_ALL_LAYERS_ID;
          const targetLayer = identifyAll
            ? undefined
            : next.layers.find((layer) => layer.id === next.identifyLayerId);
          if (!identifyAll && (!targetLayer || !isPopupClickEnabled(targetLayer.popup))) {
            removeIdentifyPopup();
            next.selectFeature(null);
            return;
          }
          if (identifyAll) {
            showIdentifyAll(e.lngLat.toArray());
            return;
          }
          const match = current
            .identifyFeatures(e.lngLat.toArray(), targetLayer?.id)
            .find((hit) => {
              const layer = next.layers.find((candidate) => candidate.id === hit.layerId);
              return layer && isPopupClickEnabled(layer.popup);
            });
          if (!match) {
            removeIdentifyPopup();
            next.selectFeature(null);
            return;
          }
          const layer = next.layers.find((candidate) => candidate.id === match.layerId);
          if (!layer) return;

          removeIdentifyPopup();
          const selectionState = useAppStore.getState();
          let popupState: IdentifyPopupState;
          const onClose = () => {
            if (identifyPopupState !== popupState) return;
            popup = undefined;
            identifyPopupState = undefined;
            restoreIdentifySelection(popupState);
          };
          popupState = createIdentifyPopupState({
            layerId: match.layerId,
            featureId: match.featureId,
            onClose,
          });
          if (selectionState.selectedLayerId !== match.layerId)
            selectionState.selectLayer(match.layerId);
          selectionState.selectFeature(match.featureId);
          const feature = match.geometry
            ? {
                type: "Feature" as const,
                properties: match.properties,
                geometry: match.geometry,
                ...(match.featureId === null ? {} : { id: match.featureId }),
              }
            : undefined;
          const content = createIdentifyPopupElement(
            layer.name,
            match.properties,
            match.featureId ?? undefined,
            {
              popup: layer.popup,
              fieldVisibility: layer.fieldVisibility,
              feature,
              zoom: map.getZoom(),
            },
          );
          const nextPopup = new gl.Popup({
            className: "geolibre-identify-popup",
            closeButton: true,
            closeOnClick: false,
            maxWidth: identifyPopupShellMaxWidth(layer.popup),
          })
            .setLngLat(e.lngLat)
            .setDOMContent(content)
            .addTo(map);
          popup = nextPopup;
          identifyPopupState = popupState;
          nextPopup.once("close", onClose);
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
          removeIdentifyPopup();
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
