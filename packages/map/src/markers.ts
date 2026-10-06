import {
  drawMarkerPath,
  isRasterMarkerSource,
  isSvgMarkerResponse,
  normalizeHexColor,
  proportionalSizeRange,
  styleValue,
  vectorColorExpression,
  type LayerStyle,
  type MarkerShape,
} from "@geolibre/core";
import {
  generatedImageToCanvas,
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
const MAX_SVG_SOURCE_CACHE = 64;
export const KML_ICON_URL_PROPERTY = "__geolibre_kml_icon_url";
// A remote source whose response is not SVG text (a PNG, JPEG, GIF, ...): the
// Image loads the URL itself, since there are no color parameters to resolve.
const RASTER_SOURCE = Symbol("raster-marker-source");
const svgSourceCache = new Map<string, Promise<string | typeof RASTER_SOURCE | null>>();
// The expression heads whose outputs markerImageValue rewrites into sprite ids.
const COLOR_BRANCH_HEADS: ReadonlySet<string> = new Set(["match", "step", "case"]);

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

function replaceSvgColorParameters(markup: string, color: string): string {
  return markup
    .replace(/param\(fill\)/gi, color)
    .replace(/param\(fill-opacity\)/gi, "1")
    .replace(/param\(outline\)/gi, color)
    .replace(/param\(outline-opacity\)/gi, "1")
    .replace(/param\(outline-width\)/gi, "0");
}

/**
 * Fetch a remote or `data:` marker source: its text when the response is SVG,
 * {@link RASTER_SOURCE} when it is another image type, `null` on an HTTP error.
 */
async function fetchMarkerSource(url: string): Promise<string | typeof RASTER_SOURCE | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  if (isSvgMarkerResponse(url, response.headers.get("content-type"))) return response.text();
  // The Image downloads the URL itself; drop this body unread.
  response.body?.cancel().catch(() => undefined);
  return RASTER_SOURCE;
}

/** An `Image.src` for a custom marker, and whether it is a raster image. */
interface MarkerImageSource {
  src: string;
  raster: boolean;
}

/**
 * Resolve a custom marker to an `Image.src`, substituting the QGIS color
 * parameters of an SVG source. Remote and `data:` SVG is fetched as text for
 * that; a raster source (by URL, or by the content type a remote URL answers
 * with) is passed through unchanged, because reading a PNG as text yields
 * garbage that resolves to no marker at all.
 */
async function colorizedMarkerSource(
  markup: string,
  color: string,
): Promise<MarkerImageSource | null> {
  if (isRasterMarkerSource(markup)) {
    const src = resolveSvgSource(markup);
    return src ? { src, raster: true } : null;
  }
  let sourceMarkup = markup;
  if (/^(?:https?:|data:image\/svg\+xml)/i.test(markup)) {
    let pending = svgSourceCache.get(markup);
    if (!pending) {
      pending = fetchMarkerSource(markup).catch(() => null);
      if (svgSourceCache.size >= MAX_SVG_SOURCE_CACHE) {
        const oldest = svgSourceCache.keys().next().value;
        if (oldest !== undefined) svgSourceCache.delete(oldest);
      }
      svgSourceCache.set(markup, pending);
    }
    const fetched = await pending;
    if (fetched === RASTER_SOURCE) {
      const src = resolveSvgSource(markup);
      return src ? { src, raster: true } : null;
    }
    if (fetched !== null) {
      sourceMarkup = fetched;
    } else {
      // Do not keep a failed fetch cached: a transient network error would
      // otherwise block every later color variant of the same source (and any
      // styleimagemissing retry) until the entry is evicted. Dropping it only
      // after the await still lets concurrent callers share the in-flight
      // promise.
      if (svgSourceCache.get(markup) === pending) svgSourceCache.delete(markup);
      // Preserve the original source when a remote host blocks CORS. The
      // marker still renders, although its QGIS color parameters cannot be
      // resolved without access to the SVG text.
    }
  }
  const src = resolveSvgSource(replaceSvgColorParameters(sourceMarkup, color));
  return src ? { src, raster: false } : null;
}

/**
 * Where to draw an image inside a square `px` canvas. SVG keeps filling the
 * square as before; a raster image is fitted inside it, centered, so a
 * non-square PNG or photo keeps its aspect ratio instead of being squashed.
 */
function markerDrawRect(
  image: HTMLImageElement,
  px: number,
  raster: boolean,
): [number, number, number, number] {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!raster || width <= 0 || height <= 0 || width === height) return [0, 0, px, px];
  const scale = px / Math.max(width, height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  return [(px - drawWidth) / 2, (px - drawHeight) / 2, drawWidth, drawHeight];
}

async function loadSvgMarker(
  markup: string,
  color: string,
  size: number,
): Promise<GeneratedImageResult | null> {
  const source = await colorizedMarkerSource(markup, color);
  if (!source) return Promise.resolve(null);
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
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, ...markerDrawRect(image, px, source.raster));
        resolve({ image: ctx.getImageData(0, 0, px, px), pixelRatio: ratio });
      } catch {
        // A cross-origin source without CORS headers taints the canvas, so
        // getImageData throws SecurityError; resolve null instead of hanging.
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = source.src;
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
export function prepareMarker(style: LayerStyle, colorOverride?: string): string | null {
  if (!styleValue(style, "markerEnabled")) return null;
  const shape = styleValue(style, "markerShape");
  const size = markerBakedSize(style);

  if (shape === "custom") {
    const markup = styleValue(style, "markerSvg").trim();
    if (!markup) return null;
    const color = colorOverride ?? markerColor(style);
    // A raster image ignores the color, so every class shares one sprite
    // instead of baking an identical copy per class color.
    const key = isRasterMarkerSource(markup) ? markup : `${markup}\0${color}`;
    const id = `geolibre-marker-svg-${hashText(key)}-${size}`;
    // Capture the markup in the factory closure so the lazy generator never
    // depends on a separate, evictable cache (which could blank the marker).
    registerGeneratedImage(id, () => loadSvgMarker(markup, color, size));
    return id;
  }

  if (!BUILTIN_SHAPES.has(shape)) return null;
  const color = colorOverride ?? markerColor(style);
  const id = `geolibre-marker-${shape}-${color.replace("#", "")}-${size}`;
  registerGeneratedImage(id, () => drawBuiltinMarker(shape, color, size));
  return id;
}

/**
 * The marker sprite as a canvas, for a renderer that takes an element rather
 * than a MapLibre image id (the globe's billboards). Baked at
 * {@link markerBakedSize} × the pixel ratio, so a billboard draws it at
 * `1 / pixelRatio` scale to land at the configured size. Resolves `null` when
 * markers are off or the custom SVG cannot be rasterised.
 *
 * @param style - The layer style.
 * @param colorOverride - The colour to bake, for a classified marker.
 */
export async function renderMarkerCanvas(
  style: LayerStyle,
  colorOverride?: string,
): Promise<{ canvas: HTMLCanvasElement; pixelRatio: number } | null> {
  if (!styleValue(style, "markerEnabled")) return Promise.resolve(null);
  const shape = styleValue(style, "markerShape");
  const size = markerBakedSize(style);
  const color = colorOverride ?? markerColor(style);
  if (shape === "custom") {
    const markup = styleValue(style, "markerSvg").trim();
    if (!markup) return Promise.resolve(null);
    return generatedImageToCanvas(loadSvgMarker(markup, color, size));
  }
  if (!BUILTIN_SHAPES.has(shape)) return Promise.resolve(null);
  return generatedImageToCanvas(drawBuiltinMarker(shape, color, size));
}

/**
 * Resolve a marker's `icon-image` layout value. Categorized, graduated, and
 * rule-based color expressions select a separately baked sprite per class,
 * because ordinary bitmap sprites cannot be tinted per feature by MapLibre.
 */
export function markerImageValue(style: LayerStyle): string | unknown[] | null {
  const fallback = markerColor(style);
  const baseId = prepareMarker(style, fallback);
  if (!baseId) return null;

  const imageFor = (value: unknown): unknown => {
    if (typeof value === "string") {
      // Bake the canonical form: prepareMarker uses the color verbatim for both
      // the sprite id and the fill, so a bare or shorthand hex ("fff") from a
      // hand-authored expression would otherwise draw black, and "#FDE725"
      // would bake a second sprite for a color already registered lowercase.
      const normalized = normalizeHexColor(value);
      return normalized ? (prepareMarker(style, normalized) ?? baseId) : baseId;
    }
    if (!Array.isArray(value)) return baseId;

    const expression = [...value];
    const firstOutput = expression[0] === "match" ? 3 : 2;
    if (!COLOR_BRANCH_HEADS.has(String(expression[0]))) return baseId;
    for (let index = firstOutput; index < expression.length; index += 2) {
      expression[index] = imageFor(expression[index]);
    }
    if (expression[0] !== "step") {
      expression[expression.length - 1] = imageFor(expression[expression.length - 1]);
    }
    return expression;
  };
  // A flat resolved color still goes through imageFor: rule-based mode with no
  // drawable rules returns the else rule's color, which need not equal the
  // layer's markerColor that baseId was baked from.
  return imageFor(vectorColorExpression(style, fallback)) as string | unknown[];
}

function loadRasterMarker(url: string): Promise<GeneratedImageResult | null> {
  if (!/^data:image\/(?!svg)[\w.+-]+;base64,/i.test(url)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve({ image, pixelRatio: 2 });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * Register embedded KMZ raster icons and return an icon-image expression for
 * the features that carry them.
 */
export function prepareKmlFeatureIcons(
  collection: GeoJSON.FeatureCollection,
  fallbackImage: unknown = "",
): unknown[] | null {
  const matches: unknown[] = [];
  const seen = new Set<string>();
  for (const feature of collection.features) {
    const url = feature.properties?.[KML_ICON_URL_PROPERTY];
    if (typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    const id = `geolibre-kml-icon-${hashText(url)}`;
    registerGeneratedImage(id, () => loadRasterMarker(url));
    matches.push(url, id);
  }
  return matches.length
    ? ["match", ["get", KML_ICON_URL_PROPERTY], ...matches, fallbackImage]
    : null;
}
