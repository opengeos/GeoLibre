import {
  normalizeHexColor,
  styleValue,
  type FillPattern,
  type LayerStyle,
} from "@geolibre/core";
import {
  hashText,
  registerGeneratedImage,
  resolveSvgSource,
  type GeneratedImageResult,
} from "./generated-images";

// Logical tile size in CSS pixels; rendered at PATTERN_PIXEL_RATIO for crisp
// lines on HiDPI displays. A 16px tile keeps the pattern dense enough to read at
// typical polygon sizes while tiling seamlessly.
const PATTERN_TILE_SIZE = 16;
const PATTERN_PIXEL_RATIO = 2;

const BUILTIN_PATTERNS: ReadonlySet<FillPattern> = new Set([
  "hatch",
  "cross-hatch",
  "horizontal",
  "vertical",
  "dots",
]);

function patternColor(style: LayerStyle): string {
  return (
    normalizeHexColor(styleValue(style, "fillPatternColor")) ?? "#1e40af"
  );
}

function drawBuiltinPattern(
  pattern: FillPattern,
  color: string,
): GeneratedImageResult | null {
  const ratio = PATTERN_PIXEL_RATIO;
  const size = PATTERN_TILE_SIZE * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, 1.5 * ratio);
  ctx.lineCap = "round";

  const half = size / 2;
  // Draw each line family at three offsets (-size, 0, +size) so the lines wrap
  // continuously across tile seams.
  const diagonal = (rising: boolean) => {
    for (const offset of [-size, 0, size]) {
      ctx.beginPath();
      if (rising) {
        ctx.moveTo(offset, size);
        ctx.lineTo(offset + size, 0);
      } else {
        ctx.moveTo(offset, 0);
        ctx.lineTo(offset + size, size);
      }
      ctx.stroke();
    }
  };

  switch (pattern) {
    case "hatch":
      diagonal(true);
      break;
    case "cross-hatch":
      diagonal(true);
      diagonal(false);
      break;
    case "horizontal":
      ctx.beginPath();
      ctx.moveTo(0, half);
      ctx.lineTo(size, half);
      ctx.stroke();
      break;
    case "vertical":
      ctx.beginPath();
      ctx.moveTo(half, 0);
      ctx.lineTo(half, size);
      ctx.stroke();
      break;
    case "dots":
      ctx.beginPath();
      ctx.arc(half, half, Math.max(1.5, 2 * ratio), 0, Math.PI * 2);
      ctx.fill();
      break;
    default:
      return null;
  }

  return {
    image: ctx.getImageData(0, 0, size, size),
    pixelRatio: ratio,
  };
}

function loadSvgImage(markup: string): Promise<GeneratedImageResult | null> {
  const src = resolveSvgSource(markup);
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve({ image, pixelRatio: 1 });
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * Resolve the `fill-pattern` image id for a layer style, registering the lazy
 * factory that draws it. Returns `null` for `"none"` (a flat fill) or an empty
 * custom SVG, in which case the caller leaves `fill-pattern` unset.
 *
 * The id encodes the pattern and color so a recolor produces a distinct image;
 * `MapLibre`'s `styleimagemissing` handler (see {@link ensureGeneratedImageHandler})
 * materializes it on first reference.
 *
 * @param style - The layer style.
 * @returns The image id, or `null` when no pattern applies.
 */
export function prepareFillPattern(style: LayerStyle): string | null {
  const pattern = styleValue(style, "fillPattern");
  if (pattern === "none") return null;

  if (pattern === "svg") {
    const markup = styleValue(style, "fillPatternSvg").trim();
    if (!markup) return null;
    const id = `geolibre-pattern-svg-${hashText(markup)}`;
    // Capture the markup in the factory closure so the lazy generator never
    // depends on a separate, evictable cache (which could blank the pattern).
    registerGeneratedImage(id, () => loadSvgImage(markup));
    return id;
  }

  if (!BUILTIN_PATTERNS.has(pattern)) return null;
  const color = patternColor(style);
  const id = `geolibre-pattern-${pattern}-${color.replace("#", "")}`;
  registerGeneratedImage(id, () => drawBuiltinPattern(pattern, color));
  return id;
}
