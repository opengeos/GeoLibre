import {
  DEFAULT_LAYER_STYLE,
  parseJsonExpression,
  vectorCircleColorValue,
  vectorColorExpression,
  vectorFillColorValue,
  vectorLineColorValue,
  type LayerStyle,
} from "@geolibre/core";
import type { PropertyValueSpecification } from "maplibre-gl";

function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

export function fillPaint(style: LayerStyle, opacity: number) {
  return {
    "fill-color": vectorFillColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "fill-opacity": styleValue(style, "fillOpacity") * opacity,
    "fill-outline-color": styleValue(style, "strokeColor"),
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
  return {
    "line-color": vectorLineColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "line-width": styleValue(style, "strokeWidth"),
    "line-opacity": opacity,
  };
}

export function circlePaint(style: LayerStyle, opacity: number) {
  return {
    "circle-color": vectorCircleColorValue(
      style,
    ) as PropertyValueSpecification<string>,
    "circle-radius": styleValue(style, "circleRadius"),
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
