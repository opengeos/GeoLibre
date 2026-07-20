import type { MapViewState, GeoLibreLayer } from "@geolibre/core";

export type EngineId = "maplibre" | "arcgis-scene";

export function getEngineIdFromUrl(): EngineId {
  if (typeof window === "undefined") return "maplibre";
  const params = new URLSearchParams(window.location.search);
  const engine = params.get("engine")?.toLowerCase();
  if (engine === "arcgis-scene") {
    return "arcgis-scene";
  }
  return "maplibre";
}

export type MapEngineEvent =
  | "moveend"
  | "click"
  | "load"
  | "error"
  | "mousemove"
  | "mouseout"
  | "projectiontransition";

export type Handler = (event: any) => void;
export type Unsubscribe = () => void;

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface HitFeature {
  layerId: string;
  featureId: string;
  properties: Record<string, unknown>;
  coordinate: [number, number];
}

export interface MapEngine {
  mount(container: HTMLElement, initialView: MapViewState): Promise<void>;
  destroy(): void;
  applyView(view: MapViewState): void;
  readView(): MapViewState;
  syncLayers(layers: GeoLibreLayer[]): void;
  supportsLayer(layer: GeoLibreLayer): boolean;
  hitTest(point: ScreenPoint): Promise<HitFeature[]>;
  on(event: MapEngineEvent, handler: Handler): Unsubscribe;
}
