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

/** A 3- or 6-digit hex color, as emitted by the simplestyle spec. */
function isSimpleStyleColor(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/**
 * simplestyle-spec color and numeric property names. Color keys carry CSS hex
 * colors; numeric keys carry plain numbers. See
 * https://github.com/mapbox/simplestyle-spec.
 */
const SIMPLE_STYLE_COLOR_KEYS = ["fill", "stroke", "marker-color"] as const;
const SIMPLE_STYLE_NUMBER_KEYS = [
  "fill-opacity",
  "stroke-width",
  "stroke-opacity",
  // Non-standard: alpha from a KML IconStyle color, wired into circle-opacity.
  "marker-opacity",
] as const;

function isSimpleStyleEnabled(style: LayerStyle): boolean {
  return styleValue(style, "simpleStyleEnabled") === true;
}

/**
 * Wrap a resolved color value so a per-feature simplestyle property takes
 * precedence when {@link LayerStyle.simpleStyleEnabled} is set. Returns the base
 * value unchanged when the feature lacks the property or the mode is off.
 *
 * @param style - The layer style.
 * @param property - The simplestyle property name (e.g. `fill`, `stroke`).
 * @param base - The flat color or expression to fall back to.
 * @returns A `coalesce` expression, or the base value when disabled.
 */
function withSimpleStyleColor(
  style: LayerStyle,
  property: (typeof SIMPLE_STYLE_COLOR_KEYS)[number],
  base: VectorColorValue,
): VectorColorValue {
  if (!isSimpleStyleEnabled(style)) return base;
  return ["coalesce", ["get", property], base];
}

/**
 * Resolve a numeric paint value, letting a per-feature simplestyle property
 * override the layer value when {@link LayerStyle.simpleStyleEnabled} is set.
 *
 * @param style - The layer style.
 * @param property - The simplestyle property name (e.g. `stroke-width`).
 * @param base - The layer-level fallback value.
 * @returns A `to-number` expression, or `base` when disabled.
 */
export function simpleStyleNumberValue(
  style: LayerStyle,
  property: (typeof SIMPLE_STYLE_NUMBER_KEYS)[number],
  base: number,
): number | unknown[] {
  if (!isSimpleStyleEnabled(style)) return base;
  return ["to-number", ["get", property], base];
}

/**
 * Whether a FeatureCollection carries per-feature simplestyle-spec properties
 * worth honoring: at least one feature with a valid hex color in a color key
 * (`fill`/`stroke`/`marker-color`) or a finite number in a numeric key
 * (`fill-opacity`/`stroke-width`/`stroke-opacity`). The scan is capped so very
 * large collections do not pay a full pass.
 *
 * @param geojson - The collection to inspect (may be undefined).
 * @returns `true` when simplestyle rendering should be enabled for the layer.
 */
export function hasSimpleStyleProperties(
  geojson: { features?: { properties?: Record<string, unknown> | null }[] } | undefined,
): boolean {
  const features = geojson?.features;
  if (!features?.length) return false;
  const limit = Math.min(features.length, 1000);
  for (let index = 0; index < limit; index += 1) {
    const properties = features[index]?.properties;
    if (!properties) continue;
    for (const key of SIMPLE_STYLE_COLOR_KEYS) {
      const value = properties[key];
      if (typeof value === "string" && isSimpleStyleColor(value)) return true;
    }
    for (const key of SIMPLE_STYLE_NUMBER_KEYS) {
      const value = properties[key];
      if (typeof value === "number" && Number.isFinite(value)) return true;
    }
  }
  return false;
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
  return withSimpleStyleColor(
    style,
    "fill",
    vectorColorExpression(style, styleValue(style, "fillColor")),
  );
}

/**
 * Circle color value for a point layer. Intentionally identical to
 * `vectorFillColorValue`: GeoLibre has no separate point-fill color, so point
 * circles share the polygon fill color (matching `circlePaint` in the map
 * package). Kept as its own function so the per-geometry callers read in
 * parallel and a future dedicated circle color stays a one-line change here.
 */
export function vectorCircleColorValue(style: LayerStyle): VectorColorValue {
  return withSimpleStyleColor(
    style,
    "marker-color",
    vectorColorExpression(style, styleValue(style, "fillColor")),
  );
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
  const resolved =
    vectorColor === strokeColor
      ? strokeColor
      : styleValue(style, "vectorStyleMode") === "expression"
        ? vectorColor
        : [
            "case",
            ["==", ["geometry-type"], "Polygon"],
            strokeColor,
            vectorColor,
          ];
  return withSimpleStyleColor(style, "stroke", resolved);
}
