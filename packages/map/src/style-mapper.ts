import {
  DEFAULT_LAYER_STYLE,
  circleRadiusValue,
  extrusionColorValue,
  extrusionHeightValue,
  lineWidthValue,
  mapZoomStepOutputs,
  simpleStyleNumberValue,
  vectorCircleColorValue,
  vectorFillColorValue,
  vectorFillOpacityValue,
  vectorLineColorValue,
  vectorOutlineColorValue,
  vectorStrokeWidthValue,
  type LayerStyle,
} from "@geolibre/core";
import type { ExpressionSpecification, PropertyValueSpecification } from "maplibre-gl";

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
    "fill-outline-color": vectorLineColorValue(style) as PropertyValueSpecification<string>,
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
    "fill-extrusion-base": styleValue(style, "extrusionBase"),
    "fill-extrusion-vertical-gradient": true,
  };
}

export function linePaint(style: LayerStyle, opacity: number) {
  return {
    "line-color": vectorLineColorValue(style) as PropertyValueSpecification<string>,
    "line-width": lineWidthValue(style) as unknown as PropertyValueSpecification<number>,
    "line-opacity": scaleByOpacity(simpleStyleNumberValue(style, "stroke-opacity", 1), opacity),
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
    "circle-stroke-opacity": scaleByOpacity(
      simpleStyleNumberValue(style, "stroke-opacity", 1),
      opacity,
    ),
  };
}

// A perceptually-ordered cold→hot ramp over MapLibre's heatmap-density (0..1).
const HEATMAP_COLOR_RAMP: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["heatmap-density"],
  0,
  "rgba(33,102,172,0)",
  0.2,
  "rgb(103,169,207)",
  0.4,
  "rgb(209,229,240)",
  0.6,
  "rgb(253,219,199)",
  0.8,
  "rgb(239,138,98)",
  1,
  "rgb(178,24,43)",
];

export function heatmapPaint(style: LayerStyle, opacity: number) {
  return {
    "heatmap-radius": styleValue(style, "heatmapRadius"),
    "heatmap-intensity": styleValue(style, "heatmapIntensity"),
    "heatmap-opacity": opacity,
    "heatmap-color": HEATMAP_COLOR_RAMP,
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
    "circle-stroke-opacity": scaleByOpacity(
      simpleStyleNumberValue(style, "stroke-opacity", 1),
      opacity,
    ),
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
