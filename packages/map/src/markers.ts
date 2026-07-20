import {
  drawMarkerPath,
  normalizeHexColor,
  proportionalSizeRange,
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
  drawMarkerPath(ctx, shape, px);
  ctx.fill();
  ctx.stroke();
  return { image: ctx.getImageData(0, 0, px, px), pixelRatio: ratio };
}

/**
 * Load a custom SVG marker as a decoded `HTMLImageElement` for the Print Layout
 * legend, which draws it into a small swatch at an arbitrary size (unlike the
 * map's {@link loadSvgMarker}, which rasterizes to fixed-size sprite pixels).
 * Resolves `null` when the markup is empty/unsupported or the image fails to
 * load, so the caller falls back to a plain color swatch.
 *
 * @param markup - Raw SVG markup, a `data:` URL, or an `http(s)` URL.
 * @returns The decoded image, or `null`.
 */
export function loadMarkerSvgImage(markup: string): Promise<HTMLImageElement | null> {
  const src = resolveSvgSource(markup.trim());
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

function loadSvgMarker(markup: string, size: number): Promise<GeneratedImageResult | null> {
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
 * The pixel size the marker sprite is baked at. Normally the configured
 * `markerSize`, but with proportional sizing active (the shared
 * `proportionalSizeRange` guard from `@geolibre/core`, so marker activation
 * can never drift from circle-radius activation) the bake grows to cover
 * the largest proportional diameter (clamped to the canvas-safety maximum), so
 * `icon-size` mostly scales the sprite *down* instead of blowing a small bake
 * up ~10x into a blurry icon. Downscaling stays crisp; the residual upscale
 * past the 96 px clamp is at most ~2x, which the 2x bake pixel ratio absorbs
 * on standard-DPI displays.
 */
function markerBakedSize(style: LayerStyle): number {
  const base = markerSize(style);
  const range = proportionalSizeRange(style);
  if (!range) return base;
  const maxDiameter = 2 * Math.max(range.minRadius, range.maxRadius);
  if (maxDiameter <= base) return base;
  return Math.min(MAX_MARKER_SIZE, Math.round(maxDiameter));
}

/**
 * Builds the `icon-size` layout value for a marker symbol layer, honoring
 * proportional (graduated) symbol sizing. The marker sprite is baked at
 * {@link markerBakedSize}, so the constant value is `1`; when proportional
 * sizing applies (the shared `proportionalSizeRange` guard from
 * `@geolibre/core`), returns an `interpolate` whose outputs scale the sprite
 * so its on-screen width matches the diameter a proportional circle of the
 * same radius would span (`2 * radius / bakedSize`).
 *
 * Note: per-rule symbol-size overrides (rule-based mode) apply only to circle
 * rendering (`circleRadiusValue`'s `ruleOverrideValue` wrapper); marker
 * icon-size deliberately uses the layer-level proportional base only.
 *
 * @param style - The layer style.
 * @returns `1`, or a MapLibre `interpolate` expression for `icon-size`.
 */
export function markerIconSizeValue(style: LayerStyle): number | unknown[] {
  const range = proportionalSizeRange(style);
  if (!range) return 1;
  const size = markerBakedSize(style);
  // icon-size must not go negative; clamp so a hand-edited project with a
  // negative radius degrades to an invisible marker instead of a style error.
  return [
    "interpolate",
    ["linear"],
    ["to-number", ["get", range.property], range.minValue],
    range.minValue,
    Math.max(0, (2 * range.minRadius) / size),
    range.maxValue,
    Math.max(0, (2 * range.maxRadius) / size),
  ];
}

/**
 * Resolve the `icon-image` id for a point layer's marker, registering the lazy
 * factory that draws it. Returns `null` when markers are disabled or a custom
 * SVG marker has no markup, in which case the caller renders a plain circle
 * instead.
 *
 * The id encodes shape, color, and size so a recolor or resize produces a
 * distinct image; the marker is baked at {@link markerBakedSize} with
 * `icon-size` left at `1` (or scaled down per feature by
 * {@link markerIconSizeValue} when proportional sizing applies). See
 * {@link ensureGeneratedImageHandler} for materialization.
 *
 * @param style - The layer style.
 * @returns The image id, or `null` when no marker applies.
 */
export function prepareMarker(style: LayerStyle): string | null {
  if (!styleValue(style, "markerEnabled")) return null;
  const shape = styleValue(style, "markerShape");
  const size = markerBakedSize(style);

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
