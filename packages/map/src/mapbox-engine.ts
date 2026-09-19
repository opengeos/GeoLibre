import { showGlSearchResult } from "./gl-search-result";
import type * as mapboxgl from "mapbox-gl";
import type { MapDiagnosticEvent } from "./map-diagnostic";
import type * as maplibregl from "maplibre-gl";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import {
  DEFAULT_LAYER_STYLE,
  controlRendersLayer,
  geojsonHasZCoordinates,
  redactUrlCredentials,
  styleValue,
} from "@geolibre/core";
import { circlePaint, fillPaint, linePaint, rasterPaint } from "./style-mapper";
import {
  DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  STORY_OPACITY_PAINT_PROPERTIES,
  type MapEngine,
  type MapEngineCapabilities,
  type MapRenderSurface,
  type FlyToCamera,
  type BuiltInMapControl,
  type CameraIdleEvent,
  type IdentifiedFeature,
  type ManualPlacementOptions,
  type ExtentDrawingOptions,
  type MapExtent,
} from "./map-engine";
import {
  compileMapboxLayer,
  isMapboxPluginLayer,
  DEFAULT_MAPBOX_TEXT_FONT,
  type MapboxLayerPlan,
  mapboxPaint,
} from "./mapbox-layers";
import {
  BASEMAP_LABEL_KEY,
  clearLayerLabels,
  publishLayerLabels,
  styleLayerLabel,
} from "./layer-labels";
import { mapboxSourceId } from "./style-layer-ids";
import { resolveTextFontFromStyleLayers } from "./text-font";
import { getLayerBounds } from "./geojson-loader";
import { captureEngineImage } from "./map-capture";
import { drawExtentOnCanvas } from "./extent-drawing";
import {
  prepareMapboxStandard,
  isMapboxStandard,
  STANDARD_OPACITY,
  STANDARD_BLANK_COLOR,
} from "./mapbox-standard-style";
import { arcgisOpacity } from "./arcgis-vector-style";
import { LayerControlHost } from "./layer-control-host";
import { ResetBearingControl } from "./reset-bearing-control";
import { MapboxGlobeControl } from "./mapbox-globe-control";

export const MAPBOX_CAPABILITIES: MapEngineCapabilities = Object.freeze({
  styleSpec: true,
  nativeMapInstance: false,
  customLayers: false,
  // `@deck.gl/mapbox` targets mapbox-gl natively: the shared interleaved
  // overlay binds to the Mapbox map through `getMapboxMap`, which is how 3D
  // Tiles, LiDAR, Deck.gl Layers and DuckDB query results draw here.
  deckOverlay: true,
  terrain: true,
  picking: true,
  onMapDrawing: true,
  domControls: true,
});

const BLANK_BACKGROUND_LAYER_ID = "geolibre-blank-background";

const HIGHLIGHT_SOURCE_ID = "geolibre-mapbox-highlight";
const HIGHLIGHT_LAYER_IDS = [
  "geolibre-mapbox-highlight-fill",
  "geolibre-mapbox-highlight-line",
  "geolibre-mapbox-highlight-point",
];

/** App-owned overlays that must remain above project layers after every sync. */
function isOverlayLayerId(id: string): boolean {
  return (
    HIGHLIGHT_LAYER_IDS.includes(id) ||
    id.startsWith("geolibre-mapbox-extent-") ||
    id.startsWith("geolibre-search-")
  );
}

/**
 * The built-in controls Mapbox can put a button on the map for, in the order
 * `MapController.init` adds them: both engines stack controls by insertion
 * within a corner, so the same order gives the same top-right cluster
 * (fullscreen, then the compass under it, then the globe toggle). Terrain is a
 * scene setting on Mapbox (no button, like Cesium), the layer control mounts
 * from the shared host once the style has loaded, and the logos are not
 * hostable: Mapbox draws its own wordmark and the Maptoolkit basemaps are
 * MapLibre styles.
 */
const MAPBOX_HOSTED_CONTROL_ORDER: readonly BuiltInMapControl[] = [
  "fullscreen",
  "compass",
  "navigation",
  "geolocate",
  "globe",
  "scale",
  "attribution",
];
const MAPBOX_HOSTED_CONTROLS: ReadonlySet<BuiltInMapControl> = new Set(MAPBOX_HOSTED_CONTROL_ORDER);

export function redactMapboxError(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, redactUrlCredentials)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(
      /(["'](?:access_?token|api_?key|token|authorization)["']\s*:\s*["'])[^"']*(["'])/gi,
      "$1[redacted]$2",
    )
    .replace(/\b(?:pk|sk)\.[\w.-]+/g, "[redacted]");
}

function diagnosticResourceKey(url: string | undefined, message: string): string {
  if (!url) return `map:${redactMapboxError(message)}`;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(/\/(?:-?\d+(?:\.\d+)?)(?=[/.@]|$)/g, "/{n}")
      .replace(/\/\d+-\d+(?=\.|$)/g, "/{range}");
    return `map:${parsed.origin}${path}`;
  } catch {
    return `map:${redactMapboxError(url)}`;
  }
}

/** Mapbox owns its own native objects; getMap deliberately remains MapLibre-only. */
export class MapboxEngine implements MapEngine {
  readonly kind = "mapbox" as const;
  readonly capabilities = MAPBOX_CAPABILITIES;
  private map: mapboxgl.Map | null;
  private surface: MapRenderSurface | null;
  private layers: GeoLibreLayer[] = [];
  /** The Layers panel's name for the basemap row, mirrored into the label bridge. */
  private backgroundLabel = "Background";
  private plans = new Map<string, MapboxLayerPlan>();
  private previous = new Map<string, GeoLibreLayer>();
  private errors = new Map<string, string>();
  private basemap: mapboxgl.LayerSpecification[] = [];
  // Label font borrowed from the basemap: a style only serves its own glyphs.
  private textFont: string[] = DEFAULT_MAPBOX_TEXT_FONT;
  private basemapVisible = true;
  private basemapOpacity = 1;
  private styleRequest = 0;
  private blankColor: string | null = null;
  private terrain = false;
  private exaggeration = 1;
  private preferences: MapPreferences | null = null;
  private pluginControls = new Map<maplibregl.IControl, mapboxgl.IControl>();
  private controlVisibility: Record<BuiltInMapControl, boolean>;
  /** See the constructor option of the same name. */
  private ownsLayerLabels: boolean;
  private controlPositions: Record<BuiltInMapControl, maplibregl.ControlPosition> = {
    ...DEFAULT_BUILT_IN_CONTROL_POSITIONS,
  };
  /** The mounted built-in controls; a hidden or unsupported id has no entry. */
  private builtInControls = new Map<BuiltInMapControl, mapboxgl.IControl>();
  // The same compass (reset pitch & bearing) button MapLibre shows, and a
  // globe toggle standing in for MapLibre's GlobeControl, which mapbox-gl
  // lacks. Both are kept typed so labels and projection changes reach them.
  private compassControl: ResetBearingControl | null = null;
  private globeControl: MapboxGlobeControl | null = null;
  private scaleControl: mapboxgl.ScaleControl | null = null;
  private compassLabel: string | undefined;
  private disposers = new Set<() => void>();
  private layerControlVisible: boolean;
  // The same on-map layer control MapLibre shows, driven through the shared
  // host: the control only needs the style API and IControl, which Mapbox has.
  private layerControlHost = new LayerControlHost({
    getMap: () => this.map,
    addControl: (control, position) => {
      this.addControl(control, position);
    },
    removeControl: (control) => this.removeControl(control),
    getLayers: () => this.layers,
    getNativeLayerIds: (layer) => this.nativeLayerIds(layer),
    getSourceIds: (layer) => {
      const plan = this.plans.get(layer.id);
      return plan ? [plan.sourceId, ...Object.keys(plan.additionalSources ?? {})] : [];
    },
    excludedLayerIds: [BLANK_BACKGROUND_LAYER_ID, ...HIGHLIGHT_LAYER_IDS],
    // Never hand the control a URL: `mapbox://` styles are not fetchable, and
    // the engine already holds the loaded style's own layers (see styleLoaded),
    // which is a better basemap answer than a second fetch would give.
    getBasemapStyleUrl: () => null,
    getBasemapLayerIds: () => this.getBasemapStyleLayerIds(),
    getBasemapState: () => ({
      visible: this.basemapVisible,
      opacity: this.basemapOpacity,
    }),
  });
  private storyOpacities = new Map<string, number>();
  // The paint a control-owned native layer carried before a story fade
  // replaced its opacity, keyed by store layer id then native id, so
  // `restoreLayerStyles` can hand it back: the ordinary mirror never writes
  // paint on those layers.
  private storyPaintBackups = new Map<string, Map<string, Map<string, unknown>>>();
  private storyCameraToken = 0;
  private onDiagnostic?: (event: MapDiagnosticEvent) => void;
  private reportedDiagnosticKeys = new Set<string>();
  private pendingStoryRotate:
    | ((event: mapboxgl.MapEventOf<"moveend"> & { storyCameraToken?: number }) => void)
    | null = null;
  private syncPending = false;
  private basemapPending = false;
  private flushLayers = () => {
    if (this.syncPending) this.syncLayers(this.layers);
    if (this.basemapPending) this.applyBasemap();
  };

  constructor(
    map: mapboxgl.Map,
    private gl: typeof mapboxgl.default,
    private accessToken = "",
    options: {
      /**
       * Override built-in control visibility before the controls are added.
       * Secondary (split/grid) panes pass `{ "layer-control": false }` so they
       * don't mount a second layer control that would write the shared
       * layer/basemap state back to the global store.
       */
      controlVisibility?: Partial<Record<BuiltInMapControl, boolean>>;
      /**
       * Whether this engine publishes the friendly style-layer names the swipe
       * panel reads (see `./layer-labels`). The bridge is one window global, so
       * only the primary pane may write it: a secondary (split/grid) pane draws
       * the same layers under the same style-layer ids but filtered by its own
       * per-pane visibility, so letting it publish would republish a subset —
       * changing the sibling count and so the qualifiers — and letting it clear
       * on teardown would wipe the primary's names until its next sync, leaving
       * the swipe panel listing raw ids. Secondary panes pass `false`.
       */
      ownsLayerLabels?: boolean;
      /** Report renderer failures through the app's Diagnostics panel. */
      onDiagnostic?: (event: MapDiagnosticEvent) => void;
    } = {},
  ) {
    this.map = map;
    this.onDiagnostic = options.onDiagnostic;
    this.ownsLayerLabels = options.ownsLayerLabels ?? true;
    this.controlVisibility = {
      ...DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
      ...options.controlVisibility,
      // Attribution is required by Mapbox; an override cannot hide it, the
      // same rule setBuiltInControlVisible applies later.
      attribution: true,
    };
    this.layerControlVisible = this.controlVisibility["layer-control"];
    this.surface = {
      getCanvas: () => map.getCanvas(),
      getContainer: () => map.getContainer(),
      getBearing: () => map.getBearing(),
      project: (p) => map.project(p),
      unproject: (p) => map.unproject(p),
      redraw: () => map.triggerRepaint(),
    };
    map.on("style.load", this.styleLoaded);
    map.on("error", this.onError);
    map.on("sourcedata", this.onSourceData);
    map.on("idle", this.flushLayers);
    map.on("styledata", this.onStyleData);
    for (const id of MAPBOX_HOSTED_CONTROL_ORDER) {
      if (this.controlVisibility[id]) this.mountBuiltInControl(id);
    }
    // Terrain is a scene setting here (see setBuiltInControlVisible); an
    // override asking for it is applied now, or by styleLoaded once the style
    // is in, since setTerrainEnabled remembers the request either way.
    if (this.controlVisibility.terrain) this.setTerrainEnabled(true);
    if (map.isStyleLoaded()) this.styleLoaded();
  }
  getMap(): null {
    return null;
  }
  /** Typed escape hatch for integrations explicitly declaring Mapbox support. */
  getMapboxMap(): mapboxgl.Map | null {
    return this.map;
  }
  /**
   * The mapbox-gl namespace the engine was built with, for an integration that
   * has to construct Mapbox's own `Marker` / `Popup` / `LngLatBounds` on the map
   * (MapLibre's throw there). The Mapbox counterpart of the `@cesium/engine`
   * namespace `getCesiumScene` hands out: plugins never import mapbox-gl.
   */
  getMapboxGl(): typeof mapboxgl.default {
    return this.gl;
  }
  /**
   * The access token this engine's map was built with.
   *
   * mapbox-gl reads its token from the global `mapboxgl.accessToken` unless a
   * map is handed one in its constructor options, which is what the canvas
   * does — the global is never set. A plugin that constructs a second Mapbox
   * map (the Layer Swipe comparison pane) therefore has to pass the token
   * along, or that map refuses to render with "An API access token is
   * required to use Mapbox GL".
   *
   * `null` rather than the empty string when the app has no token configured,
   * so a caller that forwards it into another map's options omits the key
   * instead of handing mapbox-gl a blank token — the state a plugin has to
   * distinguish is "there is no token", not "the token is zero characters".
   */
  getMapboxAccessToken(): string | null {
    return this.accessToken || null;
  }
  private clearError(key: string): void {
    this.errors.delete(key);
    this.reportedDiagnosticKeys.delete(key);
    this.reportedDiagnosticKeys.delete(`source:${key}`);
  }
  private recordError(key: string, event: MapDiagnosticEvent, diagnosticKey = key): void {
    const message = redactMapboxError(event.message);
    this.errors.set(key, message);
    if (this.reportedDiagnosticKeys.has(diagnosticKey)) return;
    this.reportedDiagnosticKeys.add(diagnosticKey);
    this.onDiagnostic?.({
      ...event,
      message,
      ...(event.detail ? { detail: redactMapboxError(event.detail) } : {}),
      ...(event.url ? { url: redactMapboxError(event.url) } : {}),
    });
  }
  private onError = (event: {
    error: Error & { status?: number; url?: string; resource?: string };
    sourceId?: string;
    status?: number;
    url?: string;
  }) => {
    // Cancelled tile/style fetches are already captured as informational
    // network events. Treating them as renderer failures would double-count
    // normal panning, style swaps, and layer removal.
    if (event.error.name === "AbortError") return;
    const source = event.sourceId;
    const status = event.status ?? event.error.status;
    const url = event.url ?? event.error.url ?? event.error.resource;
    const message = event.error.message || "Mapbox reported an error.";
    this.recordError(
      source ?? "map",
      {
        message,
        detail: JSON.stringify({ source, status, url, error: event.error.message }, null, 2),
        source,
        status,
        url,
      },
      source ? `source:${source}` : diagnosticResourceKey(url, message),
    );
  };
  /**
   * A source error is stored under the source id and must not outlive the
   * failure: Mapbox emits `sourcedata` for metadata, visibility and error
   * changes too, so only a completed `content` load clears the entry.
   */
  private onSourceData = (event: {
    sourceId?: string;
    sourceDataType?: "metadata" | "content" | "visibility" | "error";
    isSourceLoaded?: boolean;
  }) => {
    if (event.sourceId && event.sourceDataType === "content" && event.isSourceLoaded) {
      this.clearError(event.sourceId);
      // A sync deferred while this source was still loading is otherwise only
      // retried on `idle`, which a map with an animated canvas source (the Sun
      // plugin's night mask) or a render loop never reaches — so a layer added
      // during any tile fetch would stay off the map for good.
      this.flushLayers();
    }
  };
  private styleLoaded = () => {
    const map = this.map;
    if (!map) return;
    this.plans.clear();
    this.previous.clear();
    this.errors.clear();
    this.reportedDiagnosticKeys.clear();
    this.basemap = structuredClone(map.getStyle()?.layers ?? []);
    this.textFont = resolveTextFontFromStyleLayers(
      this.basemap as { type: string; layout?: Record<string, unknown> }[],
      DEFAULT_MAPBOX_TEXT_FONT,
    );
    if (this.preferences) this.applyMapPreferences(this.preferences);
    this.applyBasemap();
    this.setBlankBackgroundColor(this.blankColor);
    this.setTerrainEnabled(this.terrain);
    this.syncLayers(this.layers);
    if (this.layerControlVisible) this.layerControlHost.add();
  };
  // Plugins can add native style layers directly (outside the layer store);
  // refresh the layer control on style changes so internal-flagged layers are
  // excluded reactively (debounced by the host).
  private onStyleData = () => {
    this.layerControlHost.scheduleStyleRefresh();
  };
  destroy(): void {
    if (!this.map) return;
    this.styleRequest++;
    this.stopCamera();
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.map.off("style.load", this.styleLoaded);
    this.map.off("error", this.onError);
    this.map.off("sourcedata", this.onSourceData);
    this.map.off("idle", this.flushLayers);
    this.map.off("styledata", this.onStyleData);
    this.layerControlHost.destroy();
    // Leave no stale names behind for whichever engine mounts next — but only
    // for the pane that owns the bridge; see `ownsLayerLabels`.
    if (this.ownsLayerLabels) clearLayerLabels();
    this.map.remove();
    this.pluginControls.clear();
    this.builtInControls.clear();
    this.compassControl = null;
    this.globeControl = null;
    this.scaleControl = null;
    this.map = null;
    this.surface = null;
    this.plans.clear();
    this.previous.clear();
  }
  readView(): MapViewState {
    const map = this.map;
    return map
      ? {
          center: map.getCenter().toArray(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
          ...(this.getViewBounds() ? { bbox: this.getViewBounds()! } : {}),
        }
      : { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 };
  }
  applyView(view: MapViewState): void {
    const old = this.readView();
    if (
      Math.abs(old.center[0] - view.center[0]) < 1e-8 &&
      Math.abs(old.center[1] - view.center[1]) < 1e-8 &&
      Math.abs(old.zoom - view.zoom) < 1e-8 &&
      old.bearing === view.bearing &&
      old.pitch === view.pitch
    )
      return;
    this.map?.jumpTo(this.constrainView(view));
  }
  easeToView(view: MapViewState): void {
    this.map?.easeTo(this.constrainView(view));
  }
  /**
   * Clamp a view to the project's zoom, pitch and world-copy preferences ahead
   * of the camera move, as the MapLibre engine does: the native constraints
   * still enforce the limits, but correcting an out-of-range saved camera
   * after the jump shows as a one-frame snap.
   */
  private constrainView(view: MapViewState): {
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } {
    const p = this.preferences;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const minZoom = p ? clamp(p.minZoom, 0, 24) : 0;
    const maxZoom = p ? Math.max(minZoom, clamp(p.maxZoom, 0, 24)) : 24;
    return {
      center: [
        !p || p.renderWorldCopies ? view.center[0] : clamp(view.center[0], -180, 180),
        clamp(view.center[1], -85, 85),
      ],
      zoom: clamp(view.zoom, minZoom, maxZoom),
      bearing: view.bearing,
      pitch: clamp(view.pitch, 0, p ? clamp(p.maxPitch, 0, 85) : 85),
    };
  }
  readCameraAltitude(): number | null {
    const p = this.map?.getFreeCameraOptions().position;
    return p ? p.toAltitude() : null;
  }
  flyTo(camera: FlyToCamera): void {
    this.map?.flyTo({ duration: 800, ...camera });
  }
  flyToView(location: StoryChapterLocation): void {
    const map = this.map;
    if (!map) return;
    // A fresh token, so this preview's moveend can't satisfy a chapter's
    // pending rotate-on-settle listener, which is detached as superseded.
    const token = ++this.storyCameraToken;
    if (this.pendingStoryRotate) {
      map.off("moveend", this.pendingStoryRotate);
      this.pendingStoryRotate = null;
    }
    map.flyTo(location, { storyCameraToken: token });
  }
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation = "flyTo",
    rotate = false,
  ): void {
    const map = this.map;
    if (!map) return;
    const token = ++this.storyCameraToken;
    if (this.pendingStoryRotate) {
      map.off("moveend", this.pendingStoryRotate);
      this.pendingStoryRotate = null;
    }
    if (!rotate) {
      map[animation]({ ...location, duration: 800 }, { storyCameraToken: token });
      return;
    }
    const onMoveEnd = (event: mapboxgl.MapEventOf<"moveend"> & { storyCameraToken?: number }) => {
      if (event.storyCameraToken !== token) return;
      map.off("moveend", onMoveEnd);
      if (this.pendingStoryRotate === onMoveEnd) this.pendingStoryRotate = null;
      if (this.storyCameraToken !== token || !this.map) return;
      this.map.rotateTo(this.map.getBearing() + 180, {
        duration: 30000,
        easing: (time) => time,
      });
    };
    // Listen before moving: jumpTo fires its moveend synchronously.
    this.pendingStoryRotate = onMoveEnd;
    map.on("moveend", onMoveEnd);
    map[animation]({ ...location, duration: 800 }, { storyCameraToken: token });
  }
  zoomIn(): void {
    this.map?.zoomIn();
  }
  zoomOut(): void {
    this.map?.zoomOut();
  }
  resetNorth(): void {
    this.map?.resetNorth();
  }
  resetNorthPitch(): void {
    this.map?.resetNorthPitch();
  }
  resetPitch(): void {
    this.map?.easeTo({ pitch: 0, duration: 1000 });
  }
  fitBounds(bounds: MapExtent): void {
    this.map?.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { padding: 40, maxZoom: 14, duration: 800 },
    );
  }
  fitLayer(layer: GeoLibreLayer): void {
    const bounds = getLayerBounds(layer);
    if (bounds) this.fitBounds(bounds);
    else {
      const center = layer.metadata.center;
      if (
        Array.isArray(center) &&
        center.length >= 2 &&
        center.slice(0, 2).every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        this.map?.flyTo({
          center: [center[0] as number, center[1] as number],
          zoom: typeof layer.metadata.zoom === "number" ? layer.metadata.zoom : 16,
          // Match MapController.fitLayer: a tileset is looked at in perspective.
          ...(layer.type === "3d-tiles" ? { pitch: Math.max(this.map.getPitch(), 60) } : {}),
        });
      }
    }
  }
  readProjection(): MapProjection {
    return this.map?.getProjection().name === "globe" ? "globe" : "mercator";
  }
  applyMapPreferences(p: MapPreferences): void {
    this.preferences = p;
    const map = this.map;
    if (!map) return;
    // Clear old constraints before applying a disjoint new zoom interval.
    map.setMinZoom(0);
    map.setMaxZoom(24);
    map.setMaxZoom(Math.min(24, Math.max(0, p.maxZoom)));
    map.setMinZoom(Math.min(map.getMaxZoom(), Math.max(0, p.minZoom)));
    map.setMaxPitch(Math.min(85, Math.max(0, p.maxPitch)));
    map.setMaxBounds(
      p.restrictBounds
        ? [
            [p.bounds[0], p.bounds[1]],
            [p.bounds[2], p.bounds[3]],
          ]
        : null!,
    );
    map.setRenderWorldCopies(p.renderWorldCopies);
    map.setProjection(p.projection);
    // mapbox-gl announces neither change through an event the controls could
    // watch, so tell them directly.
    this.globeControl?.update();
    this.scaleControl?.setUnit(p.scaleUnit);
    this.setTerrainEnabled(p.terrainEnabled);
  }
  syncLayers(layers: GeoLibreLayer[]): void {
    this.layers = layers;
    const map = this.map;
    this.syncPending = true;
    if (!map?.isStyleLoaded()) return;
    this.syncPending = false;
    const ids = new Set(layers.map((layer) => layer.id));
    for (const id of this.plans.keys()) if (!ids.has(id)) this.removeLayer(id);
    // A control-rendered row that leaves the store mid-story gets its paint
    // back now; a later row under the same id starts from the control's
    // paint at that time, not from this snapshot.
    for (const id of [...this.storyPaintBackups.keys()])
      if (!ids.has(id)) this.restoreControlLayerPaint(id);
    for (const key of this.errors.keys())
      if (key.startsWith("layer:") && !ids.has(key.slice(6))) this.clearError(key);
    // The app-owned overlays are never touched by this loop, so the anchor that
    // keeps project layers beneath them is resolved once per sync.
    const beforeOverlay = map
      .getStyle()
      ?.layers?.find((candidate) => isOverlayLayerId(candidate.id))?.id;
    // Store order is topmost first. Add and move in reverse so overlays agree
    // with the layer panel, including after a style swap or drag reorder.
    for (const original of [...layers].reverse()) {
      try {
        // The plugin controls own these layers and synchronize their display
        // settings from the store. They synchronize custom renderers separately
        // from native sources; the ones that also draw native style layers get
        // the store's visibility and opacity mirrored onto those, as MapLibre's
        // layer-sync does for every external native layer.
        // A story chapter's transient opacity applies to plugin-owned layers too.
        const opacity = this.storyOpacities.get(original.id);
        const layer = opacity === undefined ? original : { ...original, opacity };
        if (isMapboxPluginLayer(original)) {
          this.removeLayer(original.id);
          this.mirrorPluginLayerState(layer);
          continue;
        }
        if (!original.visible) this.clearError(`layer:${original.id}`);
        // A Z-aware deck.gl overlay owns this representation on both GL
        // engines. Compiling the same GeoJSON into flat Mapbox layers would
        // draw every feature twice.
        if (
          original.type === "geojson" &&
          original.geojson &&
          styleValue(original.style, "elevation3dEnabled") === true &&
          geojsonHasZCoordinates(original.geojson)
        ) {
          this.removeLayer(original.id);
          this.clearError(`layer:${original.id}`);
          continue;
        }
        const plan = compileMapboxLayer(layer, { textFont: this.textFont });
        const previous = this.previous.get(layer.id);
        const oldPlan = this.plans.get(layer.id);
        const sourceChanged =
          oldPlan &&
          (JSON.stringify(oldPlan.additionalSources) !== JSON.stringify(plan.additionalSources) ||
            oldPlan.source.type !== plan.source.type ||
            (plan.source.type === "geojson" && oldPlan.source.type === "geojson"
              ? false
              : JSON.stringify(oldPlan.source) !== JSON.stringify(plan.source)));
        if (sourceChanged) this.removeLayer(layer.id);
        for (const [id, source] of Object.entries(plan.additionalSources ?? {})) {
          if (!map.getSource(id)) map.addSource(id, source);
        }
        if (!map.getSource(plan.sourceId)) map.addSource(plan.sourceId, plan.source);
        else if (
          plan.source.type === "geojson" &&
          (previous?.geojson !== layer.geojson || previous?.source !== layer.source)
        ) {
          (map.getSource(plan.sourceId) as mapboxgl.GeoJSONSource).setData(plan.source.data!);
        }
        const wanted = new Set(plan.layers.map((spec) => spec.id));
        for (const old of oldPlan?.layers ?? [])
          if (!wanted.has(old.id) && map.getLayer(old.id)) map.removeLayer(old.id);
        for (const spec of plan.layers) {
          const old = map.getLayer(spec.id);
          if (old && old.type !== spec.type) map.removeLayer(spec.id);
          if (!map.getLayer(spec.id)) map.addLayer(spec);
          else if (
            JSON.stringify(oldPlan?.layers.find((s) => s.id === spec.id)) !== JSON.stringify(spec)
          ) {
            for (const [key, value] of Object.entries(spec.paint ?? {}))
              map.setPaintProperty(spec.id, key as keyof mapboxgl.AnyPaint, value);
            for (const [key, value] of Object.entries(spec.layout ?? {}))
              map.setLayoutProperty(spec.id, key as keyof mapboxgl.AnyLayout, value);
            if ("filter" in spec) map.setFilter(spec.id, spec.filter ?? null);
            map.setLayerZoomRange(spec.id, spec.minzoom ?? 0, spec.maxzoom ?? 24);
          }
          map.moveLayer(spec.id, beforeOverlay);
        }
        this.plans.set(layer.id, plan);
        this.previous.set(layer.id, original);
        this.clearError(`layer:${layer.id}`);
      } catch (error) {
        this.removeLayer(original.id, { preserveError: true });
        if (original.visible) {
          const message = `${original.name}: ${redactMapboxError(String(error))}`;
          this.recordError(`layer:${original.id}`, {
            message,
            detail: `Mapbox could not compile or synchronize layer ${original.id}.`,
            source: original.name,
          });
        }
      }
    }
    this.publishLayerDisplayNames(layers);
    this.layerControlHost.refresh();
    this.layerControlHost.syncState();
  }
  /**
   * Publish what each style layer on this map should be called, so a control
   * that lists style layers can show the name the Layers panel shows.
   *
   * The Layer Swipe panel is the one that needs it: it drives its two sides by
   * style layer id, and this engine compiles a store layer into
   * `geolibre-mapbox-<id>-<sourceLayer>-<kind>` rows, which is not a name to
   * put in front of anyone. MapLibre's controller publishes the same bridge for
   * its own id scheme — without this the panel fell back to the raw ids on
   * Mapbox while showing "Counties Polygons" on MapLibre.
   *
   * A layer's style layers are taken from the plan the engine compiled for it,
   * plus the ids a plugin registered itself — never by matching the
   * `geolibre-mapbox-<id>-` prefix against the whole style, which would let a
   * layer named `a` claim the rows of one named `a-b`. Both are then filtered
   * against the live style, so a layer is not named before its rows exist.
   */
  private publishLayerDisplayNames(layers: GeoLibreLayer[]): void {
    const map = this.map;
    if (!map || !this.ownsLayerLabels) return;
    let present: Set<string>;
    try {
      present = new Set((map.getStyle()?.layers ?? []).map((styleLayer) => styleLayer.id));
    } catch {
      // getStyle throws while a style is loading; the next sync republishes.
      return;
    }

    const entries: Array<readonly [string, string]> = [];
    for (const layer of layers) {
      const prefix = `${mapboxSourceId(layer.id)}-`;
      const planned = this.plans.get(layer.id)?.layers.map((spec) => spec.id) ?? [];
      const native = Array.isArray(layer.metadata?.nativeLayerIds)
        ? layer.metadata.nativeLayerIds.filter((id): id is string => typeof id === "string")
        : [];
      const own = [...new Set([...planned, ...native])].filter((id) => present.has(id));
      for (const id of own) {
        // The kind is the last segment either way —
        // `geolibre-mapbox-<layerId>-<sourceLayer>-<kind>` for a layer this
        // engine compiled, and whatever a plugin named its own rows for one it
        // only adopted. Taking it from the id in both cases is what lets a
        // plugin that registered several native layers get a distinct name per
        // row, as MapLibre's `nativeLayerSuffix` does for the same case.
        const suffix = (id.startsWith(prefix) ? id.slice(prefix.length) : id).split("-").pop();
        entries.push([id, styleLayerLabel(layer, suffix, own.length)]);
      }
    }
    // Last, so this synthetic row always wins over a layer that happens to
    // share the id — the same ordering MapController uses.
    entries.push([BASEMAP_LABEL_KEY, this.backgroundLabel]);
    publishLayerLabels(entries);
  }
  /**
   * Apply a plugin-owned store layer's visibility and paint to the native
   * style layers its plugin registered under `metadata.nativeLayerIds` (the
   * Time Slider's and Timelapse's rasters, Mapillary's coverage lines, for
   * instance), the way MapLibre's layer-sync (`setExternalNativeLayerPaint`)
   * does: the whole paint object from the shared builders, so the Style
   * panel's colour/width/radius edits land and the store opacity scales the
   * style's own opacity instead of replacing it. Layers the plugin draws
   * outside the style (deck.gl overlays) have no such ids, or none the style
   * knows, and are left alone; so is paint when the control declares it owns
   * it (`metadata.controlOwnsPaint`).
   */
  private mirrorPluginLayerState(layer: GeoLibreLayer): void {
    const map = this.map;
    const ids = layer.metadata.nativeLayerIds;
    if (!map || !Array.isArray(ids)) return;
    const style = { ...DEFAULT_LAYER_STYLE, ...layer.style };
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const native = map.getLayer(id);
      if (!native) continue;
      const visibility = layer.visible ? "visible" : "none";
      if (map.getLayoutProperty(id, "visibility") !== visibility)
        map.setLayoutProperty(id, "visibility", visibility);
      // A control that paints its own layers (`controlOwnsPaint`), or renders
      // them outright from its own panel state (`customLayerType`, the
      // ordering-only path on MapLibre: Overture Maps), keeps its paint; the
      // store's opacity reaches it through the plugin's own store sync. A
      // story chapter's transient opacity is the one exception, applied (and
      // taken back) directly, as MapLibre's `setStoryLayerOpacity` does.
      if (layer.metadata.controlOwnsPaint === true || controlRendersLayer(layer)) {
        this.applyStoryOpacityToControlLayer(layer.id, id, native.type);
        continue;
      }
      const paint =
        native.type === "raster"
          ? rasterPaint(style, layer.opacity)
          : native.type === "fill"
            ? fillPaint(style, layer.opacity)
            : native.type === "line"
              ? linePaint(style, layer.opacity)
              : native.type === "circle"
                ? circlePaint(style, layer.opacity)
                : null;
      if (!paint) continue;
      for (const [property, value] of Object.entries(mapboxPaint(paint))) {
        if (value === undefined || value === null) continue;
        const key = property as keyof mapboxgl.AnyPaint;
        try {
          if (JSON.stringify(map.getPaintProperty(id, key)) !== JSON.stringify(value))
            map.setPaintProperty(id, key, value as mapboxgl.AnyPaint[keyof mapboxgl.AnyPaint]);
        } catch {
          // A control's native layers can be heterogeneous; skip a paint
          // property that does not apply to this one.
        }
      }
    }
  }
  /**
   * Replace a control-owned native layer's opacity with the active story
   * chapter's value, remembering the control's own paint the first time, and
   * put that paint back once the chapter opacity is cleared.
   */
  private applyStoryOpacityToControlLayer(layerId: string, nativeId: string, type: string): void {
    const map = this.map;
    if (!map) return;
    const story = this.storyOpacities.get(layerId);
    const props = STORY_OPACITY_PAINT_PROPERTIES[type] ?? [];
    const backups = this.storyPaintBackups.get(layerId);
    const saved = backups?.get(nativeId);
    if (story === undefined) {
      this.restoreControlLayerPaint(layerId, nativeId);
      return;
    }
    const backup = saved ?? new Map<string, unknown>();
    for (const prop of props) {
      const key = prop as keyof mapboxgl.AnyPaint;
      if (!backup.has(prop)) backup.set(prop, map.getPaintProperty(nativeId, key));
      try {
        if (map.getPaintProperty(nativeId, key) !== story)
          map.setPaintProperty(nativeId, key, story as never);
      } catch {
        // A property this native layer does not carry.
      }
    }
    if (!backups) this.storyPaintBackups.set(layerId, new Map([[nativeId, backup]]));
    else backups.set(nativeId, backup);
  }
  /**
   * Hand a control-owned native layer (or all of a store layer's) the paint it
   * carried before a story fade, and forget the snapshot.
   */
  private restoreControlLayerPaint(layerId: string, nativeId?: string): void {
    const map = this.map;
    const backups = this.storyPaintBackups.get(layerId);
    if (!backups) return;
    for (const [id, saved] of backups) {
      if (nativeId !== undefined && id !== nativeId) continue;
      if (map?.getLayer(id)) {
        for (const [prop, value] of saved) {
          try {
            map.setPaintProperty(id, prop as keyof mapboxgl.AnyPaint, value as never);
          } catch {
            // The control may have replaced the layer meanwhile; its own paint
            // then already applies.
          }
        }
      }
      backups.delete(id);
    }
    if (backups.size === 0) this.storyPaintBackups.delete(layerId);
  }
  private removeLayer(id: string, options: { preserveError?: boolean } = {}): void {
    const plan = this.plans.get(id),
      map = this.map;
    if (map && plan) {
      for (const spec of [...plan.layers].reverse())
        if (map.getLayer(spec.id)) map.removeLayer(spec.id);
      if (map.getSource(plan.sourceId)) map.removeSource(plan.sourceId);
      for (const id of Object.keys(plan.additionalSources ?? {})) {
        if (map.getSource(id)) map.removeSource(id);
      }
    }
    this.plans.delete(id);
    this.previous.delete(id);
    if (!options.preserveError) this.clearError(`layer:${id}`);
    if (plan) this.clearError(plan.sourceId);
    for (const id of Object.keys(plan?.additionalSources ?? {})) this.clearError(id);
  }
  waitAndSyncLayers(layers: GeoLibreLayer[]): void {
    this.syncLayers(layers);
  }
  async getLayerGeoJson(id: string): Promise<FeatureCollection | null> {
    return this.layers.find((l) => l.id === id)?.geojson ?? null;
  }
  getLayerRasterSource(id: string): Record<string, unknown> | null {
    const source = this.plans.get(id)?.source;
    return source?.type === "raster" || source?.type === "image" ? { ...source } : null;
  }
  setStyle(url: string): void {
    this.setResolvedStyle(url);
  }
  /** Accepts GeoLibre's expanded inline basemaps without persisting an engine-specific style. */
  setResolvedStyle(style: string | mapboxgl.StyleSpecification): void {
    const request = ++this.styleRequest;
    const apply = (prepared: string | mapboxgl.StyleSpecification) => {
      if (!this.map || request !== this.styleRequest) return;
      this.errors.clear();
      this.reportedDiagnosticKeys.clear();
      this.plans.clear();
      this.previous.clear();
      this.layerControlHost.remove();
      this.map.setStyle(prepared, {
        diff: false,
        localFontFamily: null,
        localIdeographFontFamily: "sans-serif",
      });
    };
    if (!isMapboxStandard(style)) {
      apply(style);
      return;
    }
    void prepareMapboxStandard(style, this.accessToken)
      .then(apply)
      .catch((error: unknown) => {
        if (this.map && request === this.styleRequest)
          this.onError({
            error: error instanceof Error ? error : new Error(String(error)),
          });
      });
  }
  getBasemapStyleLayerIds(): string[] {
    return this.basemap.map((s) => s.id);
  }
  setBasemapVisible(visible: boolean): void {
    this.basemapVisible = visible;
    this.applyBasemap();
    this.layerControlHost.syncState();
  }
  setBasemapOpacity(opacity: number): void {
    this.basemapOpacity = opacity;
    this.applyBasemap();
    this.layerControlHost.syncState();
  }
  private applyBasemap(): void {
    const map = this.map;
    if (!map?.isStyleLoaded()) {
      this.basemapPending = true;
      return;
    }
    this.basemapPending = false;
    for (const imported of map.getStyle()?.imports ?? []) {
      if (!imported.data?.schema?.[STANDARD_OPACITY]) continue;
      const opacity = this.basemapVisible ? this.basemapOpacity : 0;
      const color =
        this.blankColor ??
        (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff");
      if (map.getConfigProperty(imported.id, STANDARD_OPACITY) !== opacity)
        map.setConfigProperty(imported.id, STANDARD_OPACITY, opacity);
      if (map.getConfigProperty(imported.id, STANDARD_BLANK_COLOR) !== color)
        map.setConfigProperty(imported.id, STANDARD_BLANK_COLOR, color);
    }
    for (const spec of this.basemap) {
      if (!map.getLayer(spec.id)) continue;
      map.setLayoutProperty(
        spec.id,
        "visibility",
        this.basemapVisible ? (spec.layout?.visibility ?? "visible") : "none",
      );
      const props =
        spec.type === "symbol" ? ["text-opacity", "icon-opacity"] : [`${spec.type}-opacity`];
      if (
        [
          "background",
          "fill",
          "line",
          "circle",
          "symbol",
          "raster",
          "fill-extrusion",
          "heatmap",
        ].includes(spec.type)
      ) {
        for (const prop of props)
          map.setPaintProperty(
            spec.id,
            prop as keyof mapboxgl.AnyPaint,
            arcgisOpacity(
              (spec.paint as Record<string, unknown> | undefined)?.[prop],
              this.basemapOpacity,
            ) as mapboxgl.ExpressionSpecification | number,
          );
      }
    }
  }
  setBlankBackgroundColor(color: string | null): void {
    this.blankColor = color;
    this.applyBasemap();
    if (this.map?.getLayer(BLANK_BACKGROUND_LAYER_ID))
      this.map.setPaintProperty(
        BLANK_BACKGROUND_LAYER_ID,
        "background-color",
        color ?? (document.documentElement.classList.contains("dark") ? "#262626" : "#ffffff"),
      );
  }
  setStoryLayerOpacity(id: string, opacity: number): void {
    this.storyOpacities.set(id, opacity);
    this.syncLayers(this.layers);
  }
  restoreLayerStyles(): void {
    this.storyCameraToken++;
    if (this.pendingStoryRotate) {
      this.map?.off("moveend", this.pendingStoryRotate);
      this.pendingStoryRotate = null;
    }
    this.map?.stop();
    this.storyOpacities.clear();
    this.syncLayers(this.layers);
  }
  /** Style layer ids currently on the map that render `layer`. */
  private nativeLayerIds(layer: GeoLibreLayer): string[] {
    const map = this.map;
    return (this.plans.get(layer.id)?.layers ?? [])
      .map((spec) => spec.id)
      .filter((id) => Boolean(map?.getLayer(id)));
  }
  identifyFeatures(lngLat: [number, number], layerId?: string): IdentifiedFeature[] {
    const map = this.map;
    if (!map?.isStyleLoaded()) return [];
    const ids = [...this.plans]
      .filter(([id]) => !layerId || id === layerId)
      .flatMap(([id, p]) => p.layers.map((s) => ({ id: s.id, layerId: id })));
    const byId = new Map(ids.map((s) => [s.id, s.layerId]));
    const queryIds = ids.map((s) => s.id).filter((id) => map.getLayer(id));
    if (!queryIds.length) return [];
    const seen = new Set<string>();
    return map.queryRenderedFeatures(map.project(lngLat), { layers: queryIds }).flatMap((f) => {
      const id = byId.get(f.layer?.id ?? "")!;
      const featureId = this.featureIdForLayer(id, f.id);
      const key = `${id}:${featureId ?? JSON.stringify(f.properties)}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          layerId: id,
          featureId,
          properties: f.properties ?? {},
          geometry: f.geometry,
        },
      ];
    });
  }
  /** Resolve the top rendered feature at a screen point to GeoLibre's stable id. */
  featureIdAtPoint(layerId: string, point: { x: number; y: number }): string | null {
    const map = this.map;
    if (!map?.isStyleLoaded()) return null;
    const layer = this.layers.find((candidate) => candidate.id === layerId);
    const queryIds = layer ? this.nativeLayerIds(layer) : [];
    if (!queryIds.length) return null;
    const [feature] = map.queryRenderedFeatures(
      [
        [point.x - 4, point.y - 4],
        [point.x + 4, point.y + 4],
      ],
      { layers: queryIds },
    );
    return feature ? this.featureIdForLayer(layerId, feature.id) : null;
  }
  /**
   * Resolve a queried feature's id to the app's `String(feature.id ?? index)`
   * identity. GeoJSON sources are compiled with `generateId`, so Mapbox reports
   * the feature's index in the source data and overwrites any authored id; map
   * it back through the layer's own GeoJSON so selection and highlighting key
   * on the same value as the attribute table.
   */
  private featureIdForLayer(layerId: string, queried: string | number | undefined): string | null {
    if (queried == null) return null;
    const features = this.layers.find((l) => l.id === layerId)?.geojson?.features;
    if (!features) return String(queried);
    const index = Number(queried);
    const feature = Number.isInteger(index) ? features[index] : undefined;
    return feature ? String(feature.id ?? index) : String(queried);
  }
  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { fit?: boolean },
  ): void {
    this.clearFeatureHighlight();
    if (!layer?.geojson || featureId === null || !this.map?.isStyleLoaded()) return;
    const ids = new Set(Array.isArray(featureId) ? featureId : [featureId]);
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: layer.geojson.features.filter((f, i) => ids.has(String(f.id ?? i))),
    };
    this.map.addSource(HIGHLIGHT_SOURCE_ID, { type: "geojson", data });
    this.map.addLayer({
      id: HIGHLIGHT_LAYER_IDS[0],
      type: "fill",
      source: HIGHLIGHT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": "#facc15", "fill-opacity": 0.25 },
    });
    this.map.addLayer({
      id: HIGHLIGHT_LAYER_IDS[1],
      type: "line",
      source: HIGHLIGHT_SOURCE_ID,
      paint: { "line-color": "#facc15", "line-width": 4 },
    });
    this.map.addLayer({
      id: HIGHLIGHT_LAYER_IDS[2],
      type: "circle",
      source: HIGHLIGHT_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 10,
        "circle-color": "#facc15",
        "circle-opacity": 0.6,
      },
    });
    if (options?.fit) this.fitLayer({ ...layer, geojson: data });
  }
  clearFeatureHighlight(): void {
    for (const id of HIGHLIGHT_LAYER_IDS) if (this.map?.getLayer(id)) this.map.removeLayer(id);
    if (this.map?.getSource(HIGHLIGHT_SOURCE_ID)) this.map.removeSource(HIGHLIGHT_SOURCE_ID);
  }
  startManualPlacement(lngLat: [number, number], options: ManualPlacementOptions): () => void {
    if (!this.map) return () => {};
    const marker = new this.gl.Marker({ draggable: true }).setLngLat(lngLat).addTo(this.map);
    const content = document.createElement("div");
    const hint = document.createElement("p");
    hint.textContent = options.hint;
    const button = document.createElement("button");
    button.textContent = options.doneLabel;
    content.append(hint, button);
    marker.setPopup(new this.gl.Popup().setDOMContent(content)).togglePopup();
    marker.on("dragend", () => options.onMove(marker.getLngLat().toArray()));
    const dispose = () => {
      marker.remove();
      this.disposers.delete(dispose);
    };
    button.onclick = () => {
      options.onMove(marker.getLngLat().toArray());
      dispose();
      options.onDone?.();
    };
    this.disposers.add(dispose);
    return dispose;
  }
  drawExtent(options: ExtentDrawingOptions): () => void {
    const map = this.map;
    if (!map) return () => {};
    const stop = drawExtentOnCanvas(
      map.getCanvas(),
      (p) => map.unproject([p.x, p.y]).toArray(),
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
    const b = this.map?.getBounds();
    return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
  }
  showSearchResult(geometry: Point | Polygon): () => void {
    const map = this.map;
    if (!map) return () => {};
    return showGlSearchResult(
      map,
      geometry,
      (center, color) => new this.gl.Marker({ color }).setLngLat(center).addTo(map),
      this.disposers,
    );
  }

  showExtent(extent: MapExtent): () => void {
    const map = this.map;
    if (!map?.isStyleLoaded()) return () => {};
    const id = `geolibre-mapbox-extent-${crypto.randomUUID()}`;
    const [w, s, e, n] = extent;
    map.addSource(id, {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        },
      },
    });
    map.addLayer({
      id,
      type: "line",
      source: id,
      paint: { "line-color": "#f59e0b", "line-width": 3 },
    });
    const dispose = () => {
      if (this.map?.getLayer(id)) this.map.removeLayer(id);
      if (this.map?.getSource(id)) this.map.removeSource(id);
      this.disposers.delete(dispose);
    };
    this.disposers.add(dispose);
    return dispose;
  }
  getRenderSurface(): MapRenderSurface | null {
    return this.surface;
  }
  getRenderStatus(): { pending: string[]; errors: string[] } {
    return {
      pending: !this.map?.loaded() || !this.map.areTilesLoaded() ? ["Mapbox map loading"] : [],
      errors: [...this.errors.values()],
    };
  }
  captureImage(): Promise<Blob> {
    return captureEngineImage(this);
  }
  isCameraMoving(): boolean {
    return this.map?.isMoving() ?? false;
  }
  onCameraMove(listener: () => void): () => void {
    const map = this.map;
    map?.on("move", listener);
    return () => {
      map?.off("move", listener);
    };
  }
  onCameraIdle(listener: (event?: CameraIdleEvent) => void): () => void {
    const map = this.map;
    const onMoveEnd = (event: mapboxgl.MapEventOf<"moveend"> & { storyCameraToken?: number }) =>
      listener({ storyCamera: event?.storyCameraToken !== undefined });
    map?.on("moveend", onMoveEnd);
    return () => {
      map?.off("moveend", onMoveEnd);
    };
  }
  stopCamera(): void {
    this.storyCameraToken++;
    if (this.pendingStoryRotate) {
      this.map?.off("moveend", this.pendingStoryRotate);
      this.pendingStoryRotate = null;
    }
    this.map?.stop();
  }
  suspendNavigation(): () => void {
    const map = this.map;
    if (!map) return () => {};
    const enabled = [
      map.boxZoom,
      map.doubleClickZoom,
      map.dragPan,
      map.dragRotate,
      map.keyboard,
      map.scrollZoom,
      map.touchZoomRotate,
      map.touchPitch,
    ].filter((h) => h.isEnabled());
    for (const handler of enabled) handler.disable();
    return () => {
      if (this.map) for (const handler of enabled) handler.enable();
    };
  }
  addControl(
    control: maplibregl.IControl,
    position: maplibregl.ControlPosition = "top-right",
  ): boolean {
    if (!this.map) return false;
    if (this.pluginControls.has(control)) return true;
    // Only plugins declaring Mapbox support should mount; the vector importer
    // additionally uses its store-only source bridge.
    const adapter = this.adaptControl(control);
    this.map.addControl(adapter, position);
    this.pluginControls.set(control, adapter);
    return true;
  }
  /**
   * Wrap a MapLibre-typed control for a mapbox-gl map. IControl's lifecycle is
   * shared, but its TypeScript Map parameter is engine-specific, and the DOM
   * conventions differ in two ways the wrapper papers over.
   */
  private adaptControl(control: maplibregl.IControl): mapboxgl.IControl {
    return {
      onAdd: (map) => {
        // DOM controls locate their corner by MapLibre's CSS class names.
        // Without these aliases a top-left panel assumes top-right and opens
        // outside the map, underneath the Layers sidebar.
        for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
          map
            .getContainer()
            .querySelector(`.mapboxgl-ctrl-${corner}`)
            ?.classList.add(`maplibregl-ctrl-${corner}`);
        }
        const element = control.onAdd(map as unknown as maplibregl.Map);
        element.classList.add("mapboxgl-ctrl");
        return element;
      },
      onRemove: (map) => control.onRemove(map as unknown as maplibregl.Map),
    };
  }
  removeControl(control: maplibregl.IControl): void {
    const adapter = this.pluginControls.get(control);
    if (adapter && this.map?.hasControl(adapter)) this.map.removeControl(adapter);
    this.pluginControls.delete(control);
  }
  /** Build the native or shared control behind a built-in id, or null when Mapbox cannot host it. */
  private createBuiltInControl(id: BuiltInMapControl): mapboxgl.IControl | null {
    const gl = this.gl;
    switch (id) {
      case "navigation":
        return new gl.NavigationControl();
      case "fullscreen":
        // Fullscreens the map container, as on MapLibre; the app hides the
        // surrounding chrome while fullscreen is active.
        return new gl.FullscreenControl();
      case "compass": {
        const control = new ResetBearingControl(
          this.compassLabel === undefined ? {} : { label: this.compassLabel },
        );
        this.compassControl = control;
        return this.adaptControl(control);
      }
      case "geolocate":
        return new gl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
        });
      case "globe": {
        const control = new MapboxGlobeControl();
        this.globeControl = control;
        return control;
      }
      case "scale": {
        const control = new gl.ScaleControl({
          maxWidth: 120,
          unit: this.preferences?.scaleUnit ?? "metric",
        });
        this.scaleControl = control;
        return control;
      }
      case "attribution":
        return new gl.AttributionControl();
      default:
        return null;
    }
  }
  private mountBuiltInControl(id: BuiltInMapControl): void {
    if (!this.map || this.builtInControls.has(id)) return;
    const control = this.createBuiltInControl(id);
    if (!control) return;
    this.map.addControl(control, this.controlPositions[id]);
    this.builtInControls.set(id, control);
  }
  private unmountBuiltInControl(id: BuiltInMapControl): void {
    const control = this.builtInControls.get(id);
    if (!control) return;
    if (this.map?.hasControl(control)) this.map.removeControl(control);
    this.builtInControls.delete(id);
    if (id === "compass") this.compassControl = null;
    else if (id === "globe") this.globeControl = null;
    else if (id === "scale") this.scaleControl = null;
  }
  setBuiltInControlVisible(id: BuiltInMapControl, visible: boolean): boolean {
    if (!this.map) return false;
    if (id === "layer-control") {
      this.layerControlVisible = visible;
      if (visible) this.layerControlHost.add();
      else this.layerControlHost.remove();
      return true;
    }
    // Terrain has no button here; the menu and project restore still reach
    // the scene setting, as they do on Cesium.
    if (id === "terrain") {
      this.controlVisibility.terrain = visible;
      this.setTerrainEnabled(visible);
      return true;
    }
    if (!MAPBOX_HOSTED_CONTROLS.has(id)) return false;
    // Attribution is required by Mapbox; keep its native control present.
    if (id === "attribution" && !visible) return false;
    this.controlVisibility[id] = visible;
    if (visible) this.mountBuiltInControl(id);
    else this.unmountBuiltInControl(id);
    return true;
  }
  getBuiltInControlPosition(id: BuiltInMapControl): maplibregl.ControlPosition {
    if (id === "layer-control") return this.layerControlHost.getPosition();
    return this.controlPositions[id];
  }
  setBuiltInControlPosition(id: BuiltInMapControl, position: maplibregl.ControlPosition): boolean {
    if (!this.map) return false;
    if (id === "layer-control") {
      this.layerControlHost.setPosition(position);
      return true;
    }
    if (!MAPBOX_HOSTED_CONTROLS.has(id)) return false;
    this.controlPositions[id] = position;
    if (this.builtInControls.has(id)) {
      // Re-mount so the control lands in its new corner (and, as on MapLibre,
      // at the end of that corner's stack).
      this.unmountBuiltInControl(id);
      this.mountBuiltInControl(id);
    }
    return true;
  }
  setCompassLabel(label: string): void {
    // Cached so a compass re-added from the Controls menu picks up the latest
    // translation without another call.
    this.compassLabel = label;
    this.compassControl?.setLabel(label);
  }
  setBackgroundLabel(label: string): void {
    // Kept, not ignored: the swipe panel groups every basemap style layer under
    // one row and reads its name from the label bridge, so the translated
    // "Background" has to reach it here as it does on MapLibre.
    this.backgroundLabel = label;
    this.publishLayerDisplayNames(this.layers);
  }
  setTerrainLabel(_label: string): void {}
  isTerrainEnabled(): boolean {
    return this.terrain;
  }
  setTerrainEnabled(enabled: boolean): boolean {
    this.terrain = enabled;
    const map = this.map;
    if (!map?.isStyleLoaded()) return false;
    if (enabled && !map.getSource("geolibre-mapbox-dem"))
      map.addSource("geolibre-mapbox-dem", {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      });
    map.setTerrain(
      enabled ? { source: "geolibre-mapbox-dem", exaggeration: this.exaggeration } : null,
    );
    return true;
  }
  getTerrainExaggeration(): number {
    return this.exaggeration;
  }
  setTerrainExaggeration(value: number): void {
    this.exaggeration = Math.max(0, Math.min(10, value));
    this.setTerrainEnabled(this.terrain);
  }
  getTerrainCogSource(): null {
    return null;
  }
  hasCustomTerrainSource(): boolean {
    return false;
  }
  async setTerrainCogSource(source: string | Blob | null): Promise<boolean> {
    return source === null;
  }
}
