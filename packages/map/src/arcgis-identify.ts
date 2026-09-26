import {
  effectiveLayerRenderState,
  IDENTIFY_ALL_LAYERS_ID,
  identifyAllIncludes,
  isDuckDBQueryLayer,
  isPopupClickEnabled,
  NETCDF_IMAGE_SOURCE_KIND,
  resolveLayerCapabilities,
  resolvePopupMaxWidth,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import { createIdentifyPopupElement, identifyPopupShellMaxWidth } from "./feature-popup";
import {
  createGlobalIdentifyPopupElement,
  type GlobalIdentifyHit,
  type MapCanvasIdentifyAllLabels,
} from "./identify-all-popup";
import {
  duckDBBridge,
  fetchWmsIdentifyProperties,
  isAbortError,
  isPixelIdentifyLayer,
  isWmsLayer,
  pixelIdentifyProperties,
  timeSliderBridge,
} from "./identify-sources";
import { createIdentifyPopupState, restoreIdentifySelection } from "./map-identify-lifecycle";
import type { IdentifiedFeature } from "./map-engine";
import type { MapCanvasRasterIdentify } from "./MapCanvas";

type ScreenPoint = { x: number; y: number };

/** What the ArcGIS identify flow needs from its canvas. */
export interface ArcgisIdentifyHost {
  /** The engine's asynchronous hit test (every layer, or one). */
  identifyFeaturesAt(point: ScreenPoint, layerId?: string): Promise<IdentifiedFeature[]>;
  /** The geographic position of a screen point, or null off the map. */
  toLngLat(point: ScreenPoint): [number, number] | null;
  /** The camera's zoom, for popup templates and GetFeatureInfo scale. */
  zoom(): number;
  /**
   * Show `content` anchored at `lngLat`, replacing any open popup. `onClose`
   * runs when the user closes it (not when it is replaced).
   */
  showPopup(
    lngLat: [number, number],
    content: HTMLElement,
    maxWidth: string,
    onClose?: () => void,
  ): void;
  /** Remove the open popup, if any, without running its `onClose`. */
  removePopup(): void;
  labels(): MapCanvasIdentifyAllLabels;
  identifyRaster(): MapCanvasRasterIdentify | undefined;
}

/**
 * The Identify click flow on the ArcGIS map, matching the MapLibre and Mapbox
 * canvases: one layer's features (with its popup template, field visibility
 * and selection hand-off), WMS GetFeatureInfo, Time Slider pixels and DuckDB
 * picks, or every visible layer grouped in one "Identify visible layers"
 * popup. Asynchronous reads show a loading popup; a later click supersedes an
 * earlier one's result.
 *
 * @param host - The canvas services the flow draws through.
 * @returns `click` for an Identify click, and `dispose` to drop pending reads.
 */
export function createArcgisIdentify(host: ArcgisIdentifyHost): {
  click(point: ScreenPoint): void;
  dispose(): void;
} {
  let pending: AbortController | null = null;
  /** The layer an "Identify visible layers" click selected, released on a miss. */
  let activatedLayerId: string | null = null;

  const supersede = () => {
    pending?.abort();
    const abort = new AbortController();
    pending = abort;
    return abort.signal;
  };
  const clearSelection = () => useAppStore.getState().selectFeature(null);

  /** Show a loading popup, then whatever `load` resolves to, unless superseded. */
  const identifyAsync = (
    lngLat: [number, number],
    loading: HTMLElement,
    maxWidth: string,
    load: (signal: AbortSignal) => Promise<(() => void) | null>,
  ) => {
    const signal = supersede();
    host.showPopup(lngLat, loading, maxWidth, () => pending?.abort());
    const settle = (show: (() => void) | null) => {
      if (signal.aborted) return;
      pending = null;
      show?.();
    };
    void load(signal).then(settle, () => settle(() => host.removePopup()));
  };

  const hitToGlobal = (hit: IdentifiedFeature, layer: GeoLibreLayer): GlobalIdentifyHit => ({
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
  });

  const showIdentifyAll = (lngLat: [number, number], point: ScreenPoint) => {
    const next = useAppStore.getState();
    const labels = host.labels();
    const groupById = new Map(next.layerGroups.map((group) => [group.id, group]));
    const eligibleLayers = next.layers.filter(
      (candidate) =>
        identifyAllIncludes(candidate.id, next.identifyLayerIds) &&
        effectiveLayerRenderState(candidate, groupById).visible &&
        resolveLayerCapabilities(candidate).query &&
        isPopupClickEnabled(candidate.popup),
    );
    const eligible = new Map(eligibleLayers.map((candidate) => [candidate.id, candidate]));
    const activate = (hit: GlobalIdentifyHit) => {
      const store = useAppStore.getState();
      store.selectLayer(hit.layer.id);
      store.selectFeature(hit.featureId);
      activatedLayerId = hit.layer.id;
    };
    const finish = (allHits: GlobalIdentifyHit[]) => {
      const order = new Map(
        useAppStore.getState().layers.map((candidate, index) => [candidate.id, index]),
      );
      allHits.sort((a, b) => (order.get(b.layer.id) ?? -1) - (order.get(a.layer.id) ?? -1));
      host.removePopup();
      if (allHits.length === 0) {
        const store = useAppStore.getState();
        store.selectFeature(null);
        // A layer the user picked in the Layers panel is theirs to keep.
        if (activatedLayerId !== null && store.selectedLayerId === activatedLayerId)
          store.selectLayer(null);
        activatedLayerId = null;
        return;
      }
      activate(allHits[0]);
      // One popup holds several layers, so it takes the widest width any of
      // them asked for.
      const widest = allHits.reduce<number | undefined>((widestSoFar, hit) => {
        const configured = resolvePopupMaxWidth(hit.layer.popup);
        if (configured === undefined) return widestSoFar;
        return widestSoFar === undefined ? configured : Math.max(widestSoFar, configured);
      }, undefined);
      host.showPopup(
        lngLat,
        createGlobalIdentifyPopupElement(allHits, host.zoom(), activate, labels, widest),
        identifyPopupShellMaxWidth(widest ? { maxWidth: widest } : undefined),
      );
    };
    const asyncLayers = eligibleLayers.filter(
      (candidate) =>
        isWmsLayer(candidate) ||
        isPixelIdentifyLayer(candidate) ||
        candidate.type === "cog" ||
        candidate.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND,
    );
    const zoom = host.zoom();
    const identifyRaster = host.identifyRaster();
    const load = async (signal: AbortSignal) => {
      const vectorHits = (await host.identifyFeaturesAt(point).catch(() => [])).flatMap((hit) => {
        const layer = eligible.get(hit.layerId);
        return layer ? [hitToGlobal(hit, layer)] : [];
      });
      // DuckDB query layers draw through deck.gl and hold no native graphics.
      for (const candidate of eligibleLayers) {
        if (!isDuckDBQueryLayer(candidate)) continue;
        const result = duckDBBridge()?.identifyLayerAtPoint?.(candidate.id, point);
        if (result)
          vectorHits.push({
            layer: candidate,
            properties: result.properties,
            featureId: result.featureId,
          });
      }
      const asyncHits = await Promise.all(
        asyncLayers.map(async (candidate): Promise<GlobalIdentifyHit | null> => {
          try {
            if (isWmsLayer(candidate)) {
              const result = await fetchWmsIdentifyProperties(candidate, lngLat, zoom, signal);
              if (
                !result ||
                (result.featureId == null && Object.keys(result.properties).length === 0)
              )
                return null;
              return {
                layer: candidate,
                properties: result.properties,
                featureId: result.featureId == null ? null : String(result.featureId),
              };
            }
            // Before the pixel branch on purpose: the NetCDF dialog marks its
            // layers `pixelIdentify` too, and the Time Slider bridge knows
            // nothing about a retained NetCDF grid.
            if (
              candidate.metadata.sourceKind !== NETCDF_IMAGE_SOURCE_KIND &&
              isPixelIdentifyLayer(candidate)
            ) {
              const result = await timeSliderBridge()?.identifyPixelAt?.(candidate.id, lngLat, {
                signal,
              });
              return result
                ? {
                    layer: candidate,
                    properties: pixelIdentifyProperties(result),
                    featureId: null,
                    title: labels.pixel,
                  }
                : null;
            }
            const result = await identifyRaster?.(candidate, lngLat, { signal });
            return result
              ? {
                  layer: candidate,
                  properties: result.properties,
                  featureId: null,
                  title: result.title ?? labels.pixel,
                }
              : null;
          } catch (error: unknown) {
            if (signal.aborted || isAbortError(error)) return null;
            return {
              layer: candidate,
              properties: {
                [labels.errorLabel]: error instanceof Error ? error.message : labels.error,
              },
              featureId: null,
            };
          }
        }),
      );
      return () =>
        finish([...vectorHits, ...asyncHits.filter((hit): hit is GlobalIdentifyHit => !!hit)]);
    };
    if (asyncLayers.length === 0) {
      // The hit test is asynchronous here even without remote layers, but it
      // answers in a frame; no loading popup for it.
      const signal = supersede();
      void load(signal).then((show) => {
        if (signal.aborted) return;
        pending = null;
        show();
      });
      return;
    }
    clearSelection();
    identifyAsync(
      lngLat,
      createIdentifyPopupElement(labels.loadingTitle, { status: labels.loading }),
      identifyPopupShellMaxWidth(undefined),
      load,
    );
  };

  /** One layer with no native graphics to hit: WMS, Time Slider pixels, DuckDB. */
  const identifyNonVector = (
    layer: GeoLibreLayer,
    lngLat: [number, number],
    point: ScreenPoint,
  ): boolean => {
    const maxWidth = identifyPopupShellMaxWidth(layer.popup);
    const labels = host.labels();
    const message = (text: string) => createIdentifyPopupElement(layer.name, { status: text });
    if (isPixelIdentifyLayer(layer)) {
      clearSelection();
      const identifyPixelAt = timeSliderBridge()?.identifyPixelAt;
      if (!identifyPixelAt) {
        pending?.abort();
        host.removePopup();
        return true;
      }
      identifyAsync(lngLat, message(labels.loading), maxWidth, async (signal) => {
        try {
          const result = await identifyPixelAt(layer.id, lngLat, { signal });
          // A null result is a click off the image grid: a miss, not a failure.
          const content = result
            ? createIdentifyPopupElement(layer.name, pixelIdentifyProperties(result))
            : message(labels.noData);
          return () => host.showPopup(lngLat, content, maxWidth);
        } catch (error: unknown) {
          if (signal.aborted || isAbortError(error)) return null;
          const text = error instanceof Error ? error.message : labels.pixelReadFailed;
          return () => host.showPopup(lngLat, message(text), maxWidth);
        }
      });
      return true;
    }
    if (isWmsLayer(layer)) {
      clearSelection();
      const zoom = host.zoom();
      identifyAsync(lngLat, message(labels.loading), maxWidth, async (signal) => {
        try {
          const result = await fetchWmsIdentifyProperties(layer, lngLat, zoom, signal);
          const content = createIdentifyPopupElement(
            layer.name,
            result?.properties ?? {},
            result?.featureId,
          );
          return () => host.showPopup(lngLat, content, maxWidth);
        } catch (error: unknown) {
          if (signal.aborted || isAbortError(error)) return null;
          const text = error instanceof Error ? error.message : labels.wmsFailed;
          return () => host.showPopup(lngLat, message(text), maxWidth);
        }
      });
      return true;
    }
    if (isDuckDBQueryLayer(layer)) {
      pending?.abort();
      const result = duckDBBridge()?.identifyLayerAtPoint?.(layer.id, point);
      if (!result) {
        host.removePopup();
        clearSelection();
        return true;
      }
      useAppStore.getState().selectFeature(result.featureId);
      host.showPopup(
        lngLat,
        createIdentifyPopupElement(layer.name, result.properties, result.featureId, {
          popup: layer.popup,
          fieldVisibility: layer.fieldVisibility,
          zoom: host.zoom(),
        }),
        maxWidth,
      );
      return true;
    }
    return false;
  };

  /** One layer's native features: the first hit, with its popup template. */
  const identifyVector = (layer: GeoLibreLayer, lngLat: [number, number], point: ScreenPoint) => {
    const signal = supersede();
    void host
      .identifyFeaturesAt(point, layer.id)
      .catch(() => [] as IdentifiedFeature[])
      .then((matches) => {
        if (signal.aborted) return;
        pending = null;
        const next = useAppStore.getState();
        const match = matches.find((hit) => {
          const candidate = next.layers.find((l) => l.id === hit.layerId);
          return candidate && isPopupClickEnabled(candidate.popup);
        });
        host.removePopup();
        if (!match) {
          next.selectFeature(null);
          return;
        }
        const target = next.layers.find((l) => l.id === match.layerId) ?? layer;
        // Closing the popup gives the selection back to what it was.
        const state = createIdentifyPopupState({
          layerId: match.layerId,
          featureId: match.featureId,
          onClose: () => restoreIdentifySelection(state),
        });
        if (next.selectedLayerId !== match.layerId) next.selectLayer(match.layerId);
        next.selectFeature(match.featureId);
        const feature = match.geometry
          ? {
              type: "Feature" as const,
              properties: match.properties,
              geometry: match.geometry,
              ...(match.featureId === null ? {} : { id: match.featureId }),
            }
          : undefined;
        host.showPopup(
          lngLat,
          createIdentifyPopupElement(target.name, match.properties, match.featureId ?? undefined, {
            popup: target.popup,
            fieldVisibility: target.fieldVisibility,
            feature,
            zoom: host.zoom(),
          }),
          identifyPopupShellMaxWidth(target.popup),
          state.onClose,
        );
      });
  };

  return {
    click(point) {
      const next = useAppStore.getState();
      if (!next.identifyLayerId) return;
      const lngLat = host.toLngLat(point);
      if (!lngLat) return;
      if (next.identifyLayerId === IDENTIFY_ALL_LAYERS_ID) {
        showIdentifyAll(lngLat, point);
        return;
      }
      const layer = next.layers.find((candidate) => candidate.id === next.identifyLayerId);
      if (!layer || !isPopupClickEnabled(layer.popup)) {
        pending?.abort();
        host.removePopup();
        clearSelection();
        return;
      }
      // COG layers are read by the raster control's own pixel inspector and a
      // NetCDF grid by the NetCDF identify, as on the other maps.
      if (layer.type === "cog" || layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) return;
      if (identifyNonVector(layer, lngLat, point)) return;
      identifyVector(layer, lngLat, point);
    },
    dispose() {
      pending?.abort();
      pending = null;
    },
  };
}
