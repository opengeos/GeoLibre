import {
  BLANK_BASEMAP,
  DEFAULT_BASEMAP,
  DEFAULT_PROJECT_PREFERENCES,
  useAppStore,
} from "@geolibre/core";
import type {
  GeoLibreLayer,
  MapPreferences,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import maplibregl from "maplibre-gl";
import {
  LayerControl,
  type CustomLayerAdapter,
  type LayerState,
} from "maplibre-gl-layer-control";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  getLayerBounds,
  highlightCircleLayerId,
  highlightFillLayerId,
  highlightLineLayerId,
  highlightSourceId,
  lineLayerId,
  sourceId,
} from "./geojson-loader";
import {
  mbtilesStyleLayerIds,
  removeLayerFromMap,
  syncLayer,
  vectorTileStyleLayerIds,
} from "./layer-sync";

const DEFAULT_PROJECTION: maplibregl.ProjectionSpecification = {
  type: "globe",
};
const DEFAULT_MAX_PITCH = 85;
const BLANK_BACKGROUND_LAYER_ID = "geolibre-blank-background";
const BLANK_BACKGROUND_COLOR = "#ffffff";
const LAYER_CONTROL_EXCLUDED_LAYERS = [
  BLANK_BACKGROUND_LAYER_ID,
  highlightFillLayerId(),
  highlightLineLayerId(),
  highlightCircleLayerId(),
];
const NON_BASEMAP_STYLE_LAYER_IDS = [
  highlightFillLayerId(),
  highlightLineLayerId(),
  highlightCircleLayerId(),
];
const OPACITY_PAINT_PROPERTIES: Record<string, string[]> = {
  background: ["background-opacity"],
  circle: ["circle-opacity"],
  fill: ["fill-opacity"],
  "fill-extrusion": ["fill-extrusion-opacity"],
  heatmap: ["heatmap-opacity"],
  hillshade: ["hillshade-exaggeration"],
  line: ["line-opacity"],
  raster: ["raster-opacity"],
  symbol: ["icon-opacity", "text-opacity"],
};
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

function isCustomControllableLayer(layer: GeoLibreLayer): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

function nativeLayerSuffix(layerId: string): string | undefined {
  const suffix = layerId.split("-").pop();
  if (!suffix) return undefined;
  return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

function vectorTileLayerSuffix(layerId: string): string | undefined {
  if (layerId.endsWith("-vector") || layerId.endsWith("-fill")) {
    return "Polygons";
  }
  if (layerId.endsWith("-vector-extrusion") || layerId.endsWith("-extrusion")) {
    return "Extrusions";
  }
  if (layerId.endsWith("-line")) return "Lines";
  if (layerId.endsWith("-circle")) return "Points";
  return nativeLayerSuffix(layerId);
}

function createBlankMapStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: {
          "background-color": BLANK_BACKGROUND_COLOR,
        },
      },
    ],
  };
}

function resolveMapStyle(
  styleUrl: string | undefined,
): string | maplibregl.StyleSpecification {
  if (styleUrl === BLANK_BASEMAP) return createBlankMapStyle();
  return styleUrl ?? DEFAULT_BASEMAP;
}

interface LayerControlConfig {
  excludeLayers?: string[];
  customLayerAdapters?: CustomLayerAdapter[];
}

interface LayerControlInternalState {
  panel?: HTMLElement;
  state?: {
    layerStates?: Record<
      string,
      {
        visible: boolean;
        opacity: number;
        name: string;
      }
    >;
  };
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
  private basemapVisible = true;
  private basemapOpacity = 1;
  private mapPreferences: MapPreferences = DEFAULT_PROJECT_PREFERENCES.map;
  private basemapOriginalPaintValues = new Map<string, Map<string, unknown>>();
  private syncedLayers: GeoLibreLayer[] = [];
  private layerIds: string[] = [];
  private styleReady = false;
  private controlVisibility: Record<BuiltInMapControl, boolean> = {
    ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  };
  private controlPositions: Record<
    BuiltInMapControl,
    maplibregl.ControlPosition
  > = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
      mapPreferences?: MapPreferences;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    const mapPreferences = options.mapPreferences ?? this.mapPreferences;
    const minZoom = clampNumber(mapPreferences.minZoom, 0, 24);
    const maxZoom = Math.max(minZoom, clampNumber(mapPreferences.maxZoom, 0, 24));
    const maxPitch = clampNumber(mapPreferences.maxPitch, 0, DEFAULT_MAX_PITCH);
    this.mapPreferences = mapPreferences;
    this.basemapStyleUrl = options.styleUrl ?? DEFAULT_BASEMAP;
    this.map = new maplibregl.Map({
      container,
      style: resolveMapStyle(this.basemapStyleUrl),
      center: view?.center ?? [-100, 40],
      zoom: view?.zoom ?? 2,
      bearing: view?.bearing ?? 0,
      pitch: view?.pitch ?? 0,
      minZoom,
      maxZoom,
      maxPitch,
      maxBounds: mapBoundsForPreferences(mapPreferences) ?? undefined,
      renderWorldCopies: mapPreferences.renderWorldCopies,
      attributionControl: false,
      maplibreLogo: false,
      // preserveDrawingBuffer must stay true: the Print Layout composer and any
      // future export feature reads the canvas via drawImage / toDataURL outside
      // of a render callback. Removing this causes blank captures on browsers
      // that discard the drawing buffer after compositing (most mobile GPUs).
      // Trade-off: adds one extra framebuffer copy per frame on tiled renderers.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    // The constructor options above already apply the static constraints.
    // The transform constraint is installed by the MapCanvas effect that
    // fires on mount, so calling applyMapPreferences here would only add a
    // redundant jumpTo that can interrupt the initial camera.
    const handleStyleReady = () => {
      this.styleReady = true;
      this.enforceDefaultProjection();
      this.addTerrainSource();
      this.applyBasemapVisibility();
      this.applyBasemapOpacity();
      this.addLayerControl();
    };
    this.map.on("style.load", handleStyleReady);
    this.map.once("load", handleStyleReady);
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

  /**
   * Fade a project layer in or out for story-map playback.
   *
   * Story chapters change layer opacity as the reader scrolls. This writes the
   * MapLibre paint properties directly instead of going through the store, so
   * playback never marks the project dirty or pushes undo history. Call
   * {@link restoreLayerStyles} when playback ends to reset opacities.
   *
   * @param layerId GeoLibre store layer id to fade.
   * @param opacity Target opacity, clamped to the 0-1 range.
   * @param durationMs Optional transition duration in milliseconds.
   */
  setStoryLayerOpacity(
    layerId: string,
    opacity: number,
    durationMs?: number,
  ): void {
    if (!this.map) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = this.map.getLayer(nativeId);
      if (!styleLayer) continue;
      const props = OPACITY_PAINT_PROPERTIES[styleLayer.type] ?? [];
      for (const prop of props) {
        if (durationMs && durationMs > 0) {
          this.map.setPaintProperty(nativeId, `${prop}-transition`, {
            duration: durationMs,
          });
        }
        this.map.setPaintProperty(nativeId, prop, clamped);
      }
    }
  }

  /**
   * Re-apply layer styles from the last synced layers, undoing any direct paint
   * changes made during story-map playback by {@link setStoryLayerOpacity}.
   */
  restoreLayerStyles(): void {
    // Invalidate any pending story rotation and halt an in-flight camera move so
    // a deferred rotateTo cannot fire after the presenter has exited.
    this.storyCameraToken++;
    this.map?.stop();
    // Clear any opacity transitions left over from playback first, otherwise the
    // restored values animate back in (potentially over a multi-second fade).
    if (this.map) {
      for (const layer of this.syncedLayers) {
        for (const nativeId of this.getNativeLayerIdsByLayerId(layer.id)) {
          const styleLayer = this.map.getLayer(nativeId);
          if (!styleLayer) continue;
          for (const prop of OPACITY_PAINT_PROPERTIES[styleLayer.type] ?? []) {
            this.map.setPaintProperty(nativeId, `${prop}-transition`, {
              duration: 0,
            });
          }
        }
      }
    }
    this.syncLayers(this.syncedLayers);
  }

  /** Token guarding deferred story rotations against later chapter changes. */
  private storyCameraToken = 0;

  /**
   * Move the camera to a story chapter view during presentation playback.
   *
   * Cancels any in-progress movement first so a prior chapter's rotation cannot
   * fight the new transition, then optionally starts a slow rotation once the
   * move settles. Keeping this in the controller lets the presenter drive the
   * camera without reaching into the raw MapLibre instance.
   *
   * @param location Target camera (center, zoom, pitch, bearing).
   * @param animation MapLibre camera method to use.
   * @param rotate When true, slowly rotate 180° after the move settles.
   */
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
  ): void {
    if (!this.map) return;
    const map = this.map;
    // Bump the token first so any pending rotation from a prior chapter is
    // invalidated. We do NOT call map.stop() here: flyTo/easeTo already
    // supersede an in-progress camera animation, and calling stop() immediately
    // before a new movement during rapid chapter changes can drop it entirely.
    const token = ++this.storyCameraToken;
    map[animation]({
      center: location.center,
      zoom: location.zoom,
      pitch: location.pitch,
      bearing: location.bearing,
    });
    if (rotate) {
      map.once("moveend", () => {
        if (this.storyCameraToken !== token || !this.map) return;
        this.map.rotateTo(this.map.getBearing() + 180, {
          duration: 30000,
          easing: (time) => time,
        });
      });
    }
  }

  /**
   * Fly the camera to a view, used for story authoring previews.
   *
   * @param location Target camera (center, zoom, pitch, bearing).
   */
  flyToView(location: StoryChapterLocation): void {
    this.map?.flyTo({
      center: location.center,
      zoom: location.zoom,
      pitch: location.pitch,
      bearing: location.bearing,
    });
  }

  private isStyleReady(): boolean {
    return Boolean(this.map && this.styleReady);
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
    this.styleReady = false;
    this.publishLayerDisplayNames([]);
  }

  setStyle(url: string): void {
    if (!this.map) return;
    this.basemapStyleUrl = url;
    this.styleReady = false;
    this.basemapOriginalPaintValues.clear();
    this.removeLayerControl();
    this.map.setStyle(resolveMapStyle(url));
  }

  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemapVisibility();
    this.syncLayerControlState();
  }

  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemapOpacity();
    this.syncLayerControlState();
  }

  applyView(view: MapViewState): void {
    if (!this.map) return;
    this.map.jumpTo(constrainMapView(view, this.mapPreferences, this.map));
  }

  applyMapPreferences(preferences: MapPreferences): void {
    if (!this.map) return;
    this.mapPreferences = preferences;

    const requestedMinZoom = clampNumber(preferences.minZoom, 0, 24);
    const minZoom = effectiveMinZoomForPreferences(
      preferences,
      this.map,
      requestedMinZoom,
    );
    const maxZoom = Math.max(
      minZoom,
      clampNumber(preferences.maxZoom, 0, 24),
    );
    const maxPitch = clampNumber(preferences.maxPitch, 0, DEFAULT_MAX_PITCH);

    // Lower minZoom to an intermediate value first so neither setter ever
    // violates the live min <= max relationship MapLibre validates: this
    // covers both new minZoom > current maxZoom and new maxZoom < current
    // minZoom. Then raise maxZoom and finally apply the real minZoom.
    this.map.setMinZoom(Math.min(minZoom, this.map.getMinZoom()));
    this.map.setMaxZoom(maxZoom);
    this.map.setMinZoom(minZoom);
    this.map.setMaxPitch(maxPitch);
    this.map.setRenderWorldCopies(preferences.renderWorldCopies);
    this.map.setMaxBounds(mapBoundsForPreferences(preferences));
    this.map.setTransformConstrain(
      createMapTransformConstraint(preferences, this.map, minZoom, maxZoom),
    );
    this.applyView(this.readView());
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
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    };
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;

    const nextIds = layers.map((l) => l.id);
    for (const id of this.layerIds) {
      if (!nextIds.includes(id)) {
        removeLayerFromMap(
          map,
          id,
          this.syncedLayers.find((layer) => layer.id === id),
        );
      }
    }

    for (const [index, layer] of layers.entries()) {
      syncLayer(map, layer, this.getBeforeStyleLayerId(layers, index));
    }
    this.layerIds = nextIds;
    this.syncedLayers = layers;
    this.applyBasemapVisibility();
    this.applyBasemapOpacity();
    this.publishLayerDisplayNames(layers);
    this.refreshLayerControl(layers);
    this.syncLayerControlState();
  }

  private styleLoadHandler: (() => void) | null = null;

  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    if (!this.map) return;

    if (this.styleLoadHandler) {
      this.map.off("style.load", this.styleLoadHandler);
      this.map.off("load", this.styleLoadHandler);
    }

    const run = () => {
      if (this.styleLoadHandler !== run) return;
      this.syncLayers(layers);
    };
    this.styleLoadHandler = run;

    if (this.isStyleReady()) {
      run();
    } else {
      this.map.once("load", run);
    }
    this.map.on("style.load", run);
  }

  private applyBasemapVisibility(): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;

    for (const layer of this.getBasemapStyleLayers()) {
      try {
        map.setLayoutProperty(
          layer.id,
          "visibility",
          this.basemapVisible ? "visible" : "none",
        );
      } catch {
        // Some third-party custom style layers may not expose layout properties.
      }
    }
  }

  private applyBasemapOpacity(): void {
    if (!this.isStyleReady()) return;

    for (const layer of this.getBasemapStyleLayers()) {
      const properties = OPACITY_PAINT_PROPERTIES[layer.type] ?? [];
      for (const property of properties) {
        this.setBasemapPaintOpacity(layer.id, property);
      }
    }
  }

  getBasemapStyleLayerIds(): string[] {
    return this.getBasemapStyleLayers().map((layer) => layer.id);
  }

  private getBasemapStyleLayers(): maplibregl.LayerSpecification[] {
    if (!this.isStyleReady() || !this.map) return [];
    const map = this.map;

    const userStyleLayerIds = new Set(
      this.syncedLayers.flatMap((layer) =>
        this.getCandidateStyleLayers(layer).map(({ id }) => id),
      ),
    );
    const nonBasemapStyleLayerIds = new Set(NON_BASEMAP_STYLE_LAYER_IDS);

    return (map.getStyle().layers ?? []).filter(
      (layer) =>
        !userStyleLayerIds.has(layer.id) &&
        !nonBasemapStyleLayerIds.has(layer.id),
    );
  }

  private setBasemapPaintOpacity(layerId: string, property: string): void {
    if (!this.map) return;

    let originalPaintValues = this.basemapOriginalPaintValues.get(layerId);
    if (!originalPaintValues) {
      originalPaintValues = new Map<string, unknown>();
      this.basemapOriginalPaintValues.set(layerId, originalPaintValues);
    }
    if (!originalPaintValues.has(property)) {
      originalPaintValues.set(
        property,
        this.map.getPaintProperty(layerId, property),
      );
    }

    const original = originalPaintValues.get(property);
    const opacity =
      this.basemapOpacity >= 1
        ? original
        : typeof original === "number"
          ? original * this.basemapOpacity
          : this.basemapOpacity;
    try {
      this.map.setPaintProperty(layerId, property, opacity);
    } catch {
      // Some third-party custom style layers may not expose paint properties.
    }
  }

  fitLayer(layer: GeoLibreLayer): void {
    if (layer.type === "3d-tiles" && this.map) {
      const center = layer.metadata.center;
      if (
        Array.isArray(center) &&
        typeof center[0] === "number" &&
        typeof center[1] === "number" &&
        Number.isFinite(center[0]) &&
        Number.isFinite(center[1])
      ) {
        // Tilesets only expose their center, not a native zoom range. Use a
        // conservative floor so city-scale tilesets that render below zoom 18
        // are not flown past into an empty viewport.
        this.map.flyTo({
          center: [center[0], center[1]],
          duration: 800,
          pitch: Math.max(this.map.getPitch(), 60),
          zoom: Math.max(this.map.getZoom(), 14),
        });
        return;
      }
    }

    const bounds =
      getLayerBounds(layer) ??
      this.getLayerMetadataBounds(layer) ??
      this.getLayerSourceBounds(layer);
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
    if (bounds.some((value) => !Number.isFinite(value))) return;
    // A degenerate point-sized box cannot be fit; fly to the point instead.
    if (bounds[0] === bounds[2] && bounds[1] === bounds[3]) {
      this.map.flyTo({
        center: [bounds[0], bounds[1]],
        zoom: Math.max(this.map.getZoom(), 14),
        duration: 800,
      });
      return;
    }
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
    if (!this.isStyleReady()) return;

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
    // fitBounds validates the box and handles point-sized boxes.
    this.fitBounds(box);
  }

  private syncHighlight(featureCollection: FeatureCollection): void {
    if (!this.isStyleReady() || !this.map) return;
    const map = this.map;

    const source = map.getSource(highlightSourceId());
    if (source) {
      (source as maplibregl.GeoJSONSource).setData(featureCollection);
    } else {
      map.addSource(highlightSourceId(), {
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
    if (!this.map || !this.controlVisibility.terrain || !this.isStyleReady()) {
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
    this.layerControlSignature =
      this.createLayerControlSignature(layerControlConfig);
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
    this.syncLayerControlState();
    window.setTimeout(() => this.syncLayerControlState(), 100);
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

  private syncLayerControlState(): void {
    this.syncLayerControlBackgroundState();
    this.syncLayerControlLayerStates(this.syncedLayers);
  }

  private createLayerControlConfig(
    layers: GeoLibreLayer[],
  ): LayerControlConfig {
    const nativeStyleLayerIds = layers.flatMap((layer) =>
      this.getCandidateStyleLayers(layer).map(({ id }) => id),
    );
    const excludeLayers = [
      ...LAYER_CONTROL_EXCLUDED_LAYERS,
      ...nativeStyleLayerIds,
    ];
    const controllableLayers = layers.filter(
      (layer) =>
        this.getNativeLayerIds(layer).length > 0 ||
        isCustomControllableLayer(layer),
    );

    if (controllableLayers.length === 0) {
      return { excludeLayers };
    }

    return {
      excludeLayers,
      customLayerAdapters: [
        this.createGeoLibreLayerAdapter(controllableLayers),
      ],
    };
  }

  private createLayerControlSignature(config: LayerControlConfig): string {
    // Only structural attributes belong in the signature. Opacity and
    // visibility are managed in place by the control and persisted to the
    // store; including them here would destroy and recreate the control
    // (collapsing it and interrupting the drag) on every slider or checkbox
    // interaction.
    return JSON.stringify({
      excluded: config.excludeLayers ?? [],
      layers: config.customLayerAdapters?.flatMap((adapter) =>
        adapter.getLayerIds().map((id) => {
          const state = adapter.getLayerState(id);
          return {
            id,
            name: state?.name,
            symbol: adapter.getSymbolType?.(id),
          };
        }),
      ),
    });
  }

  private syncLayerControlBackgroundState(): void {
    if (!this.layerControl) return;
    const control = this.layerControl as unknown as LayerControlInternalState;

    const backgroundState =
      control.state?.layerStates?.Background ??
      (control.state?.layerStates
        ? (control.state.layerStates.Background = {
            visible: this.basemapVisible,
            opacity: this.basemapOpacity,
            name: "Background",
          })
        : null);
    if (backgroundState) {
      backgroundState.visible = this.basemapVisible;
      backgroundState.opacity = this.basemapOpacity;
    }

    const backgroundItem = this.getLayerControlItem("Background");
    if (!backgroundItem) return;

    this.updateLayerControlItem(backgroundItem, {
      name: "Background",
      visible: this.basemapVisible,
      opacity: this.basemapOpacity,
    });
  }

  private syncLayerControlLayerStates(layers: GeoLibreLayer[]): void {
    if (!this.layerControl) return;
    const control = this.layerControl as unknown as LayerControlInternalState;

    for (const layer of layers) {
      const layerState = control.state?.layerStates?.[layer.id];
      if (layerState) {
        layerState.visible = layer.visible;
        layerState.opacity = layer.opacity;
        layerState.name = layer.name;
      }

      const layerItem = this.getLayerControlItem(layer.id);
      if (!layerItem) continue;
      this.updateLayerControlItem(layerItem, {
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
      });
    }
  }

  private getLayerControlItem(layerId: string): HTMLElement | null {
    const control = this.layerControl as unknown as LayerControlInternalState;
    const items = control.panel?.querySelectorAll(".layer-control-item") ?? [];
    return (
      (Array.from(items).find(
        (item) => (item as HTMLElement).dataset.layerId === layerId,
      ) as HTMLElement | undefined) ?? null
    );
  }

  private updateLayerControlItem(
    item: HTMLElement,
    state: { name: string; visible: boolean; opacity: number },
  ): void {
    const checkbox = item.querySelector(
      ".layer-control-checkbox",
    ) as HTMLInputElement | null;
    if (checkbox) checkbox.checked = state.visible;

    const opacity = item.querySelector(
      ".layer-control-opacity",
    ) as HTMLInputElement | null;
    if (opacity) {
      opacity.value = String(state.opacity);
      opacity.title = `Opacity: ${Math.round(state.opacity * 100)}%`;
    }

    const name = item.querySelector(
      ".layer-control-name",
    ) as HTMLElement | null;
    if (name) {
      name.textContent = state.name;
      name.title = state.name;
    }
  }

  private createGeoLibreLayerAdapter(
    layers: GeoLibreLayer[],
  ): CustomLayerAdapter {
    const layerById = new Map(layers.map((layer) => [layer.id, layer]));

    return {
      type: "geolibre",
      getLayerIds: () => layers.map((layer) => layer.id),
      getLayerState: (layerId) => {
        const layer = layerById.get(layerId);
        if (!layer) return null;
        return {
          visible: layer.visible,
          opacity: layer.opacity,
          name: layer.name,
          isCustomLayer: true,
          customLayerType: this.getLayerSymbolType(layer),
        } satisfies LayerState;
      },
      setVisibility: (layerId, visible) => {
        // Update the store (the source of truth) and let the layer sync
        // pass apply the visibility change to the map, so it is not undone
        // by the next syncLayers.
        useAppStore.getState().setLayerVisibility(layerId, visible);
      },
      setOpacity: (layerId, opacity) => {
        // Persist opacity to the layer model; syncLayer derives paint from
        // layer.opacity, so updating the store keeps the map and UI in sync.
        useAppStore.getState().setLayerOpacity(layerId, opacity);
      },
      getName: (layerId) => layerById.get(layerId)?.name ?? layerId,
      getSymbolType: (layerId) => {
        const layer = layerById.get(layerId);
        return layer ? this.getLayerSymbolType(layer) : "custom";
      },
      getBounds: (layerId) => {
        const layer = layerById.get(layerId);
        if (!layer) return null;
        // GeoJSON-backed layers derive bounds from their features; other
        // layer types fall back to their source bounds (TileJSON) when
        // advertised, and return null (no zoom-to-bounds) otherwise.
        return (
          getLayerBounds(layer) ??
          this.getLayerMetadataBounds(layer) ??
          this.getLayerSourceBounds(layer)
        );
      },
      getNativeLayerIds: (layerId) => this.getNativeLayerIdsByLayerId(layerId),
      removeLayer: (layerId) => {
        // Remove the logical layer from the store; syncLayers then tears
        // down the native sources/layers, keeping project state in sync.
        useAppStore.getState().removeLayer(layerId);
      },
    };
  }

  private getNativeLayerIdsByLayerId(layerId: string): string[] {
    const layer = this.syncedLayers.find((item) => item.id === layerId);
    return layer ? this.getNativeLayerIds(layer) : [];
  }

  private getNativeLayerIds(layer: GeoLibreLayer): string[] {
    return this.getCandidateStyleLayers(layer)
      .map(({ id }) => id)
      .filter((id) => this.map?.getLayer(id));
  }

  private getLayerSymbolType(layer: GeoLibreLayer): string {
    const nativeLayer = this.getNativeLayerIds(layer)
      .map((id) => this.map?.getLayer(id))
      .find((item) => Boolean(item));

    return (
      nativeLayer?.type ??
      (typeof layer.metadata.customLayerType === "string"
        ? layer.metadata.customLayerType
        : "custom")
    );
  }

  private getLayerMetadataBounds(
    layer: GeoLibreLayer,
  ): [number, number, number, number] | null {
    return (
      this.normalizeLayerBounds(layer.source.bounds) ??
      this.normalizeLayerBounds(layer.metadata.bounds)
    );
  }

  private getLayerSourceBounds(
    layer: GeoLibreLayer,
  ): [number, number, number, number] | null {
    for (const id of this.getLayerSourceIds(layer)) {
      const source = this.map?.getSource(id) as
        | { bounds?: [number, number, number, number] }
        | undefined;
      const bounds = this.normalizeLayerBounds(source?.bounds);
      if (bounds) return bounds;
    }
    return null;
  }

  private getLayerSourceIds(layer: GeoLibreLayer): string[] {
    const ids = new Set<string>([sourceId(layer.id)]);
    const sourceIds = layer.metadata.sourceIds;
    if (Array.isArray(sourceIds)) {
      for (const id of sourceIds) {
        if (typeof id === "string") ids.add(id);
      }
    }
    if (typeof layer.metadata.sourceId === "string") {
      ids.add(layer.metadata.sourceId);
    }
    return Array.from(ids);
  }

  private normalizeLayerBounds(
    bounds: unknown,
  ): [number, number, number, number] | null {
    if (
      Array.isArray(bounds) &&
      bounds.length === 4 &&
      bounds.every((value) => Number.isFinite(value))
    ) {
      return bounds as [number, number, number, number];
    }
    return null;
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
      this.getCandidateStyleLayers(layer).some(
        ({ id }) => id === layer.beforeId,
      )
    ) {
      return undefined;
    }
    return this.map.getLayer(layer.beforeId) ? layer.beforeId : undefined;
  }

  private getCandidateStyleLayers(layer: GeoLibreLayer): Array<{
    id: string;
    suffix?: string;
  }> {
    const nativeLayerIds = layer.metadata.nativeLayerIds;
    if (Array.isArray(nativeLayerIds) && nativeLayerIds.length > 0) {
      return nativeLayerIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({ id, suffix: nativeLayerSuffix(id) }));
    }

    if (layer.type === "geojson") {
      return [
        { id: fillExtrusionLayerId(layer.id), suffix: "Extrusions" },
        { id: fillLayerId(layer.id), suffix: "Polygons" },
        { id: lineLayerId(layer.id), suffix: "Lines" },
        { id: circleLayerId(layer.id), suffix: "Points" },
      ];
    }

    if (
      layer.type === "raster" ||
      layer.type === "wms" ||
      layer.type === "wmts" ||
      layer.type === "xyz"
    ) {
      return [{ id: `layer-${layer.id}-raster` }];
    }

    if (layer.type === "video") {
      return [{ id: `layer-${layer.id}-video` }];
    }

    if (layer.type === "vector-tiles") {
      return vectorTileStyleLayerIds(layer).map((id) => ({
        id,
        suffix: vectorTileLayerSuffix(id),
      }));
    }

    if (layer.type === "mbtiles") {
      return mbtilesStyleLayerIds(layer).map((id) => ({
        id,
        suffix: nativeLayerSuffix(id),
      }));
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
    this.map.addControl(this.geolocateControl, this.controlPositions.geolocate);
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

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function createMapTransformConstraint(
  preferences: MapPreferences,
  map: maplibregl.Map,
  minZoom: number,
  maxZoom: number,
): Parameters<maplibregl.Map["setTransformConstrain"]>[0] {
  return (lngLat, zoom) => {
    const constrainedZoom = clampNumber(zoom, minZoom, maxZoom);
    const bounds =
      preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
    if (!bounds) {
      return {
        center: new maplibregl.LngLat(
          preferences.renderWorldCopies
            ? lngLat.lng
            : clampNumber(lngLat.lng, -180, 180),
          clampNumber(lngLat.lat, -85, 85),
        ),
        zoom: constrainedZoom,
      };
    }

    return {
      center: constrainCenterToVisibleBounds(
        [lngLat.lng, lngLat.lat],
        bounds,
        map,
        constrainedZoom,
      ),
      zoom: constrainedZoom,
    };
  };
}

function constrainMapView(
  view: MapViewState,
  preferences: MapPreferences,
  map: maplibregl.Map | null,
): maplibregl.JumpToOptions {
  const requestedMinZoom = clampNumber(preferences.minZoom, 0, 24);
  // Use the same effective floor the transform constraint enforces so the
  // jumpTo does not land at a zoom the constraint would immediately correct,
  // which would show as a snap when bounds are restricted.
  const minZoom = map
    ? effectiveMinZoomForPreferences(preferences, map, requestedMinZoom)
    : requestedMinZoom;
  const maxZoom = Math.max(
    minZoom,
    clampNumber(preferences.maxZoom, 0, 24),
  );

  return {
    center: [
      preferences.renderWorldCopies
        ? view.center[0]
        : clampNumber(view.center[0], -180, 180),
      clampNumber(view.center[1], -85, 85),
    ],
    zoom: clampNumber(view.zoom, minZoom, maxZoom),
    bearing: view.bearing,
    pitch: clampNumber(
      view.pitch,
      0,
      clampNumber(preferences.maxPitch, 0, DEFAULT_MAX_PITCH),
    ),
  };
}

function effectiveMinZoomForPreferences(
  preferences: MapPreferences,
  map: maplibregl.Map,
  requestedMinZoom: number,
): number {
  const bounds =
    preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return requestedMinZoom;

  const mercatorBounds = mercatorBoundsForLngLatBounds(bounds);
  const widthRatio = Math.abs(mercatorBounds.east - mercatorBounds.west);
  const heightRatio = Math.abs(mercatorBounds.south - mercatorBounds.north);
  if (widthRatio <= 0 || heightRatio <= 0) return requestedMinZoom;

  const canvas = map.getCanvas();
  const minZoomForWidth = Math.log2(canvas.clientWidth / (512 * widthRatio));
  const minZoomForHeight = Math.log2(canvas.clientHeight / (512 * heightRatio));

  return clampNumber(
    Math.max(requestedMinZoom, minZoomForWidth, minZoomForHeight),
    0,
    24,
  );
}

function constrainCenterToVisibleBounds(
  center: [number, number],
  bounds: MapPreferences["bounds"],
  map: maplibregl.Map,
  zoom: number,
): maplibregl.LngLat {
  const mercatorBounds = mercatorBoundsForLngLatBounds(bounds);
  const worldSize = 512 * 2 ** zoom;
  const halfWidth = map.getCanvas().clientWidth / (2 * worldSize);
  const halfHeight = map.getCanvas().clientHeight / (2 * worldSize);
  const centerMercator = {
    x: mercatorXFromLng(center[0]),
    y: mercatorYFromLat(center[1]),
  };
  const minX = mercatorBounds.west + halfWidth;
  const maxX = mercatorBounds.east - halfWidth;
  const minY = mercatorBounds.north + halfHeight;
  const maxY = mercatorBounds.south - halfHeight;

  return new maplibregl.LngLat(
    lngFromMercatorX(
      minX <= maxX
        ? clampNumber(centerMercator.x, minX, maxX)
        : (mercatorBounds.west + mercatorBounds.east) / 2,
    ),
    latFromMercatorY(
      minY <= maxY
        ? clampNumber(centerMercator.y, minY, maxY)
        : (mercatorBounds.north + mercatorBounds.south) / 2,
    ),
  );
}

function mercatorBoundsForLngLatBounds(bounds: MapPreferences["bounds"]): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  return {
    west: mercatorXFromLng(bounds[0]),
    south: mercatorYFromLat(bounds[1]),
    east: mercatorXFromLng(bounds[2]),
    north: mercatorYFromLat(bounds[3]),
  };
}

function mercatorXFromLng(lng: number): number {
  return (lng + 180) / 360;
}

function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

function mercatorYFromLat(lat: number): number {
  const radians = (clampNumber(lat, -85, 85) * Math.PI) / 180;
  return (
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2
  );
}

function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

function normalizeMapBounds(
  bounds: MapPreferences["bounds"],
): MapPreferences["bounds"] | null {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const normalized: MapPreferences["bounds"] = [
    clampNumber(west, -180, 180),
    clampNumber(south, -85, 85),
    clampNumber(east, -180, 180),
    clampNumber(north, -85, 85),
  ];
  if (normalized[0] >= normalized[2] || normalized[1] >= normalized[3]) {
    return null;
  }

  return normalized;
}

function mapBoundsForPreferences(
  preferences: MapPreferences,
): maplibregl.LngLatBoundsLike | null {
  const bounds =
    preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return null;

  return [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ];
}

export function createMapController(): MapController {
  return new MapController();
}
