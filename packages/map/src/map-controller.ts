import {
  BLANK_BASEMAP,
  DEFAULT_BASEMAP,
  DEFAULT_PROJECT_PREFERENCES,
  getPlanetaryBasemapByStyleUrl,
  PLANETARY_BASEMAP_SENTINEL_PREFIX,
  useAppStore,
} from "@geolibre/core";
import type {
  GeoLibreLayer,
  LayerStyle,
  MapPreferences,
  MapProjection,
  MapViewState,
  PlanetaryBasemap,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import maplibregl from "maplibre-gl";
import { LayerControl, type CustomLayerAdapter, type LayerState } from "maplibre-gl-layer-control";
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
import { installGlobePopupOcclusion } from "./globe-popup-occlusion";
import { PlanetaryScaleControl } from "./planetary-scale-control";
import { getOfflineBasemapStyle, isOfflineBasemapSentinel } from "./protomaps-basemap";
import { ResetBearingControl } from "./reset-bearing-control";
import { TerrainControl, DEFAULT_TERRAIN_EXAGGERATION } from "./terrain-control";

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
  // A point's outline fades with its fill so story playback can fully hide a
  // circle layer; without the stroke property a faded-out point still renders
  // as a hollow ring (#934).
  circle: ["circle-opacity", "circle-stroke-opacity"],
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
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  tileSize: 256,
  maxzoom: 15,
  encoding: "terrarium",
  attribution:
    'Elevation tiles by <a href="https://registry.opendata.aws/terrain-tiles/">AWS Open Data Terrain Tiles</a>',
};
/**
 * Window event dispatched when the terrain control is double-clicked, so the
 * React layer can open the vertical-exaggeration dialog. The controller lives
 * outside React, so it signals through a window event rather than a callback.
 *
 * These terrain events are dispatched on `window` (not scoped to a controller
 * instance), so they assume a single terrain-enabled map: only the primary pane
 * enables the terrain control today (secondary panes never override the default
 * `terrain: false`), and one dialog — bound to the primary controller — listens.
 * A future secondary-pane terrain control would need the event scoped to its
 * originating controller.
 */
export const TERRAIN_SETTINGS_EVENT = "geolibre:terrain-settings-open";
/** DOM class the LayerControl gives its container element. */
const LAYER_CONTROL_SELECTOR = ".maplibregl-ctrl-layer-control";

/**
 * Restore `refreshed` to just before `anchor` under `parent` after a
 * remove/re-add appended it to the end of its control corner. No-ops safely
 * when the reinsert can't be trusted: no parent, the anchor drifted to a
 * different parent, or `refreshed` is missing / already the anchor.
 *
 * Exported for unit testing; the reorder itself is only observable against a
 * real MapLibre control DOM (see refreshLayerControl).
 */
export function restoreControlOrder(
  parent: Element | null,
  anchor: Element | null,
  refreshed: Element | null,
): void {
  if (!parent) return;
  if (anchor !== null && anchor.parentElement !== parent) return;
  if (!refreshed || refreshed === anchor) return;
  parent.insertBefore(refreshed, anchor);
}
/**
 * Window event dispatched when the terrain control is removed (e.g. hidden from
 * the Controls menu), so the React layer closes the exaggeration dialog rather
 * than leaving it open with no terrain to affect.
 */
export const TERRAIN_SETTINGS_CLOSE_EVENT = "geolibre:terrain-settings-close";
const EMPTY_HIGHLIGHT: FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

function isCustomControllableLayer(layer: GeoLibreLayer): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

/**
 * Translate a MapLibre paint property edited in the layer control's per-layer
 * style editor into a partial {@link LayerStyle} update for the store, so the
 * floating editor and the right-hand Style sidebar stay in sync (issue #912).
 *
 * Scope is deliberately limited to the raster color adjustments, which map
 * one-to-one to {@link LayerStyle} fields. Vector paint is **not** round-tripped
 * here: GeoLibre renders vector layers through an expression-based style model
 * (opacities are scaled by the layer opacity, and width/radius/colors become
 * `interpolate`/`case` expressions under proportional sizing, the meters width
 * unit, a data-driven `vectorStyleMode`, or simplestyle). The value the control
 * reads back is the *rendered* paint, so storing it verbatim would corrupt
 * those configurations. The control still applies vector edits to the map; the
 * sidebar Style panel remains the canonical editor for vector symbology.
 * Layer-level opacity is handled separately — see
 * {@link MapController.applyLayerControlStyleChange}.
 */
export function layerControlPaintToStyle(
  property: string,
  value: unknown,
): Partial<LayerStyle> | null {
  if (typeof value !== "number") return null;

  switch (property) {
    case "raster-brightness-min":
      return { rasterBrightnessMin: value };
    case "raster-brightness-max":
      return { rasterBrightnessMax: value };
    case "raster-saturation":
      return { rasterSaturation: value };
    case "raster-contrast":
      return { rasterContrast: value };
    case "raster-hue-rotate":
      return { rasterHueRotate: value };
    default:
      return null;
  }
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

function resolveMapStyle(styleUrl: string | undefined): string | maplibregl.StyleSpecification {
  if (styleUrl === BLANK_BASEMAP) return createBlankMapStyle();
  const offline = getOfflineBasemapStyle(styleUrl);
  // Return a fresh copy (like the planetary path below builds a new object each
  // call): MapLibre normalises/mutates the style it's handed, and the registry
  // holds a single shared object — in split/compare view two Map instances
  // resolve the same sentinel, so handing both the same object would let them
  // corrupt each other's style state.
  if (offline) return structuredClone(offline);
  // An offline-basemap sentinel with no registered style (e.g. a project saved
  // with one, reopened in a fresh session where the in-memory archive is gone)
  // must not be fetched as a URL. Fall back to the default basemap.
  if (isOfflineBasemapSentinel(styleUrl)) {
    console.warn(
      `Offline basemap "${styleUrl}" is not available in this session; falling back to the default basemap.`,
    );
    return DEFAULT_BASEMAP;
  }
  const planetary = getPlanetaryBasemapByStyleUrl(styleUrl);
  if (planetary) return createPlanetaryMapStyle(planetary);
  // A planetary sentinel that no longer resolves (e.g. a project saved with a
  // basemap id that has since been renamed) must not be handed to MapLibre as a
  // style URL — it would try to fetch the `geolibre://` sentinel and blank the
  // map. Fall back to the default basemap instead.
  if (styleUrl?.startsWith(PLANETARY_BASEMAP_SENTINEL_PREFIX)) {
    console.warn(`Unknown planetary basemap "${styleUrl}"; falling back to the default basemap.`);
    return DEFAULT_BASEMAP;
  }
  return styleUrl ?? DEFAULT_BASEMAP;
}

/**
 * A single-source raster style for a celestial body — the Moon/Mars mosaics or
 * the Earth satellite imagery the planet switcher uses. The tiles are images in
 * that body's Web-Mercator scheme (XYZ, or TMS when `basemap.scheme` says so),
 * so MapLibre renders them like any raster basemap. A dark background shows
 * through at zoom levels the source doesn't cover, matching how the planetary
 * tiles fade to black at the poles (and reading as space around the globe).
 */
function createPlanetaryMapStyle(basemap: PlanetaryBasemap): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      "planetary-basemap": {
        type: "raster",
        tiles: [basemap.tileUrl],
        tileSize: 256,
        maxzoom: basemap.maxZoom,
        // OpenPlanetaryMap's S3 mosaics are TMS (flipped Y); the CARTO named
        // maps are XYZ. MapLibre defaults to "xyz" when scheme is omitted.
        ...(basemap.scheme ? { scheme: basemap.scheme } : {}),
        attribution: basemap.attribution,
      },
    },
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: { "background-color": "#000000" },
      },
      {
        id: "planetary-basemap",
        type: "raster",
        source: "planetary-basemap",
      },
    ],
  };
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
  | "compass"
  | "geolocate"
  | "globe"
  | "terrain"
  | "scale"
  | "attribution"
  | "logo"
  | "layer-control";

export const DEFAULT_BUILT_IN_CONTROL_VISIBILITY: Record<BuiltInMapControl, boolean> = {
  navigation: false,
  fullscreen: true,
  compass: true,
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
  compass: "top-right",
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
  private compassControl: ResetBearingControl | null = null;
  private compassLabel = "Reset pitch & bearing";
  private backgroundLabel = "Background";
  private geolocateControl: maplibregl.GeolocateControl | null = null;
  private globeControl: maplibregl.GlobeControl | null = null;
  private terrainControl: TerrainControl | null = null;
  private terrainExaggeration = DEFAULT_TERRAIN_EXAGGERATION;
  // Undefined until the React layer supplies a translated label; the control
  // falls back to its own default in the meantime (single source for the string).
  private terrainLabel: string | undefined;
  private scaleControl: PlanetaryScaleControl | null = null;
  private attributionControl: maplibregl.AttributionControl | null = null;
  private logoControl: maplibregl.LogoControl | null = null;
  private layerControl: LayerControl | null = null;
  private layerControlSignature = "";
  // Debounce timer for refreshing the layer control on style changes, so a
  // plugin adding/removing native style layers (e.g. ones flagged
  // `metadata["geolibre:internal"]`) updates the control's exclusion list.
  private layerControlStyleRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // True while pushing store paint back into the layer control's open style
  // editor, so onLayerStyleChange callbacks during that refresh are ignored
  // (reentrancy guard against a sync loop). See syncLayerControlState.
  private refreshingStyleEditor = false;
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
  private controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };

  init(
    container: HTMLElement,
    options: {
      styleUrl?: string;
      mapView?: MapViewState;
      mapPreferences?: MapPreferences;
      /**
       * Override built-in control visibility before the controls are added.
       * Secondary (split/grid) map panes pass `{ "layer-control": false }` so
       * they don't mount a second layer control that would write the shared
       * layer/basemap state back to the global store.
       */
      controlVisibility?: Partial<Record<BuiltInMapControl, boolean>>;
    },
  ): maplibregl.Map {
    const view = options.mapView;
    if (options.controlVisibility) {
      this.controlVisibility = {
        ...this.controlVisibility,
        ...options.controlVisibility,
      };
    }
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
    installGlobePopupOcclusion(maplibregl);
    // The constructor options above already apply the static constraints.
    // The transform constraint is installed by the MapCanvas effect that
    // fires on mount, so calling applyMapPreferences here would only add a
    // redundant jumpTo that can interrupt the initial camera.
    const handleStyleReady = () => {
      this.styleReady = true;
      this.enforceProjection();
      this.addTerrainSource();
      this.applyBasemapVisibility();
      this.applyBasemapOpacity();
      this.addLayerControl();
    };
    this.map.on("style.load", handleStyleReady);
    this.map.once("load", handleStyleReady);
    this.map.once("idle", () => this.enforceProjection());
    // Plugins can add native style layers directly (outside the layer store);
    // refresh the layer control on style changes so internal-flagged layers are
    // excluded reactively. Debounced (trailing edge) because styledata fires
    // frequently, and refreshLayerControl no-ops when the computed signature is
    // unchanged. Resetting the timer on each event waits until the burst of
    // style updates quiets so the control never rebuilds against a half-built
    // style.
    this.map.on("styledata", () => {
      if (this.layerControlStyleRefreshTimer !== null) {
        clearTimeout(this.layerControlStyleRefreshTimer);
      }
      this.layerControlStyleRefreshTimer = setTimeout(() => {
        this.layerControlStyleRefreshTimer = null;
        this.refreshLayerControl(this.syncedLayers);
      }, 200);
    });
    // Add the fullscreen toggle first so it anchors the top of the top-right
    // control cluster, matching the universal placement users expect (issue
    // #512). MapLibre stacks controls in insertion order within a corner.
    this.addFullscreenControl();
    // Added right after fullscreen so, with both at their default top-right
    // position, the compass stacks directly below the fullscreen toggle (the
    // placement requested in issue #508). MapLibre orders controls by insertion
    // within a corner.
    this.addCompassControl();
    this.addNavigationControl();
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
   * Resolve a layer's rendered GeoJSON from its live MapLibre source.
   *
   * The store only keeps inline GeoJSON for layers added from in-memory data;
   * URL-backed layers (remote GeoJSON, or Parquet/Shapefile converted in the
   * browser) keep their features only in the MapLibre source. Reading the
   * source lets callers such as the story-map HTML export inline those features
   * even when the layer record carries no `geojson`, so the export renders the
   * same data as the live map (#936).
   *
   * @param layerId GeoLibre store layer id.
   * @returns The source's FeatureCollection, or null when it has none.
   */
  async getLayerGeoJson(layerId: string): Promise<FeatureCollection | null> {
    if (!this.map) return null;
    const map = this.map;
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = map.getLayer(nativeId);
      const sourceId =
        styleLayer && "source" in styleLayer
          ? (styleLayer as { source?: unknown }).source
          : undefined;
      if (typeof sourceId !== "string") continue;
      const source = map.getSource(sourceId);
      if (source?.type !== "geojson") continue;
      try {
        const data = await (source as maplibregl.GeoJSONSource).getData();
        // `getData()` returns the source's original data spec: the inline
        // FeatureCollection for sources set via setData (in-browser-converted
        // layers), or the raw URL string for URL-backed sources. The `"features"`
        // guard skips the string case so the export omits such a layer rather
        // than embedding a bare URL.
        if (data && typeof data === "object" && "features" in data) {
          return data as FeatureCollection;
        }
      } catch {
        // A source still loading (or a URL that failed) has no usable data;
        // fall through so the export simply omits this layer's features.
      }
    }
    return null;
  }

  /**
   * Read the live MapLibre raster source spec backing a project layer.
   *
   * Service-backed raster layers registered by plugins (e.g. Planetary
   * Computer scenes) carry no tile or TileJSON URL in their store record — the
   * plugin builds the source directly on the map. Reading the live source back
   * lets the story-map HTML export inline those layers instead of silently
   * dropping them (#1272). Only http(s) URLs are returned; a source backed by
   * an app-internal protocol (blob:, pmtiles:, geolibre:, …) cannot load in a
   * standalone page.
   *
   * @param layerId GeoLibre store layer id.
   * @returns The serialized raster source spec, or null when the layer has no
   *   embeddable raster source.
   */
  getLayerRasterSource(layerId: string): Record<string, unknown> | null {
    if (!this.map) return null;
    const map = this.map;
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = map.getLayer(nativeId);
      const sourceId =
        styleLayer && "source" in styleLayer
          ? (styleLayer as { source?: unknown }).source
          : undefined;
      if (typeof sourceId !== "string") continue;
      const source = map.getSource(sourceId);
      if (source?.type !== "raster") continue;
      const spec = (source as maplibregl.RasterTileSource).serialize() as
        | Record<string, unknown>
        | undefined;
      if (!spec || typeof spec !== "object") continue;
      const httpUrl = (value: unknown): value is string =>
        typeof value === "string" && /^https?:\/\//i.test(value);
      // Prefer the TileJSON `url` over `tiles`, mirroring MapLibre's own
      // precedence when a raster source carries both. serialize() returns the
      // constructor options (load() extends the instance, not _options), but
      // if that ever changes, url-first also keeps the export pointing at the
      // stable TileJSON endpoint rather than a resolved tile template that
      // could embed a time-limited token.
      if (httpUrl(spec.url)) {
        const { tiles: _tiles, ...rest } = spec;
        return rest;
      }
      const tiles = Array.isArray(spec.tiles) ? spec.tiles.filter(httpUrl) : [];
      if (tiles.length > 0) {
        const { url: _url, ...rest } = spec;
        return { ...rest, tiles };
      }
    }
    return null;
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
   * @param durationMs Optional transition duration in milliseconds. Pass 0 for
   *   an instant change (overriding MapLibre's default 300 ms paint
   *   transition); leave undefined to keep the default fade.
   */
  setStoryLayerOpacity(layerId: string, opacity: number, durationMs?: number): void {
    if (!this.map) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    for (const nativeId of this.getNativeLayerIdsByLayerId(layerId)) {
      const styleLayer = this.map.getLayer(nativeId);
      if (!styleLayer) continue;
      const props = OPACITY_PAINT_PROPERTIES[styleLayer.type] ?? [];
      for (const prop of props) {
        if (typeof durationMs === "number" && durationMs >= 0) {
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
    if (this.pendingRotateHandler) {
      this.map?.off("moveend", this.pendingRotateHandler);
      this.pendingRotateHandler = null;
    }
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
   * The rotate-on-settle `moveend` listener currently awaiting its move, kept so
   * it can be detached deterministically (on the next chapter or on presenter
   * exit) instead of relying solely on self-removal, which never fires for an
   * instant move whose `moveend` precedes attachment.
   */
  private pendingRotateHandler:
    | ((event: maplibregl.MapLibreEvent & { storyCameraToken?: number }) => void)
    | null = null;

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
    // Detach any rotate-on-settle listener still waiting on a superseded move so
    // handlers can never accumulate across rapid chapter changes or a presenter
    // exit. The matching listener for the new move is registered below.
    if (this.pendingRotateHandler) {
      map.off("moveend", this.pendingRotateHandler);
      this.pendingRotateHandler = null;
    }
    // Tag the movement so the rotate-on-settle handler can recognize *this*
    // move's `moveend`. When flyTo/easeTo supersedes a prior chapter's in-flight
    // rotation, MapLibre fires a deferred `moveend` for that halted rotation; an
    // untagged `once("moveend")` would catch it and start rotating immediately,
    // around the previous chapter's center, before the new camera has travelled.
    // MapLibre re-fires the original move's eventData on this deferred moveend
    // (Camera._afterEase), so the token survives cancellation. The
    // pendingRotateHandler cleanup above and in restoreLayerStyles is the
    // backstop should that ever change, so handlers cannot leak regardless.
    map[animation](
      {
        center: location.center,
        zoom: location.zoom,
        pitch: location.pitch,
        bearing: location.bearing,
      },
      { storyCameraToken: token },
    );
    if (rotate) {
      const onMoveEnd = (event: maplibregl.MapLibreEvent & { storyCameraToken?: number }) => {
        // Only detach once the token matches. Stay attached through any
        // preceding moveend (e.g. the deferred moveend of a halted prior
        // rotateTo, which carries no storyCameraToken) so we can still react to
        // this move's own matching moveend below.
        if (event.storyCameraToken !== token) return;
        map.off("moveend", onMoveEnd);
        if (this.pendingRotateHandler === onMoveEnd) {
          this.pendingRotateHandler = null;
        }
        if (this.storyCameraToken !== token || !this.map) return;
        this.map.rotateTo(this.map.getBearing() + 180, {
          duration: 30000,
          easing: (time) => time,
        });
      };
      this.pendingRotateHandler = onMoveEnd;
      map.on("moveend", onMoveEnd);
    }
  }

  /**
   * Fly the camera to a view, used for story authoring previews.
   *
   * @param location Target camera (center, zoom, pitch, bearing).
   */
  flyToView(location: StoryChapterLocation): void {
    this.map?.flyTo(
      {
        center: location.center,
        zoom: location.zoom,
        pitch: location.pitch,
        bearing: location.bearing,
      },
      // Tag as a story camera move (like applyStoryChapterCamera) so viewport
      // history skips this scripted preview rather than recording it.
      { storyCameraToken: this.storyCameraToken },
    );
  }

  private isStyleReady(): boolean {
    return Boolean(this.map && this.styleReady);
  }

  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    // Guard against adding the same control instance twice: MapLibre would call
    // onAdd again and stack a second copy of the control's DOM (e.g. a duplicate
    // GeoEditor toolbar) if a caller re-adds an already-mounted control.
    // `hasControl` is optional-chained so test doubles without it still work.
    if (this.map.hasControl?.(control)) return true;
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

  setBuiltInControlVisible(control: BuiltInMapControl, visible: boolean): boolean {
    this.controlVisibility[control] = visible;

    if (visible) {
      if (control === "navigation") return this.addNavigationControl();
      if (control === "fullscreen") return this.addFullscreenControl();
      if (control === "compass") return this.addCompassControl();
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
    else if (control === "compass") this.removeCompassControl();
    else if (control === "geolocate") this.removeGeolocateControl();
    else if (control === "globe") this.removeGlobeControl();
    else if (control === "terrain") {
      this.removeTerrainControl();
      // Terrain is genuinely being hidden here (not repositioned, which goes
      // through removeBuiltInControl), so close the exaggeration dialog — it has
      // no control to act on now.
      window.dispatchEvent(new CustomEvent(TERRAIN_SETTINGS_CLOSE_EVENT));
    } else if (control === "scale") this.removeScaleControl();
    else if (control === "attribution") this.removeAttributionControl();
    else if (control === "logo") this.removeLogoControl();
    else this.removeLayerControl();
    return true;
  }

  getBuiltInControlPosition(control: BuiltInMapControl): maplibregl.ControlPosition {
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
    this.removeCompassControl();
    this.removeGeolocateControl();
    this.removeGlobeControl();
    this.removeTerrainControl();
    this.removeScaleControl();
    this.removeAttributionControl();
    this.removeLogoControl();
    this.removeLayerControl();
    if (this.layerControlStyleRefreshTimer !== null) {
      clearTimeout(this.layerControlStyleRefreshTimer);
      this.layerControlStyleRefreshTimer = null;
    }
    this.map?.remove();
    this.map = null;
    this.styleReady = false;
    this.clearLayerDisplayNames();
  }

  setStyle(url: string): void {
    if (!this.map) return;
    this.basemapStyleUrl = url;
    this.styleReady = false;
    this.basemapOriginalPaintValues.clear();
    this.removeLayerControl();
    this.map.setStyle(resolveMapStyle(url));
    // Switching to/from a planetary basemap changes the active body (the store's
    // ellipsoid subscription runs first, so the singleton is already current),
    // so redraw the scale bar for the new radius without waiting for a pan.
    this.scaleControl?.refresh();
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

  /**
   * Like {@link applyView} but animates the camera (MapLibre `easeTo`) instead
   * of jumping, for browser-style back/forward viewport navigation.
   */
  easeToView(view: MapViewState): void {
    if (!this.map) return;
    this.map.easeTo(constrainMapView(view, this.mapPreferences, this.map));
  }

  applyMapPreferences(preferences: MapPreferences): void {
    if (!this.map) return;
    this.mapPreferences = preferences;

    const requestedMinZoom = clampNumber(preferences.minZoom, 0, 24);
    const minZoom = effectiveMinZoomForPreferences(preferences, this.map, requestedMinZoom);
    const maxZoom = Math.max(minZoom, clampNumber(preferences.maxZoom, 0, 24));
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
    // Reflect a changed projection preference (e.g. loading a project saved in
    // mercator) onto the live map.
    this.enforceProjection();
    this.map.setMaxBounds(mapBoundsForPreferences(preferences));
    this.map.setTransformConstrain(
      createMapTransformConstraint(preferences, this.map, minZoom, maxZoom),
    );
    this.applyView(this.readView());
    // The ellipsoid or the scale unit can change here (Settings' dropdowns)
    // without the basemap changing, so push the unit and redraw the body-aware
    // scale bar now — the store's ellipsoid subscription has already updated the
    // active-radius singleton. setUnit only stores the unit, so the single
    // refresh() below redraws the bar once for whatever changed (unit, radius,
    // or both).
    this.scaleControl?.setUnit(preferences.scaleUnit);
    this.scaleControl?.refresh();
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
        map.setLayoutProperty(layer.id, "visibility", this.basemapVisible ? "visible" : "none");
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
      this.syncedLayers.flatMap((layer) => this.getCandidateStyleLayers(layer).map(({ id }) => id)),
    );
    const nonBasemapStyleLayerIds = new Set(NON_BASEMAP_STYLE_LAYER_IDS);

    return (map.getStyle().layers ?? []).filter(
      (layer) => !userStyleLayerIds.has(layer.id) && !nonBasemapStyleLayerIds.has(layer.id),
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
      originalPaintValues.set(property, this.map.getPaintProperty(layerId, property));
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
    const box: [[number, number], [number, number]] = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ];
    // Tile layers only carry data from their source `minzoom` up (e.g. an OGC
    // API vector tileset served only at z17). Fitting the whole extent would
    // land far below that zoom and render nothing, so when the fit is too far
    // out, fly to the extent center at the layer's minimum render zoom instead.
    const minRenderZoom = this.getLayerMinRenderZoom(layer);
    if (minRenderZoom !== null) {
      const camera = this.map.cameraForBounds(box, { padding: 40 });
      if (camera?.center && typeof camera.zoom === "number" && camera.zoom < minRenderZoom) {
        this.map.flyTo({
          center: camera.center,
          zoom: minRenderZoom,
          duration: 800,
        });
        return;
      }
    }
    // A glTF scenegraph model (e.g. a KML `<Model>`) is a 3D object: viewed
    // straight down it is edge-on and effectively invisible (a vertical
    // geological cross-section shows as a hairline). Frame it at a tilt so it
    // reads as a 3D object on load, pulling back slightly so its vertical extent
    // fits. The user can flatten the pitch afterward.
    if (layer.metadata.customLayerType === "scenegraph") {
      const camera = this.map.cameraForBounds(box, { padding: 40 });
      if (camera?.center && typeof camera.zoom === "number") {
        this.map.flyTo({
          center: camera.center,
          zoom: Math.max(camera.zoom - 0.75, 0),
          pitch: 60,
          duration: 800,
        });
        return;
      }
    }
    this.map.fitBounds(box, { padding: 40, duration: 800 });
  }

  /** The layer's minimum render zoom (its tile source `minzoom`), if advertised
   * — the zoom below which a tile source shows no data. */
  private getLayerMinRenderZoom(layer: GeoLibreLayer): number | null {
    for (const value of [layer.source.minzoom, layer.metadata.minzoom]) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
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

  /**
   * Drop a draggable pin at `lngLat` so the user can fine-tune the position of a
   * feature that was just placed without coordinates of its own (e.g. a
   * non-geotagged photo dropped at the map center). Every drag reports the new
   * position through `onMove`; clicking the pin's "Done" button (label supplied
   * by the caller so it stays translatable) removes the pin and runs `onDone`.
   *
   * The pin and its hint popup live outside the React tree, so the interaction
   * survives the dialog that started it being closed. Returns a disposer that
   * removes the pin early (e.g. if the caller needs to abort).
   *
   * @param lngLat - Where to drop the pin, as `[lng, lat]`.
   * @param options - Translated labels plus the move/done callbacks.
   * @returns A function that removes the pin and its popup.
   */
  startManualPlacement(
    lngLat: [number, number],
    options: {
      /** Instruction shown in the pin's popup while it is draggable. */
      hint: string;
      /** Label for the button that finishes placement. */
      doneLabel: string;
      /** Called with `[lng, lat]` on every drag of the pin. */
      onMove: (lngLat: [number, number]) => void;
      /** Called once when the user clicks the "Done" button. */
      onDone?: () => void;
    },
  ): () => void {
    const map = this.map;
    if (!map) return () => {};

    const marker = new maplibregl.Marker({ draggable: true, color: "#ef4444" })
      .setLngLat(lngLat)
      .addTo(map);

    const container = document.createElement("div");
    container.className = "geolibre-placement-popup";
    const hintText = document.createElement("p");
    hintText.className = "geolibre-placement-popup-hint";
    hintText.textContent = options.hint;
    const doneButton = document.createElement("button");
    doneButton.type = "button";
    doneButton.className = "geolibre-placement-popup-done";
    doneButton.textContent = options.doneLabel;
    container.append(hintText, doneButton);

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 28,
      className: "geolibre-placement-popup-root",
    })
      .setLngLat(lngLat)
      .setDOMContent(container)
      .addTo(map);

    let disposed = false;
    // The `drag` event fires once per pointer-move frame (60-120 Hz), and each
    // call rewrites the store and re-syncs the source. Coalesce to one update
    // per animation frame so a heavier `onMove` cannot stutter the drag.
    let rafPending = false;
    let dragRaf: number | null = null;
    const cancelPendingFrame = () => {
      if (dragRaf !== null) {
        cancelAnimationFrame(dragRaf);
        dragRaf = null;
      }
      rafPending = false;
    };
    const commit = () => {
      const next = marker.getLngLat();
      popup.setLngLat(next);
      options.onMove([next.lng, next.lat]);
    };
    const handleDrag = () => {
      if (rafPending) return;
      rafPending = true;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = null;
        rafPending = false;
        if (disposed) return;
        commit();
      });
    };
    // The final `drag` may still be sitting in a pending frame when the user
    // releases and clicks Done; commit the release position synchronously so the
    // photo never lands one frame stale, dropping the queued frame so it does
    // not fire a second, identical update.
    const handleDragEnd = () => {
      if (disposed) return;
      cancelPendingFrame();
      commit();
    };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      cancelPendingFrame();
      marker.off("drag", handleDrag);
      marker.off("dragend", handleDragEnd);
      doneButton.removeEventListener("click", handleDone);
      popup.remove();
      marker.remove();
    };
    const handleDone = () => {
      dispose();
      options.onDone?.();
    };

    marker.on("drag", handleDrag);
    marker.on("dragend", handleDragEnd);
    doneButton.addEventListener("click", handleDone);
    return dispose;
  }

  /**
   * Imperatively animate the camera, for the programmatic scripting API.
   *
   * Unlike {@link applyView} (which the store sync uses) this passes straight to
   * MapLibre's `flyTo`, so a script can request an animated move with an explicit
   * duration. Only the provided fields are changed; omitted camera properties
   * keep their current value.
   *
   * @param camera Target camera. `center` is `[lng, lat]`.
   */
  flyTo(camera: {
    center?: [number, number];
    zoom?: number;
    bearing?: number;
    pitch?: number;
    duration?: number;
  }): void {
    if (!this.map) return;
    this.map.flyTo({
      ...(camera.center ? { center: camera.center } : {}),
      ...(typeof camera.zoom === "number" ? { zoom: camera.zoom } : {}),
      ...(typeof camera.bearing === "number" ? { bearing: camera.bearing } : {}),
      ...(typeof camera.pitch === "number" ? { pitch: camera.pitch } : {}),
      duration: typeof camera.duration === "number" ? camera.duration : 800,
    });
  }

  /** Animate the map in by one zoom level, mirroring the navigation control. */
  zoomIn(): void {
    this.map?.zoomIn();
  }

  /** Animate the map out by one zoom level, mirroring the navigation control. */
  zoomOut(): void {
    this.map?.zoomOut();
  }

  /**
   * Animate the map back to north-up (bearing 0), leaving the center, zoom, and
   * pitch untouched. Mirrors MapLibre's compass-control click.
   */
  resetNorth(): void {
    this.map?.resetNorth();
  }

  /**
   * Animate the map back to north-up and flat (bearing 0 and pitch 0), leaving
   * the center and zoom untouched.
   */
  resetNorthPitch(): void {
    this.map?.resetNorthPitch();
  }

  /**
   * Animate the map back to flat (pitch 0), leaving the center, zoom, and
   * bearing untouched. The pitch counterpart to {@link resetNorth}, so the
   * heading and tilt can be reset independently.
   */
  resetPitch(): void {
    // Match MapLibre's native resetNorth/resetNorthPitch 1s animation so the
    // sibling orientation resets feel consistent (easeTo defaults to 300ms).
    this.map?.easeTo({ pitch: 0, duration: 1000 });
  }

  /**
   * Query rendered features at a geographic point, for the scripting API's
   * "identify" command. Mirrors the in-app Identify tool: it queries the same
   * candidate style layers MapLibre renders for each layer
   * ({@link getCandidateStyleLayers}) and falls back to property matching when a
   * feature carries no stable id, so a Python caller gets the same hit a click
   * would.
   *
   * @param lngLat Geographic point as `[lng, lat]`.
   * @param layerId Optional store layer id to restrict the query to; omit to
   *   query every layer at the point.
   * @returns One entry per matched feature, topmost first.
   */
  identifyFeatures(
    lngLat: [number, number],
    layerId?: string,
  ): Array<{
    layerId: string;
    featureId: string | null;
    properties: Record<string, unknown>;
    geometry: Geometry | null;
  }> {
    if (!this.map) return [];
    const point = this.map.project(lngLat);
    const targets = layerId
      ? this.syncedLayers.filter((layer) => layer.id === layerId)
      : this.syncedLayers;
    const results: Array<{
      layerId: string;
      featureId: string | null;
      properties: Record<string, unknown>;
      geometry: Geometry | null;
    }> = [];
    for (const layer of targets) {
      const styleIds = this.getNativeLayerIds(layer);
      if (styleIds.length === 0) continue;
      const features = this.map.queryRenderedFeatures(point, {
        layers: styleIds,
      });
      for (const feature of features) {
        results.push({
          layerId: layer.id,
          featureId: featureIdForLayer(layer, feature),
          properties: (feature.properties ?? {}) as Record<string, unknown>,
          geometry: feature.geometry ?? null,
        });
      }
    }
    return results;
  }

  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options: { fit?: boolean } = {},
  ): void {
    if (!this.isStyleReady()) return;

    const ids = (Array.isArray(featureId) ? featureId : featureId ? [featureId] : []).filter(
      (id) => id != null,
    );

    if (!layer?.geojson || ids.length === 0) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      return;
    }

    // Index by id once (O(n)) then look each id up in O(1); a Shift-range of
    // thousands of rows on a large layer would otherwise be O(selected × total)
    // per highlight update, on the main thread, on every selection change.
    const featureById = new Map<string, Feature>(
      layer.geojson.features.map((feature, index) => [String(feature.id ?? index), feature]),
    );
    const features = ids
      .map((id) => featureById.get(id))
      .filter((feature): feature is Feature => feature?.geometry != null);
    if (features.length === 0) {
      this.syncHighlight(EMPTY_HIGHLIGHT);
      return;
    }

    const featureCollection: FeatureCollection = {
      type: "FeatureCollection",
      features: features as Feature<Geometry>[],
    };
    this.syncHighlight(featureCollection);

    if (options.fit) {
      this.fitFeature(featureCollection);
    }
  }

  clearFeatureHighlight(): void {
    this.syncHighlight(EMPTY_HIGHLIGHT);
  }

  /** Current map projection, normalized to the two values we persist. */
  readProjection(): MapProjection {
    return this.map?.getProjection()?.type === "mercator" ? "mercator" : "globe";
  }

  /**
   * Apply the projection from the active map preferences. Defaults to globe so
   * projects saved before projection was persisted keep their previous look.
   * Retries on the next idle if the style is not ready to accept it yet.
   */
  private enforceProjection(): void {
    if (!this.map) return;
    const desired = this.mapPreferences.projection ?? DEFAULT_PROJECTION.type;
    try {
      if (this.map.getProjection()?.type === desired) return;
      this.map.setProjection({ type: desired });
    } catch {
      this.map.once("idle", () => this.enforceProjection());
    }
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
      filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
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
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
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
    if (!this.map || this.layerControl || !this.controlVisibility["layer-control"]) {
      return false;
    }
    const layerControlConfig = this.createLayerControlConfig(this.syncedLayers);
    this.layerControlSignature = this.createLayerControlSignature(layerControlConfig);
    this.layerControl = new LayerControl({
      // The layer control fetches this URL to introspect the basemap's layers.
      // Both planetary and offline basemaps use a non-fetchable `geolibre://`
      // sentinel (expanded to an inline style by resolveMapStyle), so hand the
      // control the blank sentinel instead — like blank/raster basemaps it then
      // skips the fetch (which would otherwise throw "Failed to fetch" on the
      // sentinel URL) and shows a single background entry.
      basemapStyleUrl:
        getPlanetaryBasemapByStyleUrl(this.basemapStyleUrl) ||
        isOfflineBasemapSentinel(this.basemapStyleUrl)
          ? BLANK_BASEMAP
          : this.basemapStyleUrl,
      collapsed: true,
      panelWidth: 340,
      panelMinWidth: 240,
      panelMaxWidth: 450,
      ...layerControlConfig,
      // The control toggles the basemap internally; mirror the change into the
      // store (the source of truth) so external basemap UI — e.g. the left
      // layer panel's visibility icon and opacity slider — stays in sync.
      // Placed after the spread so these wired callbacks always win.
      onBackgroundVisibilityChange: (visible) => {
        useAppStore.getState().setBasemapVisible(visible);
      },
      onBackgroundOpacityChange: (opacity) => {
        useAppStore.getState().setBasemapOpacity(opacity);
      },
      // The per-layer style editor edits MapLibre paint directly; mirror those
      // edits into the store (the source of truth) so the right-hand Style
      // sidebar stays in sync and the change survives the next layer sync.
      onLayerStyleChange: (layerId, property, value) => {
        this.applyLayerControlStyleChange(layerId, property, value);
      },
    });
    this.map.addControl(this.layerControl, this.controlPositions["layer-control"]);
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
    if (!this.map || !this.layerControl || !this.controlVisibility["layer-control"]) {
      return;
    }

    const layerControlConfig = this.createLayerControlConfig(layers);
    const nextSignature = this.createLayerControlSignature(layerControlConfig);
    if (nextSignature === this.layerControlSignature) return;

    // Capture the control's spot in its corner before the remove/re-add. The
    // LayerControl's layer list is fixed at construction, so a refresh must
    // rebuild it — but MapLibre's addControl re-appends to the end of the
    // corner, which would drop the control below any controls inserted after it
    // (e.g. a terrain control the user enabled post-load), visibly reordering
    // the stack on every basemap/style change. Re-anchor it to its old sibling.
    const container = this.map.getContainer();
    const previous = container.querySelector(LAYER_CONTROL_SELECTOR);
    const anchor = previous?.nextElementSibling ?? null;
    const parent = previous?.parentElement ?? null;

    this.removeLayerControl();
    this.addLayerControl();

    restoreControlOrder(parent, anchor, container.querySelector(LAYER_CONTROL_SELECTOR));
  }

  private syncLayerControlState(): void {
    this.syncLayerControlBackgroundState();
    this.syncLayerControlLayerStates(this.syncedLayers);
    // Push the latest paint (already applied to the map by syncLayer) into the
    // layer control's open style editor so edits made elsewhere — e.g. the
    // right-hand Style sidebar — are reflected there too (issue #912). No-op
    // when no editor is open; skips the input the user is actively dragging.
    //
    // Invariant: refreshStyleEditor() must NOT fire onLayerStyleChange. If it
    // did, this path would loop forever (sync → refresh → onLayerStyleChange →
    // applyLayerControlStyleChange → setLayerStyle → sync → ...). The upstream
    // library guarantees this by setting input values programmatically, which
    // does not dispatch an input event. The reentrancy guard below is a cheap
    // defense in case a future upstream version regresses that guarantee.
    this.refreshingStyleEditor = true;
    try {
      this.layerControl?.refreshStyleEditor();
    } finally {
      this.refreshingStyleEditor = false;
    }
  }

  /**
   * Mirror a paint property edited via the layer control's per-layer style
   * editor into the store. The per-type opacities that GeoLibre derives
   * directly from the layer-level opacity (raster/line/text/icon) map to
   * {@link AppState.setLayerOpacity}; raster color adjustments map to
   * {@link LayerStyle} via {@link layerControlPaintToStyle}. Other properties
   * (vector paint) are ignored — see that helper for why.
   */
  private applyLayerControlStyleChange(layerId: string, property: string, value: unknown): void {
    // Ignore callbacks that fire while we are pushing store values back into
    // the editor; otherwise a misbehaving refresh could create a sync loop.
    if (this.refreshingStyleEditor) return;
    const store = useAppStore.getState();
    // These paint properties equal the layer-level opacity in syncLayer
    // (rasterPaint/heatmapPaint/linePaint use it directly; symbol layers set
    // text-opacity/icon-opacity to it), so an edit to them is an edit to the
    // layer's opacity and round-trips losslessly. fill-opacity/circle-opacity
    // are deliberately not here: syncLayer scales them by the layer opacity, so
    // the rendered value the control reports is not the raw style value.
    if (
      property === "raster-opacity" ||
      property === "heatmap-opacity" ||
      property === "line-opacity" ||
      property === "text-opacity" ||
      property === "icon-opacity"
    ) {
      if (typeof value === "number") store.setLayerOpacity(layerId, value);
      return;
    }
    const styleUpdate = layerControlPaintToStyle(property, value);
    if (styleUpdate) store.setLayerStyle(layerId, styleUpdate);
  }

  private createLayerControlConfig(layers: GeoLibreLayer[]): LayerControlConfig {
    const nativeStyleLayerIds = layers.flatMap((layer) =>
      this.getCandidateStyleLayers(layer).map(({ id }) => id),
    );
    // Hide style layers a plugin marks as internal chrome (e.g. selection
    // footprints, draw/highlight helpers) so they don't clutter the control.
    const internalStyleLayerIds = (this.map?.getStyle()?.layers ?? [])
      .filter((styleLayer) =>
        Boolean(
          (styleLayer.metadata as Record<string, unknown> | undefined)?.["geolibre:internal"],
        ),
      )
      .map((styleLayer) => styleLayer.id)
      // Sort so a plugin reordering an already-hidden internal layer (which
      // shuffles live style order) doesn't change the exclusion signature and
      // force an unnecessary control rebuild.
      .sort();
    const excludeLayers = Array.from(
      new Set([...LAYER_CONTROL_EXCLUDED_LAYERS, ...nativeStyleLayerIds, ...internalStyleLayerIds]),
    );
    const controllableLayers = layers.filter(
      (layer) => this.getNativeLayerIds(layer).length > 0 || isCustomControllableLayer(layer),
    );

    if (controllableLayers.length === 0) {
      return { excludeLayers };
    }

    return {
      excludeLayers,
      customLayerAdapters: [this.createGeoLibreLayerAdapter(controllableLayers)],
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
      (Array.from(items).find((item) => (item as HTMLElement).dataset.layerId === layerId) as
        | HTMLElement
        | undefined) ?? null
    );
  }

  private updateLayerControlItem(
    item: HTMLElement,
    state: { name: string; visible: boolean; opacity: number },
  ): void {
    const checkbox = item.querySelector(".layer-control-checkbox") as HTMLInputElement | null;
    if (checkbox) checkbox.checked = state.visible;

    const opacity = item.querySelector(".layer-control-opacity") as HTMLInputElement | null;
    if (opacity) {
      opacity.value = String(state.opacity);
      opacity.title = `Opacity: ${Math.round(state.opacity * 100)}%`;
    }

    const name = item.querySelector(".layer-control-name") as HTMLElement | null;
    if (name) {
      name.textContent = state.name;
      name.title = state.name;
    }
  }

  private createGeoLibreLayerAdapter(layers: GeoLibreLayer[]): CustomLayerAdapter {
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

  private getLayerMetadataBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
    return (
      this.normalizeLayerBounds(layer.source.bounds) ??
      this.normalizeLayerBounds(layer.metadata.bounds)
    );
  }

  private getLayerSourceBounds(layer: GeoLibreLayer): [number, number, number, number] | null {
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

  private normalizeLayerBounds(bounds: unknown): [number, number, number, number] | null {
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

    const existingStyleLayers = this.getCandidateStyleLayers(layer).filter(({ id }) =>
      this.map?.getLayer(id),
    );
    return existingStyleLayers.map(({ id, suffix }) => ({
      id,
      name: existingStyleLayers.length > 1 && suffix ? `${layer.name} ${suffix}` : layer.name,
      layer,
    }));
  }

  private getBeforeStyleLayerId(layers: GeoLibreLayer[], layerIndex: number): string | undefined {
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

  private getExternalBeforeStyleLayerId(layer: GeoLibreLayer | undefined): string | undefined {
    if (!this.map || !layer?.beforeId) return undefined;
    if (this.getCandidateStyleLayers(layer).some(({ id }) => id === layer.beforeId)) {
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

    if (layer.type === "image") {
      return [{ id: `layer-${layer.id}-image` }];
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
    labelWindow.__GEOLIBRE_LAYER_LABELS__ = Object.fromEntries([
      ...layers
        .flatMap((layer) => this.getNamedStyleLayers(layer))
        .map(({ id, name }): [string, string] => [id, name]),
      // Deck.gl-rendered COG rasters are custom layers absent from the map
      // style, so getNamedStyleLayers (which filters to existing style layers)
      // skips them. Publish their store id -> name directly so the Layer Swipe
      // panel, which lists them by store id via its COG layerProvider, shows a
      // friendly name instead of the raw id. Scoped to "cog-url" (the
      // CogLayerControl rasters the provider lists) to match that scope. See
      // opengeos/GeoLibre#1240.
      ...layers
        .filter(
          (layer) =>
            layer.type === "cog" &&
            layer.metadata.sourceKind === "cog-url" &&
            layer.metadata.externalNativeLayer === true,
        )
        .map((layer): [string, string] => [layer.id, layer.name]),
      // The Layer Swipe panel groups all basemap layers under "__basemap__";
      // publish the translated base-layer label last so this synthetic key
      // always wins over a layer that happens to share the id, matching the
      // sidebar. It is published even with no overlay layers, since the panel
      // always lists the basemap entry.
      ["__basemap__", this.backgroundLabel],
    ]);
    window.dispatchEvent(new CustomEvent("geolibre-layer-labels-change"));
  }

  /**
   * Clear all published layer display names. Used on teardown so the bridge
   * does not retain stale labels; kept separate from publishLayerDisplayNames,
   * which always re-publishes the basemap entry.
   */
  private clearLayerDisplayNames(): void {
    if (typeof window === "undefined") return;
    (window as GeoLibreLayerLabelWindow).__GEOLIBRE_LAYER_LABELS__ = {};
    window.dispatchEvent(new CustomEvent("geolibre-layer-labels-change"));
  }

  private addNavigationControl(): boolean {
    if (!this.map || this.navigationControl || !this.controlVisibility.navigation) {
      return false;
    }
    this.navigationControl = new maplibregl.NavigationControl();
    this.map.addControl(this.navigationControl, this.controlPositions.navigation);
    return true;
  }

  private removeNavigationControl(): void {
    if (!this.navigationControl) return;
    this.removeControl(this.navigationControl);
    this.navigationControl = null;
  }

  private addFullscreenControl(): boolean {
    if (!this.map || this.fullscreenControl || !this.controlVisibility.fullscreen) {
      return false;
    }
    // Fullscreen the map container so only the map canvas (and its floating
    // controls) fills the screen. MapLibre defaults to `map.getContainer()`,
    // which is what we want here. The surrounding workspace chrome (toolbar and
    // side panels) is hidden by the app while fullscreen is active: Chromium
    // promotes the fullscreen element to the top layer so the chrome is hidden
    // automatically, but WebKit (the Tauri desktop webview) leaves it painted
    // around the map, so the app hides it via CSS. See opengeos/GeoLibre#611.
    this.fullscreenControl = new maplibregl.FullscreenControl();
    this.map.addControl(this.fullscreenControl, this.controlPositions.fullscreen);
    return true;
  }

  private removeFullscreenControl(): void {
    if (!this.fullscreenControl) return;
    this.removeControl(this.fullscreenControl);
    this.fullscreenControl = null;
  }

  private addCompassControl(): boolean {
    if (!this.map || this.compassControl || !this.controlVisibility.compass) {
      return false;
    }
    this.compassControl = new ResetBearingControl({
      label: this.compassLabel,
    });
    this.map.addControl(this.compassControl, this.controlPositions.compass);
    return true;
  }

  private removeCompassControl(): void {
    if (!this.compassControl) return;
    this.removeControl(this.compassControl);
    this.compassControl = null;
  }

  /**
   * Update the compass control's tooltip/aria label, e.g. after a UI language
   * change. The label is cached so a control re-added after a full map
   * reinitialisation picks up the latest translation without an extra call.
   */
  setCompassLabel(label: string): void {
    this.compassLabel = label;
    this.compassControl?.setLabel(label);
  }

  /**
   * Update the label used for the grouped base layer (e.g. after a UI language
   * change). It is published through the layer-display-name bridge so the
   * Layer Swipe panel, which lives outside React, shows the same translated
   * base-layer label as the main layer manager.
   */
  setBackgroundLabel(label: string): void {
    this.backgroundLabel = label;
    this.publishLayerDisplayNames(this.syncedLayers);
  }

  private addGeolocateControl(): boolean {
    if (!this.map || this.geolocateControl || !this.controlVisibility.geolocate) {
      return false;
    }
    const control = new maplibregl.GeolocateControl({
      positionOptions: {
        enableHighAccuracy: true,
      },
      trackUserLocation: true,
    });
    // MapLibre permanently disables the GeolocateControl button on a
    // PERMISSION_DENIED error (code 1). Browsers report code 1 both for a real
    // denial and when the user simply dismisses the permission prompt without
    // choosing, which leaves the button stuck in a blocked state with no way to
    // retry (issue #839). Re-create the control whenever the permission was not
    // actually denied so the button returns to a neutral, clickable state.
    control.on("error", this.handleGeolocateError);
    this.geolocateControl = control;
    this.map.addControl(control, this.controlPositions.geolocate);
    return true;
  }

  private handleGeolocateError = (event: { code?: number }): void => {
    // Only react to PERMISSION_DENIED; other errors (timeout, position
    // unavailable) leave the button usable, so MapLibre's own handling is fine.
    if (!this.map || !this.geolocateControl || event?.code !== 1) return;

    // Snapshot the control that errored. The reset always runs in a later
    // microtask (the Permissions API query's `.then`, or `queueMicrotask`), so
    // we never tear down the control mid error-dispatch. It also means the
    // control could be torn down or replaced in between (e.g. the user toggles
    // it off then on), so recreate() bails unless this exact instance is still
    // mounted and never disturbs a healthy replacement.
    const controlAtError = this.geolocateControl;

    const recreate = (): void => {
      if (!this.map || !this.controlVisibility.geolocate) return;
      if (this.geolocateControl !== controlAtError) return;
      // Re-create the control to clear MapLibre's permanently-disabled button.
      this.removeGeolocateControl();
      this.addGeolocateControl();
    };

    const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!permissions?.query) {
      // No Permissions API: assume a dismissal so the user is never stuck.
      queueMicrotask(recreate);
      return;
    }
    try {
      permissions
        .query({ name: "geolocation" as PermissionName })
        .then((status) => {
          // Only a pending "prompt" means the dialog was dismissed, so reset to
          // allow a retry. "denied" keeps MapLibre's disabled state, and
          // "granted" (a contradictory code-1) is left alone rather than reset.
          if (status.state === "prompt") recreate();
        })
        .catch(() => recreate());
    } catch {
      // Some Permissions API implementations throw synchronously (partial
      // support, CSP, private browsing). Fall back to a deferred reset so the
      // user is never stuck.
      queueMicrotask(recreate);
    }
  };

  private removeGeolocateControl(): void {
    if (!this.geolocateControl) return;
    this.geolocateControl.off("error", this.handleGeolocateError);
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
    this.terrainControl = new TerrainControl({
      source: TERRAIN_SOURCE_ID,
      exaggeration: this.terrainExaggeration,
      label: this.terrainLabel,
      // Double-clicking the button asks the React layer to open the
      // vertical-exaggeration dialog (see TERRAIN_SETTINGS_EVENT).
      onOpenSettings: () => {
        window.dispatchEvent(new CustomEvent(TERRAIN_SETTINGS_EVENT));
      },
    });
    this.map.addControl(this.terrainControl, this.controlPositions.terrain);
    return true;
  }

  private removeTerrainControl(): void {
    if (this.map?.getTerrain()?.source === TERRAIN_SOURCE_ID) {
      this.map.setTerrain(null);
      // Mirror TerrainControl.setEnabled(false): restore MapLibre's default
      // center-clamping, which the control turned off to stop terrain from
      // recomputing (and snapping) the zoom while zooming over steep relief.
      this.map.setCenterClampedToGround(true);
    }
    if (!this.terrainControl) return;
    this.removeControl(this.terrainControl);
    this.terrainControl = null;
  }

  /** The current terrain vertical exaggeration. */
  getTerrainExaggeration(): number {
    return this.terrainExaggeration;
  }

  /**
   * Set the terrain vertical exaggeration. Cached so it survives the control
   * being re-added (Controls menu toggle, style reload) and applied live when
   * terrain is already enabled.
   */
  setTerrainExaggeration(exaggeration: number): void {
    // Clamp before caching so the cached value (which seeds the next control
    // built on a Controls-menu toggle / style reload) can't drift from what the
    // live control actually applies, and so the public API is safe regardless of
    // whether the caller pre-validated. Mirrors TerrainControl.setExaggeration.
    const safe = Number.isFinite(exaggeration)
      ? Math.max(0, exaggeration)
      : this.terrainExaggeration;
    this.terrainExaggeration = safe;
    this.terrainControl?.setExaggeration(safe);
  }

  /**
   * Update the terrain control's tooltip/aria label, e.g. after a UI language
   * change. Cached so a re-added control picks up the latest translation.
   */
  setTerrainLabel(label: string): void {
    this.terrainLabel = label;
    this.terrainControl?.setLabel(label);
  }

  private addScaleControl(): boolean {
    if (!this.map || this.scaleControl || !this.controlVisibility.scale) {
      return false;
    }
    // A body-aware scale bar (MapLibre's built-in ScaleControl assumes Earth's
    // radius, so it is wrong on Moon/Mars/Mercury/etc.). The unit system follows
    // the project's map preference (metric / imperial / nautical).
    this.scaleControl = new PlanetaryScaleControl({
      maxWidth: 120,
      unit: this.mapPreferences.scaleUnit,
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
    if (!this.map || this.attributionControl || !this.controlVisibility.attribution) {
      return false;
    }
    this.attributionControl = new maplibregl.AttributionControl({
      compact: true,
    });
    this.map.addControl(this.attributionControl, this.controlPositions.attribution);
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
    if (control === "compass") return this.addCompassControl();
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
    else if (control === "compass") this.removeCompassControl();
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
    const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
    if (!bounds) {
      return {
        center: new maplibregl.LngLat(
          preferences.renderWorldCopies ? lngLat.lng : clampNumber(lngLat.lng, -180, 180),
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
  const maxZoom = Math.max(minZoom, clampNumber(preferences.maxZoom, 0, 24));

  return {
    center: [
      preferences.renderWorldCopies ? view.center[0] : clampNumber(view.center[0], -180, 180),
      clampNumber(view.center[1], -85, 85),
    ],
    zoom: clampNumber(view.zoom, minZoom, maxZoom),
    bearing: view.bearing,
    pitch: clampNumber(view.pitch, 0, clampNumber(preferences.maxPitch, 0, DEFAULT_MAX_PITCH)),
  };
}

/**
 * Resolve a stable feature id for an identify hit. Prefers the feature's own id;
 * for a GeoJSON layer without one, matches the rendered feature back to a source
 * feature by property equality and returns its id (or array index). Mirrors the
 * in-app Identify behaviour so the scripting API reports consistent ids.
 */
function featureIdForLayer(
  layer: GeoLibreLayer,
  feature: maplibregl.MapGeoJSONFeature,
): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;
  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  // With no properties there is nothing to match on, so any "match" would be a
  // fake id (the array index) that breaks if features are reordered — bail out.
  if (propertyKeys.length === 0) return null;
  // Match by full property-set equality (same keys and values), and only accept
  // an UNAMBIGUOUS hit; a non-unique match returns null (no stable id), like the
  // feature.id guard above. MapLibre re-parses object/array property values into
  // fresh references each query, so compare those by JSON rather than identity.
  const valuesEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
  };
  const matches = layer.geojson.features
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => {
      const candidateProperties = candidate.properties ?? {};
      if (Object.keys(candidateProperties).length !== propertyKeys.length) {
        return false;
      }
      return propertyKeys.every((key) => valuesEqual(candidateProperties[key], properties[key]));
    });
  if (matches.length !== 1) return null;
  const { candidate, index } = matches[0];
  return String(candidate.id ?? index);
}

function effectiveMinZoomForPreferences(
  preferences: MapPreferences,
  map: maplibregl.Map,
  requestedMinZoom: number,
): number {
  const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return requestedMinZoom;

  const mercatorBounds = mercatorBoundsForLngLatBounds(bounds);
  const widthRatio = Math.abs(mercatorBounds.east - mercatorBounds.west);
  const heightRatio = Math.abs(mercatorBounds.south - mercatorBounds.north);
  if (widthRatio <= 0 || heightRatio <= 0) return requestedMinZoom;

  const canvas = map.getCanvas();
  const minZoomForWidth = Math.log2(canvas.clientWidth / (512 * widthRatio));
  const minZoomForHeight = Math.log2(canvas.clientHeight / (512 * heightRatio));

  return clampNumber(Math.max(requestedMinZoom, minZoomForWidth, minZoomForHeight), 0, 24);
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
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

function normalizeMapBounds(bounds: MapPreferences["bounds"]): MapPreferences["bounds"] | null {
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

function mapBoundsForPreferences(preferences: MapPreferences): maplibregl.LngLatBoundsLike | null {
  const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return null;

  return [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ];
}

export function createMapController(): MapController {
  return new MapController();
}
