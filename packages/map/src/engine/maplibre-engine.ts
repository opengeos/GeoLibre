import { useAppStore } from "@geolibre/core";
import type { MapViewState, GeoLibreLayer } from "@geolibre/core";
import type { MapEngine, MapEngineEvent, Handler, Unsubscribe, ScreenPoint, HitFeature } from "./types";
import { createMapController } from "../map-controller";
import type { MapController } from "../map-controller";
import type maplibregl from "maplibre-gl";

export class MapLibreEngine implements MapEngine {
  private controller: MapController | null = null;
  private viewId?: string;

  constructor(viewId?: string) {
    this.viewId = viewId;
  }

  getController(): MapController | null {
    return this.controller;
  }

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    const state = useAppStore.getState();
    this.controller = createMapController();
    this.controller.init(container, {
      styleUrl: state.basemapStyleUrl,
      mapView: initialView,
      mapPreferences: state.preferences.map,
      controlVisibility: this.viewId ? { "layer-control": false } : undefined,
    });
  }

  destroy(): void {
    if (this.controller) {
      this.controller.destroy();
      this.controller = null;
    }
  }

  applyView(view: MapViewState): void {
    this.controller?.applyView(view);
  }

  readView(): MapViewState {
    return this.controller
      ? this.controller.readView()
      : { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 };
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    this.controller?.waitAndSyncLayers(layers);
  }

  supportsLayer(layer: GeoLibreLayer): boolean {
    // MapLibre is the primary 2D engine and supports all layer types
    return true;
  }

  async hitTest(point: ScreenPoint): Promise<HitFeature[]> {
    const map = this.controller?.getMap();
    if (!map) return [];

    const features = map.queryRenderedFeatures([point.x, point.y]);
    return features.map((f) => {
      let coord: [number, number] = [0, 0];
      if (f.geometry && f.geometry.type === "Point") {
        coord = f.geometry.coordinates as [number, number];
      }
      return {
        layerId: f.layer.id,
        featureId: String(f.id ?? ""),
        properties: (f.properties as Record<string, unknown>) ?? {},
        coordinate: coord,
      };
    });
  }

  on(event: MapEngineEvent, handler: Handler): Unsubscribe {
    const map = this.controller?.getMap();
    if (!map) return () => {};

    if (event === "click") {
      const clickHandler = (e: any) => {
        handler({
          point: e.point,
          lngLat: [e.lngLat.lng, e.lngLat.lat],
          originalEvent: e.originalEvent,
        });
      };
      map.on("click", clickHandler);
      return () => map.off("click", clickHandler);
    }

    if (event === "moveend") {
      const moveendHandler = (e: any) => {
        handler({
          originalEvent: e.originalEvent,
        });
      };
      map.on("moveend", moveendHandler);
      return () => map.off("moveend", moveendHandler);
    }

    map.on(event as any, handler);
    return () => map.off(event as any, handler);
  }
}
