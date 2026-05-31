import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { memo, useEffect, useRef } from "react";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
} from "./geojson-loader";
import {
  externalExtrusionLayerId,
  mbtilesStyleLayerIds,
  vectorTileStyleLayerIds,
} from "./layer-sync";
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
const MAX_IDENTIFY_PROPERTIES = 24;

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
}

function stringifyIdentifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function createIdentifyPopupElement(
  layerName: string,
  properties: Record<string, unknown>,
  featureId?: string | number,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "min-w-48 max-w-80 text-xs";

  const title = document.createElement("div");
  title.className = "mb-2 font-semibold text-foreground";
  title.textContent = layerName;
  root.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "max-h-64 overflow-auto";
  root.appendChild(rows);

  const appendRow = (key: string, value: unknown) => {
    const row = document.createElement("div");
    row.className =
      "grid grid-cols-[minmax(5rem,0.45fr)_1fr] gap-2 border-t py-1";

    const keyCell = document.createElement("div");
    keyCell.className = "break-words font-medium text-muted-foreground";
    keyCell.textContent = key;

    const valueCell = document.createElement("div");
    valueCell.className = "break-words text-foreground";
    valueCell.textContent = stringifyIdentifyValue(value);

    row.append(keyCell, valueCell);
    rows.appendChild(row);
  };

  if (featureId != null) appendRow("id", featureId);

  const entries = Object.entries(properties).slice(0, MAX_IDENTIFY_PROPERTIES);
  if (entries.length === 0 && featureId == null) {
    const empty = document.createElement("div");
    empty.className = "text-muted-foreground";
    empty.textContent = "No attributes";
    rows.appendChild(empty);
  } else {
    for (const [key, value] of entries) appendRow(key, value);
  }

  return root;
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
    circleLayerId(layer.id),
    lineLayerId(layer.id),
    fillExtrusionLayerId(layer.id),
    fillLayerId(layer.id),
    ...vectorTileStyleLayerIds(layer),
  ];
}

function findFeatureId(
  layer: GeoLibreLayer,
  feature: maplibregl.MapGeoJSONFeature,
): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;

  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  const index = layer.geojson.features.findIndex((candidate) => {
    const candidateProperties = candidate.properties ?? {};
    return propertyKeys.every(
      (key) => candidateProperties[key] === properties[key],
    );
  });

  return index >= 0 ? String(layer.geojson.features[index].id ?? index) : null;
}

export const MapCanvas = memo(function MapCanvas({
  controllerRef,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const previousSelectedFeatureKey = useRef<string | null>(null);
  const identifyPopup = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    if (!containerRef.current || controller.current) return;

    const mc = createMapController();
    const map = mc.init(containerRef.current, {
      styleUrl: basemapStyleUrl,
      mapView,
    });
    controller.current = mc;
    if (controllerRef) controllerRef.current = mc;

    map.on("mousemove", (e) => {
      setPointerCoords([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("mouseout", () => setPointerCoords(null));

    const updateView = (event?: { originalEvent?: unknown }) =>
      setMapView(mc.readView(), Boolean(event?.originalEvent));
    map.on("moveend", updateView);
    map.on("load", () => {
      mc.waitAndSyncLayers(useAppStore.getState().layers);
      mc.setBasemapVisible(useAppStore.getState().basemapVisible);
      mc.setBasemapOpacity(useAppStore.getState().basemapOpacity);
      const state = useAppStore.getState();
      mc.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        state.selectedFeatureId,
      );
      updateView();
    });

    let resizeFrame: number | null = null;
    let panelResizeActive = false;
    let resizeAfterPanelResize = false;
    const resizeMap = () => {
      if (panelResizeActive) {
        resizeAfterPanelResize = true;
        return;
      }

      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        mc.getMap()?.resize();
      });
    };
    const onPanelResizeStart = () => {
      panelResizeActive = true;
      resizeAfterPanelResize = false;
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
    };
    const onPanelResizeEnd = () => {
      panelResizeActive = false;
      if (resizeAfterPanelResize) {
        resizeAfterPanelResize = false;
      }
      resizeMap();
    };
    const resizeObserver = new ResizeObserver(resizeMap);
    resizeObserver.observe(containerRef.current);
    window.addEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
    window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
    resizeMap();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
      window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      mc.destroy();
      controller.current = null;
      if (controllerRef) controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevBasemap = useRef(basemapStyleUrl);
  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || prevBasemap.current === basemapStyleUrl) return;
    prevBasemap.current = basemapStyleUrl;
    map.once("style.load", () => {
      controller.current?.waitAndSyncLayers(useAppStore.getState().layers);
      controller.current?.setBasemapVisible(
        useAppStore.getState().basemapVisible,
      );
      controller.current?.setBasemapOpacity(
        useAppStore.getState().basemapOpacity,
      );
      const state = useAppStore.getState();
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        state.selectedFeatureId,
      );
    });
    controller.current?.setStyle(basemapStyleUrl);
  }, [basemapStyleUrl]);

  useEffect(() => {
    controller.current?.setBasemapVisible(basemapVisible);
  }, [basemapVisible]);

  useEffect(() => {
    controller.current?.setBasemapOpacity(basemapOpacity);
  }, [basemapOpacity]);

  useEffect(() => {
    controller.current?.waitAndSyncLayers(layers);
  }, [layers]);

  useEffect(() => {
    const layer = layers.find((item) => item.id === selectedLayerId);
    const nextKey =
      selectedLayerId && selectedFeatureId
        ? `${selectedLayerId}:${selectedFeatureId}`
        : null;
    const shouldFit = Boolean(
      zoomToSelectedFeature &&
      nextKey &&
      nextKey !== previousSelectedFeatureKey.current,
    );
    previousSelectedFeatureKey.current = nextKey;
    controller.current?.highlightFeature(layer, selectedFeatureId, {
      fit: shouldFit,
    });
  }, [layers, selectedLayerId, selectedFeatureId, zoomToSelectedFeature]);

  useEffect(() => {
    const map = controller.current?.getMap();
    const layer = layers.find((item) => item.id === identifyLayerId);
    if (!map || !layer) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      if (map) map.getCanvas().style.cursor = "";
      return;
    }

    map.getCanvas().style.cursor = "crosshair";

    const handleIdentifyClick = (event: maplibregl.MapMouseEvent) => {
      const clearIdentifyResult = () => {
        selectFeature(null);
        identifyPopup.current?.remove();
        identifyPopup.current = null;
      };

      const queryLayerIds = identifyStyleLayerIds(layer).filter((id) =>
        map.getLayer(id),
      );
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
      selectFeature(featureId);

      identifyPopup.current?.remove();
      identifyPopup.current = new maplibregl.Popup({
        className: "geolibre-identify-popup",
        closeButton: true,
        closeOnClick: false,
        maxWidth: "360px",
      })
        .setLngLat(event.lngLat)
        .setDOMContent(
          createIdentifyPopupElement(
            layer.name,
            feature.properties ?? {},
            featureId ?? feature.id,
          ),
        )
        .addTo(map);
    };

    map.on("click", handleIdentifyClick);

    return () => {
      map.off("click", handleIdentifyClick);
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      map.getCanvas().style.cursor = "";
    };
  }, [identifyLayerId, layers, selectFeature]);

  useEffect(() => {
    controller.current?.applyView(mapView);
  }, [
    mapView.center[0],
    mapView.center[1],
    mapView.zoom,
    mapView.bearing,
    mapView.pitch,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-testid="map-canvas"
    />
  );
});
