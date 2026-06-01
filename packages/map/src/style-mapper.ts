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
    "fill-color": vectorColorPaintValue(
      style,
      styleValue(style, "fillColor"),
    ),
    "fill-opacity": styleValue(style, "fillOpacity") * opacity,
    "fill-outline-color": styleValue(style, "strokeColor"),
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
  const vectorExpression = vectorColorPaintValue(
    style,
    styleValue(style, "extrusionColor"),
  );
  if (vectorExpression !== styleValue(style, "extrusionColor")) {
    return vectorExpression;
  }

  const advancedExpression = parseJsonExpression<string>(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionColorExpression")
      : "",
  );
  return advancedExpression ?? styleValue(style, "extrusionColor");
}

function vectorColorPaintValue(
  style: LayerStyle,
  fallbackColor: string,
): PropertyValueSpecification<string> {
  const mode = styleValue(style, "vectorStyleMode");
  if (mode === "single") return fallbackColor;

  if (mode === "expression") {
    return (
      parseJsonExpression<string>(styleValue(style, "vectorStyleExpression")) ??
      fallbackColor
    );
  }

  const property = styleValue(style, "vectorStyleProperty").trim();
  if (!property) return fallbackColor;

  if (mode === "categorized") {
    const stops = styleValue(style, "vectorStyleStops").filter(
      (stop) => String(stop.value).trim().length > 0 && isColor(stop.color),
    );
    if (stops.length === 0) return fallbackColor;

    return [
      "match",
      ["to-string", ["get", property]],
      ...stops.flatMap((stop) => [String(stop.value).trim(), stop.color]),
      fallbackColor,
    ] as PropertyValueSpecification<string>;
  }

  const stops = styleValue(style, "vectorStyleStops")
    .map((stop) => ({
      color: stop.color,
      value:
        typeof stop.value === "number"
          ? stop.value
          : Number.parseFloat(stop.value),
    }))
    .filter((stop) => Number.isFinite(stop.value) && isColor(stop.color))
    .sort((a, b) => a.value - b.value);
  if (stops.length < 2) return fallbackColor;

  return [
    "interpolate",
    ["linear"],
    ["to-number", ["get", property], stops[0].value],
    ...stops.flatMap((stop) => [stop.value, stop.color]),
  ] as PropertyValueSpecification<string>;
}

function isColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
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
  const strokeColor = styleValue(style, "strokeColor");
  const vectorColor = vectorColorPaintValue(style, strokeColor);
  const lineColor =
    vectorColor === strokeColor
      ? strokeColor
      : styleValue(style, "vectorStyleMode") === "expression"
        ? vectorColor
        : ([
            "case",
            ["==", ["geometry-type"], "Polygon"],
            strokeColor,
            vectorColor,
          ] as PropertyValueSpecification<string>);

  return {
    "line-color": lineColor,
    "line-width": styleValue(style, "strokeWidth"),
    "line-opacity": opacity,
  };
}

export function circlePaint(style: LayerStyle, opacity: number) {
  return {
    "circle-color": vectorColorPaintValue(
      style,
      styleValue(style, "fillColor"),
    ),
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
