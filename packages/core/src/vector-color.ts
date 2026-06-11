import { styleValue, type LayerStyle } from "./types";

/**
 * A data-driven color value for a vector paint property: either a plain CSS
 * color string, or a MapLibre expression array (e.g. a categorized `match` or
 * graduated `interpolate`). Typed maplibre-agnostically so `@geolibre/core`
 * stays free of a maplibre-gl dependency; consumers cast to the concrete
 * `PropertyValueSpecification<string>` where the MapLibre types are in scope.
 */
export type VectorColorValue = string | unknown[];

/** Whether a color value is a data-driven expression rather than a flat color. */
export function isVectorColorExpression(
  value: VectorColorValue,
): value is unknown[] {
  return Array.isArray(value);
}

function isColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

/**
 * Parses a user-entered MapLibre expression string into an expression array,
 * tolerating trailing commas. Returns null when the text is empty or not a
 * JSON array.
 */
export function parseJsonExpression(expression: string): unknown[] | null {
  const trimmed = expression.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
    if (!Array.isArray(parsed)) return null;
    return parsed;
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

/**
 * Builds the data-driven color value for a vector layer's current style mode.
 * `single` (or any mode that cannot produce a valid expression) returns the
 * flat fallback color; `categorized` returns a `match` expression, `graduated`
 * an `interpolate` expression, and `expression` the parsed user expression.
 *
 * @param style - The layer style.
 * @param fallbackColor - The flat color used for `single` mode and as the
 *   expression fallback.
 * @returns A flat color string or a MapLibre color expression.
 */
export function vectorColorExpression(
  style: LayerStyle,
  fallbackColor: string,
): VectorColorValue {
  const mode = styleValue(style, "vectorStyleMode");
  if (mode === "single") return fallbackColor;

  if (mode === "expression") {
    return (
      parseJsonExpression(styleValue(style, "vectorStyleExpression")) ??
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
    ];
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
  ];
}

/** Fill color value for a polygon layer (fallback: the layer fill color). */
export function vectorFillColorValue(style: LayerStyle): VectorColorValue {
  return vectorColorExpression(style, styleValue(style, "fillColor"));
}

/**
 * Circle color value for a point layer. Intentionally identical to
 * `vectorFillColorValue`: GeoLibre has no separate point-fill color, so point
 * circles share the polygon fill color (matching `circlePaint` in the map
 * package). Kept as its own function so the per-geometry callers read in
 * parallel and a future dedicated circle color stays a one-line change here.
 */
export function vectorCircleColorValue(style: LayerStyle): VectorColorValue {
  return vectorColorExpression(style, styleValue(style, "fillColor"));
}

/**
 * Line color value for line geometry and polygon outlines (fallback: the
 * layer stroke color). For non-`expression` modes the data-driven color is
 * applied to line geometry only, while polygon outlines keep the flat stroke
 * color, matching the polygon-fill-only behavior of categorized/graduated
 * styling.
 */
export function vectorLineColorValue(style: LayerStyle): VectorColorValue {
  const strokeColor = styleValue(style, "strokeColor");
  const vectorColor = vectorColorExpression(style, strokeColor);
  if (vectorColor === strokeColor) return strokeColor;
  return styleValue(style, "vectorStyleMode") === "expression"
    ? vectorColor
    : ["case", ["==", ["geometry-type"], "Polygon"], strokeColor, vectorColor];
}
