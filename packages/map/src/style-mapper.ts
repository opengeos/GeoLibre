import {
  DEFAULT_LAYER_STYLE,
  circleRadiusValue,
  extrusionBaseValue,
  extrusionColorValue,
  extrusionHeightValue,
  heatmapRampColors,
  lineWidthValue,
  mapZoomStepOutputs,
  simpleStyleNumberValue,
  strokeBlurValue,
  strokeDashValue,
  strokeOpacityPaintValue,
  strokeOpacityValue,
  vectorCircleColorValue,
  vectorFillColorValue,
  vectorFillOpacityValue,
  vectorLineColorValue,
  vectorOutlineColorValue,
  vectorStrokeWidthValue,
  type LayerStyle,
} from "@geolibre/core";
import type { ExpressionSpecification, PropertyValueSpecification } from "maplibre-gl";
import { LAYER_OPACITY_FOR_BLEND, isBlending, layerBlendModesSupported } from "./layer-blend-modes";

function styleValue<K extends keyof LayerStyle>(style: LayerStyle, key: K): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

// Fold the layer's opacity multiplier into a paint value that may itself be a
// data-driven (simplestyle or per-rule) expression rather than a plain number.
// A zoom-stepped value (per-rule scale ranges) keeps its step outermost: the
// multiplication is applied inside each step output, since MapLibre only
// allows ["zoom"] as the input of a top-level step/interpolate.
function scaleByOpacity(
  value: number | unknown[],
  opacity: number,
): PropertyValueSpecification<number> {
  return mapZoomStepOutputs(value, (output) =>
    typeof output === "number" ? output * opacity : ["*", output, opacity],
  ) as PropertyValueSpecification<number>;
}

/**
 * The `*-layer-opacity` a fill or line layer renders with: just under 1 while
 * the layer blends, so MapLibre flattens it into a scratch framebuffer and
 * composites it in the single draw `layer-blend-modes` applies the mode to.
 *
 * Also gated on support, so a build where the render wrappers failed to install
 * is fully inert rather than only visually inert: a project saved with a blend
 * mode would otherwise still pay for a render-to-texture pass per blended
 * layer, compositing a mode that nothing is left to apply.
 */
function layerOpacityForBlend(style: LayerStyle): number {
  return isBlending(style.blendMode) && layerBlendModesSupported() ? LAYER_OPACITY_FOR_BLEND : 1;
}

/**
 * Whether a polygon's fill draws its 1px hairline outline in the stroke color.
 * Only a solid, opaque stroke keeps it: the line layer draws the real outline,
 * and a hairline under a dashed or translucent one would show through. A
 * simplestyle layer drops it too, since any feature's own `stroke-opacity` can
 * make its outline translucent. That is deliberately per layer rather than per
 * feature: scanning the data for the property would cost a pass over every
 * feature on each sync, and the line layer draws the outline either way, so
 * only the hairline under it goes.
 *
 * @param style - The layer style.
 * @returns True when the fill layer should outline polygons in the stroke color.
 */
export function fillOutlineDrawn(style: LayerStyle): boolean {
  return (
    strokeDashValue(style) === null &&
    strokeOpacityValue(style) >= 1 &&
    styleValue(style, "simpleStyleEnabled") !== true
  );
}

/**
 * The paint properties the builders here may emit as a `null` reset: a solid
 * line's dash, a sharp line's blur, and the fill hairline under a dashed or
 * translucent stroke.
 * Layer sync and the Mapbox engine use it to reset only what GeoLibre set on a
 * plugin's own native layers.
 */
export function paintBuilderMayReset(property: string): boolean {
  return (
    property === "line-dasharray" || property === "line-blur" || property === "fill-outline-color"
  );
}

/**
 * The fill paint for a layer style. `fill-outline-color` may be `null`, which
 * `setPaintProperty` takes as a reset; MapLibre's `addLayer` rejects it, so a
 * caller adding a layer drops `null` values first (as `ensureLayer` and the
 * Mapbox GL exporter do).
 */
export function fillPaint(style: LayerStyle, opacity: number) {
  return {
    "fill-color": vectorFillColorValue(style) as PropertyValueSpecification<string>,
    "fill-opacity": scaleByOpacity(
      vectorFillOpacityValue(
        style,
        simpleStyleNumberValue(style, "fill-opacity", styleValue(style, "fillOpacity")),
      ),
      opacity,
    ),
    // vectorLineColorValue honors simpleStyle's per-feature stroke property; in
    // expression mode it also applies the user's expression to the hairline
    // outline (matching the separate line layer that draws the polygon stroke).
    // A dashed or translucent stroke drops the hairline (`null` resets it to the
    // fill color), or its solid, opaque edge would show through the gaps.
    "fill-outline-color": (fillOutlineDrawn(style)
      ? vectorLineColorValue(style)
      : null) as PropertyValueSpecification<string>,
    // Elects MapLibre's render-to-texture composite so the layer blends as one
    // surface instead of once per overlapping polygon. Always emitted (rather
    // than only while blending) because `ensureLayer` only writes the paint
    // keys it is handed, so clearing a blend mode has to restore the 1.
    "fill-layer-opacity": layerOpacityForBlend(style),
  };
}

function extrusionHeightPaintValue(style: LayerStyle): PropertyValueSpecification<number> {
  // Shared with the Add Vector Layer control mapping (vector-layer-sync) so
  // both render-paths extrude to the same height.
  return extrusionHeightValue(style) as PropertyValueSpecification<number>;
}

function extrusionColorPaintValue(style: LayerStyle): PropertyValueSpecification<string> {
  return extrusionColorValue(style) as PropertyValueSpecification<string>;
}

export function fillExtrusionPaint(style: LayerStyle, opacity: number) {
  return {
    "fill-extrusion-color": extrusionColorPaintValue(style),
    "fill-extrusion-opacity": styleValue(style, "extrusionOpacity") * opacity,
    "fill-extrusion-height": extrusionHeightPaintValue(style),
    "fill-extrusion-base": extrusionBaseValue(style) as PropertyValueSpecification<number>,
    "fill-extrusion-vertical-gradient": true,
  };
}

/**
 * The line paint for a layer style. `line-dasharray` is `null` for a solid
 * line, the reset `setPaintProperty` takes; drop `null` values before passing
 * the object to `addLayer` (see {@link fillPaint}).
 */
export function linePaint(style: LayerStyle, opacity: number) {
  return {
    "line-color": vectorLineColorValue(style) as PropertyValueSpecification<string>,
    "line-width": lineWidthValue(style) as unknown as PropertyValueSpecification<number>,
    "line-opacity": scaleByOpacity(strokeOpacityPaintValue(style), opacity),
    // `null` for a solid line, so the setPaintProperty update path resets a
    // dash the user has cleared (ensureLayer strips it on first add, and the
    // Mapbox GL exporter and compiler leave it out).
    "line-dasharray": strokeDashValue(style) as unknown as PropertyValueSpecification<number[]>,
    // `null` for a sharp line, like the dash, so a plugin's own blur on its
    // native layer is reset only when GeoLibre set one (OwnedPaintResets).
    "line-blur": (strokeBlurValue(style) || null) as unknown as number,
    // See the note on `fill-layer-opacity` in fillPaint.
    "line-layer-opacity": layerOpacityForBlend(style),
  };
}

export function circlePaint(style: LayerStyle, opacity: number) {
  return {
    "circle-color": vectorCircleColorValue(style) as PropertyValueSpecification<string>,
    "circle-radius": circleRadiusValue(style) as PropertyValueSpecification<number>,
    "circle-opacity": scaleByOpacity(
      vectorFillOpacityValue(
        style,
        simpleStyleNumberValue(style, "marker-opacity", styleValue(style, "fillOpacity")),
      ),
      opacity,
    ),
    "circle-stroke-color": vectorOutlineColorValue(style) as PropertyValueSpecification<string>,
    "circle-stroke-width": vectorStrokeWidthValue(
      style,
      styleValue(style, "strokeWidth"),
    ) as PropertyValueSpecification<number>,
    // Fade the outline with the layer opacity (and let it be set explicitly)
    // so story playback can fully hide a point instead of leaving a hollow
    // ring, and so the stroke is restored when playback ends (#934).
    "circle-stroke-opacity": scaleByOpacity(strokeOpacityPaintValue(style), opacity),
  };
}

export function heatmapColorRampExpression(colors: readonly string[]): ExpressionSpecification {
  const expression: unknown[] = [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    0,
    "rgba(0,0,0,0)",
  ];
  colors.forEach((color, index) => {
    expression.push((index + 1) / colors.length, color);
  });
  return expression as ExpressionSpecification;
}

function heatmapWeight(style: LayerStyle): PropertyValueSpecification<number> {
  const property = styleValue(style, "heatmapWeightProperty").trim();
  return property === ""
    ? 1
    : (["max", 0, ["to-number", ["get", property], 0]] as PropertyValueSpecification<number>);
}

export function heatmapPaint(style: LayerStyle, opacity: number) {
  return {
    "heatmap-radius": styleValue(style, "heatmapRadius"),
    "heatmap-intensity": styleValue(style, "heatmapIntensity"),
    "heatmap-weight": heatmapWeight(style),
    "heatmap-opacity": opacity,
    "heatmap-color": heatmapColorRampExpression(heatmapRampColors(style)),
  };
}

export function clusterCirclePaint(style: LayerStyle, opacity: number) {
  return {
    // Cluster bubbles take the layer's fill color; size steps up with the count.
    "circle-color": styleValue(style, "fillColor"),
    "circle-radius": [
      "step",
      ["get", "point_count"],
      16,
      50,
      22,
      200,
      30,
    ] as PropertyValueSpecification<number>,
    "circle-opacity": styleValue(style, "fillOpacity") * opacity,
    "circle-stroke-color": styleValue(style, "strokeColor"),
    "circle-stroke-width": styleValue(style, "strokeWidth"),
    // Keep the cluster outline in step with its fill so the layer opacity (and
    // story fades) hide the whole bubble, mirroring {@link circlePaint} (#934).
    "circle-stroke-opacity": scaleByOpacity(strokeOpacityPaintValue(style), opacity),
  };
}

export function rasterPaint(style: LayerStyle, opacity: number) {
  return {
    "raster-opacity": opacity,
    "raster-brightness-min": styleValue(style, "rasterBrightnessMin"),
    "raster-brightness-max": styleValue(style, "rasterBrightnessMax"),
    "raster-saturation": styleValue(style, "rasterSaturation"),
    "raster-contrast": styleValue(style, "rasterContrast"),
    "raster-hue-rotate": styleValue(style, "rasterHueRotate"),
  };
}
