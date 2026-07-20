import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { MapEngineExtensionMap } from "./extensions";

export type MapEngineId = "maplibre" | "cesium";

export type MapEngineCapability =
  | "capture"
  | "controls"
  | "feature-query"
  | "interactions"
  | "markers"
  | "popups"
  | "transient-overlays";

export type LngLat = [number, number];
export type BBox = [number, number, number, number];

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface HitFeature {
  readonly layerId: string;
  readonly featureId: string | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: Geometry | null;
}

export type Unsubscribe = () => void;

export class MapEngineCapabilityError extends Error {
  readonly name = "MapEngineCapabilityError";

  constructor(
    readonly engineId: MapEngineId,
    readonly capability: MapEngineCapability,
  ) {
    super(`Map engine "${engineId}" does not support the "${capability}" capability.`);
  }
}

export interface MapEngineEventMap {
  readonly load: { readonly reason: "mount" | "style" };
  readonly idle: undefined;
  readonly movestart: { readonly userDriven: boolean };
  readonly move: { readonly view: MapViewState; readonly userDriven: boolean };
  readonly moveend: {
    readonly view: MapViewState;
    readonly userDriven: boolean;
    readonly tag?: string;
  };
  readonly click: { readonly point: ScreenPoint; readonly lngLat: LngLat };
  readonly dblclick: { readonly point: ScreenPoint; readonly lngLat: LngLat };
  readonly contextmenu: {
    readonly point: ScreenPoint;
    readonly lngLat: LngLat;
  };
  readonly pointermove: {
    readonly point: ScreenPoint;
    readonly lngLat: LngLat;
  };
  readonly pointerleave: undefined;
  readonly dragstart: undefined;
  readonly resize: undefined;
  readonly error: {
    readonly message: string;
    readonly detail?: string;
    readonly source?: string;
    readonly status?: number;
    readonly url?: string;
  };
}

export interface MapCameraTransitionOptions {
  readonly mode?: "jump" | "ease" | "fly";
  readonly durationMs?: number;
  readonly tag?: string;
}

export interface MapCameraPort {
  readView(): MapViewState;
  readBounds(): BBox | null;
  readZoomRange(): { readonly min: number; readonly max: number };
  applyView(view: MapViewState, options?: MapCameraTransitionOptions): void;
  flyToLocation(location: StoryChapterLocation): void;
  playStoryChapter(
    location: StoryChapterLocation,
    options: {
      readonly animation: StoryChapterAnimation;
      readonly rotate: boolean;
    },
  ): void;
  fitBounds(
    bounds: BBox,
    options?: { readonly padding?: number; readonly animate?: boolean },
  ): void;
  fitLayer(layer: GeoLibreLayer): void;
  zoomIn(): void;
  zoomOut(): void;
  resetNorth(): void;
  resetPitch(): void;
  resetNorthPitch(): void;
  readProjection(): MapProjection;
  isMoving(): boolean;
  whenIdle(options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<void>;
}

export interface MapRenderTarget {
  readonly id: string;
  readonly scope: "basemap" | "content" | "overlay";
  /** Whether `queryInView(id)` can recover renderer-held vector features. */
  readonly queryable?: boolean;
}

export interface MapLayerPort {
  readGeoJson(layerId: string): Promise<FeatureCollection | null>;
  readRasterSource(layerId: string): Readonly<Record<string, unknown>> | null;
  queryInView(layerId: string): readonly Feature[];
  listRenderTargets(): readonly MapRenderTarget[];
  hasRenderTarget(id: string): boolean;
  queryAtLngLat(lngLat: LngLat, layerId?: string): Promise<readonly HitFeature[]>;
  setHighlight(
    layer: GeoLibreLayer | undefined,
    featureIds: readonly string[],
    options?: { readonly fit?: boolean },
  ): void;
  clearHighlight(): void;
}

export interface MapCaptureResult {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly metersPerPixel: number;
  readonly bearing: number;
}

export interface MapViewportPort {
  project(lngLat: LngLat): ScreenPoint | null;
  unproject(point: ScreenPoint): LngLat | null;
  getElement(): HTMLElement | null;
  getRect(): DOMRectReadOnly | null;
  capture(options?: {
    readonly bounds?: BBox;
    readonly hideOverlayIds?: readonly string[];
  }): Promise<MapCaptureResult>;
}

export type MapMarkerAnchor =
  | "center"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface MapMarkerOptions {
  readonly id?: string;
  readonly lngLat: LngLat;
  readonly color?: string;
  readonly element?: HTMLElement;
  readonly draggable?: boolean;
  readonly anchor?: MapMarkerAnchor;
  readonly offset?: ScreenPoint;
  readonly rotationAlignment?: "map" | "viewport";
  readonly pitchAlignment?: "map" | "viewport";
}

export interface MapMarkerEventMap {
  readonly dragstart: { readonly lngLat: LngLat };
  readonly drag: { readonly lngLat: LngLat };
  readonly dragend: { readonly lngLat: LngLat };
}

export interface MapMarkerHandle {
  setLngLat(lngLat: LngLat): void;
  getLngLat(): LngLat;
  setDraggable(draggable: boolean): void;
  setRotation(rotation: number): void;
  on<K extends keyof MapMarkerEventMap>(
    event: K,
    handler: (payload: MapMarkerEventMap[K]) => void,
  ): Unsubscribe;
  remove(): void;
}

export interface GeoJsonOverlayStyle {
  readonly fillColor?: string;
  readonly fillOpacity?: number;
  readonly lineColor?: string;
  readonly lineColorProperty?: string;
  readonly lineOpacity?: number;
  readonly lineWidth?: number;
  readonly lineDash?: readonly number[];
  readonly pointColor?: string;
  readonly pointOpacity?: number;
  readonly pointRadius?: number;
}

export interface GeoJsonOverlaySpec {
  readonly id: string;
  readonly data: FeatureCollection;
  readonly style?: GeoJsonOverlayStyle;
  readonly visible?: boolean;
}

export interface MapInteractionPort {
  pickPoint(options?: { readonly signal?: AbortSignal }): Promise<LngLat | null>;
  drawBounds(options?: {
    readonly aspectRatio?: number;
    readonly signal?: AbortSignal;
    readonly onPreview?: (bounds: BBox | null) => void;
  }): Promise<BBox | null>;
  setDoubleClickZoomEnabled(enabled: boolean): void;
  suspendNavigation(): Unsubscribe;
  createMarker(options: MapMarkerOptions): MapMarkerHandle;
  upsertGeoJsonOverlay(spec: GeoJsonOverlaySpec): void;
  setOverlayVisible(id: string, visible: boolean): void;
  removeOverlay(id: string): void;
  showPopup(options: {
    readonly id: string;
    readonly lngLat: LngLat;
    readonly content: HTMLElement;
    readonly closeOnClick?: boolean;
    readonly maxWidth?: string;
  }): void;
  closePopup(id: string): void;
}

export type BuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "compass"
  | "geolocate"
  | "globe"
  | "terrain"
  | "scale"
  | "attribution"
  | "logo"
  | "layer-control";

export type MapControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface MapControlState {
  readonly visible: boolean;
  readonly position: MapControlPosition;
}

export interface MapControlPort {
  getBuiltInState(control: BuiltInMapControl): MapControlState;
  setBuiltInState(control: BuiltInMapControl, state: Partial<MapControlState>): boolean;
  setLabels(labels: Partial<Record<"compass" | "terrain" | "background", string>>): void;
  getTerrainExaggeration(): number;
  setTerrainExaggeration(value: number): void;
}

export interface MapEngineClient {
  readonly camera: MapCameraPort;
  readonly layers: MapLayerPort;
  readonly viewport: MapViewportPort;
  readonly interactions: MapInteractionPort;
  readonly controls: MapControlPort;
  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"];
  on<K extends keyof MapEngineEventMap>(
    event: K,
    handler: (payload: MapEngineEventMap[K]) => void,
  ): Unsubscribe;
}

export interface MapEngine extends MapEngineClient {
  mount(container: HTMLElement, initialView: MapViewState): Promise<void>;
  destroy(): void;
  configure(options: {
    readonly preferences?: MapPreferences;
    readonly basemapStyleUrl?: string;
    readonly basemapVisible?: boolean;
    readonly basemapOpacity?: number;
  }): void;
  applyView(view: MapViewState): void;
  readView(): MapViewState;
  syncLayers(layers: readonly GeoLibreLayer[]): void;
  supports(capability: MapEngineCapability): boolean;
  supportsLayer(layer: GeoLibreLayer): boolean;
  hitTest(point: ScreenPoint): Promise<readonly HitFeature[]>;
}
