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

// Roughly one star per this many CSS pixels of starfield area.
const STAR_AREA_PER_STAR = 900;
// Starfield parallax scales exactly like the reference: a full 360° longitude
// pan shifts one viewport width, and a 180° latitude pan shifts one height.
const STARFIELD_LNG_PERIOD_DEGREES = 360;
const STARFIELD_LAT_PERIOD_DEGREES = 180;

// Halo radial gradient — color stops are fractions of the gradient span, which
// runs from the globe edge out to HALO_RADIUS_SCALE × the globe radius.
const HALO_RADIUS_SCALE = 2.8;
const HALO_SAMPLE_COUNT = 16;
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

  private rafId: number | null = null;
  private destroyed = false;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.mapCanvas = map.getCanvas();
    this.previousMapCanvasZIndex = this.mapCanvas.style.zIndex;
    this.controlContainer =
      this.mapCanvas
        .closest(".maplibregl-map")
        ?.querySelector<HTMLElement>(".maplibregl-control-container") ?? null;
    this.previousControlContainerZIndex =
      this.controlContainer?.style.zIndex ?? "";
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
    this.mapCanvas.style.zIndex = "4";
    if (this.controlContainer) this.controlContainer.style.zIndex = "5";

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
    this.spaceCanvas.remove();
    this.starsCanvas.remove();
    this.cometCanvas.remove();
    this.haloCanvas.remove();
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
      gradient.addColorStop(0, "#0c1b33");
      gradient.addColorStop(1, "#081222");
      this.spaceGradient = gradient;
    }
    ctx.save();
    ctx.fillStyle = this.spaceGradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private drawHalo(disc: GlobeCircle): void {
    if (disc.radius < 5) return;
    const ctx = this.haloCtx;
    ctx.save();
    const gradient = ctx.createRadialGradient(
      disc.x,
      disc.y,
      disc.radius,
      disc.x,
      disc.y,
      disc.radius * HALO_RADIUS_SCALE,
    );
    for (const [stop, color] of HALO_STOPS) {
      gradient.addColorStop(stop, color);
    }
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(disc.x, disc.y, disc.radius * HALO_RADIUS_SCALE, 0, Math.PI * 2);
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
