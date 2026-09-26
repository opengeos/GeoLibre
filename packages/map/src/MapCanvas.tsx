import {
  createHoverTooltipElement,
  createIdentifyPopupElement,
  identifyPopupShellMaxWidth,
} from "./feature-popup";
import {
  applyGroupEffects,
  createPointerElevationResolver,
  effectiveLayerRenderState,
  getActiveEllipsoid,
  IDENTIFY_ALL_LAYERS_ID,
  identifyAllIncludes,
  isDuckDBQueryLayer,
  isPopupClickEnabled,
  isPopupHoverEnabled,
  NETCDF_IMAGE_SOURCE_KIND,
  resolveLayerCapabilities,
  resolvePopupMaxWidth,
  useAppStore,
  type GeoLibreLayer,
  type PointerElevationResolver,
} from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import type { Feature } from "geojson";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
  markerLayerId,
} from "./geojson-loader";
import {
  externalExtrusionLayerId,
  mbtilesStyleLayerIds,
  vectorTileStyleLayerIds,
} from "./layer-sync";
import {
  attachFeatureSelection,
  FEATURE_SELECTION_BEGIN_EVENT,
  type FeatureSelectionMap,
} from "./map-feature-selection";
import { isGlobeControlToggleClick } from "./globe-control-toggle";
import { createGlobalIdentifyHitDeduper } from "./identify-all";
import {
  duckDBBridge,
  fetchWmsIdentifyProperties,
  isAbortError,
  isPixelIdentifyLayer,
  isWmsLayer,
  pixelIdentifyProperties,
  timeSliderBridge,
} from "./identify-sources";
import { createPhotoPopupElement, PHOTO_SOURCE_KIND } from "./photo-popup";
import {
  createGlobalIdentifyPopupElement,
  DEFAULT_IDENTIFY_ALL_LABELS,
  type GlobalIdentifyHit,
  type MapCanvasIdentifyAllLabels,
} from "./identify-all-popup";

export type { MapCanvasIdentifyAllLabels };
import { createMapController, type MapController } from "./map-controller";
import type { MapEngine } from "./map-engine";
import {
  createIdentifyPopupState,
  consumePendingIdentifyRestore,
  removeIdentifyPopup as removeIdentifyPopupLifecycle,
  restoreIdentifySelection,
  type IdentifyPopupState,
} from "./map-identify-lifecycle";
import { applySelectionHighlight, resolveHighlightIds, selectionFitKey } from "./map-selection";
import { createMapResizeScheduler } from "./map-resize";
import type { MapDiagnosticEvent } from "./map-diagnostic";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapEngine | null>;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  onControllerReady?: () => void;
  /**
   * Whether the status bar's elevation readout may fall back to the public
   * Open-Meteo service. Supplied by the app, which owns the persisted consent
   * flag; `@geolibre/map` has no opinion about consent storage.
   *
   * **Omitting it denies the remote lookup.** A privacy gate that fails open
   * would send coordinates off-device for any embedder that simply did not know
   * to pass a predicate. The terrain path is unaffected either way, since it
   * sends nothing anywhere.
   */
  canUseRemoteElevation?: () => boolean;
  /** Localized labels for the grouped, all-layer Identify popup. */
  identifyAllLabels?: MapCanvasIdentifyAllLabels;
  /** Reads app-owned raster layers for the grouped, all-layer Identify popup. */
  identifyRasterLayerAt?: MapCanvasRasterIdentify;
}

function setMapLibreIdentifyCursor(map: maplibregl.Map, active: boolean): void {
  // MapLibre's grab cursor belongs to the interactive canvas container. Its
  // native crosshair mode covers that container and active/drag states, while
  // the inline value keeps the canvas itself explicit for other cursor owners.
  map.getContainer().classList.toggle("maplibregl-crosshair", active);
  map.getCanvas().style.cursor = active ? "crosshair" : "";
}

/** One raster result supplied by the application to all-layer Identify. */
export interface MapCanvasRasterIdentifyResult {
  properties: Record<string, unknown>;
  title?: string;
}

/** Application bridge for raster sources owned outside `@geolibre/map`. */
export type MapCanvasRasterIdentify = (
  layer: GeoLibreLayer,
  lngLat: [number, number],
  options: { signal: AbortSignal },
) => Promise<MapCanvasRasterIdentifyResult | null>;

function createIdentifyMessagePopupElement(layerName: string, message: string): HTMLElement {
  return createIdentifyPopupElement(layerName, { status: message });
}

function nativeIdentifyLayerIds(layer: GeoLibreLayer): string[] {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

function identifyStyleLayerIds(layer: GeoLibreLayer): string[] {
  return [
    ...nativeIdentifyLayerIds(layer),
    ...nativeIdentifyLayerIds(layer).map(externalExtrusionLayerId),
    ...mbtilesStyleLayerIds(layer),
    markerLayerId(layer.id),
    circleLayerId(layer.id),
    lineLayerId(layer.id),
    fillExtrusionLayerId(layer.id),
    fillLayerId(layer.id),
    ...vectorTileStyleLayerIds(layer),
  ];
}

function findFeatureId(layer: GeoLibreLayer, feature: maplibregl.MapGeoJSONFeature): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;

  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  const index = layer.geojson.features.findIndex((candidate) => {
    const candidateProperties = candidate.properties ?? {};
    return propertyKeys.every((key) => candidateProperties[key] === properties[key]);
  });

  return index >= 0 ? String(layer.geojson.features[index].id ?? index) : null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringProperty(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberProperty(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = recordFromUnknown(error);
  return stringProperty(record, "message") ?? "MapLibre reported an error.";
}

function stringifyDiagnosticDetail(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, nestedValue: unknown) => {
        // Only clamp object-valued targets (Map, XHR, DOM nodes) that risk
        // circular or huge output; keep string targets such as tile URLs.
        if (key === "target" && typeof nestedValue === "object" && nestedValue !== null) {
          return "[Map]";
        }
        if (typeof nestedValue !== "object" || nestedValue === null) {
          return nestedValue;
        }
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
        return nestedValue;
      },
      2,
    );
  } catch {
    return undefined;
  }
}

function mapErrorDiagnosticEvent(event: maplibregl.ErrorEvent): MapDiagnosticEvent {
  const eventRecord = recordFromUnknown(event);
  const errorRecord = recordFromUnknown(event.error);
  const source = stringProperty(eventRecord, "sourceId") ?? stringProperty(errorRecord, "sourceId");
  const url =
    stringProperty(eventRecord, "url") ??
    stringProperty(errorRecord, "url") ??
    stringProperty(errorRecord, "resource");
  const status = numberProperty(eventRecord, "status") ?? numberProperty(errorRecord, "status");

  return {
    message: errorMessage(event.error),
    detail: stringifyDiagnosticDetail({
      type: event.type,
      source,
      status,
      url,
      dataType: eventRecord?.dataType,
      sourceDataType: eventRecord?.sourceDataType,
      tile: eventRecord?.tile,
      error: event.error,
    }),
    source,
    status,
    url,
  };
}

export const MapCanvas = memo(function MapCanvas({
  controllerRef,
  onMapDiagnosticEvent,
  onControllerReady,
  canUseRemoteElevation,
  identifyAllLabels = DEFAULT_IDENTIFY_ALL_LABELS,
  identifyRasterLayerAt,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  // Read the latest callback through a ref so the setup effect can stay
  // dependency-free. Adding onControllerReady to its deps would tear down and
  // recreate the entire map (losing layers, plugins, and view) whenever a
  // caller passes a non-memoized callback.
  const onControllerReadyRef = useRef(onControllerReady);
  onControllerReadyRef.current = onControllerReady;
  const onMapDiagnosticEventRef = useRef(onMapDiagnosticEvent);
  onMapDiagnosticEventRef.current = onMapDiagnosticEvent;

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const blankBackgroundColor = useAppStore((s) => s.blankBackgroundColor);
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const layerGroupsRef = useRef(layerGroups);
  // Read by the photo-popup effect, which rebinds only on photo-layer changes.
  const identifyLabelsRef = useRef(identifyAllLabels);
  identifyLabelsRef.current = identifyAllLabels;
  layerGroupsRef.current = layerGroups;
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const setPointerElevation = useAppStore((s) => s.setPointerElevation);
  const setCameraAltitude = useAppStore((s) => s.setCameraAltitude);
  const showPointerElevation = useAppStore((s) => s.preferences.map.showPointerElevation);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const pointerElevationRef = useRef<PointerElevationResolver | null>(null);
  // Held in a ref so the once-only init effect can read the current predicate
  // without re-creating the map when the consent flag changes.
  const canUseRemoteElevationRef = useRef<() => boolean>(() => true);
  canUseRemoteElevationRef.current = canUseRemoteElevation ?? (() => false);

  // loadProject resets the readout, but a lookup already in flight for the
  // previous project would repaint it a moment later -- including Earth to
  // Earth, where neither the body nor the pointer changed.
  useEffect(() => {
    pointerElevationRef.current?.invalidate();
  }, [projectGeneration]);

  // The resolver consults the preference, but only when a pointer event asks it
  // to. Switching the toggle off with the cursor resting motionless over the
  // map (a keyboard-only toggle) would otherwise leave the last resolved value
  // on screen until the next mousemove.
  useEffect(() => {
    if (!showPointerElevation) {
      // invalidate() before clearing: a lookup scheduled inside the 500ms
      // debounce window would otherwise still fire the request, and only be
      // suppressed afterwards by the isEnabled() re-check. Cancelling the timer
      // means the request is never made at all.
      pointerElevationRef.current?.invalidate();
      setPointerElevation(null);
      return;
    }
    // Symmetrically, switching it *on* while the cursor sits still would show
    // nothing until the next mousemove. Resolve once for wherever the pointer
    // already is, so the readout appears with the toggle.
    const coords = useAppStore.getState().pointerCoords;
    if (coords) pointerElevationRef.current?.update(coords);
  }, [showPointerElevation, setPointerElevation]);
  const previousSelectedFeatureKey = useRef<string | null>(null);
  const previousDuckDBSelectionLayerId = useRef<string | null>(null);
  // The layer all-layer Identify last activated, so a click that hits nothing
  // can retire that selection without touching one the user made themselves.
  const globalIdentifyActivatedLayerId = useRef<string | null>(null);
  const identifyPopup = useRef<maplibregl.Popup | null>(null);
  const photoPopup = useRef<maplibregl.Popup | null>(null);
  const hoverTooltip = useRef<maplibregl.Popup | null>(null);
  // Set for the duration of a map selection gesture. The other click handlers
  // bound to the same map (Identify, geotagged-photo popups) read it and bail,
  // so a rectangle drag or a polygon vertex click never also opens a popup.
  const featureSelectionActive = useRef(false);
  // Tears down the gesture in progress, if any. Held at component scope so the
  // Identify effect can end a half-drawn selection when the user switches
  // tools instead of finishing or pressing Esc.
  const cancelFeatureSelection = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current || controller.current) return;

    const mc = createMapController();
    const map = mc.init(containerRef.current, {
      styleUrl: basemapStyleUrl,
      mapView,
      mapPreferences,
    });
    controller.current = mc;
    if (controllerRef) controllerRef.current = mc;

    // Ground elevation under the cursor for the status bar (issue #1813).
    // Terrain sampling is synchronous so the readout tracks the pointer live;
    // the resolver only falls back to the network once the pointer settles.
    const pointerElevation = createPointerElevationResolver({
      getMap: () => map,
      isEarth: () => getActiveEllipsoid().id === "earth",
      // Read per call, not captured: the map is initialised once, so a captured
      // value would freeze at whatever the toggle was at mount.
      isEnabled: () => useAppStore.getState().preferences.map.showPointerElevation,
      // Only the Open-Meteo fallback is gated; the terrain path sends nothing
      // anywhere. Checked here rather than by scrubbing the stored preference,
      // so a project that arrives with the readout switched on still cannot
      // reach the network without local consent.
      canUseRemote: () => canUseRemoteElevationRef.current(),
      emit: setPointerElevation,
    });
    pointerElevationRef.current = pointerElevation;

    map.on("mousemove", (e) => {
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setPointerCoords(point);
      pointerElevation.update(point);
    });
    map.on("mouseout", () => {
      // invalidate() rather than update(null): both cancel a pending lookup, but
      // update(null) also emits null, and setPointerCoords(null) already clears
      // the stored elevation — so emitting here would be a second store write
      // and re-render saying the same thing.
      pointerElevation.invalidate();
      setPointerCoords(null);
    });
    map.on("error", (event) => {
      // Cancelled tile fetches are already surfaced (as info) by the
      // network capture; logging them here would double-count aborts.
      if (isAbortError(event.error)) return;
      onMapDiagnosticEventRef.current?.(mapErrorDiagnosticEvent(event));
    });

    const updateView = (event?: { originalEvent?: unknown; flightCameraToken?: number }) => {
      // While presenting a story map the presenter owns the camera. Syncing its
      // transient chapter flies and rotations back into the store would both
      // overwrite the saved project view and, worse, re-enter the applyView
      // effect below: its jumpTo cancels an in-flight chapter fly, after which
      // the rotate handler starts orbiting the previous chapter instead of the
      // one just clicked. Skipping the sync keeps the presenter authoritative.
      if (useAppStore.getState().ui.storymapPresenting) return;
      // The flight simulator likewise owns the camera while it flies, and jumps
      // it every animation frame. Writing each of those into the store would
      // overwrite the project's saved view ~60 times a second.
      if (event?.flightCameraToken !== undefined) return;
      setMapView(mc.readView(), Boolean(event?.originalEvent));
      // Same moveend cadence as zoom/bearing/pitch: a bar where one number is
      // live and the rest lag during a drag reads as broken.
      setCameraAltitude(mc.readCameraAltitude());
    };
    map.on("moveend", updateView);

    // Persist user clicks on MapLibre's GlobeControl into project preferences so
    // a project reopens with the projection it was saved in. See
    // `globe-control-toggle.ts` for why the click, and not MapLibre's
    // `projectiontransition` event, is what this listens to.
    const updateProjection = () => {
      const projection = mc.readProjection();
      // Functional update so a concurrent preference change (zoom-limit edit,
      // loadProject) between read and write is not clobbered by a stale snapshot.
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
    const handleProjectionControlClick = (event: MouseEvent) => {
      // The control's own handler runs on the button before the event reaches
      // this container-level listener, and `setProjection` is synchronous, so
      // `readProjection()` already reflects the toggle.
      if (!isGlobeControlToggleClick(event.target)) return;
      updateProjection();
    };
    map.getContainer().addEventListener("click", handleProjectionControlClick);
    map.on("load", () => {
      const state = useAppStore.getState();
      mc.setBasemapVisible(state.basemapVisible);
      mc.setBasemapOpacity(state.basemapOpacity);
      mc.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      updateView();
      onControllerReadyRef.current?.();
    });

    const disposeResizeScheduler = createMapResizeScheduler({
      getMap: () => mc.getMap(),
      container: containerRef.current,
    });

    return () => {
      disposeResizeScheduler();
      pointerElevation.dispose();
      map.getContainer().removeEventListener("click", handleProjectionControlClick);
      mc.destroy();
      controller.current = null;
      if (controllerRef) controllerRef.current = null;
    };
    // The map is initialised exactly once; onControllerReady is read via
    // onControllerReadyRef so it is intentionally excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevBasemap = useRef(basemapStyleUrl);
  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || prevBasemap.current === basemapStyleUrl) return;
    prevBasemap.current = basemapStyleUrl;
    map.once("style.load", () => {
      const state = useAppStore.getState();
      controller.current?.setBasemapVisible(state.basemapVisible);
      controller.current?.setBasemapOpacity(state.basemapOpacity);
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      onControllerReadyRef.current?.();
    });
    controller.current?.setStyle(basemapStyleUrl);
    // Switching the active body without moving the camera -- the planet switcher
    // or a different planetary basemap -- changes the radius the altitude is
    // scaled by, but fires no moveend, so the readout would keep the previous
    // body's number until the next pan. Mirrors how setStyle refreshes the
    // scale bar for the same reason.
    setCameraAltitude(controller.current?.readCameraAltitude() ?? null);
    // setCameraAltitude is a stable store action; the effect is keyed on the
    // basemap alone so it does not re-run on unrelated store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapStyleUrl]);

  useEffect(() => {
    controller.current?.setBasemapVisible(basemapVisible);
  }, [basemapVisible]);

  useEffect(() => {
    controller.current?.setBasemapOpacity(basemapOpacity);
  }, [basemapOpacity]);

  useEffect(() => {
    controller.current?.setBlankBackgroundColor(blankBackgroundColor);
    if (blankBackgroundColor !== null || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => controller.current?.setBlankBackgroundColor(null));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [blankBackgroundColor]);

  useEffect(() => {
    controller.current?.applyMapPreferences(mapPreferences);
  }, [mapPreferences]);

  // Fold group visibility/opacity into each child layer before syncing so the
  // map sync keeps treating every layer independently. This also re-runs when
  // only a group's visibility/opacity changes (the raw `layers` array is then
  // unchanged), because `renderLayers` depends on `layerGroups`.
  const renderLayers = useMemo(() => applyGroupEffects(layers, layerGroups), [layers, layerGroups]);

  useEffect(() => {
    controller.current?.waitAndSyncLayers(renderLayers);
  }, [renderLayers]);

  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map) return;
    return attachFeatureSelection(map as unknown as FeatureSelectionMap, {
      state: {
        active: featureSelectionActive,
        cancel: cancelFeatureSelection,
      },
      featureIdAtPoint: (layer, point) => {
        const queryIds = identifyStyleLayerIds(layer).filter((id) => map.getLayer(id));
        const rendered = map.queryRenderedFeatures(
          [
            [point.x - 4, point.y - 4],
            [point.x + 4, point.y + 4],
          ],
          { layers: queryIds },
        );
        return rendered[0] ? findFeatureId(layer, rendered[0]) : null;
      },
      onDiagnostic: (event) => onMapDiagnosticEventRef.current?.(event),
      onEnd: () => setMapLibreIdentifyCursor(map, Boolean(useAppStore.getState().identifyLayerId)),
    });
  }, []);

  // Stable key over just the geotagged-photo layer ids, so the photo-click
  // effect re-binds only when such a layer is added/removed, not on every
  // unrelated layer edit (e.g. a coordinate update while dragging a pin).
  const photoLayerKey = useMemo(
    () =>
      layers
        .filter((layer) => layer.metadata.sourceKind === PHOTO_SOURCE_KIND)
        .map((layer) => layer.id)
        .join(","),
    [layers],
  );

  useEffect(() => {
    const layer = layers.find((item) => item.id === selectedLayerId);
    const previousKey = previousSelectedFeatureKey.current;
    // This effect runs after an Identify restore has returned, so it reads
    // the restore's read-once marker rather than a synchronous flag.
    const restoring = consumePendingIdentifyRestore(
      selectionFitKey({ selectedLayerId, selectedFeatureIds, selectedFeatureId }),
    );
    const nextKey = applySelectionHighlight(
      controller.current,
      layers,
      selectedLayerId,
      selectedFeatureId,
      selectedFeatureIds,
      zoomToSelectedFeature,
      previousKey,
      restoring,
    );
    const shouldFit = Boolean(
      !restoring && zoomToSelectedFeature && nextKey && nextKey !== previousKey,
    );
    previousSelectedFeatureKey.current = nextKey;
    if (layer && isDuckDBQueryLayer(layer)) {
      duckDBBridge()?.setSelectedFeature?.(layer.id, selectedFeatureId);
      if (shouldFit && selectedFeatureId) {
        const bounds = duckDBBridge()?.getFeatureBounds?.(layer.id, selectedFeatureId);
        if (bounds) controller.current?.fitBounds(bounds);
      }
      previousDuckDBSelectionLayerId.current = layer.id;
    } else if (previousDuckDBSelectionLayerId.current) {
      duckDBBridge()?.setSelectedFeature?.(previousDuckDBSelectionLayerId.current, null);
      previousDuckDBSelectionLayerId.current = null;
    }
  }, [layers, selectedLayerId, selectedFeatureId, selectedFeatureIds, zoomToSelectedFeature]);

  useEffect(() => {
    const map = controller.current?.getMap();
    const identifyAllLayers = identifyLayerId === IDENTIFY_ALL_LAYERS_ID;
    const layer = identifyAllLayers
      ? undefined
      : layers.find((item) => item.id === identifyLayerId);
    if (!map || (!layer && !identifyAllLayers)) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      // Same guard as the cleanup below: picking a gesture turns Identify off,
      // and begin() has already claimed the crosshair by the time this runs.
      if (map && !featureSelectionActive.current) setMapLibreIdentifyCursor(map, false);
      return;
    }

    // Switching to Identify ends a half-drawn selection. Without this the
    // gesture stays live and its handlers keep swallowing map clicks, so the
    // Identify button would light up while Identify itself did nothing.
    cancelFeatureSelection.current?.();

    if (identifyAllLayers) {
      setMapLibreIdentifyCursor(map, true);
      let globalIdentifyAbortController: AbortController | null = null;
      const handleIdentifyAllClick = (event: maplibregl.MapMouseEvent) => {
        if (featureSelectionActive.current) return;

        globalIdentifyAbortController?.abort();
        const abortController = new AbortController();
        globalIdentifyAbortController = abortController;

        const owners = new Map<string, GeoLibreLayer>();
        // effectiveLayerRenderState rebuilds an id -> group map on every call
        // when handed the array form, so fold every candidate against one map
        // built once per click instead of one per layer.
        const groupById = new Map(layerGroupsRef.current.map((group) => [group.id, group]));
        // Read at click time: a restriction set by a script or project names
        // the layers this mode is limited to (issue #2688).
        const { identifyLayerIds } = useAppStore.getState();
        const eligibleLayers = layers.filter(
          (candidate) =>
            identifyAllIncludes(candidate.id, identifyLayerIds) &&
            effectiveLayerRenderState(candidate, groupById).visible &&
            resolveLayerCapabilities(candidate).query &&
            isPopupClickEnabled(candidate.popup),
        );
        for (const candidate of eligibleLayers) {
          for (const styleLayerId of identifyStyleLayerIds(candidate)) {
            if (map.getLayer(styleLayerId)) owners.set(styleLayerId, candidate);
          }
        }

        const hits: GlobalIdentifyHit[] = [];
        const acceptHit = createGlobalIdentifyHitDeduper();
        const queryLayerIds = [...owners.keys()];
        const rendered =
          queryLayerIds.length === 0
            ? []
            : map.queryRenderedFeatures(event.point, { layers: queryLayerIds });
        for (const feature of rendered) {
          const owner = owners.get(feature.layer.id);
          if (!owner) continue;
          const hit: GlobalIdentifyHit = {
            layer: owner,
            properties: feature.properties ?? {},
            feature,
            featureId: findFeatureId(owner, feature),
          };
          if (!acceptHit(hit.layer.id, hit.featureId, feature)) continue;
          hits.push(hit);
        }

        // DuckDB query layers draw through deck.gl, so they own no MapLibre
        // style layer and never surface in queryRenderedFeatures. The plugin
        // bridge picks them the same way the single-layer path does.
        for (const candidate of eligibleLayers) {
          if (!isDuckDBQueryLayer(candidate)) continue;
          const result = duckDBBridge()?.identifyLayerAtPoint?.(candidate.id, {
            x: event.point.x,
            y: event.point.y,
          });
          if (!result) continue;
          hits.push({
            layer: candidate,
            properties: result.properties,
            featureId: result.featureId,
          });
        }

        const activate = (hit: GlobalIdentifyHit) => {
          selectLayer(hit.layer.id);
          selectFeature(hit.featureId);
          globalIdentifyActivatedLayerId.current = hit.layer.id;
        };
        const showPopup = (content: HTMLElement, shellMaxWidth = "560px") => {
          identifyPopup.current?.remove();
          identifyPopup.current = new maplibregl.Popup({
            className: "geolibre-identify-popup",
            closeButton: true,
            closeOnClick: false,
            maxWidth: shellMaxWidth,
          })
            .setLngLat(event.lngLat)
            .setDOMContent(content)
            .addTo(map);
        };
        const finish = (allHits: GlobalIdentifyHit[]) => {
          if (abortController.signal.aborted) return;
          const order = new Map(layers.map((candidate, index) => [candidate.id, index]));
          allHits.sort((a, b) => (order.get(b.layer.id) ?? -1) - (order.get(a.layer.id) ?? -1));
          if (allHits.length === 0) {
            identifyPopup.current?.remove();
            identifyPopup.current = null;
            selectFeature(null);
            // Retire the layer selection only when this mode is what set it.
            // A layer the user picked in the Layers panel — to edit its style,
            // say — is theirs to keep, and the single-layer Identify path
            // never clears it either.
            if (
              globalIdentifyActivatedLayerId.current !== null &&
              useAppStore.getState().selectedLayerId === globalIdentifyActivatedLayerId.current
            ) {
              selectLayer(null);
            }
            globalIdentifyActivatedLayerId.current = null;
            return;
          }
          activate(allHits[0]);
          // The grouped popup holds several layers at once, so it takes the
          // widest width any of them asked for rather than picking one layer's
          // setting over the others'.
          const widest = allHits.reduce<number | undefined>((widestSoFar, hit) => {
            const configured = resolvePopupMaxWidth(hit.layer.popup);
            if (configured === undefined) return widestSoFar;
            return widestSoFar === undefined ? configured : Math.max(widestSoFar, configured);
          }, undefined);
          const content = createGlobalIdentifyPopupElement(
            allHits,
            map.getZoom(),
            activate,
            identifyAllLabels,
            widest,
          );
          showPopup(content, identifyPopupShellMaxWidth(widest ? { maxWidth: widest } : undefined));
        };

        const asyncLayers = eligibleLayers.filter(
          (candidate) =>
            isWmsLayer(candidate) ||
            isPixelIdentifyLayer(candidate) ||
            candidate.type === "cog" ||
            candidate.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND,
        );
        if (asyncLayers.length === 0) {
          finish(hits);
          return;
        }

        selectFeature(null);
        showPopup(
          createIdentifyMessagePopupElement(
            identifyAllLabels.loadingTitle,
            identifyAllLabels.loading,
          ),
        );
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => abortController.abort();
        loadingPopup?.once("close", onLoadingClose);

        void Promise.all(
          asyncLayers.map(async (candidate): Promise<GlobalIdentifyHit | null> => {
            try {
              if (isWmsLayer(candidate)) {
                const result = await fetchWmsIdentifyProperties(
                  candidate,
                  [event.lngLat.lng, event.lngLat.lat],
                  map.getZoom(),
                  abortController.signal,
                );
                if (
                  !result ||
                  (result.featureId == null && Object.keys(result.properties).length === 0)
                ) {
                  return null;
                }
                return {
                  layer: candidate,
                  properties: result.properties,
                  featureId: result.featureId == null ? null : String(result.featureId),
                };
              }

              // Ordered before the pixel-identify branch on purpose: the
              // NetCDF dialog marks these layers `pixelIdentify` too, and that
              // branch reads through the Time Slider bridge, which knows
              // nothing about a retained NetCDF grid.
              if (candidate.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) {
                const result = await identifyRasterLayerAt?.(
                  candidate,
                  [event.lngLat.lng, event.lngLat.lat],
                  { signal: abortController.signal },
                );
                return result
                  ? {
                      layer: candidate,
                      properties: result.properties,
                      featureId: null,
                      title: result.title ?? identifyAllLabels.pixel,
                    }
                  : null;
              }

              if (isPixelIdentifyLayer(candidate)) {
                const result = await timeSliderBridge()?.identifyPixelAt?.(
                  candidate.id,
                  [event.lngLat.lng, event.lngLat.lat],
                  { signal: abortController.signal },
                );
                return result
                  ? {
                      layer: candidate,
                      properties: pixelIdentifyProperties(result),
                      featureId: null,
                      title: identifyAllLabels.pixel,
                    }
                  : null;
              }

              const result = await identifyRasterLayerAt?.(
                candidate,
                [event.lngLat.lng, event.lngLat.lat],
                { signal: abortController.signal },
              );
              return result
                ? {
                    layer: candidate,
                    properties: result.properties,
                    featureId: null,
                    title: result.title ?? identifyAllLabels.pixel,
                  }
                : null;
            } catch (error: unknown) {
              if (abortController.signal.aborted || isAbortError(error)) return null;
              return {
                layer: candidate,
                properties: {
                  [identifyAllLabels.errorLabel]:
                    error instanceof Error ? error.message : identifyAllLabels.error,
                },
                featureId: null,
              };
            }
          }),
        ).then((asyncHits) => {
          if (abortController.signal.aborted) return;
          loadingPopup?.off("close", onLoadingClose);
          finish([...hits, ...asyncHits.filter((hit): hit is GlobalIdentifyHit => hit !== null)]);
        });
      };

      map.on("click", handleIdentifyAllClick);
      return () => {
        globalIdentifyAbortController?.abort();
        map.off("click", handleIdentifyAllClick);
        identifyPopup.current?.remove();
        identifyPopup.current = null;
        globalIdentifyActivatedLayerId.current = null;
        if (!featureSelectionActive.current) setMapLibreIdentifyCursor(map, false);
      };
    }

    if (!layer) return;

    // An author can turn the click popup off for a layer they only want
    // hovered (or only styled). Identify then does nothing for it rather than
    // opening a popup the shared map was designed without.
    if (!isPopupClickEnabled(layer.popup)) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      return;
    }

    // COG layers are identified by the raster control's pixel inspector (driven
    // by useRasterIdentify in the desktop app), not this vector/WMS feature
    // query. Bail so the two don't both register a map-click handler. (Only
    // "cog" is identify-enabled; plain "raster" never reaches here.)
    if (layer.type === "cog") return;

    // Likewise for a NetCDF grid baked to pixels: useNetcdfIdentify reads its
    // retained grid directly, and the image layer has no features to query.
    if (layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) return;

    setMapLibreIdentifyCursor(map, true);

    let wmsIdentifyAbortController: AbortController | null = null;
    let pixelIdentifyAbortController: AbortController | null = null;
    let identifyPopupState: IdentifyPopupState | null = null;

    const removeIdentifyPopup = () => {
      const popup = identifyPopup.current;
      const popupState = identifyPopupState;
      identifyPopup.current = null;
      identifyPopupState = null;
      // Every removal through this path is programmatic: a follow-up click,
      // mode/effect cleanup, or an async popup swap. Only the popup's own close
      // event below represents a user dismissal and may restore the snapshot.
      removeIdentifyPopupLifecycle(popup, popupState, { restore: false });
    };

    const handleIdentifyClick = (event: maplibregl.MapMouseEvent) => {
      // A selection gesture owns the map clicks while it runs.
      if (featureSelectionActive.current) return;
      const clearIdentifyResult = () => {
        wmsIdentifyAbortController?.abort();
        wmsIdentifyAbortController = null;
        selectFeature(null);
        removeIdentifyPopup();
      };
      const createAndAddIdentifyPopup = (content: HTMLElement) =>
        new maplibregl.Popup({
          className: "geolibre-identify-popup",
          closeButton: true,
          closeOnClick: false,
          maxWidth: identifyPopupShellMaxWidth(layer.popup),
        })
          .setLngLat(event.lngLat)
          .setDOMContent(content)
          .addTo(map);
      const showIdentifyPopup = (content: HTMLElement) => {
        removeIdentifyPopup();
        identifyPopup.current = createAndAddIdentifyPopup(content);
      };
      const showResolvedHitPopup = (content: HTMLElement, featureId: string | null) => {
        removeIdentifyPopup();
        let popupState: IdentifyPopupState;
        const onClose = () => {
          if (identifyPopupState !== popupState) return;
          identifyPopup.current = null;
          identifyPopupState = null;
          restoreIdentifySelection(popupState);
        };
        popupState = createIdentifyPopupState({
          layerId: layer.id,
          featureId,
          onClose,
        });
        const selectionState = useAppStore.getState();
        if (selectionState.selectedLayerId !== layer.id) selectionState.selectLayer(layer.id);
        selectionState.selectFeature(featureId);
        const popup = createAndAddIdentifyPopup(content);
        identifyPopup.current = popup;
        identifyPopupState = popupState;
        popup.once("close", onClose);
      };

      if (isPixelIdentifyLayer(layer)) {
        const identifyPixelAt = timeSliderBridge()?.identifyPixelAt;
        if (!identifyPixelAt) {
          clearIdentifyResult();
          return;
        }
        pixelIdentifyAbortController?.abort();
        const abortController = new AbortController();
        pixelIdentifyAbortController = abortController;
        selectFeature(null);
        showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, identifyAllLabels.loading));
        // Same dismissal dance as the WMS branch: the × on the loading popup
        // must cancel the read, but the programmatic swap to the result popup
        // also fires "close", so track user dismissal with a flag rather than
        // treating every close as a cancel.
        let userDismissed = false;
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => {
          userDismissed = true;
          abortController.abort();
          if (pixelIdentifyAbortController === abortController) {
            pixelIdentifyAbortController = null;
          }
        };
        loadingPopup!.once("close", onLoadingClose);

        void identifyPixelAt(layer.id, [event.lngLat.lng, event.lngLat.lat], {
          signal: abortController.signal,
        })
          .then((result) => {
            if (userDismissed || abortController.signal.aborted) return;
            pixelIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            // A null result means the click landed off the image grid, which is
            // an ordinary miss rather than a failure.
            showIdentifyPopup(
              result
                ? createIdentifyPopupElement(layer.name, pixelIdentifyProperties(result))
                : createIdentifyMessagePopupElement(layer.name, identifyAllLabels.noData),
            );
          })
          .catch((error: unknown) => {
            if (userDismissed || isAbortError(error) || abortController.signal.aborted) return;
            pixelIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            const message =
              error instanceof Error ? error.message : identifyAllLabels.pixelReadFailed;
            showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, message));
          });
        return;
      }

      if (isWmsLayer(layer)) {
        wmsIdentifyAbortController?.abort();
        const abortController = new AbortController();
        wmsIdentifyAbortController = abortController;
        selectFeature(null);
        showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, identifyAllLabels.loading));
        // Closing the loading popup (the × button) must cancel the in-flight
        // request so its result does not reopen a popup the user dismissed.
        // Track user dismissal with a flag rather than the abort signal: the
        // result swap calls remove() on this popup, which also fires "close",
        // and we must not treat that programmatic swap as a dismissal. Guard the
        // shared controller by identity so a newer request is not clobbered.
        let userDismissed = false;
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => {
          userDismissed = true;
          abortController.abort();
          if (wmsIdentifyAbortController === abortController) {
            wmsIdentifyAbortController = null;
          }
        };
        // showIdentifyPopup just assigned identifyPopup.current, so it is set.
        loadingPopup!.once("close", onLoadingClose);

        void fetchWmsIdentifyProperties(
          layer,
          [event.lngLat.lng, event.lngLat.lat],
          map.getZoom(),
          abortController.signal,
        )
          .then((result) => {
            if (userDismissed || abortController.signal.aborted) return;
            wmsIdentifyAbortController = null;
            // Detach before the swap so remove()'s synchronous "close" does not
            // spuriously abort the request that just succeeded.
            loadingPopup?.off("close", onLoadingClose);
            showIdentifyPopup(
              createIdentifyPopupElement(layer.name, result?.properties ?? {}, result?.featureId),
            );
          })
          .catch((error: unknown) => {
            if (userDismissed || isAbortError(error) || abortController.signal.aborted) return;
            wmsIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            const message = error instanceof Error ? error.message : identifyAllLabels.wmsFailed;
            showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, message));
          });
        return;
      }

      if (isDuckDBQueryLayer(layer)) {
        const result = duckDBBridge()?.identifyLayerAtPoint?.(layer.id, {
          x: event.point.x,
          y: event.point.y,
        });
        if (!result) {
          clearIdentifyResult();
          return;
        }

        selectFeature(result.featureId);
        showIdentifyPopup(
          createIdentifyPopupElement(layer.name, result.properties, result.featureId, {
            popup: layer.popup,
            fieldVisibility: layer.fieldVisibility,
            zoom: map.getZoom(),
          }),
        );
        return;
      }

      const queryLayerIds = identifyStyleLayerIds(layer).filter((id) => map.getLayer(id));
      if (queryLayerIds.length === 0) {
        clearIdentifyResult();
        return;
      }

      const [feature] = map.queryRenderedFeatures(event.point, {
        layers: queryLayerIds,
      });
      if (!feature) {
        clearIdentifyResult();
        return;
      }

      const featureId = findFeatureId(layer, feature);
      showResolvedHitPopup(
        createIdentifyPopupElement(layer.name, feature.properties ?? {}, featureId ?? feature.id, {
          popup: layer.popup,
          fieldVisibility: layer.fieldVisibility,
          feature,
          zoom: map.getZoom(),
        }),
        featureId,
      );
    };

    map.on("click", handleIdentifyClick);

    return () => {
      wmsIdentifyAbortController?.abort();
      pixelIdentifyAbortController?.abort();
      map.off("click", handleIdentifyClick);
      removeIdentifyPopup();
      // Starting a selection gesture turns Identify off, so this cleanup runs
      // after the gesture has already claimed the crosshair — leave its cursor
      // alone rather than resetting it out from under the drawing.
      if (!featureSelectionActive.current) setMapLibreIdentifyCursor(map, false);
    };
  }, [
    identifyAllLabels,
    identifyLayerId,
    identifyRasterLayerAt,
    layers,
    selectFeature,
    selectLayer,
  ]);

  // Geotagged photos: clicking a photo point opens a resizable popup with the
  // photo, without needing the Identify tool. The popup is photo-specific, and
  // its box uses CSS `resize` so the thumbnail enlarges as it is dragged bigger.
  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map) return;
    const photoLayerIds = photoLayerKey ? photoLayerKey.split(",") : [];
    if (photoLayerIds.length === 0) return;

    const removePhotoPopup = () => {
      photoPopup.current?.remove();
      photoPopup.current = null;
    };

    const handleClick = (event: maplibregl.MapLayerMouseEvent) => {
      // The Identify tool already renders the photo in its own popup; skip ours
      // so one click never opens two popups. Likewise while a selection gesture
      // is drawing, where a click is a vertex rather than a pick.
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      const feature = event.features?.[0];
      if (!feature) return;
      // Anchor to the feature's own coordinate rather than the click point, so
      // the tip stays on the photo point even when the user clicks the edge of
      // a large marker.
      const geometry = feature.geometry;
      const anchor =
        geometry.type === "Point" ? (geometry.coordinates as [number, number]) : event.lngLat;
      removePhotoPopup();
      photoPopup.current = new maplibregl.Popup({
        className: "geolibre-photo-popup-root",
        closeButton: true,
        closeOnClick: true,
        maxWidth: "none",
      })
        .setLngLat(anchor)
        .setDOMContent(
          createPhotoPopupElement(feature.properties ?? {}, identifyLabelsRef.current.photo),
        )
        .addTo(map);
    };
    const handleEnter = () => {
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      map.getCanvas().style.cursor = "pointer";
    };
    const handleLeave = () => {
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      map.getCanvas().style.cursor = "";
    };

    // Photo points render as a circle by default, or a marker symbol when the
    // user enables markers; bind to whichever style layers actually exist.
    let boundIds: string[] = [];
    const unbind = () => {
      for (const id of boundIds) {
        map.off("click", id, handleClick);
        map.off("mouseenter", id, handleEnter);
        map.off("mouseleave", id, handleLeave);
      }
      boundIds = [];
    };
    const bind = () => {
      unbind();
      boundIds = photoLayerIds
        .flatMap((id) => [circleLayerId(id), markerLayerId(id)])
        .filter((id) => map.getLayer(id));
      for (const id of boundIds) {
        map.on("click", id, handleClick);
        map.on("mouseenter", id, handleEnter);
        map.on("mouseleave", id, handleLeave);
      }
    };

    bind();
    // syncLayers creates the circle/marker style layers and then dispatches this
    // event, so re-bind on it to catch layers that did not exist yet when this
    // effect first ran (e.g. before the style finished loading).
    window.addEventListener("geolibre-layer-labels-change", bind);
    // Close the photo popup when the Identify tool is turned on (which may
    // happen via a toolbar button, with no map click to dismiss it), so the
    // photo and identify popups never coexist.
    const unsubscribeIdentify = useAppStore.subscribe((state, prev) => {
      // Only on the off->on transition: the listener runs on every store change
      // (e.g. setPointerCoords on each mousemove), so guarding on the current
      // value alone would keep clobbering the Identify crosshair cursor.
      if (state.identifyLayerId && !prev.identifyLayerId) {
        removePhotoPopup();
        // If Identify is enabled while the cursor already sits on a photo point,
        // mouseleave never fires, so clear the hover cursor here too.
        map.getCanvas().style.cursor = "";
      }
    });

    return () => {
      window.removeEventListener("geolibre-layer-labels-change", bind);
      unsubscribeIdentify();
      unbind();
      removePhotoPopup();
    };
  }, [photoLayerKey]);

  // Hover tooltips (#2113): a lightweight tip following the pointer over the
  // layers whose author turned one on, showing the fields they flagged for
  // hover. Keyed on the ids AND the popup blocks, so editing the tooltip's
  // fields in the Style panel rebinds immediately.
  const hoverTooltipKey = useMemo(
    () =>
      layers
        // Group-aware, like the Identify handler and the selection query: a
        // layer whose own switch is on can still be hidden by its group, and
        // binding pointer handlers to it would be binding to something the
        // user cannot see. `applyGroupEffects` also sets the synced MapLibre
        // layer's visibility to `none`, so nothing fires today either way —
        // this keeps the two from drifting if that ever stops being true.
        .filter(
          (layer) =>
            effectiveLayerRenderState(layer, layerGroups).visible &&
            isPopupHoverEnabled(layer.popup),
        )
        .map((layer) => `${layer.id}\u0000${JSON.stringify(layer.popup ?? {})}`)
        .join("\u0001"),
    [layers, layerGroups],
  );

  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || !hoverTooltipKey) return;
    const hoverLayerIds = hoverTooltipKey.split("\u0001").map((part) => part.split("\u0000")[0]);

    // The pointer move that has not been drawn yet, and the frame that will
    // draw it. `mousemove` fires far more often than the screen refreshes, and
    // each tip rebuilds a small DOM tree, so moves are coalesced to one render
    // per frame rather than one per event.
    let pending: {
      layerId: string;
      feature: maplibregl.MapGeoJSONFeature;
      lngLat: maplibregl.LngLat;
    } | null = null;
    let pendingFrame = 0;
    // A `mouseleave` waiting for the same frame to decide. One logical layer
    // renders as several MapLibre style layers (a polygon's fill and its own
    // stroke, a point's circle and its marker), and this effect binds to each
    // of them, so crossing from a feature's fill onto that feature's own
    // stroke fires `mouseleave` on the first and `mousemove` on the second
    // from a single pointer event. Removing on the spot would tear the popup
    // down and rebuild it on every such crossing — and if the leave arrived
    // after the move, it would cancel the redraw and blank the tip until the
    // pointer moved again. Deferring the decision to the frame lets a move
    // anywhere in the same layer outvote the leave.
    let pendingLeave = false;

    /** Drop the tooltip now, discarding anything waiting on a frame. */
    const removeTooltip = () => {
      pending = null;
      pendingLeave = false;
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
      }
      hoverTooltip.current?.remove();
      hoverTooltip.current = null;
    };

    const drawPending = () => {
      pendingFrame = 0;
      const next = pending;
      const leaving = pendingLeave;
      pending = null;
      pendingLeave = false;
      // A move seen this frame means the pointer is still over one of this
      // layer's style layers, whichever one it left.
      if (!next) {
        if (leaving) removeTooltip();
        return;
      }
      // Read the layer from the store rather than from a captured array, so an
      // edit to the tooltip's fields shows on the very next pointer move.
      const layer = useAppStore.getState().layers.find((item) => item.id === next.layerId);
      if (!layer) {
        removeTooltip();
        return;
      }
      const content = createHoverTooltipElement(layer.name, next.feature.properties ?? {}, {
        popup: layer.popup,
        fieldVisibility: layer.fieldVisibility,
        feature: next.feature,
        zoom: map.getZoom(),
      });
      if (!content) {
        removeTooltip();
        return;
      }
      if (!hoverTooltip.current) {
        hoverTooltip.current = new maplibregl.Popup({
          className: "geolibre-hover-tooltip",
          closeButton: false,
          closeOnClick: false,
          // The tip must never sit under the cursor, or it would steal the
          // pointer from the feature and flicker itself in and out.
          offset: 12,
          maxWidth: "280px",
        }).addTo(map);
      }
      hoverTooltip.current
        .setMaxWidth(`min(${(resolvePopupMaxWidth(layer.popup) ?? 256) + 24}px, calc(100% - 24px))`)
        .setLngLat(next.lngLat)
        .setDOMContent(content);
    };

    const handleLeave = () => {
      pendingLeave = true;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(drawPending);
    };

    /** Build the pointer handler for one hovered layer. */
    const moveHandlerFor = (layerId: string) => (event: maplibregl.MapLayerMouseEvent) => {
      // A selection gesture owns the pointer while it draws, and the Identify
      // crosshair means the user is about to click for the full popup: neither
      // wants a tip trailing the cursor.
      if (featureSelectionActive.current || useAppStore.getState().identifyLayerId) {
        removeTooltip();
        return;
      }
      const feature = event.features?.[0];
      if (!feature) {
        removeTooltip();
        return;
      }
      pending = { layerId, feature, lngLat: event.lngLat };
      pendingLeave = false;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(drawPending);
    };

    // Style-layer id -> the handler bound to it, so unbinding detaches the very
    // same function reference MapLibre was given.
    let bound: {
      id: string;
      move: (event: maplibregl.MapLayerMouseEvent) => void;
    }[] = [];
    const unbind = () => {
      for (const entry of bound) {
        map.off("mousemove", entry.id, entry.move);
        map.off("mouseleave", entry.id, handleLeave);
      }
      bound = [];
    };
    const bind = () => {
      unbind();
      const layersById = new Map(useAppStore.getState().layers.map((layer) => [layer.id, layer]));
      for (const layerId of hoverLayerIds) {
        const layer = layersById.get(layerId);
        if (!layer) continue;
        const move = moveHandlerFor(layerId);
        for (const styleLayerId of identifyStyleLayerIds(layer)) {
          if (!map.getLayer(styleLayerId)) continue;
          map.on("mousemove", styleLayerId, move);
          map.on("mouseleave", styleLayerId, handleLeave);
          bound.push({ id: styleLayerId, move });
        }
      }
    };

    bind();
    // syncLayers creates the style layers and then dispatches this event, so
    // re-bind on it to catch layers that did not exist yet on the first run.
    window.addEventListener("geolibre-layer-labels-change", bind);
    // A selection gesture takes the pointer the same way Identify does, and can
    // be armed from a menu with the cursor sitting still on a hovered feature.
    window.addEventListener(FEATURE_SELECTION_BEGIN_EVENT, removeTooltip);
    // Identify is armed from the toolbar, with no pointer event to hide a tip
    // that is already open. `mouseleave` does not fire under a motionless
    // cursor, so without this the tooltip would sit there while the Identify
    // popup opened beside it. Same off->on guard as the photo-popup effect:
    // this listener runs on every store change, so testing the current value
    // alone would keep clearing a tip the user is still reading.
    const unsubscribeIdentify = useAppStore.subscribe((state, prev) => {
      if (state.identifyLayerId && !prev.identifyLayerId) removeTooltip();
    });

    return () => {
      window.removeEventListener("geolibre-layer-labels-change", bind);
      window.removeEventListener(FEATURE_SELECTION_BEGIN_EVENT, removeTooltip);
      unsubscribeIdentify();
      unbind();
      removeTooltip();
    };
  }, [hoverTooltipKey]);

  useEffect(() => {
    controller.current?.applyView(mapView);
  }, [mapView.center[0], mapView.center[1], mapView.zoom, mapView.bearing, mapView.pitch]);

  // The map container sits inside a host element React owns. A control may
  // reparent the container (the Time Slider wraps it in a flex column to dock
  // its timeline below the map) and only undoes that when the map is torn down,
  // which runs after React has already removed this component's DOM. React
  // removes the host, which stays where it put it, instead of the container,
  // so a renderer swap with such a control mounted no longer throws
  // "removeChild: the node to be removed is not a child of this node".
  return (
    <div className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />
    </div>
  );
});
