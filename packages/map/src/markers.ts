import {
  normalizeHexColor,
  styleValue,
  type LayerStyle,
  type MarkerShape,
} from "@geolibre/core";
import {
  hashText,
  registerGeneratedImage,
  resolveSvgSource,
  type GeneratedImageResult,
} from "./generated-images";

const MARKER_PIXEL_RATIO = 2;
// Clamp the baked marker size so a hand-edited project cannot request an
// enormous canvas; the rendered size is set via the marker image's own pixels.
const MIN_MARKER_SIZE = 6;
const MAX_MARKER_SIZE = 96;

const BUILTIN_SHAPES: ReadonlySet<MarkerShape> = new Set([
  "circle",
  "square",
  "triangle",
  "diamond",
  "star",
  "cross",
  "pin",
]);

function markerColor(style: LayerStyle): string {
  return normalizeHexColor(styleValue(style, "markerColor")) ?? "#3b82f6";
}

function markerSize(style: LayerStyle): number {
  const size = styleValue(style, "markerSize");
  if (!Number.isFinite(size)) return 18;
  return Math.min(MAX_MARKER_SIZE, Math.max(MIN_MARKER_SIZE, Math.round(size)));
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  size: number,
): void {
  const c = size / 2;
  // Leave a small inset so the stroke is not clipped at the tile edge.
  const r = c * 0.82;
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.arc(c, c, r, 0, Math.PI * 2);
      break;
    case "square":
      ctx.rect(c - r, c - r, r * 2, r * 2);
      break;
    case "triangle":
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r, c + r);
      ctx.lineTo(c - r, c + r);
      ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(c, c - r);
      ctx.lineTo(c + r, c);
      ctx.lineTo(c, c + r);
      ctx.lineTo(c - r, c);
      ctx.closePath();
      break;
    case "star": {
      const outer = r;
      const inner = r * 0.42;
      for (let point = 0; point < 10; point += 1) {
        const radius = point % 2 === 0 ? outer : inner;
        const angle = (Math.PI / 5) * point - Math.PI / 2;
        const x = c + radius * Math.cos(angle);
        const y = c + radius * Math.sin(angle);
        if (point === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      break;
    }
    case "cross": {
      const arm = r * 0.42;
      ctx.moveTo(c - arm, c - r);
      ctx.lineTo(c + arm, c - r);
      ctx.lineTo(c + arm, c - arm);
      ctx.lineTo(c + r, c - arm);
      ctx.lineTo(c + r, c + arm);
      ctx.lineTo(c + arm, c + arm);
      ctx.lineTo(c + arm, c + r);
      ctx.lineTo(c - arm, c + r);
      ctx.lineTo(c - arm, c + arm);
      ctx.lineTo(c - r, c + arm);
      ctx.lineTo(c - r, c - arm);
      ctx.lineTo(c - arm, c - arm);
      ctx.closePath();
      break;
    }
    case "pin": {
      // A teardrop: a circle bowl with a point at the bottom.
      const bowlR = r * 0.7;
      const bowlY = c - r * 0.2;
      ctx.moveTo(c, c + r);
      ctx.quadraticCurveTo(c - bowlR, bowlY + bowlR * 0.4, c - bowlR, bowlY);
      ctx.arc(c, bowlY, bowlR, Math.PI, Math.PI * 2);
      ctx.quadraticCurveTo(c + bowlR, bowlY + bowlR * 0.4, c, c + r);
      ctx.closePath();
      break;
    }
    default:
      ctx.arc(c, c, r, 0, Math.PI * 2);
  }
}

function drawBuiltinMarker(
  shape: MarkerShape,
  color: string,
  size: number,
): GeneratedImageResult | null {
  const ratio = MARKER_PIXEL_RATIO;
  const px = size * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = color;
  // A translucent white halo keeps the marker legible over busy basemaps in
  // both light and dark themes.
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(1, ratio);
  ctx.lineJoin = "round";
  drawShape(ctx, shape, px);
  ctx.fill();
  ctx.stroke();
  return { image: ctx.getImageData(0, 0, px, px), pixelRatio: ratio };
}

function loadSvgMarker(
  markup: string,
  size: number,
): Promise<GeneratedImageResult | null> {
  const src = resolveSvgSource(markup);
  if (!src) return Promise.resolve(null);
  const ratio = MARKER_PIXEL_RATIO;
  const px = size * ratio;
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    // Request CORS-clean pixels so a cross-origin SVG can be read back below.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      // Rasterize onto a canvas at the requested size. Assigning image.width /
      // height would not work: addImage reads the SVG's intrinsic
      // naturalWidth/naturalHeight, so the marker size would be ignored.
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      try {
        ctx.clearRect(0, 0, px, px);
        ctx.drawImage(image, 0, 0, px, px);
        resolve({ image: ctx.getImageData(0, 0, px, px), pixelRatio: ratio });
      } catch {
        // A cross-origin source without CORS headers taints the canvas, so
        // getImageData throws SecurityError; resolve null instead of hanging.
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Resolve the `icon-image` id for a point layer's marker, registering the lazy
 * factory that draws it. Returns `null` when markers are disabled or a custom
 * SVG marker has no markup, in which case the caller renders a plain circle
 * instead.
 *
 * The id encodes shape, color, and size so a recolor or resize produces a
 * distinct image; the marker is baked at its display size with `icon-size` left
 * at `1`. See {@link ensureGeneratedImageHandler} for materialization.
 *
 * @param style - The layer style.
 * @returns The image id, or `null` when no marker applies.
 */
export function prepareMarker(style: LayerStyle): string | null {
  if (!styleValue(style, "markerEnabled")) return null;
  const shape = styleValue(style, "markerShape");
  const size = markerSize(style);

  if (shape === "custom") {
    const markup = styleValue(style, "markerSvg").trim();
    if (!markup) return null;
    const id = `geolibre-marker-svg-${hashText(markup)}-${size}`;
    // Capture the markup in the factory closure so the lazy generator never
    // depends on a separate, evictable cache (which could blank the marker).
    registerGeneratedImage(id, () => loadSvgMarker(markup, size));
    return id;
  }

  if (!BUILTIN_SHAPES.has(shape)) return null;
  const color = markerColor(style);
  const id = `geolibre-marker-${shape}-${color.replace("#", "")}-${size}`;
  registerGeneratedImage(id, () => drawBuiltinMarker(shape, color, size));
  return id;
}
