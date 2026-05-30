import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { PropertyValueSpecification } from "maplibre-gl";

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

function extrusionHeightPaintValue(
  style: LayerStyle,
): PropertyValueSpecification<number> {
  const advancedExpression = parseJsonExpression<number>(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionHeightExpression")
      : "",
  );
  if (advancedExpression) return advancedExpression;

  const property = styleValue(style, "extrusionHeightProperty").trim();
  const scale = styleValue(style, "extrusionHeightScale");
  if (!property) return 0;
  return ["*", ["to-number", ["get", property], 0], scale];
}

function extrusionColorPaintValue(
  style: LayerStyle,
): PropertyValueSpecification<string> {
  const advancedExpression = parseJsonExpression<string>(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionColorExpression")
      : "",
  );
  return advancedExpression ?? styleValue(style, "extrusionColor");
}

function parseJsonExpression<T>(
  expression: string,
): PropertyValueSpecification<T> | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
    if (!Array.isArray(parsed)) return null;
    return parsed as PropertyValueSpecification<T>;
  } catch {
    return null;
  }
}

function removeTrailingJsonCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      const nextSignificant = value.slice(index + 1).match(/\S/)?.[0];
      if (nextSignificant === "]" || nextSignificant === "}") continue;
    }

    result += char;
  }

  return result;
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
