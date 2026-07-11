import type {
  GeoJSONSource,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { Feature, LineString, Point } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  type LngLat,
  measureLine,
  pointAlongLine,
  sliceLineAtDistance,
} from "./route-animation-geometry";

/**
 * GeoLibre route-animation plugin.
 *
 * Animates a marker along any line layer already loaded in the project — the
 * GeoLibre take on MapLibre's "update a feature in realtime" example. A floating
 * panel (rendered by the desktop shell) picks the line layer and drives play /
 * pause / speed / loop, plus optional camera-follow, heading rotation, and a
 * growing trail. The marker, trail, and the arrow icon are native MapLibre
 * sources/layers the engine owns directly (like the sun simulation), updated via
 * `GeoJSONSource.setData` every animation frame. The route geometry itself is
 * resolved by the panel (it has store + map access) and handed to the engine via
 * {@link setRouteAnimationRoute}; only the lightweight settings persist with the
 * project, so a saved file reopens on the same layer without embedding geometry.
 */

export const ROUTE_ANIMATION_PLUGIN_ID = "geolibre-route-animation";

const MARKER_SOURCE_ID = "geolibre-route-anim-marker-source";
const MARKER_LAYER_ID = "geolibre-route-anim-marker-layer";
const POINT_LAYER_ID = "geolibre-route-anim-point-layer";
const TRAIL_SOURCE_ID = "geolibre-route-anim-trail-source";
const TRAIL_LAYER_ID = "geolibre-route-anim-trail-layer";
const ARROW_ICON_ID = "geolibre-route-anim-arrow";

/**
 * How the moving position is drawn:
 * - `arrow` — a chevron that rotates to point along the direction of travel;
 * - `point` — a plain circle (no rotation), for when heading is ambiguous;
 * - `none`  — nothing (useful with a trail and/or camera follow only).
 */
export type RouteMarkerStyle = "arrow" | "point" | "none";

export const ROUTE_MARKER_STYLES: readonly RouteMarkerStyle[] = [
  "arrow",
  "point",
  "none",
] as const;

/** Persisted, user-tunable state of the route animation. */
export interface RouteAnimationSettings {
  /** Id of the store line layer the marker follows, or null when unset. */
  layerId: string | null;
  /** Whether the marker is animating forward. */
  playing: boolean;
  /** Ground speed of the marker in meters per real second of playback. */
  speedMps: number;
  /** When true, playback wraps to the start instead of stopping at the end. */
  loop: boolean;
  /** Fraction of the route traversed, in `[0, 1]`. */
  progress: number;
  /** When true, the camera pans to keep the marker centered (stays north-up). */
  followCamera: boolean;
  /** Which marker to draw at the moving position. */
  markerStyle: RouteMarkerStyle;
  /** When true, a line is drawn over the portion of the route already traveled. */
  showTrail: boolean;
  /** Hex color (`#rgb`/`#rrggbb`) of the marker and trail. */
  color: string;
}

const DEFAULT_COLOR = "#2563eb";
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const ROUTE_ANIM_SPEED_MIN = 1;
export const ROUTE_ANIM_SPEED_MAX = 1000;

export const DEFAULT_ROUTE_ANIMATION_SETTINGS: RouteAnimationSettings = {
  layerId: null,
  playing: false,
  speedMps: 60,
  loop: true,
  progress: 0,
  followCamera: false,
  markerStyle: "arrow",
  showTrail: true,
  color: DEFAULT_COLOR,
};

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into complete settings. */
export function normalizeRouteAnimationSettings(
  value: unknown,
  base: RouteAnimationSettings = DEFAULT_ROUTE_ANIMATION_SETTINGS,
): RouteAnimationSettings {
  const c = (value ?? {}) as Partial<RouteAnimationSettings>;
  return {
    layerId:
      typeof c.layerId === "string" && c.layerId.length > 0
        ? c.layerId
        : base.layerId,
    playing: typeof c.playing === "boolean" ? c.playing : base.playing,
    speedMps: clampNumber(
      c.speedMps,
      ROUTE_ANIM_SPEED_MIN,
      ROUTE_ANIM_SPEED_MAX,
      base.speedMps,
    ),
    loop: typeof c.loop === "boolean" ? c.loop : base.loop,
    progress: clampNumber(c.progress, 0, 1, base.progress),
    followCamera:
      typeof c.followCamera === "boolean" ? c.followCamera : base.followCamera,
    markerStyle: ROUTE_MARKER_STYLES.includes(c.markerStyle as RouteMarkerStyle)
      ? (c.markerStyle as RouteMarkerStyle)
      : base.markerStyle,
    showTrail: typeof c.showTrail === "boolean" ? c.showTrail : base.showTrail,
    color:
      typeof c.color === "string" && HEX_COLOR.test(c.color)
        ? c.color
        : base.color,
  };
}

function settingsEqual(
  a: RouteAnimationSettings,
  b: RouteAnimationSettings,
): boolean {
  return (
    a.layerId === b.layerId &&
    a.playing === b.playing &&
    a.speedMps === b.speedMps &&
    a.loop === b.loop &&
    a.progress === b.progress &&
    a.followCamera === b.followCamera &&
    a.markerStyle === b.markerStyle &&
    a.showTrail === b.showTrail &&
    a.color === b.color
  );
}

function isDefaultSettings(value: RouteAnimationSettings): boolean {
  return settingsEqual(value, DEFAULT_ROUTE_ANIMATION_SETTINGS);
}

// ---------------------------------------------------------------------------
// Arrow icon: a small upward-pointing triangle drawn to a canvas once, so the
// marker needs no bundled image asset. `icon-rotate` spins it to the heading.
// ---------------------------------------------------------------------------

const ARROW_SIZE = 48;

function createArrowIcon(color: string): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = ARROW_SIZE;
  canvas.height = ARROW_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const c = ARROW_SIZE / 2;
  ctx.beginPath();
  // Triangle pointing up (north); bearing 0 = north, so no rotation = travel up.
  ctx.moveTo(c, 4);
  ctx.lineTo(ARROW_SIZE - 8, ARROW_SIZE - 8);
  ctx.lineTo(c, ARROW_SIZE - 16);
  ctx.lineTo(8, ARROW_SIZE - 8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  return ctx.getImageData(0, 0, ARROW_SIZE, ARROW_SIZE);
}

// ---------------------------------------------------------------------------
// Map engine: owns the marker/trail sources and layers and the animation loop.
// ---------------------------------------------------------------------------

class RouteAnimationEngine {
  private readonly map: MapLibreMap;
  private settings: RouteAnimationSettings;
  private coords: LngLat[] = [];
  private cumulative: number[] = [];
  private totalMeters = 0;
  private rafId: number | null = null;
  private lastFrame: number | null = null;
  private destroyed = false;
  // Color the arrow icon was last drawn with, so we only redraw on change.
  private iconColor = "";

  constructor(
    map: MapLibreMap,
    settings: RouteAnimationSettings,
    coords: LngLat[],
  ) {
    this.map = map;
    this.settings = settings;
    this.handleStyleData = this.handleStyleData.bind(this);
    this.tick = this.tick.bind(this);
    map.on("styledata", this.handleStyleData);
    // setRoute() starts the animation loop itself when settings.playing and the
    // route has length, so no extra play() call is needed here.
    this.setRoute(coords);
  }

  getMapInstance(): MapLibreMap {
    return this.map;
  }

  /** Replace the route the marker follows and re-render at the current progress. */
  setRoute(coords: LngLat[]): void {
    this.coords = coords;
    const { cumulative, totalMeters } = measureLine(coords);
    this.cumulative = cumulative;
    this.totalMeters = totalMeters;
    this.ensureLayers();
    this.render();
    // A route with no length can't be animated; stop any running loop.
    if (this.totalMeters <= 0) this.pause();
    else if (this.settings.playing && this.rafId === null) this.play();
  }

  applySettings(settings: RouteAnimationSettings): void {
    const wasPlaying = this.settings.playing;
    this.settings = settings;
    this.updateLayerProps();
    this.render();
    if (settings.playing && !wasPlaying && this.totalMeters > 0) this.play();
    else if (!settings.playing && wasPlaying) this.pause();
  }

  /**
   * Fast per-frame path: adopt a new progress and redraw the marker/trail
   * without the play/pause or layout reconciliation that {@link applySettings}
   * does. Keeps the engine's settings in sync with the store during playback.
   */
  applyProgress(progress: number): void {
    this.settings = { ...this.settings, progress };
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.map.off("styledata", this.handleStyleData);
    this.removeLayers();
  }

  // A basemap style swap wipes custom layers/images; re-add on next styledata.
  private handleStyleData(): void {
    if (this.destroyed) return;
    if (!this.map.getSource(MARKER_SOURCE_ID)) {
      this.ensureLayers();
      this.render();
    }
  }

  private ensureLayers(): void {
    // Adding sources/layers before the style is ready throws; the styledata
    // handler re-runs this the moment the style finishes loading.
    if (!this.map.isStyleLoaded()) return;

    if (!this.map.hasImage(ARROW_ICON_ID)) {
      const icon = createArrowIcon(this.settings.color);
      if (icon) {
        this.map.addImage(ARROW_ICON_ID, icon, { pixelRatio: 2 });
        this.iconColor = this.settings.color;
      }
    }

    if (!this.map.getSource(TRAIL_SOURCE_ID)) {
      this.map.addSource(TRAIL_SOURCE_ID, {
        type: "geojson",
        data: emptyLine(),
      });
    }
    if (!this.map.getLayer(TRAIL_LAYER_ID)) {
      this.map.addLayer({
        id: TRAIL_LAYER_ID,
        type: "line",
        source: TRAIL_SOURCE_ID,
        // Mark as internal "chrome" so it stays out of the Layer Control list.
        metadata: { "geolibre:internal": true },
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": this.settings.color,
          "line-width": 4,
          "line-opacity": 0.85,
        },
      });
    }

    if (!this.map.getSource(MARKER_SOURCE_ID)) {
      this.map.addSource(MARKER_SOURCE_ID, {
        type: "geojson",
        data: markerFeature([0, 0], 0),
      });
    }
    // Circle marker (the "point" style), drawn below the arrow.
    if (!this.map.getLayer(POINT_LAYER_ID)) {
      this.map.addLayer({
        id: POINT_LAYER_ID,
        type: "circle",
        source: MARKER_SOURCE_ID,
        metadata: { "geolibre:internal": true },
        paint: {
          "circle-radius": 4,
          "circle-color": this.settings.color,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });
    }
    // Arrow marker (the "arrow" style): a chevron rotated to the heading.
    if (!this.map.getLayer(MARKER_LAYER_ID)) {
      this.map.addLayer({
        id: MARKER_LAYER_ID,
        type: "symbol",
        source: MARKER_SOURCE_ID,
        metadata: { "geolibre:internal": true },
        layout: {
          "icon-image": ARROW_ICON_ID,
          "icon-size": 0.6,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
    }
    this.updateLayerProps();
  }

  private updateLayerProps(): void {
    const style = this.settings.markerStyle;
    if (this.map.getLayer(MARKER_LAYER_ID)) {
      this.map.setLayoutProperty(
        MARKER_LAYER_ID,
        "visibility",
        style === "arrow" ? "visible" : "none",
      );
    }
    if (this.map.getLayer(POINT_LAYER_ID)) {
      this.map.setLayoutProperty(
        POINT_LAYER_ID,
        "visibility",
        style === "point" ? "visible" : "none",
      );
    }
    if (this.map.getLayer(TRAIL_LAYER_ID)) {
      this.map.setLayoutProperty(
        TRAIL_LAYER_ID,
        "visibility",
        this.settings.showTrail ? "visible" : "none",
      );
    }
    this.applyColor();
  }

  /** Recolor the trail, point, and arrow marker to the current color. */
  private applyColor(): void {
    const color = this.settings.color;
    if (this.map.getLayer(TRAIL_LAYER_ID)) {
      this.map.setPaintProperty(TRAIL_LAYER_ID, "line-color", color);
    }
    if (this.map.getLayer(POINT_LAYER_ID)) {
      this.map.setPaintProperty(POINT_LAYER_ID, "circle-color", color);
    }
    // The arrow is a raster icon, so recolor means redrawing the image.
    if (this.iconColor !== color && this.map.hasImage(ARROW_ICON_ID)) {
      const icon = createArrowIcon(color);
      if (icon) {
        this.map.updateImage(ARROW_ICON_ID, icon);
        this.iconColor = color;
      }
    }
  }

  private removeLayers(): void {
    if (this.map.getLayer(MARKER_LAYER_ID)) this.map.removeLayer(MARKER_LAYER_ID);
    if (this.map.getLayer(POINT_LAYER_ID)) this.map.removeLayer(POINT_LAYER_ID);
    if (this.map.getLayer(TRAIL_LAYER_ID)) this.map.removeLayer(TRAIL_LAYER_ID);
    if (this.map.getSource(MARKER_SOURCE_ID)) {
      this.map.removeSource(MARKER_SOURCE_ID);
    }
    if (this.map.getSource(TRAIL_SOURCE_ID)) {
      this.map.removeSource(TRAIL_SOURCE_ID);
    }
    // Drop the generated arrow sprite too, so teardown leaves no leftover state.
    if (this.map.hasImage(ARROW_ICON_ID)) {
      this.map.removeImage(ARROW_ICON_ID);
      this.iconColor = "";
    }
  }

  /** Draw the marker (and trail) at the current progress; optionally follow. */
  render(): void {
    if (this.destroyed) return;
    const markerSource = this.map.getSource(MARKER_SOURCE_ID) as
      | GeoJSONSource
      | undefined;
    const trailSource = this.map.getSource(TRAIL_SOURCE_ID) as
      | GeoJSONSource
      | undefined;

    // No animatable route: actively clear the marker/trail so a stale or
    // placeholder feature (e.g. the initial [0, 0] point) never lingers on the
    // map before a layer is picked or after the selected layer is removed.
    if (this.totalMeters <= 0) {
      markerSource?.setData({ type: "FeatureCollection", features: [] });
      trailSource?.setData(emptyLine());
      return;
    }
    if (!markerSource) return;

    const distance = this.settings.progress * this.totalMeters;
    const { coord, bearing } = pointAlongLine(
      this.coords,
      this.cumulative,
      distance,
    );
    markerSource.setData(markerFeature(coord, bearing));

    if (this.settings.showTrail) {
      trailSource?.setData(
        lineFeature(sliceLineAtDistance(this.coords, this.cumulative, distance)),
      );
    }

    if (this.settings.followCamera) {
      // Recenter only, keeping the map north-up. Rotating the map to the heading
      // makes an arrow marker (aligned to the map) look like it never turns.
      this.map.jumpTo({ center: coord });
    }
  }

  play(): void {
    if (this.destroyed || this.rafId !== null || this.totalMeters <= 0) return;
    this.lastFrame = null;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrame = null;
  }

  private tick(now: number): void {
    this.rafId = null;
    if (this.destroyed || !this.settings.playing || this.totalMeters <= 0) return;
    if (this.lastFrame !== null) {
      // Cap the delta so a long stall (backgrounded/minimized tab pauses rAF)
      // resumes smoothly instead of making the marker jump far ahead.
      const elapsedSec = Math.min(0.25, (now - this.lastFrame) / 1000);
      const advanced =
        (elapsedSec * this.settings.speedMps) / this.totalMeters;
      advanceRouteProgress(advanced);
    }
    this.lastFrame = now;
    // advanceRouteProgress may have paused playback at the end of the route.
    if (this.settings.playing) {
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }
}

function markerFeature(coord: LngLat, bearing: number): Feature<Point> {
  return {
    type: "Feature",
    properties: { bearing },
    geometry: { type: "Point", coordinates: [coord[0], coord[1]] },
  };
}

function lineFeature(coords: LngLat[]): Feature<LineString> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  };
}

function emptyLine(): Feature<LineString> {
  return lineFeature([]);
}

// ---------------------------------------------------------------------------
// Module store: single source of truth shared by the engine and the React panel.
// ---------------------------------------------------------------------------

let engine: RouteAnimationEngine | null = null;
let panelVisible = false;
let settings: RouteAnimationSettings = { ...DEFAULT_ROUTE_ANIMATION_SETTINGS };
// The resolved route geometry lives here (not in settings): it is large and
// re-derivable from `layerId`, so the panel re-resolves it rather than the
// project embedding it. Re-applied whenever the engine (re)attaches to a map.
let routeCoords: LngLat[] = [];

const panelListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function notifyPanel(): void {
  for (const listener of panelListeners) listener();
}
function notifyState(): void {
  for (const listener of stateListeners) listener();
}

function attachEngine(app: GeoLibreAppAPI): boolean {
  const map = app.getMap?.();
  if (!map) return false;
  if (engine && engine.getMapInstance() !== map) detachEngine();
  if (!engine) engine = new RouteAnimationEngine(map, settings, routeCoords);
  return true;
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
}

/** Open the route-animation panel and attach the marker engine. Idempotent. */
export function openRouteAnimationPanel(app: GeoLibreAppAPI): void {
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  attachEngine(app);
}

/** Close the panel, stop the animation, and remove the marker/trail. */
export function closeRouteAnimationPanel(_app?: GeoLibreAppAPI): void {
  if (settings.playing) {
    settings = { ...settings, playing: false };
  }
  detachEngine();
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
    notifyState();
  }
}

export function isRouteAnimationPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeRouteAnimationPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/** Current settings (a copy callers may freely read). */
export function getRouteAnimationSettings(): RouteAnimationSettings {
  return { ...settings };
}

/**
 * Stable settings reference for `useSyncExternalStore`. `settings` is replaced
 * immutably on every change, so the identity is constant between changes.
 */
export function getRouteAnimationSnapshot(): RouteAnimationSettings {
  return settings;
}

export function subscribeRouteAnimation(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Apply a partial settings change: normalize, push to the engine, and notify
 * subscribers. Returns true when something actually changed.
 */
export function setRouteAnimationSettings(
  next: Partial<RouteAnimationSettings>,
): boolean {
  const normalized = normalizeRouteAnimationSettings(
    { ...settings, ...next },
    DEFAULT_ROUTE_ANIMATION_SETTINGS,
  );
  if (settingsEqual(normalized, settings)) return false;
  settings = normalized;
  engine?.applySettings(settings);
  notifyState();
  return true;
}

/** Convenience toggle for the play/pause button. */
export function toggleRouteAnimationPlaying(): void {
  // Pressing Play after a non-looping route has finished restarts from the top,
  // otherwise playback would immediately re-stop at the end and appear to do
  // nothing.
  const restart = !settings.playing && settings.progress >= 1;
  setRouteAnimationSettings({
    playing: !settings.playing,
    progress: restart ? 0 : settings.progress,
  });
}

/**
 * Scrub to an absolute progress in `[0, 1]` (used by the panel slider). Uses the
 * engine's lightweight `applyProgress` path rather than the full `applySettings`
 * reconciliation, so dragging the slider only re-renders the marker/trail
 * instead of re-running layout/paint updates on every tick.
 */
export function setRouteAnimationProgress(progress: number): void {
  const clamped = Math.max(0, Math.min(1, progress));
  if (!Number.isFinite(clamped) || clamped === settings.progress) return;
  settings = { ...settings, progress: clamped };
  engine?.applyProgress(clamped);
  notifyState();
}

/**
 * Hand the engine the geometry of the currently selected line layer. Called by
 * the panel, which has the store/map access needed to resolve a layer to
 * coordinates.
 *
 * This does NOT touch progress: the panel resets progress to 0 when the user
 * picks a different layer, and a project load restores its saved progress. So a
 * plain re-resolution (e.g. an unrelated layer edit re-running the panel effect)
 * or a load must never snap a running/restored animation back to the start. When
 * the coordinates are unchanged the engine already holds them, so it is a no-op.
 */
export function setRouteAnimationRoute(coords: LngLat[]): void {
  const unchanged =
    coords.length === routeCoords.length &&
    coords.every(
      (c, i) => c[0] === routeCoords[i][0] && c[1] === routeCoords[i][1],
    );
  routeCoords = coords;
  if (unchanged) return;
  engine?.setRoute(coords);
  // If the route can no longer be animated (e.g. the selected layer was deleted),
  // clear `playing` so the panel doesn't keep showing a disabled Pause button.
  // Sync the engine too, otherwise its stale `this.settings.playing === true`
  // would auto-start the loop the next time a valid route is set.
  if (coords.length < 2 && settings.playing) {
    settings = { ...settings, playing: false };
    engine?.applySettings(settings);
    notifyState();
  }
}

/**
 * Advance progress by `delta` (fraction of the route), honoring loop. Called by
 * the engine's animation loop each frame; stops at the end when not looping.
 */
export function advanceRouteProgress(delta: number): void {
  let next = settings.progress + delta;
  if (next >= 1) {
    if (settings.loop) {
      next = next % 1;
    } else {
      settings = { ...settings, progress: 1, playing: false };
      engine?.applySettings(settings);
      notifyState();
      return;
    }
  }
  settings = { ...settings, progress: next };
  engine?.applyProgress(next);
  notifyState();
}

/**
 * Apply a saved project's route-animation state: adopt its settings and open or
 * close the panel to match the persisted `open` flag. Playback never auto-starts
 * on load. The panel re-resolves the route geometry from `layerId`. Mirrors the
 * sun plugin's restore path; the only place allowed to change open/closed state
 * from stored data.
 */
export function restoreRouteAnimation(
  app: GeoLibreAppAPI,
  state?: unknown,
): boolean {
  const next = normalizeRouteAnimationSettings(state, {
    ...DEFAULT_ROUTE_ANIMATION_SETTINGS,
  });
  next.playing = false;
  // Drop the previous project's geometry so nothing draws a stale route while the
  // panel re-resolves it from `layerId`. Clear both the module cache and any live
  // engine: an already-open panel keeps its engine (attachEngine only rebuilds on
  // a map change), so without this it would keep rendering the old route.
  routeCoords = [];
  engine?.setRoute([]);
  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  let changed = false;
  if (!settingsEqual(next, settings)) {
    settings = next;
    notifyState();
    changed = true;
  }
  // Push the restored settings into an already-attached engine (panel open on
  // the same map, so attachEngine below is a no-op): otherwise the marker/trail
  // keep the previous project's color/markerStyle/speed/playing until the user
  // touches a control. A fresh engine picks these up via its constructor.
  engine?.applySettings(settings);
  const wasVisible = panelVisible;
  if (shouldOpen) openRouteAnimationPanel(app);
  else closeRouteAnimationPanel(app);
  return changed || panelVisible !== wasVisible;
}

/**
 * Re-bind the engine to the current map without touching open/closed state.
 * Called after a map re-init or basemap change; must never reset the panel.
 */
export function reattachRouteAnimation(app: GeoLibreAppAPI): void {
  if (panelVisible) attachEngine(app);
  else detachEngine();
}

// ---------------------------------------------------------------------------
// Video export: record the animated marker to an MP4 (or WebM) file by
// capturing the live MapLibre canvas while a single, non-looping pass plays.
//
// The map canvas is created with `preserveDrawingBuffer: true` (see
// `packages/map/src/map-controller.ts`), so `canvas.captureStream()` works
// without any constructor change — the same approach the Record Map Tour
// feature uses. MP4/H.264 is preferred so the export honors the "save as MP4"
// intent, with WebM as a fallback for browsers (notably Firefox) whose
// MediaRecorder cannot encode MP4, so the saved file is always a playable video.
// ---------------------------------------------------------------------------

/** Default frames per second sampled from the canvas while recording. */
export const ROUTE_VIDEO_FPS = 30;

/** How long to wait for the encoder's final `onstop` before giving up (ms). */
const ROUTE_VIDEO_STOP_TIMEOUT_MS = 10_000;

/**
 * Recording container/codecs tried in order; the first the browser's
 * MediaRecorder supports is used. MP4/H.264 is preferred, with WebM as a
 * fallback for browsers whose MediaRecorder cannot produce MP4.
 */
export const ROUTE_VIDEO_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/** File extension matching a recording MIME type (`mp4` for MP4, else `webm`). */
export function videoExtensionForMime(mimeType: string): "mp4" | "webm" {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

/**
 * Pick the first supported recording MIME type from a candidate list. Returns
 * `null` when none are supported. Kept pure (the support check is injected) so
 * it can be unit tested without a DOM.
 *
 * @param candidates - MIME types to try, in preference order
 * @param isSupported - Predicate telling whether a MIME type can be recorded
 * @returns The first supported MIME type, or `null` when none are
 */
export function pickVideoMimeType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return null;
}

/** The recording MIME type this browser will use, or `null` when unsupported. */
export function pickRouteVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return pickVideoMimeType(ROUTE_VIDEO_MIME_CANDIDATES, (type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/** True when the current browser can record the map canvas to a video file. */
export function isRouteVideoSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickRouteVideoMimeType() !== null
  );
}

/**
 * Estimated wall-clock length, in seconds, of one full pass of the current
 * route at the current speed (`totalMeters / speedMps`), which is exactly what
 * {@link recordRouteAnimation} captures. Returns `0` when no animatable route is
 * loaded, so the panel can show the user how long the video will be.
 *
 * @returns The estimated pass duration in seconds, or `0` when there is no route
 */
export function getRouteAnimationDurationSeconds(): number {
  const { totalMeters } = measureLine(routeCoords);
  if (totalMeters <= 0 || settings.speedMps <= 0) return 0;
  return totalMeters / settings.speedMps;
}

/** True when an engine is attached and there is an animatable route to record. */
export function isRouteAnimationRecordable(): boolean {
  return engine !== null && measureLine(routeCoords).totalMeters > 0;
}

/** Raised when the browser cannot record the canvas (no MediaRecorder / codec). */
export class RouteVideoUnsupportedError extends Error {
  constructor(message = "Canvas recording is not supported in this browser.") {
    super(message);
    this.name = "RouteVideoUnsupportedError";
  }
}

/** A finished route-animation recording plus how it should be saved. */
export interface RouteAnimationRecording {
  /** The encoded video. */
  blob: Blob;
  /** The MIME type the video was encoded with. */
  mimeType: string;
  /** File extension matching {@link mimeType} (`mp4` or `webm`). */
  extension: "mp4" | "webm";
}

/** Options for {@link recordRouteAnimation}. */
export interface RecordRouteAnimationOptions {
  /** Frames per second sampled from the canvas (defaults to {@link ROUTE_VIDEO_FPS}). */
  fps?: number;
  /** Aborts the recording early; the partial video up to that point is kept. */
  signal?: AbortSignal;
  /** Reports progress in `[0, 1]` as the pass plays. */
  onProgress?: (fraction: number) => void;
}

/**
 * Record one full, non-looping pass of the current route animation to a video
 * file and resolve with the encoded blob.
 *
 * Plays the marker from the start of the route to the end at the current speed
 * while capturing the live MapLibre canvas with a `MediaRecorder`. The user's
 * current progress, playback, and loop settings are saved and restored
 * afterward, so recording never disturbs the on-screen animation state.
 *
 * @param options - Frame rate, an optional abort signal, and a progress callback
 * @returns The encoded video with its MIME type and file extension
 * @throws {RouteVideoUnsupportedError} When the browser cannot record the canvas
 * @throws {Error} When no engine is attached or the route has no length
 */
export async function recordRouteAnimation({
  fps = ROUTE_VIDEO_FPS,
  signal,
  onProgress,
}: RecordRouteAnimationOptions = {}): Promise<RouteAnimationRecording> {
  if (!engine) {
    throw new Error("The route animation is not active.");
  }
  if (measureLine(routeCoords).totalMeters <= 0) {
    throw new Error("Select a line layer with length before recording.");
  }
  const mimeType = pickRouteVideoMimeType();
  if (!mimeType) throw new RouteVideoUnsupportedError();

  const map = engine.getMapInstance();
  const canvas = map.getCanvas();
  if (typeof canvas.captureStream !== "function") {
    throw new RouteVideoUnsupportedError();
  }

  const stream = canvas.captureStream(fps);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch {
    // The constructor can still reject a codec that isTypeSupported accepted;
    // release the capture and report it as unsupported.
    for (const track of stream.getTracks()) track.stop();
    throw new RouteVideoUnsupportedError();
  }

  // Save the user's playback state so recording is non-destructive: it plays a
  // pass from the start, then restores exactly where they were.
  const saved = {
    progress: settings.progress,
    playing: settings.playing,
    loop: settings.loop,
  };

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  let recorderFailed = false;
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => {
      // Surface the browser's own diagnosis (e.g. SecurityError) so a field
      // failure is debuggable rather than a generic message.
      const cause = (event as Event & { error?: DOMException }).error;
      recorderFailed = true;
      reject(
        new Error(`Recording failed: ${cause?.message ?? "unknown error"}`, {
          cause,
        }),
      );
    };
  });

  // Resolve when the pass reaches the end (the engine flips `playing` off at
  // progress 1 with loop forced off), the recording is aborted, or the encoder
  // errors. Subscribed before playback starts so no completion is missed.
  const played = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = subscribeRouteAnimation(() => {
      onProgress?.(settings.progress);
      if (recorderFailed || (!settings.playing && settings.progress >= 1)) {
        finish();
      }
    });
    if (signal?.aborted) {
      finish();
    } else {
      signal?.addEventListener("abort", finish, { once: true });
    }
  });

  // Keep the captured stream fed with fresh frames even on slow segments where
  // the marker barely moves between the engine's own per-frame renders.
  let rafId = 0;
  const pump = () => {
    map.triggerRepaint();
    rafId = window.requestAnimationFrame(pump);
  };

  try {
    // Park at the start (loop off so the pass stops at the end); this renders the
    // opening frame. Then start capturing and begin the pass.
    setRouteAnimationSettings({ progress: 0, loop: false, playing: false });
    onProgress?.(0);
    recorder.start(1000);
    rafId = window.requestAnimationFrame(pump);
    setRouteAnimationSettings({ playing: true });
    // `finished` only settles on stop (below) or a recorder error; racing it
    // here means an encoder failure breaks out promptly instead of hanging.
    await Promise.race([played, finished]);
  } finally {
    window.cancelAnimationFrame(rafId);
    if (recorder.state !== "inactive") recorder.stop();
    // recorder.stop() finalizes the file but does not stop the canvas capture.
    for (const track of stream.getTracks()) track.stop();
    // Restore the user's original playback position and flags.
    setRouteAnimationSettings(saved);
  }

  // Guard against a browser that never fires onstop leaving this await hung.
  const timeout = new Promise<never>((_, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Recording timed out waiting for the encoder.")),
      ROUTE_VIDEO_STOP_TIMEOUT_MS,
    );
    void finished.then(
      () => window.clearTimeout(timer),
      () => window.clearTimeout(timer),
    );
  });
  const blob = await Promise.race([finished, timeout]);
  return { blob, mimeType, extension: videoExtensionForMime(mimeType) };
}

export const maplibreRouteAnimationPlugin: GeoLibrePlugin = {
  id: ROUTE_ANIMATION_PLUGIN_ID,
  name: "Route Animation",
  version: "1.0.0",
  activeByDefault: false,
  activate: (app: GeoLibreAppAPI) => openRouteAnimationPanel(app),
  deactivate: (app: GeoLibreAppAPI) => closeRouteAnimationPanel(app),
  // Persist the panel-open flag plus settings so a saved project reopens on the
  // same layer. Nothing is stored while closed and at defaults. `playing` is
  // never persisted as true — playback is an explicit user action on load.
  getProjectState: () => {
    if (!panelVisible && isDefaultSettings(settings)) return undefined;
    return { open: panelVisible, ...settings, playing: false };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) =>
    restoreRouteAnimation(app, state),
};
