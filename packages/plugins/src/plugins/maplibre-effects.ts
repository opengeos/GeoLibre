import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * GeoLibre atmosphere & particle effects plugin.
 *
 * Stacks transparent Canvas 2D layers behind the MapLibre globe to give it a
 * sense of place in space: a deep-space backdrop, tiled parallax starfield,
 * occasional comets (shooting stars), and an atmospheric halo aligned to the
 * projected globe. The effects render only while the map is in globe projection,
 * so they never interfere with normal map work. A toolbar toggle turns the
 * whole stack on or off, and the on/off state is saved with the project.
 *
 * The technique and visual design are adapted, with thanks, from Leonel Dias's
 * article "Globe atmosphere, halo, and comets":
 * https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/
 * — specifically the layered Canvas 2D approach, the halo gradient stops and
 * "screen" blend, and the starfield/comet parameters. Re-implemented for
 * GeoLibre's plugin lifecycle (background canvases behind the MapLibre canvas
 * so the effects show through the globe projection's transparent space without
 * masking the map).
 */

export const EFFECTS_PLUGIN_ID = "maplibre-atmosphere-effects";

/**
 * User-tunable appearance of the globe atmosphere. Persisted with the project
 * (see the plugin's getProjectState/applyProjectState) so a styled globe — for
 * example one prepared for image export — reopens the way it was saved.
 *
 * - `haloColor` is the base color of the atmospheric halo; the gradient stops
 *   are derived from it (lightened toward white near the globe edge, darkened
 *   in the faint outer falloff).
 * - `haloExtent` is how far the halo reaches past the globe, as a multiple of
 *   the globe radius. Lower values pull the glow tight to the surface so data
 *   reads as painted onto the sphere; higher values give the stylized "air"
 *   look where the limb floats in a wide blue haze.
 * - `haloOpacity` scales the whole halo's strength (0 hides it).
 * - `spaceColor` is the center color of the deep-space radial backdrop; the
 *   outer edge is a darkened shade of it.
 */
export interface EffectsSettings {
  haloColor: string;
  haloExtent: number;
  haloOpacity: number;
  spaceColor: string;
}

export const DEFAULT_EFFECTS_SETTINGS: EffectsSettings = {
  haloColor: "#4d9fe6",
  haloExtent: 2.8,
  haloOpacity: 1,
  spaceColor: "#0c1b33",
};

// Slider bounds shared by the UI and the settings normalizer.
export const HALO_EXTENT_MIN = 1.05;
export const HALO_EXTENT_MAX = 4;
export const HALO_OPACITY_MIN = 0;
export const HALO_OPACITY_MAX = 1;

const EFFECTS_MAP_CLASS = "geolibre-effects-map";
const EFFECTS_OVERLAY_STYLE_ID = "geolibre-effects-maplibre-overlays";
const MAP_CANVAS_Z_INDEX = "4";
const CONTROL_CONTAINER_Z_INDEX = "5";
const MAPLIBRE_OVERLAY_Z_INDEX = "6";
// All DOM markers (e.g. Geoman's draw/edit vertex handles, plus any custom
// `new Marker()` the app adds) live in the canvas container and normally paint
// above the map canvas. Raising the map canvas to MAP_CANVAS_Z_INDEX would
// otherwise bury them — invisible and unclickable, so a drawn polygon's vertices
// vanish and you can't click the first one to close it.
//
// Intentionally tied to the control container's z-index: that clears the canvas
// while the control container — a later sibling of the canvas container in
// MapLibre's DOM — wins the equal-z-index tie and keeps controls on top. Raising
// CONTROL_CONTAINER_Z_INDEX later moves markers with it, which is the desired
// coupling. The rule below is a plain class selector (no `!important`), so a
// marker that needs its own stacking can still set an inline z-index via
// `Marker#setZIndex()`.
const MARKER_Z_INDEX = CONTROL_CONTAINER_Z_INDEX;

// Roughly one star per this many CSS pixels of starfield area.
const STAR_AREA_PER_STAR = 900;
// Starfield parallax scales exactly like the reference: a full 360° longitude
// pan shifts one viewport width, and a 180° latitude pan shifts one height.
const STARFIELD_LNG_PERIOD_DEGREES = 360;
const STARFIELD_LAT_PERIOD_DEGREES = 180;

const HALO_SAMPLE_COUNT = 16;

// Halo radial gradient as a *shape* independent of the chosen color: each stop
// is [offset, alpha, shade] where offset is the fraction of the gradient span
// (globe edge → haloExtent × radius), alpha is the base opacity, and shade
// blends the base color toward white (positive) or black (negative). The
// defaults reproduce the original light-blue glow when applied to the default
// haloColor (#4d9fe6): a bright near-white rim falling off to a faint dark blue.
const HALO_STOP_SHAPE: Array<[number, number, number]> = [
  [0.0, 1.0, 0.7],
  [0.03, 0.6, 0.32],
  [0.08, 0.35, 0.0],
  [0.18, 0.15, -0.2],
  [0.35, 0.06, -0.4],
  [0.6, 0.02, -0.55],
  [1.0, 0.0, -0.7],
];

// The space backdrop runs from spaceColor at the center to this much darker at
// the edge, matching the original #0c1b33 → #081222 falloff.
const SPACE_EDGE_DARKEN = 0.33;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb`/`#rrggbb` into RGB. Inputs reaching here are already validated by
 * normalizeEffectsSettings, so `fallback` is only for defensive use; pass the
 * caller's own default (halo vs space) so a corrupt value degrades to the right
 * neutral color rather than always to halo blue.
 */
function parseHex(hex: string, fallback: Rgb = { r: 77, g: 159, b: 230 }): Rgb {
  const value = hex.trim().replace(/^#/, "");
  const expanded =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return fallback;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

/** Blend `rgb` toward white (shade > 0) or black (shade < 0) by |shade|. */
function shadeRgb({ r, g, b }: Rgb, shade: number): Rgb {
  const target = shade >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(shade));
  return {
    r: Math.round(r + (target - r) * t),
    g: Math.round(g + (target - g) * t),
    b: Math.round(b + (target - b) * t),
  };
}

function rgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Clamp `value` into `[min, max]`, falling back to `fallback` if non-finite. */
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into a complete EffectsSettings. */
export function normalizeEffectsSettings(
  value: unknown,
  base: EffectsSettings = DEFAULT_EFFECTS_SETTINGS,
): EffectsSettings {
  const candidate = (value ?? {}) as Partial<EffectsSettings>;
  const isHex = (v: unknown): v is string =>
    typeof v === "string" && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v.trim());
  // Lowercase so casing never leaks into the equality check: uppercase hex from
  // a hand-edited project would otherwise read as "non-default" and get
  // serialized even when the rendered color matches a default exactly.
  const withHash = (v: string) => {
    const hex = v.trim().toLowerCase();
    return hex.startsWith("#") ? hex : `#${hex}`;
  };
  return {
    haloColor: isHex(candidate.haloColor)
      ? withHash(candidate.haloColor)
      : base.haloColor,
    haloExtent: clampNumber(
      candidate.haloExtent,
      HALO_EXTENT_MIN,
      HALO_EXTENT_MAX,
      base.haloExtent,
    ),
    haloOpacity: clampNumber(
      candidate.haloOpacity,
      HALO_OPACITY_MIN,
      HALO_OPACITY_MAX,
      base.haloOpacity,
    ),
    spaceColor: isHex(candidate.spaceColor)
      ? withHash(candidate.spaceColor)
      : base.spaceColor,
  };
}

function effectsSettingsEqual(a: EffectsSettings, b: EffectsSettings): boolean {
  return (
    a.haloColor === b.haloColor &&
    a.haloExtent === b.haloExtent &&
    a.haloOpacity === b.haloOpacity &&
    a.spaceColor === b.spaceColor
  );
}

interface Star {
  x: number;
  y: number;
  size: number;
  alpha: number;
  glow: boolean;
}

interface Comet {
  x: number;
  y: number;
  len: number;
  speed: number;
  angle: number;
  alpha: number;
  life: number;
  maxLife: number;
}

interface GlobeCircle {
  x: number;
  y: number;
  radius: number;
}

export interface GlobeEllipse {
  // Center of the projected globe silhouette (screen px).
  cx: number;
  cy: number;
  // Semi-axes (screen px). rx runs along `angle`, ry perpendicular to it.
  rx: number;
  ry: number;
  // Rotation of the rx axis, radians.
  angle: number;
}

function isGlobeProjection(map: MapLibreMap): boolean {
  // getProjection is available on MapLibre globe-capable versions; guard so an
  // older host or a thrown getter simply disables the effect instead of
  // breaking the render loop.
  try {
    const projection = (
      map as unknown as { getProjection?: () => { type?: string } | undefined }
    ).getProjection?.();
    return projection?.type === "globe";
  } catch {
    return false;
  }
}

function getGeoglifyGlobeCircle(map: MapLibreMap): GlobeCircle {
  const center = map.getCenter();
  const lngRad = (center.lng * Math.PI) / 180;
  const latRad = (center.lat * Math.PI) / 180;
  const points: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < HALO_SAMPLE_COUNT; i++) {
    const bearing = (i / HALO_SAMPLE_COUNT) * Math.PI * 2;
    const angularDistance = Math.PI / 2;
    const sampleLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularDistance) +
        Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const sampleLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
        Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(sampleLat),
      );
    const projected = map.project([
      (sampleLng * 180) / Math.PI,
      (sampleLat * 180) / Math.PI,
    ]);
    if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
      points.push(projected);
    }
  }

  if (points.length < 3) {
    const projectedCenter = map.project(center);
    const projectedEdge = map.project([center.lng + 90, 0]);
    return {
      x: projectedCenter.x,
      y: projectedCenter.y,
      radius: Math.max(
        Math.hypot(
          projectedCenter.x - projectedEdge.x,
          projectedCenter.y - projectedEdge.y,
        ),
        1,
      ),
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    radius: Math.max(maxX - minX, maxY - minY) / 2,
  };
}

/**
 * Fit an ellipse to points sampled around its boundary.
 *
 * Exact for points that lie on a real ellipse (such as the conic silhouette of a
 * sphere), for any sampling — including the production rays, which are cast at
 * uniform angles from the projected map center, a point that under pitch is
 * offset from the silhouette center. A bounding-box center would only be exact
 * for samples symmetric about the center (e.g. uniform in the ellipse parameter
 * t); off-center ray casts are not, and the error grows with pitch (tens of
 * pixels past ~50°). So fit the general conic A·u² + 2B·uv + C·v² + D·u + E·v = 1
 * (u,v relative to a shift origin for conditioning) and recover the center from
 * ∇ = 0; this solves for the center rather than assuming it. Returns null for a
 * degenerate (non-elliptical) fit — collinear or fewer than five points.
 */
export function fitEllipse(
  pts: ReadonlyArray<readonly [number, number]>,
): GlobeEllipse | null {
  if (pts.length < 5) return null;

  // Shift origin to the sample bounding-box center: it lies inside the ellipse,
  // keeping the conic's constant term away from zero and the |u|,|v| magnitudes
  // small so the normal equations stay well conditioned. It is only a numerical
  // origin here — the true center is solved for below, not assumed from it.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of pts) {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  const ox = (minX + maxX) / 2;
  const oy = (minY + maxY) / 2;

  // Normal equations for A·u² + 2B·uv + C·v² + D·u + E·v = 1.
  const s = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const t = new Array<number>(5).fill(0);
  for (const [px, py] of pts) {
    const u = px - ox;
    const v = py - oy;
    const f = [u * u, 2 * u * v, v * v, u, v];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) s[i][j] += f[i] * f[j];
      t[i] += f[i];
    }
  }
  const conic = solveLinear(s, t);
  if (!conic) return null;
  const [A, B, C, D, E] = conic;

  // Ellipse center solves ∇(conic) = 0: [[2A,2B],[2B,2C]]·[u0,v0] = [-D,-E].
  const center = solveLinear(
    [
      [2 * A, 2 * B],
      [2 * B, 2 * C],
    ],
    [-D, -E],
  );
  if (!center) return null;
  const [u0, v0] = center;

  // Translate to the center: A·p² + 2B·pq + C·q² = G (the constant moves over).
  const g = -(A * u0 * u0 + 2 * B * u0 * v0 + C * v0 * v0 + D * u0 + E * v0 - 1);
  if (!(g > 0)) return null; // not a real, centered ellipse
  const a2 = A / g;
  const b2 = B / g;
  const c2 = C / g;

  // Eigen-decompose [[a2,b2],[b2,c2]]: semi-axis = 1/√eigenvalue, axis direction
  // = eigenvector. A non-positive-definite form is not a real ellipse, so bail.
  const tr = a2 + c2;
  const det = a2 * c2 - b2 * b2;
  const gap = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + gap;
  const l2 = tr / 2 - gap;
  if (!(l1 > 0) || !(l2 > 0)) return null;

  return {
    cx: ox + u0,
    cy: oy + v0,
    rx: 1 / Math.sqrt(l1),
    ry: 1 / Math.sqrt(l2),
    // Eigenvector for l1 is (b2, l1 - a2); this is the rx axis direction. For a
    // circle (l1 == l2, b2 == 0) atan2(0, 0) == 0 — fine, since any angle is
    // equivalent when rx == ry.
    angle: Math.atan2(l1 - a2, b2),
  };
}

/**
 * Solve the square system M·x = b by Gaussian elimination with partial pivoting.
 * `m` is row-major and `b` has the same length; returns null if singular.
 */
function solveLinear(m: number[][], b: number[]): number[] | null {
  const n = b.length;
  const aug = m.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / aug[col][col];
      // Start at col+1: the col-th cell is being zeroed by definition, and the
      // solution reads only each row's diagonal and right-hand side, so the
      // skipped off-diagonal writes are never read.
      for (let k = col + 1; k <= n; k++) aug[row][k] -= factor * aug[col][k];
    }
  }
  return aug.map((row, i) => row[n] / row[i]);
}

/**
 * Owns the overlay canvases, the animation loop, and all per-frame drawing for
 * one map instance. Created on activate, torn down on deactivate.
 */
class EffectsEngine {
  private readonly map: MapLibreMap;
  private readonly mapRoot: HTMLElement | null;
  private readonly spaceCanvas: HTMLCanvasElement;
  private readonly starsCanvas: HTMLCanvasElement;
  private readonly cometCanvas: HTMLCanvasElement;
  private readonly haloCanvas: HTMLCanvasElement;
  private readonly spaceCtx: CanvasRenderingContext2D;
  private readonly starsCtx: CanvasRenderingContext2D;
  private readonly cometCtx: CanvasRenderingContext2D;
  private readonly haloCtx: CanvasRenderingContext2D;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly previousMapCanvasZIndex: string;
  private readonly controlContainer: HTMLElement | null;
  private readonly previousControlContainerZIndex: string;
  private readonly overlayStyle: HTMLStyleElement;

  private starfield: HTMLCanvasElement | null = null;
  private starfieldOriginLng = 0;
  private starfieldOriginLat = 0;
  private comets: Comet[] = [];
  // Cached space-background gradient; only depends on size, so rebuilt on resize.
  private spaceGradient: CanvasGradient | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private starsDirty = true;
  private settings: EffectsSettings;

  private rafId: number | null = null;
  private destroyed = false;

  constructor(map: MapLibreMap, settings: EffectsSettings) {
    this.map = map;
    this.settings = settings;
    this.mapCanvas = map.getCanvas();
    this.mapRoot = this.mapCanvas.closest(".maplibregl-map");
    this.previousMapCanvasZIndex = this.mapCanvas.style.zIndex;
    this.controlContainer =
      this.mapRoot?.querySelector<HTMLElement>(".maplibregl-control-container") ??
      null;
    this.previousControlContainerZIndex =
      this.controlContainer?.style.zIndex ?? "";
    this.overlayStyle = this.ensureOverlayStyle();
    this.spaceCanvas = this.createCanvas(0);
    this.starsCanvas = this.createCanvas(1);
    this.cometCanvas = this.createCanvas(2);
    this.haloCanvas = this.createCanvas(3);
    this.spaceCtx = this.spaceCanvas.getContext("2d")!;
    this.starsCtx = this.starsCanvas.getContext("2d")!;
    this.cometCtx = this.cometCanvas.getContext("2d")!;
    this.haloCtx = this.haloCanvas.getContext("2d")!;

    const container = map.getCanvasContainer();
    container.appendChild(this.spaceCanvas);
    container.appendChild(this.starsCanvas);
    container.appendChild(this.cometCanvas);
    container.appendChild(this.haloCanvas);
    this.mapRoot?.classList.add(EFFECTS_MAP_CLASS);
    this.mapCanvas.style.zIndex = MAP_CANVAS_Z_INDEX;
    if (this.controlContainer) {
      this.controlContainer.style.zIndex = CONTROL_CONTAINER_Z_INDEX;
    }

    this.handleResize = this.handleResize.bind(this);
    this.handleVisibility = this.handleVisibility.bind(this);
    this.handleMapChange = this.handleMapChange.bind(this);
    this.tick = this.tick.bind(this);

    map.on("resize", this.handleResize);
    // "move" already fires for pan, zoom, pitch, and rotate, so it covers every
    // camera change; no separate "zoom" listener is needed.
    map.on("move", this.handleMapChange);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.handleResize();
    this.start();
  }

  /** The map this engine is bound to (used to detect a map re-init). */
  getMapInstance(): MapLibreMap {
    return this.map;
  }

  /**
   * Swap in new appearance settings. The space gradient is size-cached, so drop
   * it to rebuild with the new color on the next frame; the halo is rebuilt
   * every frame already. Restart the loop in case it idled (a settings change
   * can arrive while the map sits still in globe mode).
   */
  applySettings(settings: EffectsSettings): void {
    this.settings = settings;
    this.spaceGradient = null;
    if (!document.hidden) this.start();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.map.off("resize", this.handleResize);
    this.map.off("move", this.handleMapChange);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.mapCanvas.style.zIndex = this.previousMapCanvasZIndex;
    if (this.controlContainer) {
      this.controlContainer.style.zIndex = this.previousControlContainerZIndex;
    }
    this.mapRoot?.classList.remove(EFFECTS_MAP_CLASS);
    this.overlayStyle.remove();
    this.spaceCanvas.remove();
    this.starsCanvas.remove();
    this.cometCanvas.remove();
    this.haloCanvas.remove();
  }

  private ensureOverlayStyle(): HTMLStyleElement {
    const existing = document.getElementById(EFFECTS_OVERLAY_STYLE_ID);
    if (existing instanceof HTMLStyleElement) return existing;

    const style = document.createElement("style");
    style.id = EFFECTS_OVERLAY_STYLE_ID;
    style.textContent = `
      .${EFFECTS_MAP_CLASS} .maplibregl-boxzoom {
        z-index: ${MAPLIBRE_OVERLAY_Z_INDEX};
      }
      .${EFFECTS_MAP_CLASS} .maplibregl-marker {
        z-index: ${MARKER_Z_INDEX};
      }
    `;
    document.head.appendChild(style);
    return style;
  }

  private createCanvas(zIndex: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = "geolibre-effects-canvas";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    // Explicit pixel sizes are set in handleResize: the canvas container
    // collapses to 0 height, so a percentage height would resolve to 0.
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = String(zIndex);
    return canvas;
  }

  private handleVisibility(): void {
    if (document.hidden) {
      this.stop();
    } else {
      this.start();
    }
  }

  // A move restarts a loop that stopped because the map was not in globe mode.
  // MapLibre's "move" fires for pan, zoom, pitch, and rotate.
  private handleMapChange(): void {
    this.starsDirty = true;
    if (!document.hidden) this.start();
  }

  private handleResize(): void {
    // Measure from the map's own canvas: the canvas container reports 0 height.
    const mapCanvas = this.map.getCanvas();
    this.width = mapCanvas.clientWidth;
    this.height = mapCanvas.clientHeight;
    this.dpr = window.devicePixelRatio || 1;

    for (const ctx of [
      this.spaceCtx,
      this.starsCtx,
      this.cometCtx,
      this.haloCtx,
    ]) {
      const canvas = ctx.canvas;
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.starfield = null; // regenerate at the new size on the next frame
    this.spaceGradient = null; // rebuild for the new dimensions
    this.starsDirty = true;
  }

  private start(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId === null) return;
    window.cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private clear(): void {
    this.spaceCtx.clearRect(0, 0, this.width, this.height);
    this.cometCtx.clearRect(0, 0, this.width, this.height);
    this.haloCtx.clearRect(0, 0, this.width, this.height);
  }

  private ensureStarfield(): void {
    if (this.starfield) return;
    const center = this.map.getCenter();
    this.starfieldOriginLng = center.lng;
    this.starfieldOriginLat = center.lat;

    const fieldWidth = this.width;
    const fieldHeight = this.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(fieldWidth * this.dpr);
    canvas.height = Math.round(fieldHeight * this.dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const count = Math.round((fieldWidth * fieldHeight) / STAR_AREA_PER_STAR);
    for (let i = 0; i < count; i++) {
      const star = this.makeStar(fieldWidth, fieldHeight);
      this.drawStar(ctx, star);
    }
    this.starfield = canvas;
  }

  private makeStar(fieldWidth: number, fieldHeight: number): Star {
    const size = Math.random() * 1.3 + 0.2;
    const alpha = Math.random() * 0.6 + 0.15;
    return {
      x: Math.random() * fieldWidth,
      y: Math.random() * fieldHeight,
      size,
      alpha,
      glow: size > 1.1,
    };
  }

  private drawStar(ctx: CanvasRenderingContext2D, star: Star): void {
    // ~20% of stars get a faint blue (hue 220) or warm (hue 40) tint; the rest
    // are white.
    let color = `rgba(255, 255, 255, ${star.alpha})`;
    if (Math.random() > 0.8) {
      color =
        Math.random() > 0.5
          ? `hsla(220, 30%, 85%, ${star.alpha})`
          : `hsla(40, 30%, 85%, ${star.alpha})`;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
    if (star.glow) {
      ctx.fillStyle = `rgba(200, 220, 255, ${0.12 * star.alpha})`;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawStarfield(): void {
    if (this.width <= 0 || this.height <= 0) return;
    this.ensureStarfield();
    if (!this.starfield) return;
    const center = this.map.getCenter();
    const offsetX =
      ((center.lng - this.starfieldOriginLng) /
        STARFIELD_LNG_PERIOD_DEGREES) *
      this.width;
    const offsetY =
      ((center.lat - this.starfieldOriginLat) /
        STARFIELD_LAT_PERIOD_DEGREES) *
      this.height;
    const wrappedX = ((offsetX % this.width) + this.width) % this.width;
    const wrappedY = ((offsetY % this.height) + this.height) % this.height;
    const field = this.starfield;
    if (!field) return;
    const ctx = this.starsCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(field, wrappedX, wrappedY, this.width, this.height);
    ctx.drawImage(field, wrappedX - this.width, wrappedY, this.width, this.height);
    ctx.drawImage(field, wrappedX, wrappedY - this.height, this.width, this.height);
    ctx.drawImage(
      field,
      wrappedX - this.width,
      wrappedY - this.height,
      this.width,
      this.height,
    );
  }

  private updateAndDrawComets(): void {
    // One comet at a time, spawned with ~0.5% probability per frame.
    if (this.comets.length === 0 && Math.random() < 0.005) {
      this.comets.push(this.spawnComet());
    }

    const ctx = this.cometCtx;
    const survivors: Comet[] = [];
    for (const comet of this.comets) {
      comet.life += 1;
      comet.x += Math.cos(comet.angle) * comet.speed;
      comet.y += Math.sin(comet.angle) * comet.speed;
      comet.alpha = 1 - comet.life / comet.maxLife;

      const offscreen =
        comet.x < -comet.len ||
        comet.x > this.width + comet.len ||
        comet.y < -comet.len ||
        comet.y > this.height + comet.len;
      if (comet.life >= comet.maxLife || offscreen) continue;
      survivors.push(comet);

      const tailX = comet.x - Math.cos(comet.angle) * comet.len;
      const tailY = comet.y - Math.sin(comet.angle) * comet.len;
      const gradient = ctx.createLinearGradient(tailX, tailY, comet.x, comet.y);
      gradient.addColorStop(0, "rgba(255, 255, 255, 0)");
      gradient.addColorStop(1, `rgba(255, 255, 255, ${comet.alpha})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(comet.x, comet.y);
      ctx.stroke();

      ctx.fillStyle = `rgba(200, 220, 255, ${0.5 * comet.alpha})`;
      ctx.beginPath();
      ctx.arc(comet.x, comet.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    this.comets = survivors;
  }

  private spawnComet(): Comet {
    return {
      x: Math.random() * this.width,
      y: Math.random() * this.height,
      len: Math.random() * 200 + 150,
      speed: Math.random() * 8 + 6,
      angle: Math.random() * Math.PI * 2,
      alpha: 1,
      life: 0,
      maxLife: Math.random() * 40 + 80,
    };
  }

  private drawSpaceBackground(): void {
    const ctx = this.spaceCtx;
    if (!this.spaceGradient) {
      const gradient = ctx.createRadialGradient(
        this.width / 2,
        this.height / 2,
        0,
        this.width / 2,
        this.height / 2,
        Math.max(this.width, this.height) * 0.75,
      );
      const space = parseHex(this.settings.spaceColor, { r: 12, g: 27, b: 51 });
      gradient.addColorStop(0, rgba(space, 1));
      gradient.addColorStop(1, rgba(shadeRgb(space, -SPACE_EDGE_DARKEN), 1));
      this.spaceGradient = gradient;
    }
    ctx.save();
    ctx.fillStyle = this.spaceGradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private drawHalo(disc: GlobeCircle): void {
    const { haloExtent, haloOpacity } = this.settings;
    if (disc.radius < 5 || haloOpacity <= 0 || haloExtent <= 1) return;
    const ctx = this.haloCtx;
    const base = parseHex(this.settings.haloColor);
    const outerRadius = disc.radius * haloExtent;
    ctx.save();
    const gradient = ctx.createRadialGradient(
      disc.x,
      disc.y,
      disc.radius,
      disc.x,
      disc.y,
      outerRadius,
    );
    for (const [stop, alpha, shade] of HALO_STOP_SHAPE) {
      gradient.addColorStop(stop, rgba(shadeRgb(base, shade), alpha * haloOpacity));
    }
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(disc.x, disc.y, outerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private tick(): void {
    this.rafId = null;
    if (this.destroyed) return;

    this.clear();

    if (!isGlobeProjection(this.map)) {
      this.starsCtx.clearRect(0, 0, this.width, this.height);
      // Not globe: idle without burning frames. A later move (handleMapChange)
      // restarts the loop when the globe comes back.
      return;
    }

    this.drawSpaceBackground();
    if (this.starsDirty) {
      this.drawStarfield();
      this.starsDirty = false;
    }
    this.updateAndDrawComets();
    this.drawHalo(getGeoglifyGlobeCircle(this.map));

    this.start();
  }
}

/**
 * The plugin's active state is the on/off switch: it is toggled from the
 * Controls menu (with a check mark) rather than an on-map control button, so no
 * icon is added to the map. Active-state persistence is handled by the plugin
 * manager via the project's `activePluginIds`, so no per-plugin project state
 * is needed here. On by default.
 */
let engine: EffectsEngine | null = null;
// Live appearance settings, shared by the engine and the Controls-menu UI.
// Kept at module scope so they survive the engine being torn down and rebuilt
// (map re-init, toggle off/on) and so applyProjectState can stage them before
// the engine exists.
let currentSettings: EffectsSettings = { ...DEFAULT_EFFECTS_SETTINGS };

function attachEngine(app: GeoLibreAppAPI): boolean {
  const map = app.getMap?.();
  if (!map) return false;
  // A map re-init hands back a different MapLibreMap instance; tear down the
  // engine bound to the old map (its canvases/listeners) before rebinding.
  if (engine && engine.getMapInstance() !== map) detachEngine();
  if (!engine) engine = new EffectsEngine(map, currentSettings);
  return true;
}

/** Current atmosphere appearance settings (a copy callers may freely mutate). */
export function getEffectsSettings(): EffectsSettings {
  return { ...currentSettings };
}

/**
 * Update the atmosphere appearance and push it to the live engine if running.
 * Input is normalized, so partial or out-of-range values are safe. Returns true
 * when the settings actually changed (callers persist only on a real change).
 */
export function setEffectsSettings(next: Partial<EffectsSettings>): boolean {
  const normalized = normalizeEffectsSettings(
    { ...currentSettings, ...next },
    DEFAULT_EFFECTS_SETTINGS,
  );
  if (effectsSettingsEqual(normalized, currentSettings)) return false;
  currentSettings = normalized;
  engine?.applySettings(currentSettings);
  return true;
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
}

/**
 * Attach or detach the effect overlays to match the plugin's active state.
 *
 * `activeByDefault` plugins are marked active by the plugin manager without
 * `activate()` ever being called (there is no app API at registration time), so
 * the engine would never start on first load. The desktop shell calls this once
 * after restoring plugin state — mirroring `restoreRasterLayers` — to bridge
 * that gap. Idempotent: safe to call on every project load / map reinit.
 */
export function restoreEffects(
  app: GeoLibreAppAPI,
  active: boolean,
  settings?: unknown,
): void {
  // Apply the project's saved appearance (or defaults when absent) before
  // attaching. restoreProjectState only invokes applyProjectState when the
  // project actually carries effects settings, so a project saved with the
  // default look would otherwise inherit the previously open project's colors;
  // resetting here keeps the in-memory appearance in step with what loaded.
  const next = normalizeEffectsSettings(settings, DEFAULT_EFFECTS_SETTINGS);
  if (!effectsSettingsEqual(next, currentSettings)) {
    currentSettings = next;
    engine?.applySettings(currentSettings);
  }
  if (active) attachEngine(app);
  else detachEngine();
}

export const maplibreEffectsPlugin: GeoLibrePlugin = {
  id: EFFECTS_PLUGIN_ID,
  name: "Atmosphere Effects",
  version: "1.0.0",
  activeByDefault: true,
  activate: (app: GeoLibreAppAPI) => attachEngine(app),
  deactivate: (_app: GeoLibreAppAPI) => detachEngine(),
  // Persist the appearance only when it differs from the defaults, so untouched
  // projects don't carry an effects settings blob.
  getProjectState: () =>
    effectsSettingsEqual(currentSettings, DEFAULT_EFFECTS_SETTINGS)
      ? undefined
      : { ...currentSettings },
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    // A project without saved settings (state === undefined) resets to defaults,
    // matching how applyProjectState is invoked with resetMissingSettings.
    const next = normalizeEffectsSettings(state, DEFAULT_EFFECTS_SETTINGS);
    if (effectsSettingsEqual(next, currentSettings)) return false;
    currentSettings = next;
    engine?.applySettings(currentSettings);
    return true;
  },
};
