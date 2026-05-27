import type { LayerStyle } from "@geolibre/core";

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
