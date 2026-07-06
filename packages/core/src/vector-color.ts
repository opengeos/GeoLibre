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
 * Ground resolution (meters per pixel) at MapLibre zoom 0 on the equator, for
 * the Web Mercator projection: earth circumference (2*pi*6378137) over the
 * 512px world at zoom 0. Resolution halves with every zoom level. Exported so
 * the Mapbox-style importer can reverse {@link metersWidthExpression} without a
 * second copy of the magic number.
 */
export const MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = (2 * Math.PI * 6378137) / 512;

// Largest zoom MapLibre renders; used as the upper interpolation stop.
const MAX_MERCATOR_ZOOM = 24;

/**
 * Build a zoom-driven width expression that keeps a stroke proportional to the
 * map scale, so a width given in ground meters renders thicker when zoomed in
 * and thinner when zoomed out (QGIS "map units" behavior).
 *
 * In Web Mercator the pixels-per-meter ratio doubles with each zoom level, so
 * an `["exponential", 2]` interpolation between two stops one zoom apart is
 * exact across the whole range. The conversion is referenced to the equator;
 * because Mercator stretches distances toward the poles, the on-screen width at
 * higher latitudes is correspondingly larger, matching how the underlying map
 * is itself stretched.
 *
 * Typed maplibre-agnostically (`unknown[]`); consumers cast to the concrete
 * `PropertyValueSpecification<number>` where the MapLibre types are in scope.
 *
 * @param meters - The stroke width in ground meters.
 * @returns A MapLibre `interpolate` expression array.
 */
export function metersWidthExpression(meters: number): unknown[] {
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

/**
 * Resolve the `line-width` paint value for a layer style, honoring the
 * {@link LayerStyle.strokeWidthUnit}:
 *
 * - `"meters"`: a zoom-driven {@link metersWidthExpression} from the flat
 *   `strokeWidth`, so the stroke scales with the map. A per-feature pixel
 *   `stroke-width` override no longer applies in this mode.
 * - `"pixels"` (default): the constant pixel width, still honoring any
 *   per-feature simplestyle `stroke-width`.
 *
 * Shared by the map style-mapper and the geo-editor plugin so the Sketches
 * store layer and Geoman's interaction display layers render an identical
 * width.
 *
 * @param style - The layer style.
 * @returns A number (constant pixels) or a MapLibre expression array.
 */
export function lineWidthValue(style: LayerStyle): number | unknown[] {
  // Proportional (graduated) sizing takes precedence: width is driven by a
  // numeric field, reusing the circle-radius output range as the width range.
  if (styleValue(style, "proportionalSizeEnabled")) {
    const property = styleValue(style, "proportionalSizeProperty").trim();
    const minValue = styleValue(style, "proportionalSizeMinValue");
    const maxValue = styleValue(style, "proportionalSizeMaxValue");
    const minRadius = styleValue(style, "proportionalSizeMinRadius");
    const maxRadius = styleValue(style, "proportionalSizeMaxRadius");
    if (
      property &&
      Number.isFinite(minValue) &&
      Number.isFinite(maxValue) &&
      maxValue > minValue &&
      Number.isFinite(minRadius) &&
      Number.isFinite(maxRadius)
    ) {
      return [
        "interpolate",
        ["linear"],
        ["to-number", ["get", property], minValue],
        minValue,
        minRadius,
        maxValue,
        maxRadius,
      ];
    }
  }
  if (styleValue(style, "strokeWidthUnit") === "meters") {
    return metersWidthExpression(styleValue(style, "strokeWidth"));
  }
  return simpleStyleNumberValue(
    style,
    "stroke-width",
    styleValue(style, "strokeWidth"),
  );
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

  if (mode === "rule-based") {
    return ruleBasedColorExpression(style, fallbackColor);
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

/**
 * Compiles the `"rule-based"` renderer's ordered rules into a MapLibre `case`
 * color expression: `["case", filter1, color1, filter2, color2, …, elseColor]`.
 * Rules are evaluated top to bottom; the first matching filter wins. Rules with
 * an invalid filter JSON or a non-hex color are skipped. The catch-all
 * (`isElse`) rule supplies the trailing fallback; when absent or invalid the
 * layer `fallbackColor` is used. With no usable rules the flat fallback color
 * is returned.
 *
 * @param style - The layer style (reads {@link LayerStyle.vectorRules}).
 * @param fallbackColor - The color used when no else rule defines one.
 * @returns A MapLibre `case` expression, or a flat color when no rule applies.
 */
export function ruleBasedColorExpression(
  style: LayerStyle,
  fallbackColor: string,
): VectorColorValue {
  const rules = styleValue(style, "vectorRules");
  const elseRule = rules.find((rule) => rule.isElse);
  const elseColor =
    elseRule && isColor(elseRule.color) ? elseRule.color : fallbackColor;

  const branches: unknown[] = [];
  for (const rule of rules) {
    if (rule.isElse || !isColor(rule.color)) continue;
    const filter = parseJsonExpression(rule.filter);
    // A MapLibre filter is an expression that must start with a string operator;
    // skip non-operator arrays (e.g. a bare value) so the compiled `case` never
    // carries a non-boolean condition that MapLibre would reject at runtime.
    if (!filter || typeof filter[0] !== "string") continue;
    branches.push(filter, rule.color);
  }
  if (branches.length === 0) return elseColor;
  return ["case", ...branches, elseColor];
}

/**
 * Builds the `circle-radius` paint value, honoring proportional (graduated)
 * symbol sizing. When {@link LayerStyle.proportionalSizeEnabled} is set with a
 * chosen numeric field and a valid value range, returns an `interpolate` that
 * maps `proportionalSizeMinValue..proportionalSizeMaxValue` onto
 * `proportionalSizeMinRadius..proportionalSizeMaxRadius`; otherwise the constant
 * {@link LayerStyle.circleRadius}.
 *
 * @param style - The layer style.
 * @returns A constant radius (pixels) or a MapLibre `interpolate` expression.
 */
export function circleRadiusValue(style: LayerStyle): number | unknown[] {
  const constant = styleValue(style, "circleRadius");
  if (!styleValue(style, "proportionalSizeEnabled")) return constant;
  const property = styleValue(style, "proportionalSizeProperty").trim();
  if (!property) return constant;
  const minValue = styleValue(style, "proportionalSizeMinValue");
  const maxValue = styleValue(style, "proportionalSizeMaxValue");
  if (!(Number.isFinite(minValue) && Number.isFinite(maxValue))) return constant;
  if (maxValue <= minValue) return constant;
  const minRadius = styleValue(style, "proportionalSizeMinRadius");
  const maxRadius = styleValue(style, "proportionalSizeMaxRadius");
  if (!(Number.isFinite(minRadius) && Number.isFinite(maxRadius))) {
    return constant;
  }
  return [
    "interpolate",
    ["linear"],
    ["to-number", ["get", property], minValue],
    minValue,
    minRadius,
    maxValue,
    maxRadius,
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

/**
 * Resolves the 3D-extrusion height for a layer style into a MapLibre value: a
 * plain meters number, or a data-driven expression. In advanced mode a valid
 * `extrusionHeightExpression` wins; otherwise the height is the chosen property
 * scaled by `extrusionHeightScale` (`["*", ["to-number", ["get", prop], 0],
 * scale]`), or a flat `0` when no property is set (so the layer renders flat
 * rather than erroring). Shared by the map's fill-extrusion paint and the
 * Add Vector Layer control's extrusion mapping so both extrude identically.
 *
 * @param style - The layer style.
 * @returns The extrusion height as a number or a MapLibre expression array.
 */
export function extrusionHeightValue(style: LayerStyle): number | unknown[] {
  const advancedExpression = parseJsonExpression(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionHeightExpression")
      : "",
  );
  if (advancedExpression) return advancedExpression;
  const property = styleValue(style, "extrusionHeightProperty").trim();
  if (!property) return 0;
  const scale = styleValue(style, "extrusionHeightScale");
  return ["*", ["to-number", ["get", property], 0], scale];
}

/**
 * Resolves the 3D-extrusion color for a layer style: a data-driven expression
 * when the layer's symbology mode produces one (categorized/graduated/rule/
 * expression) or an advanced `extrusionColorExpression` is set, otherwise the
 * flat `extrusionColor`. Mirrors the fill-color contract so an extruded layer
 * honors the same attribute-driven styling.
 *
 * @param style - The layer style.
 * @returns A flat color string or a MapLibre color expression array.
 */
export function extrusionColorValue(style: LayerStyle): VectorColorValue {
  const flat = styleValue(style, "extrusionColor");
  const vectorExpression = vectorColorExpression(style, flat);
  if (vectorExpression !== flat) return vectorExpression;
  const advancedExpression = parseJsonExpression(
    styleValue(style, "extrusionAdvancedStyleEnabled")
      ? styleValue(style, "extrusionColorExpression")
      : "",
  );
  return (advancedExpression as VectorColorValue | null) ?? flat;
}
