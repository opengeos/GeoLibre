/**
 * The real night sky behind the globe for the effects plugin: ~5,000 stars
 * (position, magnitude, colour) and the Milky Way outlines from d3-celestial
 * (BSD-3-Clause, Olaf Frohn), placed where they are at this moment. The clock
 * gives Earth's sidereal rotation and the globe camera looks through the Earth
 * at the sky beyond it. The data is a chunk of its own, loaded on first use.
 */

type Vec3 = readonly [number, number, number];

interface Sky {
  starXyz: Float32Array;
  mag: Float32Array;
  tint: string[];
  /** Each constellation figure as unit vectors of its vertices. */
  figures: Float32Array[];
  /** Per brightness level (faintest first), its rings as unit vectors. */
  milkyWay: Float32Array[][];
}

const RAD = Math.PI / 180;
// MapLibre's camera looks with a 36.87° vertical field of view.
const FOCAL_HALF_FOV = Math.tan((36.87 * RAD) / 2);
const COS_EDGE = Math.cos(80 * RAD);
const TEX_W = 1024;
const TEX_H = 512;
// Per brightness level, how much each Milky Way outline adds (x10 in the texture for precision).
const LEVEL_ALPHA = [0.01, 0.014, 0.018, 0.022, 0.028];
const TEX_GAIN = 10;
const MILKY_STEP = 4;

let sky: Sky | null = null;
let loading = false;
// Redraw callbacks from every caller that asked while the data was loading.
const pending = new Set<() => void>();
let milkyTexture: Float32Array | null = null;
let milkyCanvas: HTMLCanvasElement | null = null;
// Reused across redraws (the starfield redraws during camera motion); rebuilt when the size changes.
let milkyImage: ImageData | null = null;

function unitFrom(raDeg: number, decDeg: number, out: Float32Array, i: number): void {
  const a = raDeg * RAD;
  const d = decDeg * RAD;
  out[i] = Math.cos(d) * Math.cos(a);
  out[i + 1] = Math.cos(d) * Math.sin(a);
  out[i + 2] = Math.sin(d);
}

/** A star's colour (rgb) from its B-V index: blue-white to white to orange. */
function tintOf(bv: number): string {
  if (bv < 0) return "176,205,255";
  if (bv < 0.5) return "240,244,255";
  if (bv < 0.9) return "255,244,220";
  if (bv < 1.3) return "255,216,170";
  return "255,184,130";
}

function pathOf(flat: readonly number[]): Float32Array {
  const v = new Float32Array((flat.length / 2) * 3);
  for (let i = 0; i < flat.length; i += 2) unitFrom(flat[i], flat[i + 1], v, (i / 2) * 3);
  return v;
}

/** Load the sky data once; every `onLoad` asked meanwhile redraws when it arrives. Until then the sky is empty. */
export function loadSky(onLoad: () => void): void {
  if (sky) return onLoad();
  pending.add(onLoad);
  if (loading) return;
  loading = true;
  void import("./maplibre-effects-sky-data")
    .then(({ STARS, FIGURES, MILKY_WAY }) => {
      const starXyz = new Float32Array(STARS.length * 3);
      const mag = new Float32Array(STARS.length);
      const tint: string[] = [];
      STARS.forEach(([ra, dec, m, bv], i) => {
        unitFrom(ra, dec, starXyz, i * 3);
        mag[i] = m / 10;
        tint.push(tintOf(bv / 10));
      });
      sky = {
        starXyz,
        mag,
        tint,
        figures: FIGURES.map(pathOf),
        milkyWay: MILKY_WAY.map((level) => level.map(pathOf)),
      };
      loading = false;
      const callbacks = [...pending];
      pending.clear();
      for (const callback of callbacks) {
        // One caller failing must not stop the rest from redrawing.
        try {
          callback();
        } catch (error) {
          console.error("Night-sky redraw failed", error);
        }
      }
    })
    .catch((error) => {
      console.error("Night-sky data failed to load", error);
      loading = false;
      pending.clear();
    });
}

/** Greenwich mean sidereal time in radians (Meeus, Astronomical Algorithms). */
function siderealTime(nowMs: number): number {
  const days = nowMs / 86_400_000 + 2_440_587.5 - 2_451_545.0;
  return ((((280.46061837 + 360.98564736629 * days) % 360) + 360) % 360) * RAD;
}

/**
 * The camera over (lng, lat) in the inertial frame at `nowMs`: its position
 * from Earth's centre, and screen right/up (east/north turned by the bearing).
 */
function skyFrame(
  center: { lng: number; lat: number },
  bearingDeg: number,
  nowMs: number,
): { at: Vec3; right: Vec3; up: Vec3 } {
  const theta = siderealTime(nowMs);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const toSky = (x: number, y: number, z: number): Vec3 => [x * ct - y * st, x * st + y * ct, z];
  const lng = center.lng * RAD;
  const lat = center.lat * RAD;
  const at = toSky(Math.cos(lat) * Math.cos(lng), Math.cos(lat) * Math.sin(lng), Math.sin(lat));
  const east = toSky(-Math.sin(lng), Math.cos(lng), 0);
  const north = toSky(
    -Math.sin(lat) * Math.cos(lng),
    -Math.sin(lat) * Math.sin(lng),
    Math.cos(lat),
  );
  const cb = Math.cos(bearingDeg * RAD);
  const sb = Math.sin(bearingDeg * RAD);
  const mix = (e: number, n: number, i: number): number => east[i] * e + north[i] * n;
  return {
    at,
    right: [mix(cb, -sb, 0), mix(cb, -sb, 1), mix(cb, -sb, 2)],
    up: [mix(sb, cb, 0), mix(sb, cb, 1), mix(sb, cb, 2)],
  };
}

/**
 * The Milky Way painted once in right ascension / declination: 0..1 brightness
 * per texel, or `null` when no 2D context is available (so it is retried, not
 * cached as an empty texture).
 */
function buildMilkyTexture(data: Sky): Float32Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const out = new Float32Array(TEX_W * TEX_H);
  ctx.globalCompositeOperation = "lighter";
  data.milkyWay.forEach((rings, level) => {
    ctx.beginPath();
    for (const ring of rings) {
      // Unwrap right ascension so a ring crossing 0/360 stays one piece, and draw it a turn to either side too.
      const xs: number[] = [];
      const ys: number[] = [];
      let prev = 0;
      for (let i = 0; i < ring.length; i += 3) {
        let ra = Math.atan2(ring[i + 1], ring[i]) / RAD;
        if (i > 0) while (ra - prev > 180) ra -= 360;
        if (i > 0) while (ra - prev < -180) ra += 360;
        prev = ra;
        xs.push((ra / 360) * TEX_W);
        ys.push(((90 - Math.asin(Math.max(-1, Math.min(1, ring[i + 2]))) / RAD) / 180) * TEX_H);
      }
      // A ring that goes once around the whole sky is open in this flat view: close it through the north pole.
      const around = Math.abs(xs[xs.length - 1] - xs[0]) > TEX_W / 2;
      for (const shift of [-TEX_W, 0, TEX_W]) {
        xs.forEach((x, k) => (k ? ctx.lineTo(x + shift, ys[k]) : ctx.moveTo(x + shift, ys[k])));
        if (around) {
          ctx.lineTo(xs[xs.length - 1] + shift, 0);
          ctx.lineTo(xs[0] + shift, 0);
        }
        ctx.closePath();
      }
    }
    ctx.fillStyle = `rgba(255,255,255,${((LEVEL_ALPHA[level] ?? 0.02) * TEX_GAIN).toFixed(3)})`;
    ctx.fill("evenodd");
  });
  const px = ctx.getImageData(0, 0, TEX_W, TEX_H).data;
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] / 255 / TEX_GAIN;
  return out;
}

function drawMilkyWay(
  ctx: CanvasRenderingContext2D,
  data: Sky,
  w: number,
  h: number,
  focal: number,
  at: Vec3,
  right: Vec3,
  up: Vec3,
): void {
  milkyTexture ??= buildMilkyTexture(data);
  const tex = milkyTexture;
  if (!tex) return;
  const cw = Math.max(1, Math.ceil(w / MILKY_STEP));
  const ch = Math.max(1, Math.ceil(h / MILKY_STEP));
  milkyCanvas ??= document.createElement("canvas");
  if (milkyCanvas.width !== cw || milkyCanvas.height !== ch) {
    milkyCanvas.width = cw;
    milkyCanvas.height = ch;
  }
  const mctx = milkyCanvas.getContext("2d");
  if (!mctx) return;
  if (!milkyImage || milkyImage.width !== cw || milkyImage.height !== ch) {
    milkyImage = mctx.createImageData(cw, ch);
  }
  const img = milkyImage;
  const px = img.data;
  for (let j = 0; j < ch; j++) {
    const b = (h / 2 - (j + 0.5) * MILKY_STEP) / focal;
    for (let i = 0; i < cw; i++) {
      const a = ((i + 0.5) * MILKY_STEP - w / 2) / focal;
      // The ray's direction in the sky: forward is away from the camera, through the Earth.
      const vx = a * right[0] + b * up[0] - at[0];
      const vy = a * right[1] + b * up[1] - at[1];
      const vz = a * right[2] + b * up[2] - at[2];
      const len = Math.hypot(vx, vy, vz);
      let ra = Math.atan2(vy, vx) / (2 * Math.PI);
      ra -= Math.floor(ra);
      const x = Math.min(TEX_W - 1, Math.floor(ra * TEX_W));
      const y = Math.min(
        TEX_H - 1,
        Math.floor(((Math.PI / 2 - Math.asin(vz / len)) / Math.PI) * TEX_H),
      );
      const o = (j * cw + i) * 4;
      px[o] = 185;
      px[o + 1] = 200;
      px[o + 2] = 235;
      px[o + 3] = Math.min(255, tex[y * TEX_W + x] * 255);
    }
  }
  mctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(milkyCanvas, 0, 0, w, h);
  ctx.restore();
}

export interface SkyLayers {
  stars: boolean;
  milkyWay: boolean;
  constellations: boolean;
}

/**
 * Paint the chosen sky layers as the globe camera sees them, into a context
 * already scaled to CSS pixels. Returns false (drawing nothing) until the data
 * has loaded.
 */
export function drawRealSky(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  center: { lng: number; lat: number },
  bearing: number,
  layers: SkyLayers,
): boolean {
  const data = sky;
  if (!data) return false;
  const { at, right, up } = skyFrame(center, bearing, Date.now());
  const focal = h / 2 / FOCAL_HALF_FOV;

  if (layers.milkyWay) drawMilkyWay(ctx, data, w, h, focal, at, right, up);

  if (layers.constellations) {
    ctx.beginPath();
    for (const fig of data.figures) {
      let pen = false;
      for (let i = 0; i < fig.length; i += 3) {
        const vx = fig[i];
        const vy = fig[i + 1];
        const vz = fig[i + 2];
        const d = -(vx * at[0] + vy * at[1] + vz * at[2]);
        if (d < COS_EDGE) {
          pen = false;
          continue;
        }
        const x = w / 2 + (focal * (vx * right[0] + vy * right[1] + vz * right[2])) / d;
        const y = h / 2 - (focal * (vx * up[0] + vy * up[1] + vz * up[2])) / d;
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(150,185,255,0.13)";
    ctx.stroke();
  }

  if (!layers.stars) return true;
  const { starXyz, mag, tint } = data;
  for (let i = 0; i < mag.length; i++) {
    const vx = starXyz[i * 3];
    const vy = starXyz[i * 3 + 1];
    const vz = starXyz[i * 3 + 2];
    // Forward is away from the camera's position, through the Earth.
    const d = -(vx * at[0] + vy * at[1] + vz * at[2]);
    if (d < COS_EDGE) continue;
    const x = w / 2 + (focal * (vx * right[0] + vy * right[1] + vz * right[2])) / d;
    const y = h / 2 - (focal * (vx * up[0] + vy * up[1] + vz * up[2])) / d;
    if (x < -8 || y < -8 || x > w + 8 || y > h + 8) continue;
    const m = mag[i];
    const r = 0.5 + Math.max(0, 5.2 - m) * 0.3;
    const alpha = Math.min(0.95, 0.42 + (5.2 - m) * 0.14);
    if (m < 2.4) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      g.addColorStop(0, `rgba(${tint[i]},0.22)`);
      g.addColorStop(1, `rgba(${tint[i]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
    }
    ctx.fillStyle = `rgba(${tint[i]},${alpha.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return true;
}
