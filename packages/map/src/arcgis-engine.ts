import { disposeArcgisControlAdapters, identifyArcgisControls } from "./arcgis-control-adapters";
import { ArcgisControlHost } from "./arcgis-control-host";
import { createArcgisZarrLayer } from "./arcgis-zarr";
import { createArcgisArchiveLayer } from "./arcgis-tile-archives";
import { createArcgisTemplateTileLayer } from "./arcgis-template-tiles";
import { attachArcgisSprite } from "./arcgis-sprite";
import { createArcgisCogLayer, loadCogTiler } from "./arcgis-cog-imagery";
import { createArcgisScaleBar, type ArcgisScaleBar } from "./arcgis-scale-bar";
import { boundsFillMinZoom, normalizeMapBounds } from "./map-bounds";
import { cachingCogTiler, cogSourceUrl } from "./cog-imagery";
import { SEARCH_HIGHLIGHT_COLOR } from "./map-engine";
import { renderFillPatternCanvas } from "./fill-patterns";
import { registerCogDemSource, type CogDemSourceRegistration } from "./cog-dem-source";
import { createCogElevationLayer } from "./arcgis-cog-terrain";
import type * as maplibregl from "maplibre-gl";
import type { Feature, FeatureCollection, Geometry, Point, Polygon, Position } from "geojson";
import {
  compileLayerFilters,
  portableWmsTileUrl,
  type GeoLibreLayer,
  type MapPreferences,
  type MapProjection,
  type MapViewState,
  type StoryChapterAnimation,
  type StoryChapterLocation,
} from "@geolibre/core";
import {
  DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  type BuiltInMapControl,
  type CameraIdleEvent,
  type ExtentDrawingOptions,
  type FlyToCamera,
  type IdentifiedFeature,
  type ManualPlacementOptions,
  type MapEngine,
  type MapEngineCapabilities,
  type MapExtent,
  type MapRenderSurface,
} from "./map-engine";
import {
  ARCGIS_HEIGHT_FIELD,
  ARCGIS_ID_FIELD,
  ARCGIS_LABEL_CLASS_FIELD,
  ARCGIS_LABEL_FIELD,
  arcgisBlendMode,
  isArcgisRasterPlan,
  ARCGIS_SYMBOL_FIELD,
  ARCGIS_WEIGHT_FIELD,
  compileArcgisLayer,
  featurePassesFilters,
  geometryContainsPoint,
  isArcgisPluginLayer,
  isMarkerPlaceholder,
  scaleToZoom,
  zoomToScale,
  type ArcgisGeoJsonPart,
  type ArcgisLayerPlan,
  type ArcgisMarkerPlaceholder,
  type ArcgisRendererJson,
  type ArcgisSymbolJson,
} from "./arcgis-layers";
import { renderMarkerCanvas } from "./markers";
import { parseLabelOverride } from "./label-style";
import { planArcgisBasemap, type ArcgisBasemapPlan, sameArcgisBasemapPlan } from "./arcgis-basemap";
import {
  redactArcgisError,
  type ArcgisGeometryJson,
  type ArcgisGraphic,
  type ArcgisHandle,
  type ArcgisElevationLayer,
  type ArcgisLayer,
  type ArcgisMap,
  type ArcgisPoint,
  type ArcgisSceneSdk,
  type ArcgisSceneView,
  type ArcgisSdk,
  type ArcgisView,
  type ArcgisWidget,
} from "./arcgis-sdk";
import { getLayerBounds } from "./geojson-loader";
import { drawExtentOnCanvas } from "./extent-drawing";

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
});

export const ARCGIS_DECK_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  ...ARCGIS_CAPABILITIES,
  deckOverlay: true,
});

/**
 * The built-in controls the SDK has a widget for, the globe toggle (a DOM
 * button), terrain (a scene setting with no button, as on Mapbox and Cesium),
 * plus attribution, which the view draws itself (`attributionVisible`) and
 * which cannot be turned off.
 */
const HOSTED_CONTROLS: ReadonlySet<BuiltInMapControl> = new Set<BuiltInMapControl>([
  "layer-control",
  "navigation",
  "fullscreen",
  "compass",
  "geolocate",
  "globe",
  "terrain",
  "scale",
  "attribution",
]);

/** Mount order within a corner, matching `MapController.init`. */
const HOSTED_CONTROL_ORDER: readonly BuiltInMapControl[] = [
  "layer-control",
  "fullscreen",
  "compass",
  "navigation",
  "geolocate",
  "globe",
  "scale",
];

/**
 * Esri's global terrain, the same service the SDK's `"world-elevation"` ground
 * resolves to. Publicly readable: terrain needs no API key.
 */
export const ARCGIS_WORLD_ELEVATION_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

/**
 * How an ArcGIS pane renders: a flat `MapView`, or a `SceneView` that is
 * either a globe (`global`) or a flat 3D map (`local`).
 */
export type ArcgisSceneMode = "2d" | "global" | "local";

/**
 * The view an ArcGIS pane needs for the project's map preferences.
 *
 * The SDK splits what MapLibre does in one map across two view classes: a
 * `MapView` cannot tilt, draw a globe or drape terrain, and a `SceneView`
 * does all three. So the globe projection selects a global scene, terrain on
 * a Mercator map selects a local (projected) scene, and only a Mercator map
 * without terrain stays a `MapView`. The canvas rebuilds the view when the
 * answer changes.
 */
export function arcgisSceneMode(
  projection: MapProjection,
  terrainEnabled: boolean,
): ArcgisSceneMode {
  if (projection === "globe") return "global";
  return terrainEnabled ? "local" : "2d";
}

/** User-facing error messages the engine reports, which the app translates. */
export interface ArcgisEngineMessages {
  /** A FeatureServer layer's filter has no SQL form, so it draws unfiltered. */
  filterNoSql(layer: string): string;
  /** A georeferenced image could not be loaded. */
  imageFailed(layer: string): string;
  /** A plugin draws the layer on MapLibre only, so the ArcGIS map omits it. */
  pluginLayer(layer: string): string;
}

const DEFAULT_ARCGIS_MESSAGES: ArcgisEngineMessages = {
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
  /**
   * Everything but the display fields of the record the plan was compiled
   * from, with the zoom it was compiled at; an unchanged key reuses the plan
   * instead of re-baking every feature.
   */
  compileKey?: string;
  compiledZoom?: number;
  visibilityHandle?: ArcgisHandle;
}

const HIGHLIGHT_COLOR = [250, 204, 21, 1];

/** Keys the SDK's keyboard navigation moves the camera with. */
const CAMERA_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "+",
  "-",
  "=",
  "_",
  "PageUp",
  "PageDown",
  "a",
  "A",
  "d",
  "D",
  "w",
  "W",
  "s",
  "S",
  "n",
  "N",
  // SceneView only: move the camera up (U) and down (J), and look at the
  // point under the pointer (P).
  "j",
  "J",
  "u",
  "U",
  "p",
  "P",
]);

/** Pages of a service's features `getLayerGeoJson` reads before stopping. */
const SERVICE_GEOJSON_MAX_PAGES = 50;

/** Pixel radius the synchronous identify accepts around points and lines. */
const HIT_TOLERANCE_PX = 6;

/**
 * The schema of the compiler's GeoJSON: only the three synthetic fields (the
 * SDK adds its object id). Declared widths keep long labels intact.
 */
const ARCGIS_GEOJSON_FIELDS = [
  { name: ARCGIS_ID_FIELD, type: "string", length: 255 },
  { name: ARCGIS_SYMBOL_FIELD, type: "string", length: 32 },
  { name: ARCGIS_LABEL_FIELD, type: "string", length: 4000 },
  { name: ARCGIS_LABEL_CLASS_FIELD, type: "string", length: 16 },
  { name: ARCGIS_HEIGHT_FIELD, type: "double" },
  { name: ARCGIS_WEIGHT_FIELD, type: "double" },
];

/**
 * A renderer the SDK can take now: marker placeholders swapped for the circle
 * each stands in for. `bakeMarkers` replaces them with picture symbols later.
 */
function rendererWithFallbackMarkers(renderer: ArcgisRendererJson): ArcgisRendererJson {
  const fallback = (symbol: ArcgisSymbolJson | unknown): ArcgisSymbolJson =>
    isMarkerPlaceholder(symbol)
      ? (symbol as ArcgisMarkerPlaceholder).fallback
      : (symbol as ArcgisSymbolJson);
  return mapRendererSymbols(renderer, fallback);
}

/** A renderer with every symbol mapped, its visual variables kept. */
function mapRendererSymbols(
  renderer: ArcgisRendererJson,
  map: (symbol: ArcgisSymbolJson | unknown) => ArcgisSymbolJson,
): ArcgisRendererJson {
  if (renderer.type === "heatmap") return renderer;
  const visualVariables = renderer.visualVariables
    ? { visualVariables: renderer.visualVariables }
    : {};
  return renderer.type === "simple"
    ? { type: "simple", symbol: map(renderer.symbol), ...visualVariables }
    : {
        type: "unique-value",
        field: renderer.field,
        uniqueValueInfos: renderer.uniqueValueInfos.map((info) => ({
          value: info.value,
          symbol: map(info.symbol),
        })),
        ...visualVariables,
      };
}

/**
 * The on-map globe/Mercator toggle. The SDK has no such widget, so this is a
 * plain button carrying MapLibre's `GlobeControl` classes, as the Mapbox
 * engine's toggle does, so the same glyph and "enabled" styling apply.
 * Toggling rebuilds the view (a `MapView` cannot become a globe), which is the
 * canvas's job; the button only reports the click.
 */
function createGlobeToggle(
  projection: MapProjection,
  onToggle: (projection: MapProjection) => void,
): ArcgisWidget {
  const container = document.createElement("div");
  container.className = "maplibregl-ctrl maplibregl-ctrl-group geolibre-arcgis-globe";
  const button = document.createElement("button");
  button.type = "button";
  const icon = document.createElement("span");
  icon.className = "maplibregl-ctrl-icon";
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);
  let globe = projection === "globe";
  const paint = () => {
    button.className = globe ? "maplibregl-ctrl-globe-enabled" : "maplibregl-ctrl-globe";
    const label = globe ? "Disable globe" : "Enable globe";
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  paint();
  button.addEventListener("click", () => {
    // Repaint at once: the rebuilt view takes a moment to appear, and until
    // then this button (on the outgoing view) is the only sign of the click.
    globe = !globe;
    paint();
    onToggle(globe ? "globe" : "mercator");
  });
  container.append(button);
  return { uiComponent: container, destroy: () => container.remove() };
}

/**
 * The SDK's tiled elevation layer, optionally exaggerated. The SDK has no
 * exaggeration setting; its documented route is a `BaseElevationLayer`
 * subclass that scales each tile's heights, built once per SDK.
 */
const exaggeratedElevationClasses = new WeakMap<
  ArcgisSceneSdk,
  new (properties?: Record<string, unknown>) => ArcgisElevationLayer
>();

function createElevationLayer(scene: ArcgisSceneSdk, exaggeration: number): ArcgisElevationLayer {
  if (exaggeration === 1)
    return new scene.ElevationLayer({ url: ARCGIS_WORLD_ELEVATION_URL, listMode: "hide" });
  let Exaggerated = exaggeratedElevationClasses.get(scene);
  if (!Exaggerated) {
    type Self = ArcgisElevationLayer & {
      exaggeration: number;
      source: ArcgisElevationLayer;
      addResolvingPromise(promise: Promise<unknown>): void;
      fullExtent: unknown;
    };
    Exaggerated = scene.BaseElevationLayer.createSubclass({
      properties: { exaggeration: 1 },
      load(this: Self) {
        this.source = new scene.ElevationLayer({ url: ARCGIS_WORLD_ELEVATION_URL });
        this.addResolvingPromise(
          this.source.load().then(() => {
            this.tileInfo = this.source.tileInfo;
            this.spatialReference = this.source.spatialReference;
            this.fullExtent = this.source.fullExtent;
          }),
        );
      },
      fetchTile(this: Self, level: number, row: number, col: number, options?: unknown) {
        return this.source.fetchTile(level, row, col, options).then((data) => {
          const factor = this.exaggeration;
          for (let i = 0; i < data.values.length; i++) data.values[i] *= factor;
          return data;
        });
      },
    });
    exaggeratedElevationClasses.set(scene, Exaggerated);
  }
  return new Exaggerated({ exaggeration, listMode: "hide" });
}

/** Convert GeoJSON geometry to the SDK's geometry JSON (WGS84). */
export function geojsonToArcgisGeometry(geometry: Geometry): ArcgisGeometryJson | null {
  const sr = { wkid: 4326 };
  switch (geometry.type) {
    case "Point":
      return {
        type: "point",
        x: geometry.coordinates[0],
        y: geometry.coordinates[1],
        ...(geometry.coordinates.length > 2 ? { z: geometry.coordinates[2] } : {}),
        spatialReference: sr,
      };
    case "MultiPoint":
      return { type: "multipoint", points: geometry.coordinates, spatialReference: sr };
    case "LineString":
      return { type: "polyline", paths: [geometry.coordinates], spatialReference: sr };
    case "MultiLineString":
      return { type: "polyline", paths: geometry.coordinates, spatialReference: sr };
    case "Polygon":
      return { type: "polygon", rings: geometry.coordinates, spatialReference: sr };
    case "MultiPolygon":
      return { type: "polygon", rings: geometry.coordinates.flat(), spatialReference: sr };
    default:
      return null;
  }
}

/**
 * The view's zoom level. A MapView with no tiling scheme (the Blank basemap)
 * reports -1, so the level is derived from its scale there; a view with no
 * scale yet (before it is ready) reads as zoom 0 rather than a non-finite one.
 */
function viewZoom(view: ArcgisView): number {
  if (view.zoom >= 0) return view.zoom;
  const zoom = view.scale > 0 ? scaleToZoom(view.scale) : Number.NaN;
  return Number.isFinite(zoom) ? zoom : 0;
}

/**
 * The view's scale at a zoom level. The SDK's levels follow the basemap's
 * tiling scheme (a 512 px vector basemap's level 6 is a 256 px scheme's level
 * 7), so the scale is taken from the view's own zoom-to-scale ratio; a view
 * with no levels (the Blank basemap) uses the standard scheme `viewZoom` reads.
 */
function scaleForZoom(view: ArcgisView, zoom: number): number {
  return view.zoom >= 0 && view.scale > 0
    ? view.scale * 2 ** (view.zoom - zoom)
    : zoomToScale(zoom);
}

/**
 * Which zoom-level scheme the view is in, as the power of two its levels are
 * offset by from the standard scheme; changes only when the basemap does.
 */
function levelScheme(view: ArcgisView): number {
  return view.zoom >= 0 && view.scale > 0
    ? Math.round(Math.log2(scaleForZoom(view, 0) / zoomToScale(0)))
    : 0;
}

/**
 * A rejected `goTo` is worth a warning, not a render error: the SDK rejects
 * when a later move interrupts this one (routine) but also when a target is
 * malformed, and the second must not vanish silently.
 */
function reportGoToFailure(error: unknown): void {
  const name = (error as { name?: string } | null)?.name;
  if (name === "view:goto-interrupted" || name === "AbortError") return;
  console.warn("[geolibre/arcgis] camera move failed", error);
}

/** Whether an SDK error is a cancelled request rather than a failure. */
function isAbortError(error: { name?: string; message?: string } | null | undefined): boolean {
  return (
    error?.name === "AbortError" ||
    error?.name === "view:goto-interrupted" ||
    /^aborted$/i.test(error?.message?.trim() ?? "")
  );
}

/** Normalize a bearing into `[0, 360)`. */
function normalizeBearing(value: number): number {
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

/**
 * The ArcGIS Maps SDK for JavaScript behind the shared {@link MapEngine}
 * surface. Construction (loading the SDK from the CDN, building the `Map` and
 * `MapView`) is the canvas component's job; everything after it is here.
 */
export class ArcgisEngine implements MapEngine {
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
  private view: ArcgisView | null;
  private controlHost: ArcgisControlHost | null = null;
  private map: ArcgisMap | null;
  private surface: MapRenderSurface | null;
  private layers: GeoLibreLayer[] = [];
  private natives = new Map<string, NativePlan>();
  /**
   * Companion native layers a plan draws for a store layer (an inverted-fill
   * mask, generated geometry, line decorations, de-duplicated labels): not
   * the layer's features, so identify skips them.
   */
  private companions = new WeakSet<ArcgisLayer>();
  /** Whether {@link settleView} has placed the stored camera. */
  private placed = false;
  private errors = new Map<string, string>();
  private preferences: MapPreferences | null = null;
  private basemapPlan: ArcgisBasemapPlan | null = null;
  private basemapVisible = true;
  private basemapOpacity = 1;
  private blankColor: string | null = null;
  private storyOpacities = new Map<string, number>();
  private messages: ArcgisEngineMessages = DEFAULT_ARCGIS_MESSAGES;
  /** Animation frames of the story opacity fades in flight, by layer id. */
  private storyFades = new Map<string, number>();
  private controlVisibility: Record<BuiltInMapControl, boolean>;
  private controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };
  private builtInControls = new Map<BuiltInMapControl, ArcgisWidget>();
  private compassLabel: string | undefined;
  private disposers = new Set<() => void>();
  private handles = new Set<ArcgisHandle>();
  private highlight: ArcgisLayer | null = null;
  /** Bumped by every story camera move, so a superseded move never starts a rotation. */
  private storyCameraToken = 0;
  /** Whether the camera move in progress is a story chapter's or preview's. */
  private storyMove = false;
  private storyMoveLapse: ReturnType<typeof setTimeout> | undefined;
  /** Integer zoom the zoom-dependent plans were compiled at. */
  private compiledZoom: number;
  /**
   * Geometries of service features the hit test has returned, keyed by
   * `layerId:featureId`: a service layer's features never live in the store,
   * so this is what a selection of one is highlighted from. Bounded.
   */
  private serviceGeometries = new Map<string, Geometry>();
  /** Results of the latest hit test, served by the synchronous identify. */
  private lastHit: { lngLat: [number, number]; features: IdentifiedFeature[] } | null = null;
  private zoomWatch: ArcgisHandle | null = null;
  private terrain = false;
  private exaggeration = 1;
  private cogTerrain: CogDemSourceRegistration | null = null;
  private cogTerrainUrl: string | null = null;
  private cogTerrainRequest = 0;
  private cogTiler: Promise<ReturnType<typeof cachingCogTiler>> | null = null;
  private cogUrls = new Set<string>();

  private loadCachedCogTiler(): Promise<ReturnType<typeof cachingCogTiler>> {
    return (this.cogTiler ??= loadCogTiler()
      .then(cachingCogTiler)
      .catch((error) => {
        this.cogTiler = null;
        throw error;
      }));
  }
  private elevation: ArcgisElevationLayer | null = null;

  constructor(
    private sdk: ArcgisSdk,
    map: ArcgisMap,
    view: ArcgisView,
    private options: {
      /** Secondary panes do not own the primary shared deck overlay. */
      deckOverlay?: boolean;
      domControls?: boolean;
      /** Whether an API key is configured, so Esri basemap styles are usable. */
      hasApiKey?: boolean;
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
    } = {},
  ) {
    this.map = map;
    this.view = view;
    this.compiledZoom = Math.round(viewZoom(view));
    this.controlVisibility = {
      ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
      ...options.controlVisibility,
      // Esri's terms require attribution; an override cannot hide it.
      attribution: true,
    };
    this.controlPositions = { ...this.controlPositions, ...options.controlPositions };
    this.surface = {
      getCanvas: () => this.canvas(),
      getContainer: () => view.container ?? document.createElement("div"),
      getBearing: () => this.bearing(),
      project: (p) => {
        const screen = this.view?.toScreen(this.point(p));
        return screen ? { x: screen.x, y: screen.y } : { x: 0, y: 0 };
      },
      unproject: (p) => {
        const point = this.view?.toMap({ x: p[0], y: p[1] });
        return point ? { lng: point.longitude, lat: point.latitude } : null;
      },
      redraw: () => {},
    };
    // The SDK's default UI components (zoom on older releases) are replaced by
    // the built-in set the Controls menu governs. Attribution is not a
    // component in 5.x: the view draws it itself while `attributionVisible`
    // is on, which Esri's terms require alongside its basemaps.
    view.ui.components = [];
    view.attributionVisible = true;
    for (const id of HOSTED_CONTROL_ORDER)
      if (this.controlVisibility[id]) this.mountBuiltInControl(id);
    this.handles.add(
      view.on("layerview-create-error", (event) => {
        const layer = event.layer as ArcgisLayer | undefined;
        const error = event.error as { message?: string; name?: string } | undefined;
        // A restyle rebuilds the native layers, and the SDK reports the
        // outgoing layer's cancelled load as an error ("Aborted") — routine,
        // not a failure. The same goes for any layer the engine no longer
        // tracks: it was removed on purpose.
        if (isAbortError(error)) return;
        const storeId = layer ? this.storeIdFor(layer) : undefined;
        if (!storeId) return;
        this.errors.set(
          `layer:${storeId}`,
          `${layer?.title ?? "Layer"}: ${redactArcgisError(error?.message ?? "failed to load")}`,
        );
      }),
    );
    // The user taking the camera ends a story move: the settle that follows is
    // theirs, and viewport history and collaboration must record it.
    for (const type of ["drag", "mouse-wheel", "double-click"] as const)
      this.handles.add(
        view.on(type, () => {
          this.storyMove = false;
        }),
      );
    // Only the keys that move the camera; a Shift press does not.
    this.handles.add(
      view.on("key-down", (event) => {
        if (CAMERA_KEYS.has((event as { key?: string }).key ?? "")) this.storyMove = false;
      }),
    );
    // A string, so the camera's own changes (the scheme reads the zoom and
    // scale) re-evaluate the getter without re-running the callback.
    this.handles.add(
      sdk.reactiveUtils.watch(
        () => `${view.ready}|${view.width}|${view.height}|${levelScheme(view)}`,
        () => this.applyNavigationLimits(),
      ),
    );
    // The project's zoom range on a flat view (see `applyNavigationLimits`):
    // a wheel step past a limit the view is at is dropped, and one that
    // overshoots a limit is eased back once the view settles.
    this.handles.add(
      view.on("mouse-wheel", (event) => {
        if (view.type !== "2d") return;
        const deltaY = event.deltaY ?? 0;
        const zoom = viewZoom(view);
        const { minZoom, maxZoom } = this.zoomRange();
        if ((deltaY > 0 && zoom <= minZoom + 0.01) || (deltaY < 0 && zoom >= maxZoom - 0.01))
          event.stopPropagation();
      }),
    );
    // Expressions baked at one zoom are re-evaluated when the integer zoom
    // changes, the way MapLibre would evaluate `["zoom"]` live.
    this.zoomWatch = sdk.reactiveUtils.when(
      () => view.stationary,
      () => {
        if (!this.view) return;
        this.constrainSettledView();
        const zoom = Math.round(viewZoom(this.view));
        if (zoom === this.compiledZoom) return;
        this.compiledZoom = zoom;
        if ([...this.natives.values()].some((n) => n.plan.zoomDependent))
          this.syncLayers(this.layers);
      },
    );
  }

  /**
   * Replace the engine's user-facing messages (translated by the app). Errors
   * already reported are rewritten on the next sync.
   */
  setMessages(messages: Partial<ArcgisEngineMessages>): void {
    this.messages = { ...DEFAULT_ARCGIS_MESSAGES, ...messages };
    if (this.map) this.syncLayers(this.layers);
  }
  /** The SDK the engine was built from, for the canvas and integrations. */
  getSdk(): ArcgisSdk {
    return this.sdk;
  }
  /** The live `MapView` or `SceneView`, or `null` once destroyed. */
  getView(): ArcgisView | null {
    return this.view;
  }
  /** The live view when it is a `SceneView`. */
  private sceneView(): ArcgisSceneView | null {
    return this.view?.type === "3d" ? this.view : null;
  }
  /** MapLibre bearing of the live view. */
  private bearing(): number {
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
  private orientation(
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
  private clampPitch(pitch: number): number {
    const max = this.preferences ? Math.min(85, Math.max(0, this.preferences.maxPitch)) : 85;
    return Math.min(max, Math.max(0, pitch));
  }
  getMap(): null {
    return null;
  }

  private canvas(): HTMLCanvasElement {
    return (
      (this.view?.container?.querySelector("canvas") as HTMLCanvasElement | null) ??
      document.createElement("canvas")
    );
  }
  private point(lngLat: [number, number]): ArcgisPoint {
    return new this.sdk.Point({
      longitude: lngLat[0],
      latitude: lngLat[1],
      spatialReference: { wkid: 4326 },
    });
  }
  private storeIdFor(native: ArcgisLayer): string | undefined {
    for (const [id, entry] of this.natives) if (entry.layers.includes(native)) return id;
    return undefined;
  }

  // ---------------------------------------------------------------- lifecycle

  destroy(): void {
    const view = this.view;
    if (!view) return;
    this.stopCamera();
    clearTimeout(this.storyMoveLapse);
    for (const id of [...this.storyFades.keys()]) this.cancelStoryFade(id);
    this.controlHost?.destroy();
    this.controlHost = null;
    disposeArcgisControlAdapters(view);
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    for (const handle of this.handles) handle.remove();
    this.handles.clear();
    this.zoomWatch?.remove();
    this.zoomWatch = null;
    this.clearFeatureHighlight();
    this.removeElevation();
    this.cogTerrainRequest++;
    this.cogTerrain?.dispose();
    void this.cogTiler?.then((tiler) => tiler.clear()).catch(() => {});
    this.cogTiler = null;
    this.cogUrls.clear();
    this.cogTerrain = null;
    for (const id of [...this.natives.keys()]) this.removeLayer(id);
    for (const widget of this.builtInControls.values()) widget.destroy();
    this.builtInControls.clear();
    // Destroying the view does not destroy the map; the map owns the layers.
    view.destroy();
    this.map?.destroy();
    this.view = null;
    this.map = null;
    this.surface = null;
  }

  // ------------------------------------------------------------------- camera

  readView(): MapViewState {
    const view = this.view;
    if (!view) return { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 };
    const center = view.center;
    const bounds = this.getViewBounds();
    return {
      center: [center.longitude, center.latitude],
      zoom: viewZoom(view),
      bearing: this.bearing(),
      // A MapView has no pitch.
      pitch: view.type === "3d" ? (view.camera?.tilt ?? 0) : 0,
      ...(bounds ? { bbox: bounds } : {}),
    };
  }
  async applyView(view: MapViewState): Promise<void> {
    const old = this.readView();
    const target = this.constrainView(view);
    const scene = this.view?.type === "3d";
    if (
      Math.abs(old.center[0] - target.center[0]) < 1e-8 &&
      Math.abs(old.center[1] - target.center[1]) < 1e-8 &&
      Math.abs(old.zoom - target.zoom) < 1e-8 &&
      Math.abs(normalizeBearing(old.bearing) - normalizeBearing(target.bearing)) < 1e-8 &&
      // A MapView reads pitch as 0 whatever the store holds.
      (!scene || Math.abs(old.pitch - this.clampPitch(target.pitch)) < 1e-8)
    )
      return;
    try {
      await this.view?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { animate: false },
      );
    } catch (error) {
      reportGoToFailure(error);
    }
  }
  /**
   * Place the camera at `view` and resolve once it is there. A new view
   * reports `stationary` at its constructor's default camera before the first
   * move lands, and a `SceneView` cannot be constructed at a heading and tilt;
   * the canvas awaits this before it lets camera changes reach the store, or
   * that default (north-up, untilted) would overwrite the project's view.
   */
  async settleView(view: MapViewState): Promise<void> {
    const target = this.constrainView(view);
    try {
      await this.view?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { animate: false },
      );
    } catch (error) {
      reportGoToFailure(error);
    } finally {
      // The stored camera has landed; from here a settle outside the limits
      // is corrected (it may itself be outside the bounds).
      this.placed = true;
      this.constrainSettledView();
    }
  }
  easeToView(view: MapViewState): void {
    const target = this.constrainView(view);
    void this.view
      ?.goTo(
        {
          center: target.center,
          ...this.zoomTarget(target.zoom),
          ...this.orientation(target.bearing, target.pitch),
        },
        { duration: 500 },
      )
      .catch(reportGoToFailure);
  }
  /** Clamp a view to the project's zoom and world-copy preferences, as the other engines do. */
  private constrainView(view: MapViewState): {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const { minZoom, maxZoom } = this.zoomRange();
    return {
      center: [
        !p || p.renderWorldCopies ? view.center[0] : clamp(view.center[0], -180, 180),
        clamp(view.center[1], -85, 85),
      ],
      zoom: clamp(view.zoom, minZoom, maxZoom),
      bearing: view.bearing,
      pitch: Number.isFinite(view.pitch) ? view.pitch : 0,
    };
  }
  readCameraAltitude(): number | null {
    // A MapView has a scale, not a camera.
    const z = this.sceneView()?.camera?.position.z;
    return typeof z === "number" && Number.isFinite(z) ? z : null;
  }
  flyTo(camera: FlyToCamera): void {
    const view = this.view;
    if (!view) return;
    void view
      .goTo(
        {
          ...(camera.center ? { center: camera.center } : {}),
          ...(camera.zoom !== undefined ? this.zoomTarget(camera.zoom) : {}),
          ...this.orientation(camera.bearing, camera.pitch),
        },
        { duration: camera.duration ?? 800 },
      )
      .catch(reportGoToFailure);
  }
  flyToView(location: StoryChapterLocation): void {
    // A chapter preview is scripted, like a chapter's own move.
    this.markStoryMove();
    this.flyTo(location);
  }
  /**
   * Flag the camera move now starting as a story move, so the settle that
   * ends it reports `storyCamera`. An instant jump may never change
   * `stationary`, so the flag also lapses shortly after the move.
   */
  private markStoryMove(): void {
    this.storyMove = true;
    clearTimeout(this.storyMoveLapse);
    this.storyMoveLapse = setTimeout(() => {
      if (this.view?.stationary !== false) this.storyMove = false;
    }, 1500);
  }
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
  ): void {
    this.stopCamera();
    const view = this.view;
    if (!view) return;
    this.markStoryMove();
    const token = this.storyCameraToken;
    void view
      .goTo(
        {
          ...(location.center ? { center: location.center } : {}),
          ...(location.zoom !== undefined ? this.zoomTarget(location.zoom) : {}),
          ...this.orientation(location.bearing, location.pitch),
        },
        { duration: animation === "jumpTo" ? 0 : 800, animate: animation !== "jumpTo" },
      )
      .then(() => {
        // A later chapter (or any camera stop) superseded this move while it
        // flew; its rotation would otherwise orbit the wrong chapter.
        if (rotate && this.view && token === this.storyCameraToken) this.rotate();
      })
      .catch(reportGoToFailure);
  }
  /**
   * One half turn at MapLibre's story pace (180° over 30 s), as the MapLibre
   * and Mapbox engines do; it stops there rather than orbiting forever.
   */
  private rotate(): void {
    const view = this.view;
    if (!view) return;
    // MapLibre's story rotation turns the bearing forward; `rotation` runs
    // the other way to `heading`.
    const turn =
      view.type === "3d"
        ? { heading: (view.camera?.heading ?? 0) + 180 }
        : { rotation: view.rotation - 180 };
    this.markStoryMove();
    void view.goTo(turn, { duration: 30000, easing: "linear" }).catch(reportGoToFailure);
  }
  /**
   * A goTo zoom target. A view without a tiling scheme (the Blank basemap on
   * a MapView) reports `zoom` as -1 and cannot be sent to a zoom level, so
   * the level is given as the equivalent scale there.
   */
  private zoomTarget(zoom: number): { zoom: number } | { scale: number } {
    return this.view && this.view.zoom < 0 ? { scale: zoomToScale(zoom) } : { zoom };
  }
  zoomIn(): void {
    const view = this.view;
    if (view)
      void view
        .goTo(this.zoomTarget(viewZoom(view) + 1), { duration: 500 })
        .catch(reportGoToFailure);
  }
  zoomOut(): void {
    const view = this.view;
    if (view)
      void view
        .goTo(this.zoomTarget(viewZoom(view) - 1), { duration: 500 })
        .catch(reportGoToFailure);
  }
  resetNorth(): void {
    void this.view
      ?.goTo(this.orientation(0, undefined), { duration: 1000 })
      .catch(reportGoToFailure);
  }
  resetNorthPitch(): void {
    void this.view?.goTo(this.orientation(0, 0), { duration: 1000 }).catch(reportGoToFailure);
  }
  resetPitch(): void {
    if (this.view?.type === "3d")
      void this.view.goTo({ tilt: 0 }, { duration: 1000 }).catch(reportGoToFailure);
  }
  fitBounds(bounds: MapExtent): void {
    const view = this.view;
    if (!view) return;
    if (bounds.some((value) => !Number.isFinite(value))) return;
    const [w, s, e, n] = bounds;
    // A point-sized extent cannot be fit; fly to the point at zoom 14 or
    // closer, as the MapLibre engine does. Any other extent is framed at
    // whatever zoom fits it.
    if (w === e && s === n) {
      void view
        .goTo(
          { center: [w, s], ...this.zoomTarget(Math.max(viewZoom(view), 14)) },
          { duration: 800 },
        )
        .catch(reportGoToFailure);
      return;
    }
    // The 2D map frames with 40 px padding; pad the extent by a tenth instead.
    const padX = Math.max((e - w) * 0.1, 1e-4);
    const padY = Math.max((n - s) * 0.1, 1e-4);
    const extent = new this.sdk.Extent({
      xmin: w - padX,
      ymin: Math.max(-85, s - padY),
      xmax: e + padX,
      ymax: Math.min(85, n + padY),
      spatialReference: { wkid: 4326 },
    });
    void view.goTo(extent, { duration: 800 }).catch(reportGoToFailure);
  }
  fitLayer(layer: GeoLibreLayer): void {
    const center = layer.metadata.center;
    const hasCenter =
      Array.isArray(center) &&
      center.length >= 2 &&
      center.slice(0, 2).every((v) => typeof v === "number" && Number.isFinite(v));
    // A tileset exposes only its center; look at it in perspective from a
    // conservative floor, as the MapLibre engine does (a scene only: a flat
    // view has no tilt).
    if (layer.type === "3d-tiles" && hasCenter && this.view) {
      this.flyTo({
        center: [center[0] as number, center[1] as number],
        zoom: Math.max(viewZoom(this.view), 14),
        ...(this.view.type === "3d" ? { pitch: Math.max(this.view.camera?.tilt ?? 0, 60) } : {}),
      });
      return;
    }
    const bounds = getLayerBounds(layer);
    if (bounds) {
      // A tile source carries data only from its `minzoom` up; fitting the
      // whole extent would land below it and draw nothing, so fly to the
      // extent's center at that zoom instead.
      const minRenderZoom = [layer.source.minzoom, layer.metadata.minzoom].find(
        (value): value is number =>
          typeof value === "number" && Number.isFinite(value) && value > 0,
      );
      const fit = this.fitZoom(bounds);
      if (minRenderZoom !== undefined && fit !== null && fit < minRenderZoom) {
        this.flyTo({
          center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2],
          zoom: minRenderZoom,
        });
        return;
      }
      this.fitBounds(bounds);
      return;
    }
    if (hasCenter) {
      this.flyTo({
        center: [center[0] as number, center[1] as number],
        zoom: typeof layer.metadata.zoom === "number" ? layer.metadata.zoom : 16,
      });
      return;
    }
    // A service layer knows its own extent once loaded.
    const native = this.natives.get(layer.id)?.layers[0];
    if (native?.fullExtent)
      void this.view?.goTo(native.fullExtent, { duration: 800 }).catch(reportGoToFailure);
  }
  /**
   * The zoom at which `bounds` fills the view, in Web Mercator, or null before
   * the view has a size. `fitBounds` lets the SDK frame the extent; this only
   * compares a fit against a zoom floor before moving.
   */
  private fitZoom(bounds: MapExtent): number | null {
    const view = this.view;
    if (!view || !(view.width > 0) || !(view.height > 0)) return null;
    const mercatorY = (lat: number) => {
      const clamped = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
      return Math.log(Math.tan(Math.PI / 4 + clamped / 2));
    };
    // Fractions of the world's width and height the extent spans.
    const spanX = Math.max((bounds[2] - bounds[0]) / 360, 1e-12);
    const spanY = Math.max((mercatorY(bounds[3]) - mercatorY(bounds[1])) / (2 * Math.PI), 1e-12);
    return Math.min(Math.log2(view.width / 256 / spanX), Math.log2(view.height / 256 / spanY));
  }
  readProjection(): MapProjection {
    return this.sceneView()?.viewingMode === "global" ? "globe" : "mercator";
  }
  applyMapPreferences(p: MapPreferences): void {
    this.preferences = p;
    if (!this.view) return;
    this.setTerrainEnabled(p.terrainEnabled);
    (this.builtInControls.get("scale") as ArcgisScaleBar | undefined)?.setUnit(p.scaleUnit);
    this.applyNavigationLimits();
  }
  /**
   * Hold the view to the project's zoom range, pitch limit and bounds. Rerun
   * when the view is ready, resized or given another zoom-level scheme (a
   * basemap swap): the bounds' minimum zoom depends on the view's size, and a
   * flat view's limits are scales in its own scheme.
   */
  private applyNavigationLimits(): void {
    const p = this.preferences;
    const view = this.view;
    if (!p || !view) return;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const { minZoom, maxZoom } = this.zoomRange();
    if (view.type === "3d") {
      // A SceneView's constraints are about the camera: the pitch limit
      // becomes the tilt limit and, on a globe, the zoom range an altitude
      // range. The bounds (and a local scene's zoom) are held by
      // `constrainSettledView` once the camera settles.
      if (view.constraints.tilt) view.constraints.tilt.max = clamp(p.maxPitch, 0, 85);
      // An unsized view has no diagonal to measure yet; the size watch
      // applies the range once it has one.
      if (view.viewingMode === "global" && view.width > 0 && view.height > 0)
        view.constraints.altitude = {
          min: this.altitudeForZoom(view, maxZoom),
          max: this.altitudeForZoom(view, minZoom),
        };
      this.constrainSettledView();
      return;
    }
    view.constraints = {
      // No SDK zoom limits: with zoom snapping off (MapLibre's continuous
      // zoom), the SDK refuses a wheel step that would cross a limit instead
      // of stopping at it, which can stop the wheel well short of the limit
      // or at the current zoom. The zoom range is held by the wheel guard in
      // the constructor and by `constrainSettledView`.
      minZoom: -1,
      maxZoom: -1,
      minScale: 0,
      maxScale: 0,
      rotationEnabled: true,
      snapToZoom: false,
      // The bounds are held by `constrainSettledView`, not the SDK's lateral
      // `geometry`: with a zoom limit as well, the SDK refuses to zoom out by
      // wheel at all. The SDK always wraps around the antimeridian, so
      // `renderWorldCopies` is only honoured for the views the app applies.
      geometry: null,
    };
    this.constrainSettledView();
  }
  /**
   * The project's zoom range in MapLibre levels. With restricted bounds the
   * minimum rises until the bounds fill the view, as on the 2D map.
   */
  private zoomRange(): { minZoom: number; maxZoom: number } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    if (!p) return { minZoom: 0, maxZoom: 24 };
    const requested = clamp(p.minZoom, 0, 24);
    const view = this.view;
    const minZoom =
      view && view.width > 0 && view.height > 0
        ? boundsFillMinZoom(p, view.width, view.height, requested)
        : requested;
    return { minZoom, maxZoom: Math.max(minZoom, clamp(p.maxZoom, 0, 24)) };
  }
  /**
   * The camera height a nadir `SceneView` has at a MapLibre zoom level: the
   * height at which the view's diagonal field of view spans the zoom's
   * ground resolution (the SDK's scale is measured over the diagonal).
   */
  private altitudeForZoom(view: ArcgisSceneView, zoom: number): number {
    const metresPerPixel = (scaleForZoom(view, zoom) * 0.0254) / 96;
    const diagonal = Math.hypot(view.width || 1, view.height || 1);
    const fov = ((view.camera?.fov ?? 55) * Math.PI) / 180;
    return (metresPerPixel * diagonal) / (2 * Math.tan(fov / 2));
  }
  /**
   * Bring a settled view back inside the project's zoom range and bounds,
   * which the SDK's constraints cannot hold: a scene's altitude limit only
   * approximates the zoom range, and neither view limits the extent (see
   * `applyNavigationLimits`). Like the SDK's own lateral limit, it holds the
   * centre inside the bounds, where MapLibre keeps the whole viewport.
   */
  private constrainSettledView(): void {
    const view = this.view;
    const p = this.preferences;
    // Not before the stored camera is placed: the view's default camera would
    // start a correction that interrupts `settleView`'s own move.
    if (!view || !p || !this.placed || !view.ready || !view.stationary || this.storyMove) return;
    const { minZoom, maxZoom } = this.zoomRange();
    const zoom = viewZoom(view);
    const bounds = p.restrictBounds ? normalizeMapBounds(p.bounds) : null;
    const lng = view.center.longitude ?? 0;
    const lat = view.center.latitude ?? 0;
    const center: [number, number] = bounds
      ? [
          Math.min(bounds[2], Math.max(bounds[0], lng)),
          Math.min(bounds[3], Math.max(bounds[1], lat)),
        ]
      : [lng, lat];
    // A little slack, so the SDK's own rounding never starts a correction.
    const targetZoom = zoom < minZoom - 0.05 ? minZoom : zoom > maxZoom + 0.05 ? maxZoom : null;
    // The SDK's projection round trip can leave a settled centre a hair past
    // the edge it was moved to; that must not start another correction.
    const moved = Math.abs(center[0] - lng) > 1e-6 || Math.abs(center[1] - lat) > 1e-6;
    if (targetZoom === null && !moved) return;
    void view
      .goTo(
        { center, ...(targetZoom === null ? {} : this.zoomTarget(targetZoom)) },
        { duration: 300 },
      )
      .catch(reportGoToFailure);
  }

  // ------------------------------------------------------------------- layers

  syncLayers(layers: GeoLibreLayer[]): void {
    this.layers = layers;
    const map = this.map;
    if (!map) return;
    const ids = new Set(layers.map((layer) => layer.id));
    const previousCogUrls = this.cogUrls;
    this.cogUrls = new Set(
      layers
        .filter((layer) => layer.type === "cog")
        .map(cogSourceUrl)
        .filter((url): url is string => !!url),
    );
    void this.cogTiler
      ?.then((tiler) => {
        for (const url of previousCogUrls) if (!this.cogUrls.has(url)) tiler.forget(url);
      })
      .catch(() => {});
    for (const id of [...this.natives.keys()]) if (!ids.has(id)) this.removeLayer(id);
    for (const key of [...this.errors.keys()])
      if (key.startsWith("layer:") && !ids.has(key.slice(6))) this.errors.delete(key);
    // Store order is topmost first; the SDK draws index 0 at the bottom.
    const ordered: ArcgisLayer[] = [];
    for (const original of [...layers].reverse()) {
      const opacity = this.storyOpacities.get(original.id);
      const layer = opacity === undefined ? original : { ...original, opacity };
      if (isArcgisPluginLayer(original)) {
        this.removeLayer(original.id);
        // The layer panels badge it too; the banner says why it is missing.
        if (original.visible)
          this.errors.set(`layer:${original.id}`, this.messages.pluginLayer(original.name));
        continue;
      }
      try {
        let entry = this.natives.get(layer.id);
        const compileKey = layer.geojson ? geojsonCompileKey(layer) : undefined;
        // Baking a GeoJSON layer's symbols walks every feature; an opacity
        // tick, a visibility toggle or a rename leaves them as they were, so
        // the plan is reused with only its display fields replaced.
        const reusable =
          entry?.plan.kind === "geojson" &&
          compileKey !== undefined &&
          entry.compileKey === compileKey &&
          entry.geojson === layer.geojson &&
          (!entry.plan.zoomDependent || entry.compiledZoom === this.compiledZoom);
        const plan: ArcgisLayerPlan =
          reusable && entry
            ? {
                ...entry.plan,
                title: layer.name,
                visible: layer.visible,
                opacity: Math.min(1, Math.max(0, layer.opacity)),
                blendMode: arcgisBlendMode(layer.style),
              }
            : compileArcgisLayer(layer, {
                zoom: this.compiledZoom,
                scene: this.view?.type === "3d",
                deckOverlay: this.capabilities.deckOverlay,
              });
        const signature = reusable && entry ? entry.signature : planSignature(plan, layer);
        if (entry && (entry.signature !== signature || entry.geojson !== layer.geojson)) {
          // Anything but the display fields changed (a re-style, a filter, an
          // edit to the features): rebuild the native layers.
          this.removeLayer(layer.id);
          entry = undefined;
        }
        if (!entry) {
          entry = { plan, signature, layers: [], urls: [], disposers: [], geojson: layer.geojson };
          this.natives.set(layer.id, entry);
          for (const native of this.instantiate(plan, entry.urls, entry.disposers)) {
            // A mixed-geometry GeoJSON record has several native layers but
            // one shared visibility toggle. Service sublayers stay managed by
            // their source record rather than exposing unsaved native changes.
            native.listMode = entry.layers.length ? "hide" : "hide-children";
            entry.layers.push(native);
            map.add(native);
          }
          const first = entry.layers[0];
          if (first && this.options.onLayerVisibilityChange) {
            entry.visibilityHandle = this.sdk.reactiveUtils.watch(
              () => first.visible,
              () => {
                const current = this.natives.get(layer.id);
                if (current?.layers[0] !== first || first.visible === current.plan.visible) return;
                this.options.onLayerVisibilityChange?.(layer.id, first.visible);
              },
              // Commit native toggles before another store sync can overwrite them.
              { sync: true },
            );
          }
        }
        entry.plan = plan;
        entry.compileKey = compileKey;
        entry.compiledZoom = this.compiledZoom;
        if (plan.kind === "feature-service" && plan.filterUnsupported)
          this.errors.set(`filter:${layer.id}`, this.messages.filterNoSql(layer.name));
        else this.errors.delete(`filter:${layer.id}`);
        for (const native of entry.layers) {
          if (plan.kind === "zarr") {
            const zarr = native as import("./arcgis-zarr").ArcgisZarrLayer;
            zarr.setSelector((plan.source.source.selector ?? {}) as Record<string, unknown>);
            zarr.setStyle(plan.source.source);
          }
          native.title = plan.title;
          native.visible = plan.visible;
          native.opacity = plan.opacity;
          native.blendMode = plan.blendMode;
          native.effect = isArcgisRasterPlan(plan) ? plan.effect : null;
          native.minScale = plan.minScale;
          native.maxScale = plan.maxScale;
        }
        ordered.push(...entry.layers);
        this.errors.delete(`layer:${layer.id}`);
      } catch (error) {
        this.removeLayer(original.id);
        if (original.visible)
          this.errors.set(
            `layer:${original.id}`,
            `${original.name}: ${redactArcgisError(String((error as Error).message ?? error))}`,
          );
      }
    }
    ordered.forEach((native, index) => {
      if (map.layers.indexOf(native) !== index) map.layers.reorder(native, index);
    });
    if (this.highlight && map.layers.indexOf(this.highlight) !== map.layers.length - 1)
      map.layers.reorder(this.highlight, map.layers.length - 1);
  }
  /** Build the SDK layers for a plan, recording blob URLs to revoke on removal. */
  private instantiate(
    plan: ArcgisLayerPlan,
    urls: string[],
    disposers: (() => void)[],
  ): ArcgisLayer[] {
    const { layers, media } = this.sdk;
    const common = {
      title: plan.title,
      visible: plan.visible,
      opacity: plan.opacity,
      minScale: plan.minScale,
      maxScale: plan.maxScale,
    };
    const fullExtent = plan.bounds
      ? {
          fullExtent: new this.sdk.Extent({
            xmin: plan.bounds[0],
            ymin: plan.bounds[1],
            xmax: plan.bounds[2],
            ymax: plan.bounds[3],
            spatialReference: { wkid: 4326 },
          }),
        }
      : {};
    switch (plan.kind) {
      case "zarr": {
        const bridge = createArcgisZarrLayer(this.sdk, plan.source, common);
        disposers.push(bridge.dispose);
        return [bridge.layer];
      }
      case "archive": {
        const bridge = createArcgisArchiveLayer(this.sdk, plan, common);
        disposers.push(bridge.dispose);
        return [bridge.layer];
      }
      case "external-deck":
        return [];
      case "cog":
        return [
          createArcgisCogLayer(this.sdk, plan.source, common, () => this.loadCachedCogTiler()),
        ];
      case "geojson":
        return plan.parts.map((part) => {
          let url = part.url;
          if (!url) {
            url = URL.createObjectURL(
              new Blob(
                [JSON.stringify(part.features ?? { type: "FeatureCollection", features: [] })],
                {
                  type: "application/geo+json",
                },
              ),
            );
            urls.push(url);
          }
          const native = new layers.GeoJSONLayer({
            ...common,
            url,
            geometryType: part.geometryType,
            renderer: rendererWithFallbackMarkers(part.renderer),
            // Hit-test graphics only carry the fields the renderer and labels
            // read unless every field is requested; identify needs the
            // compiler's identity field.
            outFields: ["*"],
            // Declared rather than inferred: the SDK sizes an inferred string
            // field from sampled features and truncates longer values later,
            // which would clip labels (and once clipped the symbol key).
            fields: part.url ? undefined : ARCGIS_GEOJSON_FIELDS,
            ...(part.labelingInfo ? { labelingInfo: part.labelingInfo, labelsVisible: true } : {}),
            ...(part.elevationInfo ? { elevationInfo: part.elevationInfo } : {}),
            ...(part.hasZ ? { hasZ: true } : {}),
            ...(part.featureReduction ? { featureReduction: part.featureReduction } : {}),
            // The SDK's popup is not used; identify goes through hitTest.
            popupEnabled: false,
            legendEnabled: false,
          });
          if (part.interactive === false) this.companions.add(native);
          if (part.markerStyle) void this.bakeMarkers(native, part);
          if (part.patternStyle) void this.bakePattern(native, part);
          return native;
        });
      case "web-tile":
        return [
          new layers.WebTileLayer({
            ...common,
            ...fullExtent,
            urlTemplate: plan.urlTemplate,
            ...(plan.subDomains ? { subDomains: plan.subDomains } : {}),
            ...(plan.copyright ? { copyright: plan.copyright } : {}),
          }),
        ];
      case "template-tile":
        return [
          createArcgisTemplateTileLayer(this.sdk, plan, {
            ...common,
            ...(plan.copyright ? { copyright: plan.copyright } : {}),
          }),
        ];
      case "wms":
        return [
          new layers.WMSLayer({
            ...common,
            ...fullExtent,
            url: plan.url,
            sublayers: plan.sublayers,
            ...(plan.version ? { version: plan.version } : {}),
            ...(plan.imageFormat ? { imageFormat: plan.imageFormat } : {}),
            imageTransparency: plan.imageTransparency,
            ...(plan.customParameters ? { customParameters: plan.customParameters } : {}),
          }),
        ];
      case "vector-tile": {
        // `fullExtent` is read-only on a VectorTileLayer (it comes from the style).
        const sprite = attachArcgisSprite(this.sdk, plan.style);
        disposers.push(sprite.dispose);
        return [new layers.VectorTileLayer({ ...common, style: sprite.style })];
      }
      case "feature-service": {
        const native = new layers.FeatureLayer({
          ...common,
          url: plan.url,
          popupEnabled: false,
          outFields: ["*"],
          ...(plan.definitionExpression ? { definitionExpression: plan.definitionExpression } : {}),
        });
        // The service's geometry type is known only once it has loaded.
        const symbols = plan.symbols;
        if (symbols)
          void native
            .when()
            .then(() => {
              // A restyle or removal may have replaced the layer meanwhile.
              if (native.destroyed) return;
              const type = (native as { geometryType?: string }).geometryType;
              const kind = type === "multipoint" ? "point" : type;
              if (kind === "point" || kind === "polyline" || kind === "polygon")
                native.renderer = { type: "simple", symbol: symbols[kind] };
            })
            .catch(() => {});
        return [native];
      }
      case "tile-service":
        return [new layers.TileLayer({ ...common, url: plan.url })];
      case "map-image":
        return [new layers.MapImageLayer({ ...common, url: plan.url })];
      case "imagery":
        return [new layers.ImageryLayer({ ...common, url: plan.url })];
      case "media-image": {
        // The four corners are an arbitrary quad (the georeferencer fits an
        // affine transform), which only a control-point georeference can
        // express; it needs the image's pixel size, so the element is added
        // once the image has loaded. Without a DOM `Image` (the tests) the
        // layer stays empty.
        const layer = new layers.MediaLayer({ ...common, source: [] });
        if (typeof Image !== "undefined") {
          const image = new Image();
          image.crossOrigin = "anonymous";
          image.onload = () => {
            if (layer.destroyed) return;
            const toMap = (p: Position) =>
              this.sdk.webMercatorUtils.geographicToWebMercator(
                new this.sdk.Point({
                  longitude: p[0],
                  latitude: p[1],
                  spatialReference: { wkid: 4326 },
                }),
              );
            const [tl, tr, br, bl] = plan.corners;
            const { naturalWidth: width, naturalHeight: height } = image;
            (layer as unknown as { source: unknown }).source = [
              new media.ImageElement({
                image,
                georeference: new media.ControlPointsGeoreference({
                  width,
                  height,
                  controlPoints: [
                    { sourcePoint: { x: 0, y: 0 }, mapPoint: toMap(tl) },
                    { sourcePoint: { x: width, y: 0 }, mapPoint: toMap(tr) },
                    { sourcePoint: { x: width, y: height }, mapPoint: toMap(br) },
                    { sourcePoint: { x: 0, y: height }, mapPoint: toMap(bl) },
                  ],
                }),
              }),
            ];
          };
          image.onerror = () => {
            this.errors.set(`layer:${plan.id}`, this.messages.imageFailed(plan.title));
          };
          image.src = plan.url;
        }
        return [layer];
      }
    }
  }
  private removeLayer(id: string): void {
    const entry = this.natives.get(id);
    if (entry) {
      entry.visibilityHandle?.remove();
      for (const native of entry.layers) {
        if (this.map?.layers.includes(native)) this.map.remove(native);
        native.destroy();
      }
      for (const dispose of entry.disposers) dispose();
      for (const url of entry.urls) URL.revokeObjectURL(url);
    }
    this.natives.delete(id);
    this.errors.delete(`layer:${id}`);
    this.errors.delete(`filter:${id}`);
    for (const key of [...this.serviceGeometries.keys()])
      if (key.startsWith(`${id}:`)) this.serviceGeometries.delete(key);
  }
  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    this.syncLayers(layers);
  }
  async getLayerGeoJson(id: string): Promise<FeatureCollection | null> {
    const layer = this.layers.find((l) => l.id === id);
    if (layer?.geojson) return layer.geojson;
    // A service layer's features live on the server: page through them the
    // way the service allows (its maxRecordCount per request), up to a cap.
    const entry = this.natives.get(id);
    const native = entry?.plan.kind === "feature-service" ? entry.layers[0] : undefined;
    if (!native?.queryFeatures) return null;
    const graphics: ArcgisGraphic[] = [];
    let oidField: string | undefined;
    const toCollection = (): FeatureCollection => ({
      type: "FeatureCollection",
      features: graphics.flatMap((graphic) => {
        const geometry = this.graphicGeometryToGeoJson(graphic.geometry);
        // The service's object id is the feature's identity, as identify
        // reports it.
        const oid = oidField ? graphic.attributes?.[oidField] : undefined;
        return geometry
          ? [
              {
                type: "Feature" as const,
                ...(typeof oid === "string" || typeof oid === "number" ? { id: oid } : {}),
                properties: stripSyntheticFields(graphic.attributes ?? {}),
                geometry,
              },
            ]
          : [];
      }),
    });
    try {
      // The service's metadata (object id field, capabilities) is read from
      // the loaded layer.
      await native.when();
      // A stable order, so offset pages neither overlap nor skip rows — where
      // the service supports ORDER BY at all.
      oidField = (native as { objectIdField?: string }).objectIdField;
      const orderBy =
        (native as { capabilities?: { query?: { supportsOrderBy?: boolean } } }).capabilities?.query
          ?.supportsOrderBy === true;
      let firstOfPreviousPage: string | undefined;
      // The SDK's query asks for 10 rows once `start` is set unless told
      // otherwise; later pages ask for as many as the first page returned
      // (the service's per-request limit).
      let pageSize = 0;
      for (let page = 0; page < SERVICE_GEOJSON_MAX_PAGES; page++) {
        const result = await native.queryFeatures({
          where: "1=1",
          outFields: ["*"],
          returnGeometry: true,
          outSpatialReference: { wkid: 4326 },
          ...(oidField && orderBy ? { orderByFields: [oidField] } : {}),
          ...(graphics.length ? { start: graphics.length, num: pageSize } : {}),
        });
        if (page === 0) pageSize = result.features.length;
        // A service that ignores the offset returns its first page again;
        // stop rather than repeat it.
        const first = JSON.stringify(result.features[0]?.attributes ?? null);
        if (page > 0 && first === firstOfPreviousPage) break;
        firstOfPreviousPage = first;
        graphics.push(...result.features);
        if (!result.exceededTransferLimit || !result.features.length) break;
      }
      return toCollection();
    } catch {
      // A page failing part way still returns what was read before it.
      return graphics.length ? toCollection() : null;
    }
  }
  /**
   * The store record's tile templates as plain HTTP(S) URLs, as a story export
   * rebuilds them in a MapLibre page with none of the app's protocols: the
   * desktop's `geolibre-wms://tile?url=` wrapper is unwrapped, and any other
   * protocol template is left out.
   */
  private storeTiles(id: string): string[] | null {
    const tiles = this.layers.find((l) => l.id === id)?.source.tiles;
    if (!Array.isArray(tiles)) return null;
    const http = tiles
      .filter((tile): tile is string => typeof tile === "string")
      // A malformed wrapper (a hand-edited project) stays wrapped and is
      // left out below.
      .map((tile) => portableWmsTileUrl(tile) as string)
      .filter((tile) => /^https?:\/\//i.test(tile));
    return http.length ? http : null;
  }
  getLayerRasterSource(id: string): Record<string, unknown> | null {
    const plan = this.natives.get(id)?.plan;
    if (!plan) return null;
    if (plan.kind === "template-tile")
      return {
        type: "raster",
        // The store's templates: the plan's are dev-proxied for WMS records.
        tiles: this.storeTiles(id) ?? plan.templates,
        scheme: plan.scheme,
        tileSize: plan.tileSize,
        minzoom: plan.minzoom,
        maxzoom: plan.maxzoom,
        ...(plan.copyright ? { attribution: plan.copyright } : {}),
      };
    if (plan.kind === "web-tile") {
      // The plan holds the SDK's `{level}/{col}/{row}` form; exports want the
      // store's MapLibre template.
      return {
        type: "raster",
        tiles: this.storeTiles(id) ?? [plan.urlTemplate],
        ...(plan.copyright ? { attribution: plan.copyright } : {}),
      };
    }
    if (plan.kind === "media-image") return { type: "image", url: plan.url };
    if (plan.kind === "wms" || plan.kind === "archive") {
      const tiles = this.storeTiles(id);
      return tiles ? { type: "raster", tiles, tileSize: 256 } : null;
    }
    // A service record names only the service; MapLibre draws its cache or
    // its export endpoint as a tile template.
    const path =
      (plan.kind === "tile-service" || plan.kind === "map-image" || plan.kind === "imagery") &&
      plan.url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (!path) return null;
    // `/tile` and `/export` live on the service root; a sublayer the record
    // names is drawn alone through `layers=show:`.
    const sublayer = plan.kind === "map-image" ? /\/(\d+)$/.exec(path)?.[1] : undefined;
    const service = sublayer ? path.replace(/\/\d+$/, "") : path;
    const exportParams = `bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true${
      sublayer ? `&layers=show:${sublayer}` : ""
    }&f=image`;
    return {
      type: "raster",
      tileSize: 256,
      tiles: [
        plan.kind === "tile-service"
          ? `${service}/tile/{z}/{y}/{x}`
          : `${service}/${plan.kind === "imagery" ? "exportImage" : "export"}?${exportParams}`,
      ],
    };
  }

  // ------------------------------------------------------------------ basemap

  /**
   * Draw the basemap for the shared project style and the ArcGIS override.
   * The canvas calls this on mount and whenever either preference changes.
   */
  setBasemap(styleUrl: string | undefined, arcgisBasemap: string | undefined): void {
    const plan = planArcgisBasemap(styleUrl, arcgisBasemap, this.options.hasApiKey === true);
    if (this.basemapPlan && sameArcgisBasemapPlan(this.basemapPlan, plan)) return;
    this.basemapPlan = plan;
    const map = this.map;
    if (!map) return;
    this.errors.delete("basemap");
    const previous = map.basemap;
    switch (plan.kind) {
      case "none":
        map.basemap = null;
        break;
      case "esri-style":
        // A string id autocasts to a basemap styles service basemap.
        (map as unknown as { basemap: unknown }).basemap = plan.id;
        break;
      case "tile-service":
        map.basemap = new this.sdk.Basemap({
          baseLayers: [new this.sdk.layers.TileLayer({ url: plan.url })],
        });
        break;
      case "web-tile":
        map.basemap = new this.sdk.Basemap({
          baseLayers: [
            new this.sdk.layers.WebTileLayer({
              urlTemplate: plan.urlTemplate,
              ...(plan.subDomains ? { subDomains: plan.subDomains } : {}),
              copyright: plan.copyright,
            }),
            ...(plan.overlay
              ? [
                  new this.sdk.layers.WebTileLayer({
                    urlTemplate: plan.overlay.urlTemplate,
                    ...(plan.overlay.subDomains ? { subDomains: plan.overlay.subDomains } : {}),
                    copyright: plan.copyright,
                  }),
                ]
              : []),
          ],
        });
        break;
    }
    if (previous && previous !== map.basemap) previous.destroy?.();
    this.applyBasemap();
    // A named Esri style fills its layers asynchronously; re-apply the stored
    // visibility and opacity once they exist, and surface a style that fails
    // to load (a key without the basemaps privilege, say).
    const current = map.basemap;
    if (current && typeof current === "object" && typeof current.when === "function") {
      void current
        .when()
        .then(() => {
          if (this.map?.basemap === current) this.applyBasemap();
        })
        .catch((error: unknown) => {
          if (this.map?.basemap === current)
            this.errors.set(
              "basemap",
              `Basemap: ${redactArcgisError((error as Error)?.message ?? String(error))}`,
            );
        });
    }
  }
  setStyle(url: string): void {
    this.setBasemap(url, undefined);
  }
  getBasemapStyleLayerIds(): string[] {
    return [];
  }
  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemap();
  }
  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemap();
  }
  private applyBasemap(): void {
    const basemap = this.map?.basemap;
    if (!basemap || typeof basemap !== "object" || !basemap.baseLayers) return;
    const apply = (layer: ArcgisLayer) => {
      layer.visible = this.basemapVisible;
      layer.opacity = this.basemapOpacity;
    };
    basemap.baseLayers.forEach(apply);
    basemap.referenceLayers?.forEach(apply);
  }
  setBlankBackgroundColor(color: string | null): void {
    this.blankColor = color;
    const view = this.view;
    if (!view) return;
    const fill =
      color ?? (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff");
    if (view.type === "2d") {
      view.background = { type: "color", color: fill };
      return;
    }
    // A scene has no background behind the map: what shows without a basemap
    // is the ground's surface. A global scene keeps its sky around the globe.
    if (this.map?.ground) this.map.ground.surfaceColor = fill;
    if (view.viewingMode === "local") view.environment.background = { type: "color", color: fill };
  }

  // ---------------------------------------------------------- story rendering

  setStoryLayerOpacity(id: string, opacity: number, durationMs = 0): void {
    const target = Math.min(1, Math.max(0, opacity));
    const from = this.natives.get(id)?.layers[0]?.opacity;
    this.cancelStoryFade(id);
    this.storyOpacities.set(id, target);
    // The sync applies the target (and builds the layer if it is new).
    this.syncLayers(this.layers);
    const natives = this.natives.get(id)?.layers ?? [];
    if (
      durationMs <= 0 ||
      from === undefined ||
      from === target ||
      !natives.length ||
      typeof requestAnimationFrame === "undefined"
    )
      return;
    // Fade from where the layer was, over the chapter's transition, as
    // MapLibre's paint-property transition does.
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      for (const native of natives) native.opacity = from + (target - from) * t;
      if (t < 1) this.storyFades.set(id, requestAnimationFrame(step));
      else this.storyFades.delete(id);
    };
    for (const native of natives) native.opacity = from;
    this.storyFades.set(id, requestAnimationFrame(step));
  }
  /** Stop a running story fade, leaving the layer at whatever the sync last applied. */
  private cancelStoryFade(id: string): void {
    const frame = this.storyFades.get(id);
    if (frame !== undefined) cancelAnimationFrame(frame);
    this.storyFades.delete(id);
  }
  restoreLayerStyles(): void {
    for (const id of [...this.storyFades.keys()]) this.cancelStoryFade(id);
    this.storyOpacities.clear();
    this.syncLayers(this.layers);
  }

  // ------------------------------------------------------------------ picking

  /**
   * Hit-test the map at a screen point. The SDK's picking is asynchronous, so
   * the canvas awaits this on click and the synchronous {@link identifyFeatures}
   * answers from the same result for callers that pass the clicked location.
   */
  async identifyFeaturesAt(
    screenPoint: { x: number; y: number },
    layerId?: string,
  ): Promise<IdentifiedFeature[]> {
    const view = this.view;
    if (!view) return [];
    const external = identifyArcgisControls(view, screenPoint, layerId);
    const include = [...this.natives]
      .filter(([id]) => !layerId || id === layerId)
      .flatMap(([, entry]) => entry.layers.filter((native) => !this.companions.has(native)));
    if (!include.length) return external;
    let hit;
    try {
      hit = await view.hitTest(screenPoint, { include });
    } catch {
      return external;
    }
    // The engine may have been destroyed (a renderer swap, an unmounted pane)
    // while the hit test was in flight; the captured view is gone with it.
    if (this.view !== view) return external;
    const seen = new Set<string>();
    const features: IdentifiedFeature[] = [...external];
    for (const result of hit.results) {
      if (result.type !== "graphic" || !result.graphic) continue;
      // A cluster is a summary graphic whose object id names no feature.
      if (result.graphic.isAggregate) continue;
      const native = result.graphic.layer ?? result.layer ?? null;
      const storeId = native ? this.storeIdFor(native) : undefined;
      if (!storeId) continue;
      const attributes = result.graphic.attributes ?? {};
      const storeLayer = this.layers.find((l) => l.id === storeId);
      const rawId = attributes[ARCGIS_ID_FIELD];
      // A service layer's features never live in the store; their object id
      // is the identity the SDK offers.
      // The service names its own object id field (`objectid`, `FID`, ...).
      const oidField = (native as { objectIdField?: string } | null)?.objectIdField;
      const oid =
        (oidField ? attributes[oidField] : undefined) ??
        attributes.OBJECTID ??
        attributes.__OBJECTID;
      const featureId = rawId != null ? String(rawId) : oid != null ? String(oid) : null;
      const feature =
        rawId != null
          ? storeLayer?.geojson?.features.find((f, i) => String(f.id ?? i) === featureId)
          : undefined;
      const key = `${storeId}:${featureId ?? JSON.stringify(attributes)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hitGeometry =
        feature?.geometry ?? this.graphicGeometryToGeoJson(result.graphic.geometry);
      if (!feature && featureId !== null && hitGeometry) {
        this.serviceGeometries.delete(`${storeId}:${featureId}`);
        this.serviceGeometries.set(`${storeId}:${featureId}`, hitGeometry);
        if (this.serviceGeometries.size > 500)
          this.serviceGeometries.delete(this.serviceGeometries.keys().next().value!);
      }
      features.push({
        layerId: storeId,
        featureId,
        properties: feature?.properties ?? stripSyntheticFields(attributes),
        // The store's geometry when the feature is there; otherwise the one
        // the hit test found (a service layer's), converted from the view.
        geometry: hitGeometry,
      });
    }
    try {
      const mapPoint = view.toMap(screenPoint);
      if (mapPoint) this.lastHit = { lngLat: [mapPoint.longitude, mapPoint.latitude], features };
    } catch {
      // A view torn down between the hit test and the conversion has no
      // location to remember; the features are still the answer.
    }
    return features;
  }
  /**
   * Features under `lngLat`, answered synchronously. The SDK's own hit test is
   * asynchronous, so the click flow goes through {@link identifyFeaturesAt} and
   * its result is served here for the same location; any other location (the
   * scripting, notebook and command bridges) is answered by testing the
   * store's GeoJSON geometry directly, with a few pixels of tolerance for
   * points and lines. Service layers, whose features live on the server, are
   * only reachable through the asynchronous path.
   */
  identifyFeatures(lngLat: [number, number], layerId?: string): IdentifiedFeature[] {
    const hit = this.lastHit;
    if (
      hit &&
      Math.abs(hit.lngLat[0] - lngLat[0]) <= 1e-6 &&
      Math.abs(hit.lngLat[1] - lngLat[1]) <= 1e-6
    )
      return layerId ? hit.features.filter((f) => f.layerId === layerId) : hit.features;
    const tolerance = this.degreesPerPixel(lngLat[1]) * HIT_TOLERANCE_PX;
    const zoom = this.compiledZoom;
    const features: IdentifiedFeature[] = [];
    // Store order is topmost first, which is the order a click should report.
    for (const layer of this.layers) {
      if (layerId && layer.id !== layerId) continue;
      if (!layer.visible || !layer.geojson || !this.natives.has(layer.id)) continue;
      layer.geojson.features.forEach((feature, index) => {
        if (!feature.geometry || !geometryContainsPoint(feature.geometry, lngLat, tolerance))
          return;
        if (!featurePassesFilters(layer, feature, zoom)) return;
        features.push({
          layerId: layer.id,
          featureId: String(feature.id ?? index),
          properties: feature.properties ?? {},
          geometry: feature.geometry,
        });
      });
    }
    return features;
  }
  /** An SDK geometry (in the view's spatial reference) as WGS84 GeoJSON, or null. */
  private graphicGeometryToGeoJson(geometry: ArcgisGraphic["geometry"]): Geometry | null {
    if (!geometry) return null;
    let source: ArcgisGraphic["geometry"] = geometry;
    try {
      const sr = (geometry as { spatialReference?: { isWebMercator?: boolean; wkid?: number } })
        .spatialReference;
      if (sr?.isWebMercator || sr?.wkid === 3857 || sr?.wkid === 102100)
        source = this.sdk.webMercatorUtils.webMercatorToGeographic(geometry);
    } catch {
      return null;
    }
    const g = source as unknown as {
      type: string;
      x?: number;
      y?: number;
      points?: Position[];
      paths?: Position[][];
      rings?: Position[][];
      xmin?: number;
      ymin?: number;
      xmax?: number;
      ymax?: number;
    };
    switch (g.type) {
      case "point":
        return typeof g.x === "number" && typeof g.y === "number"
          ? { type: "Point", coordinates: [g.x, g.y] }
          : null;
      case "multipoint":
        return g.points ? { type: "MultiPoint", coordinates: g.points } : null;
      case "polyline":
        return !g.paths
          ? null
          : g.paths.length === 1
            ? { type: "LineString", coordinates: g.paths[0] }
            : { type: "MultiLineString", coordinates: g.paths };
      case "polygon":
        // The SDK's rings carry no outer/hole grouping; a single polygon whose
        // first ring is the exterior is the best faithful reading.
        return g.rings ? { type: "Polygon", coordinates: g.rings } : null;
      case "extent":
        return [g.xmin, g.ymin, g.xmax, g.ymax].every((v) => typeof v === "number")
          ? {
              type: "Polygon",
              coordinates: [
                [
                  [g.xmin!, g.ymin!],
                  [g.xmax!, g.ymin!],
                  [g.xmax!, g.ymax!],
                  [g.xmin!, g.ymax!],
                  [g.xmin!, g.ymin!],
                ],
              ],
            }
          : null;
      default:
        return null;
    }
  }
  /** Degrees of longitude per screen pixel at `latitude`, from the view's resolution. */
  private degreesPerPixel(latitude: number): number {
    const view = this.view;
    const metersPerPixel =
      view?.type === "2d" && Number.isFinite(view.resolution) && view.resolution > 0
        ? view.resolution
        : // Web Mercator ground resolution at the compiled zoom.
          156543.03392804097 / 2 ** this.compiledZoom;
    const cos = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    return metersPerPixel / (111320 * cos);
  }
  /**
   * Rasterize the shared pattern tile into native picture fills. Until the
   * image resolves, the layer draws its ordinary solid polygon symbols.
   */
  private async bakePattern(native: ArcgisLayer, part: ArcgisGeoJsonPart): Promise<void> {
    if (!part.patternStyle || typeof document === "undefined") return;
    try {
      const tile = await renderFillPatternCanvas(part.patternStyle);
      if (!tile || native.destroyed) return;
      // PictureFillSymbol ignores its color property, including alpha. Bake
      // each class's fill opacity into the image; keep its outline independent.
      const urls = new Map<number, string>();
      native.renderer = mapRendererSymbols(part.renderer, (symbol) => {
        const fill = symbol as ArcgisSymbolJson;
        if (fill.type !== "simple-fill") return fill;
        const alpha = Array.isArray(fill.color) ? Number(fill.color[3] ?? 1) : 1;
        let url = urls.get(alpha);
        if (!url) {
          const canvas = document.createElement("canvas");
          canvas.width = tile.canvas.width;
          canvas.height = tile.canvas.height;
          const context = canvas.getContext("2d");
          if (!context) return fill;
          context.globalAlpha = Math.max(0, Math.min(1, alpha));
          context.drawImage(tile.canvas, 0, 0);
          url = canvas.toDataURL("image/png");
          urls.set(alpha, url);
        }
        return {
          type: "picture-fill",
          url,
          width: `${tile.canvas.width / tile.pixelRatio}px`,
          height: `${tile.canvas.height / tile.pixelRatio}px`,
          outline: fill.outline,
        };
      });
    } catch {
      // Invalid/unrenderable SVG retains the ordinary fill, as on the globe.
    }
  }

  /** Replace marker placeholders with the shared shape/SVG sprites. */
  private async bakeMarkers(native: ArcgisLayer, part: ArcgisGeoJsonPart): Promise<void> {
    const style = part.markerStyle;
    if (!style || part.renderer.type === "heatmap" || typeof document === "undefined") return;
    const symbols =
      part.renderer.type === "simple"
        ? [part.renderer.symbol]
        : part.renderer.uniqueValueInfos.map((info) => info.symbol);
    const colors = [
      ...new Set(
        symbols.flatMap((symbol) =>
          isMarkerPlaceholder(symbol) ? [(symbol as ArcgisMarkerPlaceholder).color] : [],
        ),
      ),
    ];
    const sprites = new Map<string, { url: string; size: number }>();
    await Promise.all(
      colors.map(async (color) => {
        try {
          const baked = await renderMarkerCanvas(style, color);
          if (baked)
            sprites.set(color, {
              url: baked.canvas.toDataURL("image/png"),
              size: baked.canvas.width / baked.pixelRatio,
            });
        } catch {
          // A sprite that fails to rasterize keeps its circle fallback.
        }
      }),
    );
    if (native.destroyed || !sprites.size) return;
    const resolve = (symbol: ArcgisSymbolJson | unknown): ArcgisSymbolJson => {
      if (!isMarkerPlaceholder(symbol)) return symbol as ArcgisSymbolJson;
      const marker = symbol as ArcgisMarkerPlaceholder;
      const sprite = sprites.get(marker.color);
      if (!sprite) return marker.fallback;
      const size = `${Math.max(1, sprite.size * marker.scale)}px`;
      return { type: "picture-marker", url: sprite.url, width: size, height: size };
    };
    native.renderer = mapRendererSymbols(part.renderer, resolve);
  }
  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { fit?: boolean },
  ): void {
    this.clearFeatureHighlight();
    const map = this.map;
    if (!map || !layer || featureId === null) return;
    const ids = new Set(Array.isArray(featureId) ? featureId : [featureId]);
    // A service layer's features are on the server; the ones identify hit
    // left their geometry behind for this.
    const selected: Feature[] = layer.geojson
      ? layer.geojson.features.filter((f, i) => ids.has(String(f.id ?? i)))
      : [...ids].flatMap((id) => {
          const geometry = this.serviceGeometries.get(`${layer.id}:${id}`);
          return geometry ? [{ type: "Feature" as const, id, properties: {}, geometry }] : [];
        });
    if (!selected.length) return;
    const plan = this.natives.get(layer.id)?.plan;
    const elevated = plan?.kind === "geojson" && plan.parts.some((part) => part.hasZ);
    const geometries =
      elevated && plan.kind === "geojson"
        ? plan.parts.flatMap(
            (part) =>
              part.features?.features
                .filter((feature) => ids.has(String(feature.properties?.[ARCGIS_ID_FIELD])))
                .map((feature) => feature.geometry) ?? [],
          )
        : selected.map((feature) => feature.geometry);
    const graphics: ArcgisGraphic[] = [];
    for (const sourceGeometry of geometries) {
      if (!sourceGeometry) continue;
      const geometry = geojsonToArcgisGeometry(sourceGeometry);
      if (!geometry) continue;
      if (elevated) geometry.hasZ = true;
      const isPoint = geometry.type === "point" || geometry.type === "multipoint";
      graphics.push(
        new this.sdk.Graphic({
          geometry,
          symbol: isPoint
            ? {
                type: "simple-marker",
                style: "circle",
                color: [250, 204, 21, 0.6],
                size: "20px",
                outline: { color: HIGHLIGHT_COLOR, width: "2px" },
              }
            : geometry.type === "polygon"
              ? {
                  type: "simple-fill",
                  style: "none",
                  outline: { color: HIGHLIGHT_COLOR, width: "4px" },
                }
              : { type: "simple-line", color: HIGHLIGHT_COLOR, width: "4px" },
        }),
      );
    }
    this.highlight = new this.sdk.layers.GraphicsLayer({
      title: "Selection",
      listMode: "hide",
      // Raw GeoJSON can carry Z even when its elevation style is disabled.
      elevationInfo: { mode: elevated ? "absolute-height" : "on-the-ground" },
      graphics,
    });
    map.add(this.highlight);
    if (options?.fit)
      this.fitLayer({ ...layer, geojson: { type: "FeatureCollection", features: selected } });
  }
  clearFeatureHighlight(): void {
    if (!this.highlight) return;
    if (this.map?.layers.includes(this.highlight)) this.map.remove(this.highlight);
    this.highlight.destroy();
    this.highlight = null;
  }

  // ------------------------------------------------------------------ drawing

  showSearchResult(geometry: Point | Polygon): () => void {
    const map = this.map;
    if (!map) return () => {};
    const layer = new this.sdk.layers.GraphicsLayer({
      listMode: "hide",
      elevationInfo: { mode: "on-the-ground" },
      graphics: [
        new this.sdk.Graphic({
          geometry: geojsonToArcgisGeometry(geometry)!,
          symbol:
            geometry.type === "Point"
              ? {
                  type: "simple-marker",
                  style: "circle",
                  color: SEARCH_HIGHLIGHT_COLOR,
                  size: "12px",
                  outline: { color: "white", width: "2px" },
                }
              : {
                  type: "simple-fill",
                  color: [239, 68, 68, 0.15],
                  outline: { color: SEARCH_HIGHLIGHT_COLOR, width: "2px" },
                },
        }),
      ],
    });
    map.add(layer);
    const dispose = () => {
      if (!this.disposers.delete(dispose)) return;
      if (map.layers.includes(layer)) map.remove(layer);
      layer.destroy();
    };
    this.disposers.add(dispose);
    return dispose;
  }

  /**
   * Keep a DOM element pinned to a geographic location as the view moves.
   * Returns the element's teardown.
   */
  private anchorElement(
    element: HTMLElement,
    lngLat: () => [number, number],
    offset: { x: number; y: number } = { x: 0, y: 0 },
  ): () => void {
    const view = this.view;
    if (!view?.container) return () => {};
    element.style.position = "absolute";
    element.style.zIndex = "5";
    view.container.append(element);
    const place = () => {
      const screen = this.view?.toScreen(this.point(lngLat()));
      if (!screen) return;
      element.style.left = `${screen.x + offset.x}px`;
      element.style.top = `${screen.y + offset.y}px`;
    };
    place();
    const handle = this.sdk.reactiveUtils.watch(() => viewPlacementState(view), place);
    return () => {
      handle.remove();
      element.remove();
    };
  }
  startManualPlacement(lngLat: [number, number], options: ManualPlacementOptions): () => void {
    const view = this.view;
    const map = this.map;
    if (!view || !map) return () => {};
    let position: [number, number] = lngLat;
    const layer = new this.sdk.layers.GraphicsLayer({ listMode: "hide" });
    const pin = new this.sdk.Graphic({
      geometry: geojsonToArcgisGeometry({ type: "Point", coordinates: position })!,
      symbol: {
        type: "simple-marker",
        style: "circle",
        color: [59, 130, 246, 1],
        size: "16px",
        outline: { color: [255, 255, 255, 1], width: "2px" },
      },
    });
    layer.graphics!.add(pin);
    map.add(layer);
    const content = document.createElement("div");
    content.className = "geolibre-arcgis-placement";
    const hint = document.createElement("p");
    hint.textContent = options.hint;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = options.doneLabel;
    content.append(hint, button);
    const unanchor = this.anchorElement(content, () => position, { x: 12, y: -12 });
    let dragging = false;
    const drag = view.on("drag", (event) => {
      if (event.action === "start") {
        const origin = { x: event.x, y: event.y };
        const start = view.toScreen(pin.geometry as ArcgisGeometryJson);
        if (start && Math.hypot(start.x - origin.x, start.y - origin.y) < 16) {
          dragging = true;
          event.stopPropagation();
        }
        return;
      }
      if (!dragging) return;
      event.stopPropagation();
      const point = view.toMap({ x: event.x, y: event.y });
      if (point) {
        position = [point.longitude, point.latitude];
        pin.geometry = geojsonToArcgisGeometry({ type: "Point", coordinates: position });
      }
      if (event.action === "end") {
        dragging = false;
        options.onMove(position);
      }
    });
    const dispose = () => {
      drag.remove();
      unanchor();
      if (this.map?.layers.includes(layer)) this.map.remove(layer);
      layer.destroy();
      this.disposers.delete(dispose);
    };
    button.onclick = () => {
      options.onMove(position);
      dispose();
      options.onDone?.();
    };
    this.disposers.add(dispose);
    return dispose;
  }
  drawExtent(options: ExtentDrawingOptions): () => void {
    const view = this.view;
    if (!view) return () => {};
    const stop = drawExtentOnCanvas(
      this.canvas(),
      (p) => {
        const point = view.toMap({ x: p.x, y: p.y });
        return point ? [point.longitude, point.latitude] : [0, 0];
      },
      () => this.suspendNavigation(),
      options,
    );
    const dispose = () => {
      stop();
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getViewBounds(): MapExtent | null {
    const view = this.view;
    if (!view?.extent) return null;
    const extent = view.spatialReference?.isWebMercator
      ? this.sdk.webMercatorUtils.webMercatorToGeographic(view.extent)
      : view.extent;
    if (!extent) return null;
    return [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  }
  showExtent(extent: MapExtent): () => void {
    const map = this.map;
    if (!map) return () => {};
    const [w, s, e, n] = extent;
    const ring: Position[] = [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ];
    const layer = new this.sdk.layers.GraphicsLayer({
      listMode: "hide",
      graphics: [
        new this.sdk.Graphic({
          geometry: geojsonToArcgisGeometry({ type: "LineString", coordinates: ring })!,
          symbol: { type: "simple-line", color: [245, 158, 11, 1], width: "3px" },
        }),
      ],
    });
    map.add(layer);
    const dispose = () => {
      if (this.map?.layers.includes(layer)) this.map.remove(layer);
      layer.destroy();
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getRenderSurface(): MapRenderSurface | null {
    return this.surface;
  }
  getRenderStatus(): { pending: string[]; errors: string[] } {
    const pending: string[] = [];
    if (!this.view?.ready || this.view.updating) pending.push("ArcGIS map loading");
    for (const entry of this.natives.values())
      for (const native of entry.layers)
        if (native.loadStatus === "failed" && native.loadError && !isAbortError(native.loadError)) {
          const key = `layer:${entry.plan.id}`;
          if (!this.errors.has(key))
            this.errors.set(
              key,
              `${entry.plan.title}: ${redactArcgisError(native.loadError.message)}`,
            );
        }
    return { pending, errors: [...this.errors.values()] };
  }
  async captureImage(): Promise<Blob> {
    const view = this.view;
    if (!view) throw new Error("ArcGIS map is not available");
    const shot = await view.takeScreenshot({ format: "png", ignorePadding: true });
    const response = await fetch(shot.dataUrl);
    return response.blob();
  }
  onMapClick(listener: (lngLat: [number, number]) => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = view.on("click", (event) => {
      const point = view.toMap({ x: event.x, y: event.y });
      if (point) listener([point.longitude, point.latitude]);
    });
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  isCameraMoving(): boolean {
    return this.view ? !this.view.stationary : false;
  }
  onCameraMove(listener: () => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = this.sdk.reactiveUtils.watch(
      () => viewPlacementState(view),
      () => listener(),
    );
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  whenDrawn(timeoutMs: number): Promise<void> {
    const view = this.view;
    if (!view) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let handle: ArcgisHandle | undefined;
      let frame = 0;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        if (handle) {
          handle.remove();
          this.handles.delete(handle);
        }
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      // A frame first: right after a jump the layer views have not started
      // loading the new extent, and `updating` still reads false.
      frame = requestAnimationFrame(() => {
        if (finished || this.view !== view) return done();
        handle = this.sdk.reactiveUtils.when(() => view.stationary && !view.updating, done, {
          initial: true,
        });
        // Torn down with the view, like the class's other subscriptions.
        if (finished) handle.remove();
        else this.handles.add(handle);
      });
    });
  }
  onCameraIdle(listener: (event?: CameraIdleEvent) => void): () => void {
    const view = this.view;
    if (!view) return () => {};
    const handle = this.sdk.reactiveUtils.when(
      () => view.stationary,
      () => {
        const storyCamera = this.storyMove;
        // Every subscriber sees the same answer for this settle; the flag
        // clears once they all have.
        queueMicrotask(() => {
          if (this.view?.stationary !== false) this.storyMove = false;
        });
        listener({ storyCamera });
      },
    );
    this.handles.add(handle);
    return () => {
      handle.remove();
      this.handles.delete(handle);
    };
  }
  stopCamera(): void {
    this.storyCameraToken++;
    // Stopping the animation settles an in-flight goTo where it is.
    (this.view?.animation as { stop?: () => void } | null | undefined)?.stop?.();
  }
  suspendNavigation(): () => void {
    const view = this.view;
    if (!view) return () => {};
    const wheel = view.navigation.mouseWheelZoomEnabled;
    const touch = view.navigation.browserTouchPanEnabled;
    view.navigation.mouseWheelZoomEnabled = false;
    view.navigation.browserTouchPanEnabled = false;
    const swallow = (event: { stopPropagation(): void }) => event.stopPropagation();
    const handles = [
      view.on("drag", swallow),
      view.on("double-click", swallow),
      view.on("key-down", swallow),
      view.on("mouse-wheel", swallow),
    ];
    return () => {
      for (const handle of handles) handle.remove();
      if (this.view) {
        this.view.navigation.mouseWheelZoomEnabled = wheel;
        this.view.navigation.browserTouchPanEnabled = touch;
      }
    };
  }

  // ----------------------------------------------------------------- controls

  addControl(control: maplibregl.IControl, position?: maplibregl.ControlPosition): boolean {
    if (!control || !this.view || this.options.domControls === false) return false;
    this.controlHost ??= new ArcgisControlHost(this, this.view, this.sdk);
    return this.controlHost.addControl(control, position);
  }
  removeControl(control: maplibregl.IControl): void {
    this.controlHost?.removeControl(control);
  }
  private createBuiltInControl(id: BuiltInMapControl): ArcgisWidget | null {
    const view = this.view;
    if (!view) return null;
    const { widgets } = this.sdk;
    switch (id) {
      case "layer-control": {
        if (!this.options.onLayerVisibilityChange) return null;
        const list = new widgets.LayerList({ view });
        const expand = new widgets.Expand({ view, content: list });
        return {
          uiComponent: expand,
          destroy: () => {
            expand.destroy();
            list.destroy();
          },
        };
      }
      case "navigation":
        return new widgets.Zoom({ view });
      case "fullscreen":
        return new widgets.Fullscreen({ view, element: view.container ?? undefined });
      case "compass":
        return new widgets.Compass({
          view,
          ...(this.compassLabel ? { label: this.compassLabel } : {}),
        });
      case "geolocate":
        return new widgets.Locate({ view });
      case "globe":
        // Only the canvas can rebuild the view in the other projection.
        if (!this.options.onProjectionToggle || typeof document === "undefined") return null;
        return createGlobeToggle(this.readProjection(), this.options.onProjectionToggle);
      case "scale":
        // The 2D map's scale bar: it knows nautical miles and other bodies'
        // radii, and it measures at the centre of a scene too.
        if (typeof document === "undefined") return null;
        return createArcgisScaleBar(
          this.sdk,
          view,
          () => this.getRenderSurface(),
          this.preferences?.scaleUnit ?? "metric",
        );
      default:
        return null;
    }
  }
  private mountBuiltInControl(id: BuiltInMapControl): void {
    if (!this.view || this.builtInControls.has(id)) return;
    const widget = this.createBuiltInControl(id);
    if (!widget) return;
    this.view.ui.add(widget.uiComponent ?? widget, this.controlPositions[id]);
    this.builtInControls.set(id, widget);
  }
  private unmountBuiltInControl(id: BuiltInMapControl): void {
    const widget = this.builtInControls.get(id);
    if (!widget) return;
    this.view?.ui.remove(widget.uiComponent ?? widget);
    widget.destroy();
    this.builtInControls.delete(id);
  }
  setBuiltInControlVisible(id: BuiltInMapControl, visible: boolean): boolean {
    if (!this.view) return false;
    if (!HOSTED_CONTROLS.has(id)) return false;
    if (id === "attribution") {
      // Always on; the view renders it from `attributionItems`.
      if (this.view) this.view.attributionVisible = true;
      return visible;
    }
    // Terrain has no button: it is the scene's elevation, and turning it on
    // over a MapView asks the canvas for a SceneView through the preference
    // the Controls menu writes once this reports success.
    if (id === "terrain") {
      this.controlVisibility.terrain = visible;
      this.setTerrainEnabled(visible);
      return true;
    }
    if (id === "globe" && !this.options.onProjectionToggle) return false;
    if (id === "layer-control" && !this.options.onLayerVisibilityChange) return false;
    this.controlVisibility[id] = visible;
    if (visible) this.mountBuiltInControl(id);
    else this.unmountBuiltInControl(id);
    return true;
  }
  getBuiltInControlPosition(id: BuiltInMapControl): maplibregl.ControlPosition {
    return this.controlPositions[id];
  }
  setBuiltInControlPosition(id: BuiltInMapControl, position: maplibregl.ControlPosition): boolean {
    if (!this.view || !HOSTED_CONTROLS.has(id)) return false;
    this.controlPositions[id] = position;
    this.options.onControlPositionChange?.(id, position);
    if (this.builtInControls.has(id)) {
      this.unmountBuiltInControl(id);
      this.mountBuiltInControl(id);
    }
    return true;
  }
  setCompassLabel(label: string): void {
    this.compassLabel = label;
    const compass = this.builtInControls.get("compass") as
      | (ArcgisWidget & { label?: string })
      | undefined;
    if (compass) compass.label = label;
  }
  setBackgroundLabel(): void {}
  setTerrainLabel(): void {}

  // ------------------------------------------------------------------ terrain

  isTerrainEnabled(): boolean {
    return this.terrain;
  }
  /**
   * Drape the scene over Esri's world elevation. On a MapView the choice is
   * only recorded: the canvas swaps in a SceneView when the project's terrain
   * preference changes, and the new engine applies it.
   */
  setTerrainEnabled(enabled: boolean): boolean {
    if (!this.view) return false;
    this.terrain = enabled;
    // Preferences re-apply on every change; only a real transition rebuilds.
    if (enabled && this.canDrape() !== (this.elevation !== null)) this.applyElevation();
    else if (!enabled && this.elevation) this.removeElevation();
    return true;
  }
  getTerrainExaggeration(): number {
    return this.exaggeration;
  }
  setTerrainExaggeration(exaggeration: number): void {
    const next = Math.max(0, Math.min(10, exaggeration));
    if (next === this.exaggeration) return;
    this.exaggeration = next;
    // Tiles already fetched carry the old heights; a new layer refetches them.
    this.applyElevation();
  }
  private canDrape(): boolean {
    return this.view?.type === "3d" && Boolean(this.map?.ground && this.options.scene);
  }
  private applyElevation(): void {
    this.removeElevation();
    const ground = this.map?.ground;
    const scene = this.options.scene;
    if (!this.terrain || !this.canDrape() || !ground || !scene) return;
    this.elevation = this.cogTerrain
      ? createCogElevationLayer(scene, this.cogTerrain, this.exaggeration)
      : createElevationLayer(scene, this.exaggeration);
    ground.layers.add(this.elevation);
  }
  private removeElevation(): void {
    const layer = this.elevation;
    if (!layer) return;
    this.elevation = null;
    const ground = this.map?.ground;
    if (ground?.layers.includes(layer)) ground.layers.remove(layer);
    // The exaggerated subclass owns the layer it reads its tiles from, and
    // destroying the outer layer does not destroy it.
    (layer as { source?: ArcgisElevationLayer }).source?.destroy();
    layer.destroy();
  }
  getTerrainCogSource(): string | null {
    return this.cogTerrainUrl;
  }
  hasCustomTerrainSource(): boolean {
    return this.cogTerrain !== null;
  }
  private openCogDem = registerCogDemSource;

  async setTerrainCogSource(source: string | Blob | null, band = 1): Promise<boolean> {
    if (!this.view) return false;
    const normalized = typeof source === "string" ? source.trim() || null : source;
    const request = ++this.cogTerrainRequest;
    let registration: CogDemSourceRegistration | null;
    try {
      registration = normalized ? await this.openCogDem(normalized, band) : null;
    } catch (error) {
      if (request !== this.cogTerrainRequest || !this.view) return false;
      throw error;
    }
    if (request !== this.cogTerrainRequest || !this.view) {
      registration?.dispose();
      return false;
    }
    const previous = this.cogTerrain;
    this.cogTerrain = registration;
    this.cogTerrainUrl = typeof normalized === "string" ? normalized : null;
    this.applyElevation();
    previous?.dispose();
    this.options.onTerrainSourceChange?.(normalized, band);
    return true;
  }
}

/**
 * What moves a screen-anchored element: the extent and size for both views,
 * plus the rotation of a MapView or the camera of a SceneView (a tilt or
 * heading change moves every screen point without changing the extent much).
 */
export function viewPlacementState(view: ArcgisView): unknown[] {
  return view.type === "3d"
    ? [
        view.extent,
        // Scalar fields rather than the Camera object, so a camera the SDK
        // mutates in place is tracked as surely as a replaced one.
        view.camera?.heading,
        view.camera?.tilt,
        view.camera?.position.x,
        view.camera?.position.y,
        view.camera?.position.z,
        view.width,
        view.height,
      ]
    : [view.extent, view.rotation, view.width, view.height];
}

/** Drop the compiler's synthetic attributes from a hit graphic's attributes. */
function stripSyntheticFields(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !key.startsWith("gl__") && key !== "__OBJECTID"),
  );
}

/**
 * Everything about a plan that requires rebuilding the native layers when it
 * changes: the kind, the source, the symbology. Visibility, opacity and the
 * scale range are applied in place, so they are left out. For GeoJSON plans
 * the features themselves are replaced by their count and the store record's
 * identity, so a re-style rebuilds (the symbols are baked into the data) but
 * a visibility toggle does not.
 */
function planSignature(plan: ArcgisLayerPlan, layer: GeoLibreLayer): string {
  const {
    title: _t,
    visible: _v,
    opacity: _o,
    minScale: _mn,
    maxScale: _mx,
    effect: _e,
    blendMode: _b,
    ...rest
  } = plan;
  if (rest.kind === "cog" || rest.kind === "zarr") {
    const { source: _source, ...signature } = rest;
    return JSON.stringify(signature);
  }
  if (rest.kind === "geojson") {
    return JSON.stringify({
      ...rest,
      parts: rest.parts.map((part) => ({
        ...part,
        features: part.features ? part.features.features.length : undefined,
      })),
      // The blend mode is applied in place, so a change to it alone does not rebuild.
      style: { ...layer.style, blendMode: undefined },
      filters: [layer.timeFilter, layer.embedFilter, compileLayerFilters(layer)],
    });
  }
  return JSON.stringify(rest);
}

/**
 * What a GeoJSON layer's compiled plan depends on apart from its features
 * (compared by identity) and the display fields applied in place: the style,
 * filters, source and metadata.
 */
function geojsonCompileKey(layer: GeoLibreLayer): string {
  const { geojson: _g, name: _n, visible: _v, opacity, ...rest } = layer;
  // A label opacity override is baked against the layer opacity it replaces,
  // so only then does an opacity change recompile the layer.
  const labels = layer.style?.labels;
  const labelOpacity =
    labels?.enabled &&
    (labels.field || labels.expression?.trim()) &&
    parseLabelOverride(labels.opacityExpression, "number")
      ? opacity
      : undefined;
  // The blend mode is applied in place, like opacity.
  return JSON.stringify({ ...rest, labelOpacity, style: { ...rest.style, blendMode: undefined } });
}
