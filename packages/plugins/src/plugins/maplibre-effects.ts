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
 * "screen" blend, the limb-sampling that keeps the halo aligned under pitch,
 * and the starfield/comet parameters. Re-implemented for GeoLibre's plugin
 * lifecycle (single on-top canvas that punches out the globe disc so the
 * effects show only around the globe regardless of the active basemap).
 */

export const EFFECTS_PLUGIN_ID = "maplibre-atmosphere-effects";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

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

interface GlobeDisc {
  x: number;
  y: number;
  r: number;
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
 * Screen-space center and radius of the rendered globe disc.
 *
 * Samples 16 points on the globe limb (great-circle distance π/2 from the map
 * center) and projects them; the bounding box of those points gives a disc
 * that stays aligned even when the map is pitched. Returns null when too few
 * points project to finite coordinates (e.g. the globe is off-screen).
 */
function getGlobeDisc(map: MapLibreMap): GlobeDisc | null {
  const center = map.getCenter();
  const clng = center.lng * D2R;
  const clat = center.lat * D2R;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let i = 0; i < 16; i++) {
    const bearing = (i / 16) * 2 * Math.PI;
    // Destination point at angular distance π/2 (the visible limb) along
    // `bearing`; the great-circle formulas simplify since cos(π/2)=0, sin(π/2)=1.
    const lat2 = Math.asin(Math.cos(clat) * Math.cos(bearing));
    const lng2 =
      clng +
      Math.atan2(
        Math.sin(bearing) * Math.cos(clat),
        -Math.sin(clat) * Math.sin(lat2),
      );

    const point = map.project([lng2 * R2D, lat2 * R2D]);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    count++;
  }

  if (count < 8) return null;
  const halfWidth = (maxX - minX) / 2;
  const halfHeight = (maxY - minY) / 2;
  return {
    x: minX + halfWidth,
    y: minY + halfHeight,
    r: (halfWidth + halfHeight) / 2,
  };
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

  private width = 0;
  private height = 0;
  private dpr = 1;

  private rafId: number | null = null;
  private destroyed = false;

  constructor(map: MapLibreMap) {
    this.map = map;
    this.spaceCanvas = this.createCanvas(0);
    this.haloCanvas = this.createCanvas(1);
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

  // move/zoom restart a loop that stopped because the effects had faded out.
  private handleMapChange(): void {
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

  private punchOutGlobe(disc: GlobeDisc): void {
    // Remove the deep-space layer over the globe disc so the real basemap globe
    // shows through; the halo (drawn on its own canvas) hides any seam.
    this.spaceCtx.save();
    this.spaceCtx.globalCompositeOperation = "destination-out";
    this.spaceCtx.fillStyle = "rgba(0, 0, 0, 1)";
    this.spaceCtx.beginPath();
    this.spaceCtx.arc(disc.x, disc.y, disc.r, 0, Math.PI * 2);
    this.spaceCtx.fill();
    this.spaceCtx.restore();
  }

  private drawSpaceBackground(alpha: number): void {
    const ctx = this.spaceCtx;
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
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  private drawHalo(disc: GlobeDisc, alpha: number): void {
    const ctx = this.haloCtx;
    const outer = disc.r * HALO_RADIUS_SCALE;
    const gradient = ctx.createRadialGradient(
      disc.x,
      disc.y,
      disc.r,
      disc.x,
      disc.y,
      outer,
    );
    for (const [stop, color] of HALO_STOPS) {
      gradient.addColorStop(stop, color);
    }
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = gradient;
    // Paint only the annulus outside the globe (outer circle CW, inner circle
    // CCW = an even-odd hole), so the rim glows without tinting the globe disc.
    ctx.beginPath();
    ctx.arc(disc.x, disc.y, outer, 0, Math.PI * 2, false);
    ctx.arc(disc.x, disc.y, disc.r, 0, Math.PI * 2, true);
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

    const disc = getGlobeDisc(this.map);
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
  deactivate: () => detachEngine(),
};
