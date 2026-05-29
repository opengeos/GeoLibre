import { DEFAULT_BASEMAP } from "@geolibre/core";
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import maplibregl from "maplibre-gl";
import { LayerControl } from "maplibre-gl-layer-control";
import {
  circleLayerId,
  fillLayerId,
  getLayerBounds,
  highlightCircleLayerId,
  highlightFillLayerId,
  highlightLineLayerId,
  highlightSourceId,
  lineLayerId,
} from "./geojson-loader";
import { removeLayerFromMap, syncLayer } from "./layer-sync";

const DEFAULT_PROJECTION: maplibregl.ProjectionSpecification = {
  type: "globe",
};
const DEFAULT_MAX_PITCH = 85;
const TERRAIN_SOURCE_ID = "geolibre-terrain-dem";
const TERRAIN_SOURCE: maplibregl.RasterDEMSourceSpecification = {
  type: "raster-dem",
  tiles: [
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  ],
  tileSize: 256,
  maxzoom: 15,
  encoding: "terrarium",
  attribution:
    'Elevation tiles by <a href="https://registry.opendata.aws/terrain-tiles/">AWS Open Data Terrain Tiles</a>',
};
const TERRAIN_OPTIONS: maplibregl.TerrainSpecification = {
  source: TERRAIN_SOURCE_ID,
  exaggeration: 1,
};
const EMPTY_HIGHLIGHT: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

interface NamedLayerState {
  visible: boolean;
  opacity: number;
  name: string;
}

interface LayerControlConfig {
  layers?: string[];
  layerStates?: Record<string, NamedLayerState>;
}

interface GeoLibreLayerLabelWindow extends Window {
  __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
}

export type BuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "geolocate"
  | "globe"
  | "terrain"
  | "scale"
  | "attribution"
  | "logo"
  | "layer-control";

export const DEFAULT_BUILT_IN_CONTROL_VISIBILITY: Record<
  BuiltInMapControl,
  boolean
> = {
  navigation: true,
  fullscreen: true,
  geolocate: false,
  globe: true,
  terrain: false,
  scale: true,
  attribution: true,
  logo: false,
  "layer-control": true,
};

export const DEFAULT_BUILT_IN_CONTROL_POSITIONS: Record<
  BuiltInMapControl,
  maplibregl.ControlPosition
> = {
  navigation: "top-right",
  fullscreen: "top-right",
  geolocate: "top-right",
  globe: "top-right",
  terrain: "top-right",
  scale: "bottom-left",
  attribution: "bottom-right",
  logo: "bottom-left",
  "layer-control": "top-right",
};

export class MapController {
  private map: maplibregl.Map | null = null;
  private navigationControl: maplibregl.NavigationControl | null = null;
  private fullscreenControl: maplibregl.FullscreenControl | null = null;
  private geolocateControl: maplibregl.GeolocateControl | null = null;
  private globeControl: maplibregl.GlobeControl | null = null;
  private terrainControl: maplibregl.TerrainControl | null = null;
  private scaleControl: maplibregl.ScaleControl | null = null;
  private attributionControl: maplibregl.AttributionControl | null = null;
  private logoControl: maplibregl.LogoControl | null = null;
  private layerControl: LayerControl | null = null;
  private layerControlSignature = "";
  private basemapStyleUrl = DEFAULT_BASEMAP;
  private syncedLayers: GeoLibreLayer[] = [];
  private layerIds: string[] = [];
  private controlVisibility: Record<BuiltInMapControl, boolean> = {
    ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  };
  private controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    this.basemapStyleUrl = options.styleUrl ?? DEFAULT_BASEMAP;
    this.map = new maplibregl.Map({
      container,
      style: this.basemapStyleUrl,
      center: view?.center ?? [-100, 40],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      maxPitch: DEFAULT_MAX_PITCH,
      attributionControl: false,
      maplibreLogo: false,
    });
    this.map.on("style.load", () => {
      this.enforceDefaultProjection();
      this.addTerrainSource();
      this.addLayerControl();
    });
    this.map.once("load", () => {
      this.enforceDefaultProjection();
      this.addTerrainSource();
      this.addLayerControl();
    });
    this.map.once("idle", () => this.enforceDefaultProjection());
    this.addNavigationControl();
    this.addFullscreenControl();
    this.addGeolocateControl();
    this.addGlobeControl();
    this.addTerrainControl();
    this.addScaleControl();
    this.addAttributionControl();
    this.addLogoControl();
    return this.map;
  }

  getMap(): maplibregl.Map | null {
    return this.map;
  }

  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    this.map.addControl(control, position);
    return true;
  }

  removeControl(control: maplibregl.IControl): void {
    if (!this.map) return;
    try {
      this.map.removeControl(control);
    } catch {
      // MapLibre throws when a control has already been removed.
    }
  }

  setBuiltInControlVisible(
    control: BuiltInMapControl,
    visible: boolean,
  ): boolean {
    this.controlVisibility[control] = visible;

    if (visible) {
      if (control === "navigation") return this.addNavigationControl();
      if (control === "fullscreen") return this.addFullscreenControl();
      if (control === "geolocate") return this.addGeolocateControl();
      if (control === "globe") return this.addGlobeControl();
      if (control === "terrain") return this.addTerrainControl();
      if (control === "scale") return this.addScaleControl();
      if (control === "attribution") return this.addAttributionControl();
      if (control === "logo") return this.addLogoControl();
      return this.addLayerControl();
    }

    if (control === "navigation") this.removeNavigationControl();
    else if (control === "fullscreen") this.removeFullscreenControl();
    else if (control === "geolocate") this.removeGeolocateControl();
    else if (control === "globe") this.removeGlobeControl();
    else if (control === "terrain") this.removeTerrainControl();
    else if (control === "scale") this.removeScaleControl();
    else if (control === "attribution") this.removeAttributionControl();
    else if (control === "logo") this.removeLogoControl();
    else this.removeLayerControl();
    return true;
  }

  getBuiltInControlPosition(
    control: BuiltInMapControl,
  ): maplibregl.ControlPosition {
    return this.controlPositions[control];
  }

  setBuiltInControlPosition(
    control: BuiltInMapControl,
    position: maplibregl.ControlPosition,
  ): boolean {
    this.controlPositions[control] = position;
    if (!this.controlVisibility[control]) return true;

    this.removeBuiltInControl(control);
    return this.addBuiltInControl(control);
  }

  destroy(): void {
    this.removeNavigationControl();
    this.removeFullscreenControl();
    this.removeGeolocateControl();
    this.removeGlobeControl();
    this.removeTerrainControl();
    this.removeScaleControl();
    this.removeAttributionControl();
    this.removeLogoControl();
    this.removeLayerControl();
    this.map?.remove();
    this.map = null;
    this.publishLayerDisplayNames([]);
  }

  setStyle(url: string): void {
    if (!this.map) return;
    this.basemapStyleUrl = url;
    this.removeLayerControl();
    this.map.setStyle(url);
  }

  applyView(view: MapViewState): void {
    if (!this.map) return;
    this.map.jumpTo({
      center: view.center,
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
    });
  }

  readView(): MapViewState {
    if (!this.map) {
      return {
        center: [-100, 40],
        zoom: 2,
        bearing: 0,
        pitch: 0,
      };
    }
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    return {
      center: [c.lng, c.lat],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      pitch: this.map.getPitch(),
      bbox: [
        b.getWest(),
        b.getSouth(),
        b.getEast(),
        b.getNorth(),
      ],
    };
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map || !this.map.isStyleLoaded()) return;

    const nextIds = layers.map((l) => l.id);
    for (const id of this.layerIds) {
      if (!nextIds.includes(id)) {
        removeLayerFromMap(this.map, id);
      }
    }

    for (const [index, layer] of layers.entries()) {
      syncLayer(this.map, layer, this.getBeforeStyleLayerId(layers, index));
    }
    this.layerIds = nextIds;
    this.syncedLayers = layers;
    this.publishLayerDisplayNames(layers);
    this.refreshLayerControl(layers);
  }

  private styleLoadHandler: (() => void) | null = null;

  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map) return;

    if (this.styleLoadHandler) {
      this.map.off("style.load", this.styleLoadHandler);
    }

    const run = () => this.syncLayers(layers);
    this.styleLoadHandler = run;

    if (this.map.isStyleLoaded()) {
      run();
    } else {
      this.map.once("load", run);
    }
    this.map.on("style.load", run);
  }

  fitLayer(layer: GeoLibreLayer): void {
    const bounds = getLayerBounds(layer);
    if (!bounds || !this.map) return;
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, duration: 800 },
    );
  }

  fitBounds(bounds: [number, number, number, number]): void {
    if (!this.map) return;
    this.map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, duration: 800 },
    );
  }

  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | null,
    options: { fit?: boolean } = {},
  ): void {
    if (!this.map || !this.map.isStyleLoaded()) return;

    if (!layer?.geojson || !featureId) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      return;
    }

    const feature = this.findFeature(layer, featureId);
    if (!feature?.geometry) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      return;
    }

    const featureCollection: FeatureCollection = {
      type: "FeatureCollection",
      features: [feature as Feature<Geometry>],
    };
    this.syncHighlight(featureCollection);

    if (options.fit) {
      this.fitFeature(featureCollection);
    }
  }

  clearFeatureHighlight(): void {
    this.syncHighlight(EMPTY_HIGHLIGHT);
  }

  private enforceDefaultProjection(): void {
    if (!this.map) return;
    try {
      if (this.map.getProjection()?.type === DEFAULT_PROJECTION.type) return;
      this.map.setProjection(DEFAULT_PROJECTION);
    } catch {
      this.map.once("idle", () => this.enforceDefaultProjection());
    }
  }

  private findFeature(
    layer: GeoLibreLayer,
    featureId: string,
  ): Feature | undefined {
    return layer.geojson?.features.find(
      (feature, index) => String(feature.id ?? index) === featureId,
    );
  }

  private fitFeature(featureCollection: FeatureCollection): void {
    if (!this.map || featureCollection.features.length === 0) return;
    const box = bbox(featureCollection) as [number, number, number, number];
    if (box.some((value) => !Number.isFinite(value))) return;

    if (box[0] === box[2] && box[1] === box[3]) {
      this.map.flyTo({
        center: [box[0], box[1]],
        zoom: Math.max(this.map.getZoom(), 14),
        duration: 800,
      });
      return;
    }

    this.fitBounds(box);
  }

  private syncHighlight(featureCollection: FeatureCollection): void {
    if (!this.map || !this.map.isStyleLoaded()) return;

    const source = this.map.getSource(highlightSourceId());
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(featureCollection);
    } else {
      this.map.addSource(highlightSourceId(), {
        type: "geojson",
        data: featureCollection,
      });
    }

    this.ensureHighlightLayer({
      id: highlightFillLayerId(),
      type: "fill",
      source: highlightSourceId(),
      filter: [
        "match",
        ["geometry-type"],
        ["Polygon", "MultiPolygon"],
        true,
        false,
      ],
      paint: {
        "fill-color": "#facc15",
        "fill-opacity": 0.32,
        "fill-outline-color": "#111827",
      },
    });

    this.ensureHighlightLayer({
      id: highlightLineLayerId(),
      type: "line",
      source: highlightSourceId(),
      filter: [
        "match",
        ["geometry-type"],
        ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
        true,
        false,
      ],
      paint: {
        "line-color": "#facc15",
        "line-width": 5,
        "line-opacity": 0.9,
      },
    });

    this.ensureHighlightLayer({
      id: highlightCircleLayerId(),
      type: "circle",
      source: highlightSourceId(),
      filter: [
        "match",
        ["geometry-type"],
        ["Point", "MultiPoint"],
        true,
        false,
      ],
      paint: {
        "circle-color": "#facc15",
        "circle-radius": 9,
        "circle-opacity": 0.95,
        "circle-stroke-color": "#111827",
        "circle-stroke-width": 3,
      },
    });
  }

  private ensureHighlightLayer(spec: maplibregl.AddLayerObject): void {
    if (!this.map) return;
    if (!this.map.getLayer(spec.id)) {
      this.map.addLayer(spec);
      return;
    }
    try {
      this.map.moveLayer(spec.id);
    } catch {
      // Style reloads can remove layers while selection is syncing.
    }
  }

  private addTerrainSource(): boolean {
    if (
      !this.map ||
      !this.controlVisibility.terrain ||
      !this.map.isStyleLoaded()
    ) {
      return false;
    }
    if (this.map.getSource(TERRAIN_SOURCE_ID)) return true;
    this.map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
    return true;
  }

  private addLayerControl(): boolean {
    if (
      !this.map ||
      this.layerControl ||
      !this.controlVisibility["layer-control"]
    ) {
      return false;
    }
    const layerControlConfig = this.createLayerControlConfig(this.syncedLayers);
    this.layerControlSignature = this.createLayerControlSignature(
      layerControlConfig,
    );
    this.layerControl = new LayerControl({
      basemapStyleUrl: this.basemapStyleUrl,
      collapsed: true,
      panelWidth: 340,
      panelMinWidth: 240,
      panelMaxWidth: 450,
      ...layerControlConfig,
    });
    this.map.addControl(
      this.layerControl,
      this.controlPositions["layer-control"],
    );
    return true;
  }

  private removeLayerControl(): void {
    if (!this.map || !this.layerControl) return;
    this.removeControl(this.layerControl);
    this.layerControl = null;
  }

  private refreshLayerControl(layers: GeoLibreLayer[]): void {
    if (
      !this.map ||
      !this.layerControl ||
      !this.controlVisibility["layer-control"]
    ) {
      return;
    }

    const layerControlConfig = this.createLayerControlConfig(layers);
    const nextSignature = this.createLayerControlSignature(layerControlConfig);
    if (nextSignature === this.layerControlSignature) return;

    this.removeLayerControl();
    this.addLayerControl();
  }

  private createLayerControlConfig(
    layers: GeoLibreLayer[],
  ): LayerControlConfig {
    const namedStyleLayers = layers.flatMap((layer) =>
      this.getNamedStyleLayers(layer),
    );
    if (namedStyleLayers.length === 0) return {};

    return {
      layers: namedStyleLayers.map(({ id }) => id),
      layerStates: Object.fromEntries(
        namedStyleLayers.map(({ id, name, layer }) => [
          id,
          {
            visible: layer.visible,
            opacity: layer.opacity,
            name,
          },
        ]),
      ),
    };
  }

  private createLayerControlSignature(config: LayerControlConfig): string {
    return JSON.stringify({
      layers: config.layers ?? [],
      names: Object.fromEntries(
        Object.entries(config.layerStates ?? {}).map(([id, state]) => [
          id,
          state.name,
        ]),
      ),
    });
  }

  private getNamedStyleLayers(layer: GeoLibreLayer): Array<{
    id: string;
    name: string;
    layer: GeoLibreLayer;
  }> {
    if (!this.map) return [];

    const existingStyleLayers = this.getCandidateStyleLayers(layer).filter(
      ({ id }) => this.map?.getLayer(id),
    );
    return existingStyleLayers.map(({ id, suffix }) => ({
      id,
      name:
        existingStyleLayers.length > 1 && suffix
          ? `${layer.name} ${suffix}`
          : layer.name,
      layer,
    }));
  }

  private getBeforeStyleLayerId(
    layers: GeoLibreLayer[],
    layerIndex: number,
  ): string | undefined {
    if (!this.map) return undefined;

    for (const layer of layers.slice(layerIndex + 1)) {
      const beforeLayer = this.getCandidateStyleLayers(layer).find(({ id }) =>
        this.map?.getLayer(id),
      );
      if (beforeLayer) return beforeLayer.id;
    }

    if (layerIndex >= 0) {
      return this.getExternalBeforeStyleLayerId(layers[layerIndex]);
    }

    return undefined;
  }

  private getExternalBeforeStyleLayerId(
    layer: GeoLibreLayer | undefined,
  ): string | undefined {
    if (!this.map || !layer?.beforeId) return undefined;
    if (
      this.getCandidateStyleLayers(layer).some(({ id }) => id === layer.beforeId)
    ) {
      return undefined;
    }
    return this.map.getLayer(layer.beforeId) ? layer.beforeId : undefined;
  }

  private getCandidateStyleLayers(layer: GeoLibreLayer): Array<{
    id: string;
    suffix?: string;
  }> {
    if (layer.type === "geojson") {
      return [
        { id: fillLayerId(layer.id), suffix: "Polygons" },
        { id: lineLayerId(layer.id), suffix: "Lines" },
        { id: circleLayerId(layer.id), suffix: "Points" },
      ];
    }

    if (
      layer.type === "raster" ||
      layer.type === "wms" ||
      layer.type === "xyz"
    ) {
      return [{ id: `layer-${layer.id}-raster` }];
    }

    if (layer.type === "vector-tiles") {
      return [{ id: `layer-${layer.id}-vector` }];
    }

    return [];
  }

  private publishLayerDisplayNames(layers: GeoLibreLayer[]): void {
    if (typeof window === "undefined") return;

    const labelWindow = window as GeoLibreLayerLabelWindow;
    labelWindow.__GEOLIBRE_LAYER_LABELS__ = Object.fromEntries(
      layers
        .flatMap((layer) => this.getNamedStyleLayers(layer))
        .map(({ id, name }) => [id, name]),
    );
    window.dispatchEvent(new CustomEvent("geolibre-layer-labels-change"));
  }

  private addNavigationControl(): boolean {
    if (
      !this.map ||
      this.navigationControl ||
      !this.controlVisibility.navigation
    ) {
      return false;
    }
    this.navigationControl = new maplibregl.NavigationControl();
    this.map.addControl(
      this.navigationControl,
      this.controlPositions.navigation,
    );
    return true;
  }

  private removeNavigationControl(): void {
    if (!this.navigationControl) return;
    this.removeControl(this.navigationControl);
    this.navigationControl = null;
  }

  private addFullscreenControl(): boolean {
    if (
      !this.map ||
      this.fullscreenControl ||
      !this.controlVisibility.fullscreen
    ) {
      return false;
    }
    this.fullscreenControl = new maplibregl.FullscreenControl();
    this.map.addControl(
      this.fullscreenControl,
      this.controlPositions.fullscreen,
    );
    return true;
  }

  private removeFullscreenControl(): void {
    if (!this.fullscreenControl) return;
    this.removeControl(this.fullscreenControl);
    this.fullscreenControl = null;
  }

  private addGeolocateControl(): boolean {
    if (
      !this.map ||
      this.geolocateControl ||
      !this.controlVisibility.geolocate
    ) {
      return false;
    }
    this.geolocateControl = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    });
    this.map.addControl(
      this.geolocateControl,
      this.controlPositions.geolocate,
    );
    return true;
  }

  private removeGeolocateControl(): void {
    if (!this.geolocateControl) return;
    this.removeControl(this.geolocateControl);
    this.geolocateControl = null;
  }

  private addGlobeControl(): boolean {
    if (!this.map || this.globeControl || !this.controlVisibility.globe) {
      return false;
    }
    this.globeControl = new maplibregl.GlobeControl();
    this.map.addControl(this.globeControl, this.controlPositions.globe);
    return true;
  }

  private removeGlobeControl(): void {
    if (!this.globeControl) return;
    this.removeControl(this.globeControl);
    this.globeControl = null;
  }

  private addTerrainControl(): boolean {
    if (!this.map || this.terrainControl || !this.controlVisibility.terrain) {
      return false;
    }
    this.addTerrainSource();
    this.terrainControl = new maplibregl.TerrainControl(TERRAIN_OPTIONS);
    this.map.addControl(this.terrainControl, this.controlPositions.terrain);
    return true;
  }

  private removeTerrainControl(): void {
    if (this.map?.getTerrain()?.source === TERRAIN_SOURCE_ID) {
      this.map.setTerrain(null);
    }
    if (!this.terrainControl) return;
    this.removeControl(this.terrainControl);
    this.terrainControl = null;
  }

  private addScaleControl(): boolean {
    if (!this.map || this.scaleControl || !this.controlVisibility.scale) {
      return false;
    }
    this.scaleControl = new maplibregl.ScaleControl({
      maxWidth: 120,
      unit: "metric",
    });
    this.map.addControl(this.scaleControl, this.controlPositions.scale);
    return true;
  }

  private removeScaleControl(): void {
    if (!this.scaleControl) return;
    this.removeControl(this.scaleControl);
    this.scaleControl = null;
  }

  private addAttributionControl(): boolean {
    if (
      !this.map ||
      this.attributionControl ||
      !this.controlVisibility.attribution
    ) {
      return false;
    }
    this.attributionControl = new maplibregl.AttributionControl({
      compact: true,
    });
    this.map.addControl(
      this.attributionControl,
      this.controlPositions.attribution,
    );
    return true;
  }

  private removeAttributionControl(): void {
    if (!this.attributionControl) return;
    this.removeControl(this.attributionControl);
    this.attributionControl = null;
  }

  private addLogoControl(): boolean {
    if (!this.map || this.logoControl || !this.controlVisibility.logo) {
      return false;
    }
    this.logoControl = new maplibregl.LogoControl();
    this.map.addControl(this.logoControl, this.controlPositions.logo);
    return true;
  }

  private removeLogoControl(): void {
    if (!this.logoControl) return;
    this.removeControl(this.logoControl);
    this.logoControl = null;
  }

  private addBuiltInControl(control: BuiltInMapControl): boolean {
    if (control === "navigation") return this.addNavigationControl();
    if (control === "fullscreen") return this.addFullscreenControl();
    if (control === "geolocate") return this.addGeolocateControl();
    if (control === "globe") return this.addGlobeControl();
    if (control === "terrain") return this.addTerrainControl();
    if (control === "scale") return this.addScaleControl();
    if (control === "attribution") return this.addAttributionControl();
    if (control === "logo") return this.addLogoControl();
    return this.addLayerControl();
  }

  private removeBuiltInControl(control: BuiltInMapControl): void {
    if (control === "navigation") this.removeNavigationControl();
    else if (control === "fullscreen") this.removeFullscreenControl();
    else if (control === "geolocate") this.removeGeolocateControl();
    else if (control === "globe") this.removeGlobeControl();
    else if (control === "terrain") this.removeTerrainControl();
    else if (control === "scale") this.removeScaleControl();
    else if (control === "attribution") this.removeAttributionControl();
    else if (control === "logo") this.removeLogoControl();
    else this.removeLayerControl();
  }
}

export function createMapController(): MapController {
  return new MapController();
}
