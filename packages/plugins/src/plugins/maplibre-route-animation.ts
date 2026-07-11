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
const MARKER_COLOR = "#2563eb";

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
}

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
    a.showTrail === b.showTrail
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

function createArrowIcon(): ImageData | null {
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
  ctx.fillStyle = "#2563eb";
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
    this.setRoute(coords);
    if (settings.playing && this.totalMeters > 0) this.play();
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
      const icon = createArrowIcon();
      if (icon) this.map.addImage(ARROW_ICON_ID, icon, { pixelRatio: 2 });
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
          "line-color": MARKER_COLOR,
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
          "circle-color": MARKER_COLOR,
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
  }

  /** Draw the marker (and trail) at the current progress; optionally follow. */
  render(): void {
    if (this.destroyed || this.totalMeters <= 0) return;
    const markerSource = this.map.getSource(MARKER_SOURCE_ID) as
      | GeoJSONSource
      | undefined;
    if (!markerSource) return;

    const distance = this.settings.progress * this.totalMeters;
    const { coord, bearing } = pointAlongLine(
      this.coords,
      this.cumulative,
      distance,
    );
    markerSource.setData(markerFeature(coord, bearing));

    if (this.settings.showTrail) {
      const trailSource = this.map.getSource(TRAIL_SOURCE_ID) as
        | GeoJSONSource
        | undefined;
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
      const elapsedSec = (now - this.lastFrame) / 1000;
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
  setRouteAnimationSettings({ playing: !settings.playing });
}

/** Scrub to an absolute progress in `[0, 1]` (used by the panel slider). */
export function setRouteAnimationProgress(progress: number): void {
  setRouteAnimationSettings({ progress });
}

/**
 * Hand the engine the geometry of the currently selected line layer. Called by
 * the panel, which has the store/map access needed to resolve a layer to
 * coordinates. Resets progress to the start when the route changes.
 */
export function setRouteAnimationRoute(coords: LngLat[]): void {
  routeCoords = coords;
  const shouldResetProgress = settings.progress !== 0;
  if (shouldResetProgress) {
    settings = { ...settings, progress: 0 };
  }
  engine?.setRoute(coords);
  if (shouldResetProgress) notifyState();
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
  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  let changed = false;
  if (!settingsEqual(next, settings)) {
    settings = next;
    notifyState();
    changed = true;
  }
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
