import { useAppStore } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
}

export function MapCanvas({ controllerRef }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);

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
      updateView();
    });

    return () => {
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
    });
    controller.current?.setStyle(basemapStyleUrl);
  }, [basemapStyleUrl]);

  useEffect(() => {
    controller.current?.waitAndSyncLayers(layers);
  }, [layers]);

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
}
