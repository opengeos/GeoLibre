import { useAppStore } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { memo, useEffect, useRef } from "react";
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
}

export const MapCanvas = memo(function MapCanvas({
  controllerRef,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const zoomToSelectedFeature = useAppStore(
    (s) => s.ui.zoomToSelectedFeature,
  );
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const previousSelectedFeatureKey = useRef<string | null>(null);

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
      const state = useAppStore.getState();
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        state.selectedFeatureId,
      );
    });
    controller.current?.setStyle(basemapStyleUrl);
  }, [basemapStyleUrl]);

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
      nextKey && nextKey !== previousSelectedFeatureKey.current,
    );
    previousSelectedFeatureKey.current = nextKey;
    controller.current?.highlightFeature(layer, selectedFeatureId, {
      fit: shouldFit,
    });
  }, [layers, selectedLayerId, selectedFeatureId, zoomToSelectedFeature]);

  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;
    map.jumpTo({
      center: mapView.center,
      zoom: mapView.zoom,
      bearing: mapView.bearing,
      pitch: mapView.pitch,
    });
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
