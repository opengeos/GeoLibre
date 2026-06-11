import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * GeoLibre atmosphere & particle effects plugin.
 *
 * Stacks a few transparent Canvas 2D overlays over the MapLibre globe to give
 * it a sense of place in space: a deep-space backdrop, a parallax starfield,
 * occasional comets (shooting stars), and an atmospheric halo aligned to the
 * projected globe limb. The effects only render in globe projection at low
 * zoom and fade out as you zoom in, so they never interfere with normal map
 * work. A toolbar toggle turns the whole stack on or off, and the on/off state
 * is saved with the project.
 *
 * The technique and visual design are adapted, with thanks, from Leonel Dias's
 * article "Globe atmosphere, halo, and comets":
 * https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/
 * — specifically the layered Canvas 2D approach, the halo gradient stops and
 * "screen" blend, and the starfield/comet parameters. Re-implemented for
 * GeoLibre's plugin lifecycle (single on-top canvas that punches out the globe
 * silhouette so the effects show only around the globe regardless of the active
 * basemap).
 *
 * The silhouette is recovered by sampling the *rendered* globe limb (see
 * {@link getGlobeEllipse}) and fitting an ellipse, rather than projecting a fixed
 * great-circle limb from the map center. Under MapLibre's perspective globe the
 * visible silhouette is an ellipse that is smaller than the 90° limb and offset
 * from the screen center under pitch, so the fitted ellipse keeps the halo and
 * punch-out hugging the globe at any zoom, pitch, and bearing.
 */

export const EFFECTS_PLUGIN_ID = "maplibre-atmosphere-effects";

// Effects are fully visible at/below ZOOM_FADE_START and fully hidden at/above
// ZOOM_FADE_END, with a linear fade between (the reference gates around zoom
// 3.5 — we fade across it so the transition is not abrupt).
const ZOOM_FADE_START = 2.5;
const ZOOM_FADE_END = 4.5;

// Roughly one star per this many CSS pixels of starfield area.
const STAR_AREA_PER_STAR = 900;
// Extra margin (CSS px) around the viewport for the starfield so a small
// parallax translation never exposes an unpainted edge.
const STARFIELD_MARGIN = 80;
// Pixels of parallax drift applied per degree of map-center movement.
const PARALLAX_PX_PER_DEGREE = 0.6;

// Halo radial gradient — color stops are fractions of the gradient span, which
// runs from the globe edge out to HALO_RADIUS_SCALE × the globe radius.
const HALO_RADIUS_SCALE = 2.8;
// The space punch-out and the halo's opaque inner edge sit slightly inside the
// fitted limb. The 2D overlay edge and the WebGL globe edge are rasterized
// independently, so aligning them exactly leaves a thin seam wherever they
// disagree by a sub-pixel — the dark space gradient bleeds onto the globe rim
// (a dark line) or the page background shows through (a light line), most
// visible on HiDPI displays and at high zoom. Overlapping the bright, opaque
// inner glow a few percent onto the limb hides that seam, the way the original
// (smaller) great-circle disc did. The fitted ellipse still sets the center,
// shape, and rotation, so the halo tracks the globe under zoom and pitch.
const LIMB_INSET = 0.965;
// Globe-silhouette sampling: rays cast from the projected map center, each
// bisected to the rendered limb. The silhouette is a conic (a circle top-down,
// an ellipse under pitch), so a handful of rays over-determine the 3-parameter
// ellipse fit; the bisection depth pins each limb crossing to sub-pixel.
const SILHOUETTE_RAYS = 24;
const SILHOUETTE_BISECTIONS = 18;
// A screen point is "on the globe" when it round-trips through unproject→project
// to within this many pixels; points off the globe clamp to the limb and miss by
// tens to hundreds of pixels, so the threshold is not sensitive.
const ON_GLOBE_TOLERANCE_PX = 1;
const HALO_STOPS: Array<[number, string]> = [
  [0.0, "rgba(200, 235, 255, 1.0)"],
  [0.03, "rgba(130, 200, 250, 0.6)"],
  [0.08, "rgba(70, 150, 230, 0.35)"],
  [0.18, "rgba(40, 100, 200, 0.15)"],
  [0.35, "rgba(25, 65, 160, 0.06)"],
  [0.6, "rgba(15, 40, 110, 0.02)"],
  [1.0, "rgba(10, 25, 70, 0.0)"],
];

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
  life: number;
  maxLife: number;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/**
 * Is this screen point on the rendered globe?
 *
 * MapLibre's `unproject` clamps points outside the globe to the nearest limb
 * location, so an off-globe pixel does not round-trip back to itself through
 * `project`. On-globe pixels round-trip to within a pixel; off-globe pixels miss
 * by tens to hundreds of pixels. This is the only signal we have for the
 * *rendered* silhouette, which (under perspective + pitch) is neither the
 * geometric 90° limb nor centered on the projected map center.
 */
function isOnGlobe(map: MapLibreMap, x: number, y: number): boolean {
  const back = map.project(map.unproject([x, y]));
  return Math.hypot(back.x - x, back.y - y) <= ON_GLOBE_TOLERANCE_PX;
}

/**
 * Distance from (cx,cy) along (dx,dy) to the globe limb, by bisection.
 *
 * Assumes the start point is on the globe; expands until a point is off-globe,
 * then bisects the on/off boundary. `maxR` caps the search so a globe larger
 * than the search window (very rare in the effect's low-zoom range) terminates.
 */
function rayToLimb(
  map: MapLibreMap,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  maxR: number,
): number {
  let lo = 0;
  let hi = 8;
  while (hi < maxR && isOnGlobe(map, cx + dx * hi, cy + dy * hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi > maxR) hi = maxR;
  for (let i = 0; i < SILHOUETTE_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (isOnGlobe(map, cx + dx * mid, cy + dy * mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The rendered globe silhouette as a screen-space ellipse.
 *
 * Casts {@link SILHOUETTE_RAYS} rays from the projected map center (always
 * inside the silhouette) out to the rendered limb, then fits an ellipse to those
 * limb points. The silhouette of a sphere under a pinhole camera is exactly a
 * conic — a circle when viewed top-down, an ellipse under pitch — so the fit is
 * exact: its bounding-box center is the ellipse center, and a 3-parameter
 * quadratic-form least-squares solve recovers the axes and rotation. This tracks
 * the globe under any zoom, pitch, and bearing, unlike a fixed great-circle
 * limb measured from the map center. Returns null when the globe is off-screen.
 */
function getGlobeEllipse(map: MapLibreMap): GlobeEllipse | null {
  const center = map.project(map.getCenter());
  const cx = center.x;
  const cy = center.y;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  if (!isOnGlobe(map, cx, cy)) return null;

  const canvas = map.getCanvas();
  const maxR = Math.max(canvas.clientWidth, canvas.clientHeight) * 8;

  const pts: Array<[number, number]> = [];
  for (let i = 0; i < SILHOUETTE_RAYS; i++) {
    const a = (i / SILHOUETTE_RAYS) * 2 * Math.PI;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const r = rayToLimb(map, cx, cy, dx, dy, maxR);
    pts.push([cx + dx * r, cy + dy * r]);
  }

  return fitEllipse(pts);
}

/**
 * Fit an ellipse to points sampled around its boundary.
 *
 * Exact for points that lie on a real ellipse (such as the conic silhouette of a
 * sphere): the axis-aligned bounding box of any ellipse is centered on the
 * ellipse, so its center is recovered directly; the shape comes from a
 * 3-parameter quadratic-form least-squares solve of A·dx² + 2B·dx·dy + C·dy² = 1.
 * Returns null for a degenerate (non-positive-definite) fit — e.g. collinear or
 * too few points.
 */
export function fitEllipse(
  pts: ReadonlyArray<readonly [number, number]>,
): GlobeEllipse | null {
  if (pts.length < 3) return null;

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
  const ex = (minX + maxX) / 2;
  const ey = (minY + maxY) / 2;

  // Normal equations for A·dx² + 2B·dx·dy + C·dy² = 1 about the center.
  let s00 = 0;
  let s01 = 0;
  let s02 = 0;
  let s11 = 0;
  let s12 = 0;
  let s22 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const [px, py] of pts) {
    const dx = px - ex;
    const dy = py - ey;
    const f0 = dx * dx;
    const f1 = 2 * dx * dy;
    const f2 = dy * dy;
    s00 += f0 * f0;
    s01 += f0 * f1;
    s02 += f0 * f2;
    s11 += f1 * f1;
    s12 += f1 * f2;
    s22 += f2 * f2;
    t0 += f0;
    t1 += f1;
    t2 += f2;
  }
  const conic = solve3(
    [
      [s00, s01, s02],
      [s01, s11, s12],
      [s02, s12, s22],
    ],
    [t0, t1, t2],
  );
  if (!conic) return null;
  const [A, B, C] = conic;

  // Eigen-decompose [[A,B],[B,C]]: semi-axis = 1/√eigenvalue, axis direction =
  // eigenvector. A non-positive-definite fit is not a real ellipse, so bail.
  const tr = A + C;
  const det = A * C - B * B;
  const gap = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + gap;
  const l2 = tr / 2 - gap;
  if (!(l1 > 0) || !(l2 > 0)) return null;

  return {
    cx: ex,
    cy: ey,
    rx: 1 / Math.sqrt(l1),
    ry: 1 / Math.sqrt(l2),
    // Eigenvector for l1 is (B, l1 - A); this is the rx axis direction.
    angle: Math.atan2(l1 - A, B),
  };
}

/**
 * Solve the 3×3 system M·x = b by Gaussian elimination with partial pivoting.
 * Returns null if the matrix is singular (degenerate fit).
 */
function solve3(
  m: [number, number, number][],
  b: [number, number, number],
): [number, number, number] | null {
  const aug: number[][] = [
    [m[0][0], m[0][1], m[0][2], b[0]],
    [m[1][0], m[1][1], m[1][2], b[1]],
    [m[2][0], m[2][1], m[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[pivot][col])) pivot = row;
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) return null;
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / aug[col][col];
      for (let k = col; k < 4; k++) aug[row][k] -= factor * aug[col][k];
    }
  }
  return [aug[0][3] / aug[0][0], aug[1][3] / aug[1][1], aug[2][3] / aug[2][2]];
}

/**
 * Owns the overlay canvases, the animation loop, and all per-frame drawing for
 * one map instance. Created on activate, torn down on deactivate.
 */
class EffectsEngine {
  private readonly map: MapLibreMap;
  private readonly spaceCanvas: HTMLCanvasElement;
  private readonly haloCanvas: HTMLCanvasElement;
  private readonly spaceCtx: CanvasRenderingContext2D;
  private readonly haloCtx: CanvasRenderingContext2D;

  private starfield: HTMLCanvasElement | null = null;
  private starfieldOriginLng = 0;
  private starfieldOriginLat = 0;
  private comets: Comet[] = [];
  // Cached space-background gradient; only depends on size, so rebuilt on resize.
  private spaceGradient: CanvasGradient | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;

  // Cached globe silhouette. Fitting it costs many project/unproject round-trips,
  // but it only changes when the camera moves, so recompute lazily on a dirty
  // flag set by move/zoom/resize rather than every animation frame.
  private globeEllipse: GlobeEllipse | null = null;
  private ellipseDirty = true;

  private rafId: number | null = null;
  private destroyed = false;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.spaceCanvas = this.createCanvas(0);
    this.haloCanvas = this.createCanvas(1, "screen");
    this.spaceCtx = this.spaceCanvas.getContext("2d")!;
    this.haloCtx = this.haloCanvas.getContext("2d")!;

    const container = map.getCanvasContainer();
    container.appendChild(this.spaceCanvas);
    container.appendChild(this.haloCanvas);

    this.handleResize = this.handleResize.bind(this);
    this.handleVisibility = this.handleVisibility.bind(this);
    this.handleMapChange = this.handleMapChange.bind(this);
    this.tick = this.tick.bind(this);

    map.on("resize", this.handleResize);
    map.on("move", this.handleMapChange);
    map.on("zoom", this.handleMapChange);
    document.addEventListener("visibilitychange", this.handleVisibility);

    this.handleResize();
    this.start();
  }

  /** The map this engine is bound to (used to detect a map re-init). */
  getMapInstance(): MapLibreMap {
    return this.map;
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.map.off("resize", this.handleResize);
    this.map.off("move", this.handleMapChange);
    this.map.off("zoom", this.handleMapChange);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.spaceCanvas.remove();
    this.haloCanvas.remove();
  }

  private createCanvas(zIndex: number, blendMode?: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = "geolibre-effects-canvas";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    // Explicit pixel sizes are set in handleResize: the canvas container
    // collapses to 0 height, so a percentage height would resolve to 0.
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = String(zIndex);
    // The halo screen-blends against the layers below it (space canvas + map)
    // at the compositor level. This must be a CSS blend on the element: a 2D
    // context `globalCompositeOperation` would only blend against this canvas's
    // own pixels, which are cleared transparent each frame (i.e. a no-op).
    if (blendMode) canvas.style.mixBlendMode = blendMode;
    return canvas;
  }

  private handleVisibility(): void {
    if (document.hidden) {
      this.stop();
    } else {
      this.start();
    }
  }

  // move/zoom restart a loop that stopped because the effects had faded out.
  // MapLibre's "move" fires for pan, zoom, pitch, and rotate, so this also marks
  // the cached silhouette stale on any camera change.
  private handleMapChange(): void {
    this.ellipseDirty = true;
    if (!document.hidden) this.start();
  }

  private handleResize(): void {
    // Measure from the map's own canvas: the canvas container reports 0 height.
    const mapCanvas = this.map.getCanvas();
    this.width = mapCanvas.clientWidth;
    this.height = mapCanvas.clientHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    for (const ctx of [this.spaceCtx, this.haloCtx]) {
      const canvas = ctx.canvas;
      canvas.style.width = `${this.width}px`;
      canvas.style.height = `${this.height}px`;
      canvas.width = Math.round(this.width * this.dpr);
      canvas.height = Math.round(this.height * this.dpr);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.starfield = null; // regenerate at the new size on the next frame
    this.spaceGradient = null; // rebuild for the new dimensions
    this.ellipseDirty = true; // silhouette depends on viewport size
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
    this.haloCtx.clearRect(0, 0, this.width, this.height);
  }

  private alphaForZoom(): number {
    const zoom = this.map.getZoom();
    if (zoom <= ZOOM_FADE_START) return 1;
    if (zoom >= ZOOM_FADE_END) return 0;
    return 1 - (zoom - ZOOM_FADE_START) / (ZOOM_FADE_END - ZOOM_FADE_START);
  }

  private ensureStarfield(): void {
    if (this.starfield) return;
    const center = this.map.getCenter();
    this.starfieldOriginLng = center.lng;
    this.starfieldOriginLat = center.lat;

    const fieldWidth = this.width + STARFIELD_MARGIN * 2;
    const fieldHeight = this.height + STARFIELD_MARGIN * 2;
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
          ? `hsla(220, 70%, 80%, ${star.alpha})`
          : `hsla(40, 80%, 80%, ${star.alpha})`;
    }
    if (star.glow) {
      const glow = ctx.createRadialGradient(
        star.x,
        star.y,
        0,
        star.x,
        star.y,
        star.size * 3,
      );
      glow.addColorStop(0, color);
      glow.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawStarfield(alpha: number): void {
    this.ensureStarfield();
    if (!this.starfield) return;
    const center = this.map.getCenter();
    let offsetX = clamp(
      (center.lng - this.starfieldOriginLng) * PARALLAX_PX_PER_DEGREE,
      -STARFIELD_MARGIN,
      STARFIELD_MARGIN,
    );
    let offsetY = clamp(
      (center.lat - this.starfieldOriginLat) * PARALLAX_PX_PER_DEGREE,
      -STARFIELD_MARGIN,
      STARFIELD_MARGIN,
    );
    // When drift reaches the margin, regenerate so the field re-centers without
    // ever revealing an unpainted edge.
    if (
      Math.abs(offsetX) >= STARFIELD_MARGIN ||
      Math.abs(offsetY) >= STARFIELD_MARGIN
    ) {
      this.starfield = null;
      this.ensureStarfield();
      offsetX = 0;
      offsetY = 0;
    }

    const field = this.starfield;
    if (!field) return;
    this.spaceCtx.save();
    this.spaceCtx.globalAlpha = alpha;
    this.spaceCtx.drawImage(
      field,
      -STARFIELD_MARGIN + offsetX,
      -STARFIELD_MARGIN + offsetY,
      this.width + STARFIELD_MARGIN * 2,
      this.height + STARFIELD_MARGIN * 2,
    );
    this.spaceCtx.restore();
  }

  private updateAndDrawComets(alpha: number): void {
    // One comet at a time, spawned with ~0.5% probability per frame.
    if (this.comets.length === 0 && Math.random() < 0.005) {
      this.comets.push(this.spawnComet());
    }

    const ctx = this.spaceCtx;
    const survivors: Comet[] = [];
    for (const comet of this.comets) {
      comet.x += Math.cos(comet.angle) * comet.speed;
      comet.y += Math.sin(comet.angle) * comet.speed;
      comet.life += 1;

      const offscreen =
        comet.x < -comet.len ||
        comet.x > this.width + comet.len ||
        comet.y < -comet.len ||
        comet.y > this.height + comet.len;
      if (comet.life >= comet.maxLife || offscreen) continue;
      survivors.push(comet);

      // Smooth fade in and out across the comet's lifetime.
      const lifeAlpha =
        Math.sin((comet.life / comet.maxLife) * Math.PI) * 0.9 * alpha;
      if (lifeAlpha <= 0) continue;

      const tailX = comet.x - Math.cos(comet.angle) * comet.len;
      const tailY = comet.y - Math.sin(comet.angle) * comet.len;
      const gradient = ctx.createLinearGradient(tailX, tailY, comet.x, comet.y);
      gradient.addColorStop(0, "rgba(255, 255, 255, 0)");
      gradient.addColorStop(1, `rgba(255, 255, 255, ${lifeAlpha})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(comet.x, comet.y);
      ctx.stroke();

      ctx.fillStyle = `rgba(200, 220, 255, ${0.5 * lifeAlpha})`;
      ctx.beginPath();
      ctx.arc(comet.x, comet.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    this.comets = survivors;
  }

  private spawnComet(): Comet {
    // Enter from the top; angle points down, randomly leaning left or right.
    const leanRight = Math.random() < 0.5;
    const base = Math.PI * 0.15 + Math.random() * Math.PI * 0.3;
    return {
      x: Math.random() * this.width,
      y: Math.random() * this.height * 0.4,
      len: 150 + Math.random() * 200,
      speed: 6 + Math.random() * 8,
      angle: leanRight ? base : Math.PI - base,
      life: 0,
      maxLife: 80 + Math.random() * 40,
    };
  }

  private punchOutGlobe(disc: GlobeEllipse): void {
    // Remove the deep-space layer over the globe silhouette so the real basemap
    // globe shows through; the halo (drawn on its own canvas) hides any seam.
    this.spaceCtx.save();
    this.spaceCtx.globalCompositeOperation = "destination-out";
    this.spaceCtx.fillStyle = "rgba(0, 0, 0, 1)";
    this.spaceCtx.beginPath();
    this.spaceCtx.ellipse(
      disc.cx,
      disc.cy,
      disc.rx * LIMB_INSET,
      disc.ry * LIMB_INSET,
      disc.angle,
      0,
      Math.PI * 2,
    );
    this.spaceCtx.fill();
    this.spaceCtx.restore();
  }

  private drawSpaceBackground(alpha: number): void {
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
      gradient.addColorStop(0, "#0c1b33");
      gradient.addColorStop(1, "#081222");
      this.spaceGradient = gradient;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.spaceGradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private drawHalo(disc: GlobeEllipse, alpha: number): void {
    const ctx = this.haloCtx;
    ctx.save();
    // Work in a normalized space where the silhouette is the unit circle: shift
    // to the center, rotate to the ellipse axes, then scale by the semi-axes.
    // A circular radial gradient and annulus drawn here map to an ellipse that
    // hugs the globe at any pitch — the halo thickens along the major axis, as a
    // real atmospheric rim does under perspective.
    ctx.translate(disc.cx, disc.cy);
    ctx.rotate(disc.angle);
    // Same inset as the punch-out so the two edges coincide; the unit circle in
    // this frame is then the inset limb, where the halo's opaque inner stop sits.
    ctx.scale(disc.rx * LIMB_INSET, disc.ry * LIMB_INSET);

    const gradient = ctx.createRadialGradient(0, 0, 1, 0, 0, HALO_RADIUS_SCALE);
    for (const [stop, color] of HALO_STOPS) {
      gradient.addColorStop(stop, color);
    }
    // The screen blend is applied via the canvas element's mix-blend-mode
    // (set in createCanvas); here we just paint the gradient normally.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    // Paint only the annulus outside the globe (outer ring CW, inner ring CCW
    // cancels the winding in the hole — nonzero rule), so the rim glows without
    // tinting the globe disc.
    ctx.beginPath();
    ctx.arc(0, 0, HALO_RADIUS_SCALE, 0, Math.PI * 2, false);
    ctx.arc(0, 0, 1, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();
  }

  private tick(): void {
    this.rafId = null;
    if (this.destroyed) return;

    this.clear();

    const alpha = isGlobeProjection(this.map) ? this.alphaForZoom() : 0;
    if (alpha <= 0) {
      // Faded out / not globe: idle without burning frames. A later move/zoom
      // (handleMapChange) restarts the loop when the globe comes back.
      return;
    }

    if (this.ellipseDirty) {
      this.globeEllipse = getGlobeEllipse(this.map);
      this.ellipseDirty = false;
    }
    const disc = this.globeEllipse;
    this.drawSpaceBackground(alpha);
    this.drawStarfield(alpha);
    this.updateAndDrawComets(alpha);
    if (disc) {
      this.punchOutGlobe(disc);
      this.drawHalo(disc, alpha);
    }

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

function attachEngine(app: GeoLibreAppAPI): boolean {
  const map = app.getMap?.();
  if (!map) return false;
  // A map re-init hands back a different MapLibreMap instance; tear down the
  // engine bound to the old map (its canvases/listeners) before rebinding.
  if (engine && engine.getMapInstance() !== map) detachEngine();
  if (!engine) engine = new EffectsEngine(map);
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
export function restoreEffects(app: GeoLibreAppAPI, active: boolean): void {
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
};
