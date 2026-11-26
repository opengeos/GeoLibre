// ArcgisEngine layer: SDK/map/view handles, layer bookkeeping and coordinate helpers.
// The ArcgisEngine layer chain is documented in arcgis-engine.ts.

import type * as maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer, MapPreferences, MapProjection } from "@geolibre/core";
import {
  DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  type BuiltInMapControl,
  type MapEngineCapabilities,
  type MapRenderSurface,
} from "./map-engine";
import { ARCGIS_SUPPORTED_LAYER_KINDS, type ArcgisLayerPlan } from "./arcgis-layers";
import type {
  ArcgisHandle,
  ArcgisLayer,
  ArcgisMap,
  ArcgisPoint,
  ArcgisProjectOperator,
  ArcgisSceneSdk,
  ArcgisSceneView,
  ArcgisSdk,
  ArcgisView,
} from "./arcgis-sdk";

/**
 * What the ArcGIS engine can do (issue #2421).
 *
 * The `false` flags are the operations the SDK has no equivalent for, or that
 * this engine deliberately does not claim:
 *
 * - `styleSpec` / `nativeMapInstance`: the SDK draws layers with renderers,
 *   not a Mapbox Style document, and there is no `maplibregl.Map` behind it.
 * - `customLayers`: MapLibre custom layers have no native SDK equivalent.
 *   `deckOverlay` is enabled separately on primary 2D and local scene views.
 * - `terrain` is claimed: the pane renders a `SceneView` over Esri's world
 *   elevation while terrain is on (see {@link arcgisSceneMode}).
 * - `domControls`: the primary view hosts adapted controls through `view.ui`.
 *   Rendering operations still require an explicit native or deck.gl bridge.
 */
export const ARCGIS_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  styleSpec: false,
  nativeMapInstance: false,
  customLayers: false,
  deckOverlay: false,
  terrain: true,
  picking: true,
  onMapDrawing: true,
  domControls: true,
  screenOverlays: false,
  flatProjection: true,
  terrainSource: true,
  ionTerrain: false,
  // The SDK draws Zarr from the record, and ArcgisControlHost renders the
  // MeasureControl shadow-style overlay onto its GraphicsLayer. The raster and
  // PMTiles panels remain MapLibre controls, so those go through Add Data.
  nativeZarr: true,
  nativeDataSources: false,
  // The engine is published once its view is ready.
  deferredEngineReady: true,
  measureTool: true,
  // Side labels are a MapLibre/Mapbox symbol layer; the SDK has no analogue yet.
  edgeLengthLabels: false,
  controlLayerPanels: false,
  supportedLayerKinds: ARCGIS_SUPPORTED_LAYER_KINDS,
});

export const ARCGIS_DECK_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  ...ARCGIS_CAPABILITIES,
  deckOverlay: true,
});

/** User-facing error messages the engine reports, which the app translates. */
export interface ArcgisEngineMessages {
  /** A FeatureServer layer's filter has no SQL form, so it draws unfiltered. */
  filterNoSql(layer: string): string;
  /** A georeferenced image could not be loaded. */
  imageFailed(layer: string): string;
  /** A plugin draws the layer on MapLibre only, so the ArcGIS map omits it. */
  pluginLayer(layer: string): string;
}

export const DEFAULT_ARCGIS_MESSAGES: ArcgisEngineMessages = {
  filterNoSql: (layer) =>
    `${layer}: this filter has no SQL form, so the ArcGIS service draws unfiltered`,
  imageFailed: (layer) => `${layer}: the image failed to load`,
  pluginLayer: (layer) => `${layer}: drawn by a plugin that does not support the ArcGIS renderer`,
};

/** The SDK's layer instances a plan produced, plus the blob URLs backing them. */
interface NativePlan {
  disposers: (() => void)[];
  plan: ArcgisLayerPlan;
  /** Serialized plan without the features, for cheap change detection. */
  signature: string;
  layers: ArcgisLayer[];
  urls: string[];
  /** The store record's GeoJSON the features were baked from, by identity. */
  geojson: FeatureCollection | undefined;
  /** Serialized filter state when `plan` was built, for in-place renderer updates. */
  filterSignature?: string;
  /**
   * Everything but the display fields of the record the plan was compiled
   * from, with the zoom it was compiled at; an unchanged key reuses the plan
   * instead of re-baking every feature.
   */
  compileKey?: string;
  compiledZoom?: number;
  visibilityHandle?: ArcgisHandle;
}

/**
 * Project a geometry with the project operator, or null when it cannot be
 * projected (a point outside the projection's domain).
 */
export function safeProject<T>(operator: ArcgisProjectOperator, geometry: T): T | null {
  try {
    return operator.execute(geometry, { wkid: 4326 });
  } catch {
    return null;
  }
}

/**
 * A view point as `[lng, lat]`, or null when there is no point or it has no
 * finite geographic position. Points in Web Mercator or WGS 84 carry
 * longitude/latitude; any other projection's are projected with
 * `projectOperator` (issue #2708).
 *
 * Args:
 *   point: A point from the view (`center`, `toMap`).
 *   projectOperator: The loaded project operator, when the view needs one.
 *
 * Returns:
 *   The point's longitude and latitude, or null.
 */
export function arcgisPointLngLat(
  point: ArcgisPoint | null | undefined,
  projectOperator?: ArcgisProjectOperator,
): [number, number] | null {
  if (!point) return null;
  if (Number.isFinite(point.longitude) && Number.isFinite(point.latitude))
    return [point.longitude, point.latitude];
  if (!projectOperator) return null;
  const projected = safeProject(projectOperator, point);
  return projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)
    ? [projected.x, projected.y]
    : null;
}

/** Normalize a bearing into `[0, 360)`. */
export function normalizeBearing(value: number): number {
  const wrapped = value % 360;
  return (wrapped < 0 ? wrapped + 360 : wrapped) + 0;
}

/**
 * MapLibre's `bearing` is the compass direction that points up; the SDK's
 * `rotation` is how far due north has turned clockwise from the top. They are
 * negatives of each other.
 */
export function bearingToRotation(bearing: number): number {
  return normalizeBearing(-bearing);
}

export function rotationToBearing(rotation: number): number {
  return normalizeBearing(-rotation);
}

/** Options for {@link ArcgisEngine}. */
export type ArcgisEngineOptions = {
  /** Secondary panes do not own the primary shared deck overlay. */
  deckOverlay?: boolean;
  domControls?: boolean;
  /** Whether an API key is configured, so Esri basemap styles are usable. */
  hasApiKey?: boolean;
  /**
   * The loaded project operator, given when the flat view is in a
   * projection other than Web Mercator (issue #2708). Its points carry no
   * longitude/latitude, so every map position is projected through it,
   * and tiled basemaps (which the SDK cannot reproject) are not drawn.
   */
  projectOperator?: ArcgisProjectOperator;
  /**
   * The 3D modules, required when `view` is a `SceneView`: terrain builds
   * its elevation layers from them.
   */
  scene?: ArcgisSceneSdk;
  /**
   * Called when the on-map globe toggle is clicked with the projection it
   * asks for. Without it the toggle is not mounted, since only the canvas
   * can rebuild the view in the other projection.
   */
  onProjectionToggle?: (projection: MapProjection) => void;
  /** Write LayerList changes through the owning pane's store state. */
  onLayerVisibilityChange?: (id: string, visible: boolean) => void;
  /** Preserve the device-local terrain choice across a 2D/3D view rebuild. */
  onTerrainSourceChange?: (source: string | Blob | null, band: number) => void;
  /**
   * Override built-in control visibility before the controls are added.
   * Split/grid panes pass `{ "layer-control": false }` like the other
   * engines.
   */
  controlVisibility?: Partial<Record<BuiltInMapControl, boolean>>;
  /**
   * Corners the controls were moved to on an earlier view. The canvas
   * rebuilds the engine on every 2D/3D switch; without these a moved
   * control would snap back to its default corner.
   */
  controlPositions?: Partial<Record<BuiltInMapControl, maplibregl.ControlPosition>>;
  /** Record a control move, so the next rebuild can pass it back. */
  onControlPositionChange?: (
    control: BuiltInMapControl,
    position: maplibregl.ControlPosition,
  ) => void;
};

/**
 * ArcgisEngine layer: the SDK, map and view handles, layer and native-plan
 * bookkeeping, and the coordinate helpers (bearing, screen points, store ids)
 * every other layer builds on.
 */
export abstract class ArcgisEngineBase {
  readonly kind = "arcgis" as const;

  get capabilities(): MapEngineCapabilities {
    const capabilities =
      this.options.deckOverlay !== false &&
      (this.view?.type === "2d" || this.view?.viewingMode === "local")
        ? ARCGIS_DECK_CAPABILITIES
        : ARCGIS_CAPABILITIES;
    return this.options.domControls === false
      ? { ...capabilities, domControls: false }
      : capabilities;
  }

  protected view!: ArcgisView | null;

  protected map!: ArcgisMap | null;

  protected surface!: MapRenderSurface | null;

  protected layers: GeoLibreLayer[] = [];

  protected natives = new Map<string, NativePlan>();

  /**
   * Companion native layers a plan draws for a store layer (an inverted-fill
   * mask, generated geometry, line decorations, de-duplicated labels): not
   * the layer's features, so identify skips them.
   */
  protected companions = new WeakSet<ArcgisLayer>();

  /** Whether {@link settleView} has placed the stored camera. */
  protected placed = false;

  protected errors = new Map<string, string>();

  protected preferences: MapPreferences | null = null;

  protected messages: ArcgisEngineMessages = DEFAULT_ARCGIS_MESSAGES;

  protected controlVisibility!: Record<BuiltInMapControl, boolean>;

  protected controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };

  protected disposers = new Set<() => void>();

  protected handles = new Set<ArcgisHandle>();

  protected sdk!: ArcgisSdk;

  protected options!: ArcgisEngineOptions;

  /** The SDK the engine was built from, for the canvas and integrations. */
  getSdk(): ArcgisSdk {
    return this.sdk;
  }

  /** The live `MapView` or `SceneView`, or `null` once destroyed. */
  getView(): ArcgisView | null {
    return this.view;
  }

  /** The live view when it is a `SceneView`. */
  protected sceneView(): ArcgisSceneView | null {
    return this.view?.type === "3d" ? this.view : null;
  }

  /** MapLibre bearing of the live view. */
  protected bearing(): number {
    const view = this.view;
    if (!view) return 0;
    return view.type === "3d"
      ? normalizeBearing(view.camera?.heading ?? 0)
      : rotationToBearing(view.rotation);
  }

  /**
   * The SDK's camera fields for a MapLibre bearing and pitch: a `MapView`
   * rotates (and cannot tilt), a `SceneView` takes a heading and tilt.
   */
  protected orientation(
    bearing: number | undefined,
    pitch: number | undefined,
  ): Record<string, number> {
    const view = this.view;
    if (!view) return {};
    if (view.type === "2d")
      return bearing === undefined ? {} : { rotation: bearingToRotation(bearing) };
    return {
      ...(bearing === undefined ? {} : { heading: normalizeBearing(bearing) }),
      ...(pitch === undefined ? {} : { tilt: this.clampPitch(pitch) }),
    };
  }

  protected clampPitch(pitch: number): number {
    const max = this.preferences ? Math.min(85, Math.max(0, this.preferences.maxPitch)) : 85;
    return Math.min(max, Math.max(0, pitch));
  }

  getMap(): null {
    return null;
  }

  protected canvas(): HTMLCanvasElement {
    return (
      (this.view?.container?.querySelector("canvas") as HTMLCanvasElement | null) ??
      document.createElement("canvas")
    );
  }

  protected point(lngLat: [number, number]): ArcgisPoint {
    return new this.sdk.Point({
      longitude: lngLat[0],
      latitude: lngLat[1],
      spatialReference: { wkid: 4326 },
    });
  }

  /**
   * A point from the view (`center`, `toMap`) as `[lng, lat]`, or null. A
   * view in Web Mercator or WGS 84 reports longitude and latitude itself; one
   * in any other projection does not, so the point is projected to WGS 84.
   */
  lngLatOf(point: ArcgisPoint | null | undefined): [number, number] | null {
    return arcgisPointLngLat(point, this.options.projectOperator);
  }

  protected storeIdFor(native: ArcgisLayer): string | undefined {
    for (const [id, entry] of this.natives) if (entry.layers.includes(native)) return id;
    return undefined;
  }
}
