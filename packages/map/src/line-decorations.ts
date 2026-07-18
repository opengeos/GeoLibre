import {
  normalizeHexColor,
  styleValue,
  type LayerStyle,
  type LineDecoration,
} from "@geolibre/core";
import { lineDecorationColorValue } from "./derived-geometry";
import { registerGeneratedImage, type GeneratedImageResult } from "./generated-images";

/**
 * Lazily-generated decoration icons repeated along line features (QGIS
 * marker-line / arrow lines). Follows the marker sprite pattern in
 * `markers.ts`: a deterministic image id encodes shape + color + size, and the
 * `styleimagemissing` handler materializes the bitmap on demand.
 *
 * The arrow is drawn pointing right (+x). With `symbol-placement: "line"`
 * MapLibre rotates the icon so its x-axis follows the line direction, which
 * makes the arrowhead point along the feature with no explicit rotation.
 */

const DECORATION_PIXEL_RATIO = 2;
const MIN_DECORATION_SIZE = 4;
const MAX_DECORATION_SIZE = 64;

const DECORATION_SHAPES: ReadonlySet<LineDecoration> = new Set([
  "arrow",
  "triangle",
  "circle",
  "square",
]);

function decorationSize(style: LayerStyle): number {
  const size = styleValue(style, "lineDecorationSize");
  if (!Number.isFinite(size)) return 12;
  return Math.min(MAX_DECORATION_SIZE, Math.max(MIN_DECORATION_SIZE, Math.round(size)));
}

function drawDecoration(ctx: CanvasRenderingContext2D, shape: LineDecoration, size: number): void {
  const c = size / 2;
  const r = c * 0.82;
  ctx.beginPath();
  switch (shape) {
    case "arrow":
      // A solid arrowhead pointing +x with a notched tail, so direction reads
      // clearly even at small sizes.
      ctx.moveTo(c + r, c);
      ctx.lineTo(c - r, c - r * 0.78);
      ctx.lineTo(c - r * 0.35, c);
      ctx.lineTo(c - r, c + r * 0.78);
      ctx.closePath();
      break;
    case "triangle":
      // Pointing +x so it doubles as a subtle direction marker.
      ctx.moveTo(c + r, c);
      ctx.lineTo(c - r, c - r);
      ctx.lineTo(c - r, c + r);
      ctx.closePath();
      break;
    case "square":
      ctx.rect(c - r * 0.85, c - r * 0.85, r * 1.7, r * 1.7);
      break;
    case "circle":
    default:
      ctx.arc(c, c, r * 0.9, 0, Math.PI * 2);
  }
}

function drawDecorationImage(
  shape: LineDecoration,
  color: string,
  size: number,
): GeneratedImageResult | null {
  const ratio = DECORATION_PIXEL_RATIO;
  const px = size * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = color;
  // Match the marker sprites' translucent halo so decorations stay legible
  // over busy basemaps in both themes.
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(1, ratio);
  ctx.lineJoin = "round";
  drawDecoration(ctx, shape, px);
  ctx.fill();
  ctx.stroke();
  return { image: ctx.getImageData(0, 0, px, px), pixelRatio: ratio };
}

/**
 * Resolve the `icon-image` id for a layer's line decoration, registering the
 * lazy factory that draws it. Returns `null` when decorations are off, in
 * which case the caller removes the decoration layer.
 *
 * @param style - The layer style.
 * @returns The image id, or `null` when no decoration applies.
 */
export function prepareLineDecoration(style: LayerStyle): string | null {
  const shape = styleValue(style, "lineDecoration");
  if (!DECORATION_SHAPES.has(shape)) return null;
  const size = decorationSize(style);
  const color = normalizeHexColor(lineDecorationColorValue(style)) ?? "#1e40af";
  const id = `geolibre-line-decoration-${shape}-${color.replace("#", "")}-${size}`;
  registerGeneratedImage(id, () => drawDecorationImage(shape, color, size));
  return id;
}
