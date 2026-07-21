import type { MapEngine, MapEngineEvent, Handler, Unsubscribe, ScreenPoint, HitFeature } from "./types";
import type { MapViewState, GeoLibreLayer } from "@geolibre/core";
import { getArcGISApiKey } from "@geolibre/core";

export function isArcGIS2DSupportedLayerType(layer: GeoLibreLayer): boolean {
  const IMAGERY_TYPES = new Set(["raster", "xyz", "wms", "wmts"]);
  return layer.type === "geojson" || IMAGERY_TYPES.has(layer.type);
}

function getRendererForGeoJSON(layer: GeoLibreLayer) {
  const style = layer.style ?? {};
  const fillColor = style.fillColor ?? "#3b82f6";
  const strokeColor = style.strokeColor ?? "#1d4ed8";
  const strokeWidth = style.strokeWidth ?? 2;
  const markerColor = style.markerColor ?? fillColor;

  let hasPolygon = false;
  let hasLine = false;
  let hasPoint = false;
  if (layer.geojson?.features) {
    for (const f of layer.geojson.features) {
      const type = f.geometry?.type;
      if (type === "Polygon" || type === "MultiPolygon") hasPolygon = true;
      if (type === "LineString" || type === "MultiLineString") hasLine = true;
      if (type === "Point" || type === "MultiPoint") hasPoint = true;
    }
  }

  let symbol: any = {
    type: "simple-fill",
    color: fillColor,
    outline: { color: strokeColor, width: strokeWidth }
  };
  if (hasPoint && !hasPolygon && !hasLine) {
    symbol = {
      type: "simple-marker",
      color: markerColor,
      outline: { color: strokeColor, width: strokeWidth }
    };
  } else if (hasLine && !hasPolygon) {
    symbol = {
      type: "simple-line",
      color: strokeColor,
      width: strokeWidth
    };
  }

  return {
    type: "simple",
    symbol
  };
}

export class ArcGISMapController {
  private engine: ArcGISMapEngine;

  constructor(engine: ArcGISMapEngine) {
    this.engine = engine;
  }

  getMap() {
    return (this.engine as any).view;
  }

  waitAndSyncLayers(layers: GeoLibreLayer[]) {
    this.engine.syncLayers(layers);
  }

  setStyle(basemapStyleUrl: string) {
    // Optionally update style
  }

  setBasemapVisible(visible: boolean) {
    this.engine.setBasemapVisible(visible);
  }

  setBasemapOpacity(opacity: number) {
    this.engine.setBasemapOpacity(opacity);
  }

  applyMapPreferences(preferences: any) {
    // Preferences sync
  }

  applyView(view: MapViewState) {
    this.engine.applyView(view);
  }

  readView() {
    return this.engine.readView();
  }

  highlightFeature(layer: any, highlightIds: any, options?: any) {
    // No-op stub
  }

  fitBounds(bounds: [number, number, number, number], options?: any) {
    // No-op stub
  }

  readProjection() {
    return "mercator";
  }

  destroy() {
    this.engine.destroy();
  }
}

export class ArcGISMapEngine implements MapEngine {
  private view: any | null = null;
  private container: HTMLElement | null = null;
  private listeners: Map<MapEngineEvent, Set<Handler>> = new Map();
  private activeLayers: Map<string, { layer: GeoLibreLayer; handle: any }> = new Map();
  private basemapVisible = true;
  private basemapOpacity = 1.0;
  private lastAppliedView: MapViewState | null = null;
  private viewId: string;
  private stationaryWatcher: any | null = null;

  constructor(viewId: string) {
    this.viewId = viewId;
  }

  getController() {
    return new ArcGISMapController(this);
  }

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    this.container = container;

    // Dynamically load ArcGIS dependencies
    const [
      { default: Map },
      { default: MapView },
      { default: esriConfig }
    ] = await Promise.all([
      import("@arcgis/core/Map"),
      import("@arcgis/core/views/MapView"),
      import("@arcgis/core/config")
    ]);

    // Setup local assets and optional API Key
    const appBaseUrl = (import.meta as any).env?.BASE_URL ?? "/";
    esriConfig.assetsPath = `${appBaseUrl}esri`;

    const key = getArcGISApiKey();
    if (key) {
      esriConfig.apiKey = key;
    }

    const map = new Map({
      basemap: "osm"
    });

    this.view = new MapView({
      container: container as any,
      map,
      ui: {
        components: [] // disable default UI controls in grid panes
      }
    });

    const viewAny = this.view as any;
    viewAny.getLayer = () => null;
    viewAny.getSource = () => null;
    viewAny.addSource = () => {};
    viewAny.removeSource = () => {};
    viewAny.addLayer = () => {};
    viewAny.removeLayer = () => {};
    viewAny.once = (event: string, handler: any) => {};
    viewAny.getCanvas = () => ({
      style: { cursor: "" }
    });

    this.applyView(initialView);

    await this.view.when();

    this.stationaryWatcher = this.view.watch("stationary", (isStationary: boolean) => {
      if (isStationary) {
        this.trigger("moveend");
      }
    });

    this.trigger("load");
  }

  destroy(): void {
    if (this.stationaryWatcher) {
      this.stationaryWatcher.remove();
      this.stationaryWatcher = null;
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.activeLayers.clear();
    this.listeners.clear();
  }

  applyView(view: MapViewState): void {
    if (!this.view) return;
    this.lastAppliedView = view;
    this.view.goTo(
      {
        target: view.center,
        zoom: view.zoom,
        rotation: view.bearing,
      },
      { animate: false }
    );
  }

  readView(): MapViewState {
    if (!this.view) {
      return { center: [0, 0], zoom: 0, bearing: 0, pitch: 0 };
    }
    const center = this.view.center;
    let lng = 0;
    let lat = 0;
    if (center) {
      lng = center.longitude;
      lat = center.latitude;
    }

    let bearing = this.view.rotation ?? 0;
    if (bearing > 180) bearing -= 360;

    return {
      center: [lng, lat],
      zoom: Math.round((this.view.zoom ?? 0) * 100) / 100,
      bearing,
      pitch: 0, // MapView does not support pitch (always 2D)
    };
  }

  async syncLayers(layers: GeoLibreLayer[]): Promise<void> {
    if (!this.view) return;

    const [
      { default: GeoJSONLayer },
      { default: WebTileLayer },
      { default: WMSLayer },
      { default: WMTSLayer }
    ] = await Promise.all([
      import("@arcgis/core/layers/GeoJSONLayer"),
      import("@arcgis/core/layers/WebTileLayer"),
      import("@arcgis/core/layers/WMSLayer"),
      import("@arcgis/core/layers/WMTSLayer")
    ]);

    const isSupported = (layer: GeoLibreLayer) => {
      const source = layer.source as any;
      if (layer.type === "geojson") return Boolean(layer.geojson?.features?.length);
      if (layer.type === "wms") return Boolean(source?.url);
      return Boolean(source?.tiles?.[0]);
    };

    const newActiveLayers = new Map<string, { layer: GeoLibreLayer; handle: any }>();

    for (const layer of layers) {
      if (!isArcGIS2DSupportedLayerType(layer) || !isSupported(layer)) {
        continue;
      }

      const existingLayer = this.activeLayers.get(layer.id);
      const source = layer.source as any;

      if (existingLayer) {
        const needsRebuild = this.checkNeedsRebuild(existingLayer.layer, layer);
        if (!needsRebuild) {
          existingLayer.handle.visible = layer.visible;
          existingLayer.handle.opacity = layer.opacity;
          existingLayer.layer = layer;
          newActiveLayers.set(layer.id, existingLayer);
          continue;
        } else {
          this.view.map.remove(existingLayer.handle);
        }
      }

      let handle: any;
      if (layer.type === "geojson") {
        const geojsonUrl = URL.createObjectURL(
          new Blob([JSON.stringify(layer.geojson)], { type: "application/json" })
        );
        handle = new GeoJSONLayer({
          id: layer.id,
          url: geojsonUrl,
          visible: layer.visible,
          opacity: layer.opacity,
          renderer: getRendererForGeoJSON(layer) as any,
        });
      } else if (layer.type === "wms") {
        const layerNames = source?.params?.layers ?? source?.params?.LAYERS;
        const sublayers = layerNames
          ? layerNames.split(",").map((name: string) => ({ name }))
          : undefined;
        handle = new WMSLayer({
          id: layer.id,
          url: source?.url,
          visible: layer.visible,
          opacity: layer.opacity,
          sublayers,
        });
      } else if (layer.type === "wmts") {
        handle = new WMTSLayer({
          id: layer.id,
          url: source?.url,
          visible: layer.visible,
          opacity: layer.opacity,
        });
      } else {
        const url = source?.tiles?.[0] ?? "";
        handle = new WebTileLayer({
          id: layer.id,
          urlTemplate: url.replace(/{z}/g, "{level}").replace(/{x}/g, "{col}").replace(/{y}/g, "{row}"),
          visible: layer.visible,
          opacity: layer.opacity,
        });
      }

      this.view.map.add(handle);
      newActiveLayers.set(layer.id, { layer, handle });
    }

    for (const [id, entry] of this.activeLayers.entries()) {
      if (!newActiveLayers.has(id)) {
        this.view.map.remove(entry.handle);
      }
    }

    this.activeLayers = newActiveLayers;
  }

  private checkNeedsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
    if (prev.type !== next.type) return true;
    const prevSource = prev.source as any;
    const nextSource = next.source as any;
    if (prev.type === "geojson") {
      return prev.geojson !== next.geojson ||
        prev.style?.fillColor !== next.style?.fillColor ||
        prev.style?.strokeColor !== next.style?.strokeColor ||
        prev.style?.strokeWidth !== next.style?.strokeWidth;
    }
    return (prevSource?.tiles?.[0] !== nextSource?.tiles?.[0]) || prevSource?.url !== nextSource?.url;
  }

  supportsLayer(layer: GeoLibreLayer): boolean {
    return isArcGIS2DSupportedLayerType(layer);
  }

  async hitTest(point: ScreenPoint): Promise<HitFeature[]> {
    if (!this.view) return [];
    const response = await this.view.hitTest(point);
    const hits: HitFeature[] = [];
    if (response.results) {
      for (const result of response.results) {
        if (result.type === "graphic" && result.graphic) {
          const graphic = result.graphic;
          const layer = graphic.layer;
          const coordinate = result.mapPoint
            ? [result.mapPoint.longitude, result.mapPoint.latitude]
            : [0, 0];
          hits.push({
            layerId: layer?.id ?? "",
            featureId: String(graphic.attributes?.id ?? graphic.uid ?? ""),
            properties: graphic.attributes ?? {},
            coordinate: coordinate as [number, number],
          });
        }
      }
    }
    return hits;
  }

  setBasemapVisible(visible: boolean) {
    this.basemapVisible = visible;
    if (this.view?.map?.basemap?.baseLayers) {
      this.view.map.basemap.baseLayers.forEach((l: any) => {
        l.visible = visible;
      });
    }
  }

  setBasemapOpacity(opacity: number) {
    this.basemapOpacity = opacity;
    if (this.view?.map?.basemap?.baseLayers) {
      this.view.map.basemap.baseLayers.forEach((l: any) => {
        l.opacity = opacity;
      });
    }
  }

  on(event: MapEngineEvent, handler: Handler): Unsubscribe {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  private trigger(event: MapEngineEvent, payload?: any) {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }
}
