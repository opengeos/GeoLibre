import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";

function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

export function fillPaint(style: LayerStyle, opacity: number) {
  return {
    "fill-color": style.fillColor,
    "fill-opacity": style.fillOpacity * opacity,
    "fill-outline-color": style.strokeColor,
  };
}

export function linePaint(style: LayerStyle, opacity: number) {
  return {
    "line-color": style.strokeColor,
    "line-width": style.strokeWidth,
    "line-opacity": opacity,
  };
}

export function circlePaint(style: LayerStyle, opacity: number) {
  return {
    "circle-color": style.fillColor,
    "circle-radius": style.circleRadius,
    "circle-opacity": style.fillOpacity * opacity,
    "circle-stroke-color": style.strokeColor,
    "circle-stroke-width": style.strokeWidth,
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
