import {
  DEFAULT_LAYER_STYLE,
  parseJsonExpression,
  simpleStyleNumberValue,
  vectorCircleColorValue,
  vectorColorExpression,
  vectorFillColorValue,
  vectorLineColorValue,
  type LayerStyle,
} from "@geolibre/core";
import type {
  ExpressionSpecification,
  PropertyValueSpecification,
} from "maplibre-gl";

function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

// Ground resolution (meters per pixel) at MapLibre zoom 0 on the equator, for
// the Web Mercator projection: earth circumference (2*pi*6378137) over the
// 512px world at zoom 0. Resolution halves with every zoom level.
const MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = (2 * Math.PI * 6378137) / 512;

// Largest zoom MapLibre renders; used as the upper interpolation stop.
const MAX_MERCATOR_ZOOM = 24;

/**
 * Build a zoom-driven `line-width` value that keeps a stroke proportional to
 * the map scale, so a width given in ground meters renders thicker when zoomed
 * in and thinner when zoomed out (QGIS "map units" behavior).
 *
 * In Web Mercator the pixels-per-meter ratio doubles with each zoom level, so
 * an `["exponential", 2]` interpolation between two stops one zoom apart is
 * exact across the whole range. The conversion is referenced to the equator;
 * because Mercator stretches distances toward the poles, the on-screen width at
 * higher latitudes is correspondingly larger, matching how the underlying map
 * is itself stretched.
 */
export function metersWidthExpression(
  meters: number,
): ExpressionSpecification {
  const widthAtZoom0 = meters / MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0;
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    0,
    widthAtZoom0,
    MAX_MERCATOR_ZOOM,
    widthAtZoom0 * 2 ** MAX_MERCATOR_ZOOM,
  ];
}

// Fold the layer's opacity multiplier into a paint value that may itself be a
// data-driven (simplestyle) expression rather than a plain number.
function scaleByOpacity(
  value: number | unknown[],
  opacity: number,
): PropertyValueSpecification<number> {
  if (typeof value === "number") return value * opacity;
  return ["*", value, opacity] as unknown as PropertyValueSpecification<number>;
}

export function fillPaint(style: LayerStyle, opacity: number) {
  return {
    "fill-color": vectorFillColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "fill-opacity": scaleByOpacity(
      simpleStyleNumberValue(style, "fill-opacity", styleValue(style, "fillOpacity")),
      opacity,
    ),
    // vectorLineColorValue honors simpleStyle's per-feature stroke property; in
    // expression mode it also applies the user's expression to the hairline
    // outline (matching the separate line layer that draws the polygon stroke).
    "fill-outline-color": vectorLineColorValue(
      style,
    ) as PropertyValueSpecification<string>,
  };
}

function extrusionHeightPaintValue(
  style: LayerStyle,
): PropertyValueSpecification<number> {
  const advancedExpression = parseJsonExpression(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionHeightExpression")
      : "",
  ) as PropertyValueSpecification<number> | null;
  if (advancedExpression) return advancedExpression;

  const property = styleValue(style, "extrusionHeightProperty").trim();
  const scale = styleValue(style, "extrusionHeightScale");
  if (!property) return 0;
  return ["*", ["to-number", ["get", property], 0], scale];
}

function extrusionColorPaintValue(
  style: LayerStyle,
): PropertyValueSpecification<string> {
  const vectorExpression = vectorColorExpression(
    style,
    styleValue(style, "extrusionColor"),
  ) as PropertyValueSpecification<string>;
  if (vectorExpression !== styleValue(style, "extrusionColor")) {
    return vectorExpression;
  }

  const advancedExpression = parseJsonExpression(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionColorExpression")
      : "",
  ) as PropertyValueSpecification<string> | null;
  return advancedExpression ?? styleValue(style, "extrusionColor");
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
  // In "meters" mode the width is a ground distance, so it must scale with the
  // map and a per-feature pixel stroke-width override no longer applies; emit a
  // zoom expression from the flat width. Otherwise keep the existing pixel
  // width (which still honors any per-feature simplestyle stroke-width).
  const lineWidth =
    styleValue(style, "strokeWidthUnit") === "meters"
      ? (metersWidthExpression(
          styleValue(style, "strokeWidth"),
        ) as unknown as PropertyValueSpecification<number>)
      : (simpleStyleNumberValue(
          style,
          "stroke-width",
          styleValue(style, "strokeWidth"),
        ) as unknown as PropertyValueSpecification<number>);
  return {
    "line-color": vectorLineColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "line-width": lineWidth,
    "line-opacity": scaleByOpacity(
      simpleStyleNumberValue(style, "stroke-opacity", 1),
      opacity,
    ),
  };
}

export function circlePaint(style: LayerStyle, opacity: number) {
  return {
    "circle-color": vectorCircleColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "circle-radius": styleValue(style, "circleRadius"),
    "circle-opacity": scaleByOpacity(
      simpleStyleNumberValue(style, "marker-opacity", styleValue(style, "fillOpacity")),
      opacity,
    ),
    "circle-stroke-color": styleValue(style, "strokeColor"),
    "circle-stroke-width": styleValue(style, "strokeWidth"),
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
