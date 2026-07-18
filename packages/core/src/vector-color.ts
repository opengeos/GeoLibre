import { styleValue, type LayerStyle, type VectorRule } from "./types";
import { getActiveSemiMajorAxisMeters } from "./ellipsoids";
import { removeTrailingJsonCommas } from "./expressions";

/**
 * A data-driven color value for a vector paint property: either a plain CSS
 * color string, or a MapLibre expression array (e.g. a categorized `match` or
 * graduated `interpolate`). Typed maplibre-agnostically so `@geolibre/core`
 * stays free of a maplibre-gl dependency; consumers cast to the concrete
 * `PropertyValueSpecification<string>` where the MapLibre types are in scope.
 */
export type VectorColorValue = string | unknown[];

/** Whether a color value is a data-driven expression rather than a flat color. */
export function isVectorColorExpression(value: VectorColorValue): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Whether a string is a 6-digit hex color (`#rrggbb`), the form the vector
 * renderer treats as valid. Exported so the symbology exporters can apply the
 * same validity check the live `match`/`case` expressions use rather than
 * re-deriving the regex.
 */
export function isHexColor(value: unknown): boolean {
  // Guard the type: `stop.color`/`rule.color` are typed `string`, but the data
  // can come from a hand-edited or imported .geolibre.json, so a missing/null
  // value must return false rather than throw on `.trim()`.
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim());
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
  // A zoom-stepped base (per-rule scale ranges) must keep its step outermost:
  // MapLibre only allows ["zoom"] as the input of a top-level step/interpolate,
  // so the per-feature coalesce is applied inside each step output instead of
  // around the whole expression.
  return mapZoomStepOutputs(base, (value) => [
    "coalesce",
    ["get", property],
    value,
  ]) as VectorColorValue;
}

/**
 * Apply a per-feature transform to a value, descending into the outputs of a
 * top-level `["step", ["zoom"], …]` expression (as produced by the rule-based
 * per-rule zoom compilation) so the zoom step stays outermost. MapLibre
 * rejects any expression where `["zoom"]` is not the input of a top-level
 * `step`/`interpolate`, so wrappers (simplestyle coalesce, opacity folds)
 * must be pushed inside the step's outputs rather than wrapped around it.
 * Non-step values are transformed directly.
 */
export function mapZoomStepOutputs(
  value: unknown,
  transform: (output: unknown) => unknown,
): unknown {
  if (
    Array.isArray(value) &&
    value[0] === "step" &&
    Array.isArray(value[1]) &&
    value[1][0] === "zoom"
  ) {
    const out: unknown[] = ["step", value[1], transform(value[2])];
    for (let index = 3; index < value.length; index += 2) {
      out.push(value[index], transform(value[index + 1]));
    }
    return out;
  }
  return transform(value);
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

/**
 * Same ground resolution as {@link MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0} but for
 * the project's active body: its circumference over the 512px zoom-0 world. On
 * Earth this equals the constant; on the Moon/Mars it uses that body's radius so
 * a stroke width given in ground meters renders at the correct on-screen size.
 * Exported so the Mapbox-style importer can reverse {@link metersWidthExpression}
 * with the same ellipsoid-aware factor the exporter used (keeping the round trip
 * correct on non-Earth projects), rather than the Earth-only constant.
 */
export function mercatorMetersPerPixelAtZoom0(): number {
  return (2 * Math.PI * getActiveSemiMajorAxisMeters()) / 512;
}

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
  const widthAtZoom0 = meters / mercatorMetersPerPixelAtZoom0();
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
  const proportionalWidth = proportionalRadiusExpression(style);
  if (proportionalWidth) {
    // Per-rule widths still override the proportional base for matched
    // features (the property-driven interpolate nests legally inside a
    // case), mirroring circleRadiusValue.
    return vectorStrokeWidthValue(style, proportionalWidth);
  }
  if (styleValue(style, "strokeWidthUnit") === "meters") {
    // The meters width is itself a zoom-driven interpolation; embedding it
    // inside a per-rule case would nest ["zoom"] below the top level, which
    // MapLibre rejects. Like the per-feature simplestyle width, per-rule pixel
    // widths do not apply in meters mode.
    return metersWidthExpression(styleValue(style, "strokeWidth"));
  }
  // Per-rule symbol widths (rule-based mode) override the layer width for
  // features a rule matches; unmatched features keep the base value.
  return vectorStrokeWidthValue(
    style,
    simpleStyleNumberValue(style, "stroke-width", styleValue(style, "strokeWidth")),
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
export function vectorColorExpression(style: LayerStyle, fallbackColor: string): VectorColorValue {
  const mode = styleValue(style, "vectorStyleMode");
  if (mode === "single") return fallbackColor;

  if (mode === "expression") {
    return parseJsonExpression(styleValue(style, "vectorStyleExpression")) ?? fallbackColor;
  }

  if (mode === "rule-based") {
    return ruleBasedColorExpression(style, fallbackColor);
  }

  const property = styleValue(style, "vectorStyleProperty").trim();
  if (!property) return fallbackColor;

  if (mode === "categorized") {
    const stops = styleValue(style, "vectorStyleStops").filter(
      (stop) => String(stop.value).trim().length > 0 && isHexColor(stop.color),
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
      value: typeof stop.value === "number" ? stop.value : Number.parseFloat(stop.value),
    }))
    .filter((stop) => Number.isFinite(stop.value) && isHexColor(stop.color))
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
 * A rule-based renderer rule resolved for rendering: the rule tree walked down
 * to a drawable leaf, with the ancestors' filters ANDed in and zoom ranges
 * intersected. Only enabled leaves with a valid
 * color and filter appear; group rules (rules other rules name as
 * {@link VectorRule.parentId}) contribute constraints but are not themselves
 * emitted. Shared by the paint compilers, the legend, and the symbology
 * exporters so all of them agree on which rules actually draw.
 */
export interface EffectiveVectorRule {
  id: string;
  /** The leaf rule's label (for the legend / exported rule titles). */
  label: string;
  /** The symbol fill/circle color (valid 6-digit hex). */
  color: string;
  /** The parsed MapLibre filter, ANDed with every ancestor's filter. */
  filter: unknown[];
  /** Intersected lower zoom bound (inclusive), when any rule in the chain has one. */
  minZoom?: number;
  /** Intersected upper zoom bound (exclusive), when any rule in the chain has one. */
  maxZoom?: number;
  strokeColor?: string;
  strokeWidth?: number;
  fillOpacity?: number;
  circleRadius?: number;
}

/** A finite per-rule zoom bound, or undefined when unset/invalid. */
function ruleZoom(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the layer's rule tree into the drawable leaf rules (see
 * {@link EffectiveVectorRule}) plus the catch-all else rule. Disabled rules
 * (and every descendant of a disabled group), rules with an invalid color or
 * filter, subtrees under a group whose non-blank filter does not parse, and
 * rules whose intersected zoom range is empty are all dropped. Cycles in
 * `parentId` are treated as broken chains and dropped rather than looping.
 *
 * @param style - The layer style (reads {@link LayerStyle.vectorRules}).
 * @returns The ordered drawable rules and the enabled else rule, if any.
 */
export function effectiveVectorRules(style: LayerStyle): {
  rules: EffectiveVectorRule[];
  elseRule: VectorRule | null;
} {
  const all = styleValue(style, "vectorRules");
  const elseRule = all.find((rule) => rule.isElse && rule.enabled !== false) ?? null;
  const byId = new Map<string, VectorRule>();
  for (const rule of all) {
    if (!rule.isElse) byId.set(rule.id, rule);
  }
  // A rule other rules point at is a group; only leaves draw. A rule naming
  // itself as its parent is treated as top-level (mirroring the editor and
  // the QML exporter), not as its own group.
  const groupIds = new Set<string>();
  for (const rule of byId.values()) {
    if (rule.parentId && rule.parentId !== rule.id && byId.has(rule.parentId)) {
      groupIds.add(rule.parentId);
    }
  }

  const rules: EffectiveVectorRule[] = [];
  for (const rule of all) {
    if (rule.isElse || groupIds.has(rule.id)) continue;
    if (rule.enabled === false || !isHexColor(rule.color)) continue;
    const own = parseJsonExpression(rule.filter);
    // A MapLibre filter is an expression that must start with a string operator;
    // skip non-operator arrays (e.g. a bare value) so the compiled `case` never
    // carries a non-boolean condition that MapLibre would reject at runtime.
    if (!own || typeof own[0] !== "string") continue;

    const filters: unknown[][] = [own];
    let minZoom = ruleZoom(rule.minZoom);
    let maxZoom = ruleZoom(rule.maxZoom);
    let dropped = false;
    const seen = new Set([rule.id]);
    // A self-referencing parentId means "no parent" (a normal top-level
    // rule), matching the editor's tree walk and the QML exporter.
    let parent = rule.parentId && rule.parentId !== rule.id ? byId.get(rule.parentId) : undefined;
    while (parent) {
      if (seen.has(parent.id) || parent.enabled === false) {
        dropped = true;
        break;
      }
      seen.add(parent.id);
      if (parent.filter.trim()) {
        const parentFilter = parseJsonExpression(parent.filter);
        // A group whose filter is written but unreadable can match nothing;
        // dropping the subtree mirrors how an invalid leaf filter is skipped.
        if (!parentFilter || typeof parentFilter[0] !== "string") {
          dropped = true;
          break;
        }
        filters.unshift(parentFilter);
      }
      const parentMin = ruleZoom(parent.minZoom);
      const parentMax = ruleZoom(parent.maxZoom);
      if (parentMin !== undefined) {
        minZoom = minZoom === undefined ? parentMin : Math.max(minZoom, parentMin);
      }
      if (parentMax !== undefined) {
        maxZoom = maxZoom === undefined ? parentMax : Math.min(maxZoom, parentMax);
      }
      // An ancestor with a self-referencing parentId is a top-level rule (the
      // same convention as the initial parent resolution above); advancing to
      // itself would trip the cycle guard and wrongly drop the whole subtree.
      parent =
        parent.parentId && parent.parentId !== parent.id ? byId.get(parent.parentId) : undefined;
    }
    if (dropped) continue;
    if (minZoom !== undefined && maxZoom !== undefined && minZoom >= maxZoom) {
      continue;
    }

    rules.push({
      id: rule.id,
      label: rule.label,
      color: rule.color,
      filter: filters.length === 1 ? filters[0] : ["all", ...filters],
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      ...(isHexColor(rule.strokeColor) ? { strokeColor: rule.strokeColor } : {}),
      ...(typeof rule.strokeWidth === "number" && Number.isFinite(rule.strokeWidth)
        ? { strokeWidth: rule.strokeWidth }
        : {}),
      ...(typeof rule.fillOpacity === "number" && Number.isFinite(rule.fillOpacity)
        ? { fillOpacity: rule.fillOpacity }
        : {}),
      ...(typeof rule.circleRadius === "number" && Number.isFinite(rule.circleRadius)
        ? { circleRadius: rule.circleRadius }
        : {}),
    });
  }
  return { rules, elseRule };
}

/**
 * A rule's match condition as a MapLibre filter: its (ancestor-combined)
 * attribute filter, with any scale range folded in as `["zoom"]` comparisons.
 * The zoom window is half-open (`min <= zoom < max`), matching how
 * {@link zoomWrappedRuleValue} activates rules per zoom segment. MapLibre only
 * re-evaluates `["zoom"]` in filters at integer zoom levels, so a scale-ranged
 * rule's features appear/disappear on whole zooms — the paint expressions keep
 * the fractional-zoom precision.
 */
function ruleMatchFilter(rule: EffectiveVectorRule): unknown[] {
  const conditions: unknown[] = [rule.filter];
  if (rule.minZoom !== undefined) {
    conditions.push([">=", ["zoom"], rule.minZoom]);
  }
  if (rule.maxZoom !== undefined) {
    conditions.push(["<", ["zoom"], rule.maxZoom]);
  }
  return conditions.length === 1 ? rule.filter : ["all", ...conditions];
}

// The layer sync recomputes the visibility filter for every render sub-layer
// (fill, line, point, labels, …) on every sync tick, and compiling it re-walks
// and re-parses the whole rule tree. The store replaces the vectorRules array
// on every edit, so the array's identity is a correct cache key; memoizing on
// it makes the repeated per-sub-layer calls O(1), mirroring the WeakMap caches
// in the map package (e.g. the text-marker scan).
const visibilityFilterCache = new WeakMap<VectorRule[], unknown[] | null>();

/**
 * The MapLibre filter that hides features matching no rule, for a rule-based
 * layer whose catch-all else rule has been switched off. Returns `null` — and
 * callers then leave their geometry filters untouched — unless the layer is in
 * `"rule-based"` mode AND carries an else record explicitly disabled
 * (`enabled: false`). An absent else record keeps the historical fallback
 * rendering, so projects saved before the toggle existed are unaffected.
 *
 * With the else rule off, the returned `["any", filter1, filter2, …]` keeps
 * only features matched by a drawable rule (see {@link effectiveVectorRules});
 * with no drawable rules it returns the vacuous `["any"]`, which matches
 * nothing, so every feature hides. Sub-layers combine it with their geometry
 * filters, which also drops unmatched features from labels and hit-testing —
 * mirroring QGIS, where features matching no rule are simply not drawn.
 *
 * @param style - The layer style (reads {@link LayerStyle.vectorRules}).
 * @returns The filter to `["all", …]`-combine into each sub-layer, or `null`.
 */
export function ruleBasedVisibilityFilter(style: LayerStyle): unknown[] | null {
  if (styleValue(style, "vectorStyleMode") !== "rule-based") return null;
  const all = styleValue(style, "vectorRules");
  const cached = visibilityFilterCache.get(all);
  if (cached !== undefined) return cached;
  const elseRecord = all.find((rule) => rule.isElse);
  const filter =
    !elseRecord || elseRecord.enabled !== false
      ? null
      : ["any", ...effectiveVectorRules(style).rules.map(ruleMatchFilter)];
  visibilityFilterCache.set(all, filter);
  return filter;
}

/**
 * Wrap a per-zoom-segment value builder in a `["step", ["zoom"], …]` expression
 * when any rule carries a zoom bound. MapLibre only allows `["zoom"]` as the
 * top-level input of a `step`/`interpolate` in paint properties (not inside a
 * `case` condition), so per-rule scale ranges compile by splitting the zoom
 * axis at every rule bound and rebuilding the `case` expression per segment
 * with only the rules active in that segment. With no zoom bounds the builder
 * runs once and its plain value is returned unchanged, keeping the historical
 * `case` shape (which the Mapbox-style importer recognizes).
 */
function zoomWrappedRuleValue(
  rules: EffectiveVectorRule[],
  build: (active: EffectiveVectorRule[]) => unknown,
): unknown {
  const bounds = new Set<number>();
  for (const rule of rules) {
    if (rule.minZoom !== undefined) bounds.add(rule.minZoom);
    if (rule.maxZoom !== undefined) bounds.add(rule.maxZoom);
  }
  if (bounds.size === 0) return build(rules);
  const breaks = [...bounds].sort((a, b) => a - b);
  const activeAt = (segmentStart: number) =>
    rules.filter(
      (rule) =>
        (rule.minZoom ?? -Infinity) <= segmentStart && segmentStart < (rule.maxZoom ?? Infinity),
    );
  const expression: unknown[] = ["step", ["zoom"], build(activeAt(-Infinity))];
  for (const zoom of breaks) {
    expression.push(zoom, build(activeAt(zoom)));
  }
  return expression;
}

/**
 * Compiles the `"rule-based"` renderer's ordered rules into a MapLibre `case`
 * color expression: `["case", filter1, color1, filter2, color2, …, elseColor]`.
 * Rules are evaluated top to bottom; the first matching filter wins. Disabled
 * rules and rules with an invalid filter JSON or a non-hex color are skipped;
 * nested rules AND their ancestors' filters (see {@link effectiveVectorRules}).
 * When any rule carries a zoom range the `case` is rebuilt per zoom segment
 * inside a `["step", ["zoom"], …]` wrapper. The catch-all (`isElse`) rule
 * supplies the trailing fallback; when absent or invalid the layer
 * `fallbackColor` is used. With no usable rules the flat fallback color is
 * returned.
 *
 * @param style - The layer style (reads {@link LayerStyle.vectorRules}).
 * @param fallbackColor - The color used when no else rule defines one.
 * @returns A MapLibre expression, or a flat color when no rule applies.
 */
export function ruleBasedColorExpression(
  style: LayerStyle,
  fallbackColor: string,
): VectorColorValue {
  const { rules, elseRule } = effectiveVectorRules(style);
  const elseColor = elseRule && isHexColor(elseRule.color) ? elseRule.color : fallbackColor;
  if (rules.length === 0) return elseColor;
  return zoomWrappedRuleValue(rules, (active) => {
    if (active.length === 0) return elseColor;
    return ["case", ...active.flatMap((rule) => [rule.filter, rule.color]), elseColor];
  }) as VectorColorValue;
}

/** The per-rule override fields a paint channel can read. */
type VectorRuleOverrideKey = "strokeColor" | "strokeWidth" | "fillOpacity" | "circleRadius";

/**
 * Build a paint value honoring per-rule symbol overrides for one field: a
 * `case` expression (zoom-wrapped when rules carry scale ranges) where each
 * drawable rule's branch yields its override, or the layer fallback when that
 * rule does not override the field. Returns the fallback unchanged when the
 * layer is not in rule-based mode or no rule (including the else rule)
 * overrides the field, so simple styles keep their flat paint values.
 *
 * First-match semantics are preserved: every drawable rule contributes a
 * branch (even without an override) so a feature matched by an earlier rule
 * never picks up a later rule's override.
 */
function ruleOverrideValue(
  style: LayerStyle,
  key: VectorRuleOverrideKey,
  fallback: unknown,
): unknown {
  if (styleValue(style, "vectorStyleMode") !== "rule-based") return fallback;
  const { rules, elseRule } = effectiveVectorRules(style);
  const elseOverride = readRuleOverride(elseRule ?? undefined, key);
  if (elseOverride === undefined && !rules.some((rule) => rule[key] !== undefined)) {
    return fallback;
  }
  const elseValue = elseOverride ?? fallback;
  return zoomWrappedRuleValue(rules, (active) => {
    if (active.length === 0) return elseValue;
    return ["case", ...active.flatMap((rule) => [rule.filter, rule[key] ?? fallback]), elseValue];
  });
}

/** A validated override read straight off a (possibly else) {@link VectorRule}. */
function readRuleOverride(
  rule: VectorRule | undefined,
  key: VectorRuleOverrideKey,
): string | number | undefined {
  const value = rule?.[key];
  if (key === "strokeColor") {
    return isHexColor(value) ? (value as string) : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The stroke/outline color for polygon outlines and circle strokes, honoring
 * per-rule {@link VectorRule.strokeColor} overrides in rule-based mode.
 * Falls back to the flat layer stroke color.
 */
export function vectorOutlineColorValue(style: LayerStyle): VectorColorValue {
  return ruleOverrideValue(
    style,
    "strokeColor",
    styleValue(style, "strokeColor"),
  ) as VectorColorValue;
}

/**
 * A stroke-width paint value honoring per-rule {@link VectorRule.strokeWidth}
 * overrides in rule-based mode; `fallback` is the layer-level width (a number
 * or an already-built expression such as the meters-based interpolation).
 */
export function vectorStrokeWidthValue(
  style: LayerStyle,
  fallback: number | unknown[],
): number | unknown[] {
  return ruleOverrideValue(style, "strokeWidth", fallback) as number | unknown[];
}

/**
 * A fill/circle opacity paint value honoring per-rule
 * {@link VectorRule.fillOpacity} overrides in rule-based mode; `fallback` is
 * the layer-level opacity value (number or expression).
 */
export function vectorFillOpacityValue(
  style: LayerStyle,
  fallback: number | unknown[],
): number | unknown[] {
  return ruleOverrideValue(style, "fillOpacity", fallback) as number | unknown[];
}

/** The validated proportional (graduated) size configuration of a layer. */
export interface ProportionalSizeRange {
  property: string;
  minValue: number;
  maxValue: number;
  minRadius: number;
  maxRadius: number;
}

/**
 * The proportional-size configuration, or `null` when proportional sizing
 * does not apply: disabled, no field chosen, non-finite or degenerate
 * (`maxValue <= minValue`) value range, or non-finite radii. This is the
 * single validation chain for every proportional consumer — circle radius,
 * line width, and marker icon-size (`@geolibre/map`) — so their notion of
 * "active" can never drift apart.
 *
 * @param style - The layer style.
 * @returns The validated range, or `null` when proportional sizing is off.
 */
export function proportionalSizeRange(style: LayerStyle): ProportionalSizeRange | null {
  if (!styleValue(style, "proportionalSizeEnabled")) return null;
  const property = styleValue(style, "proportionalSizeProperty").trim();
  if (!property) return null;
  const minValue = styleValue(style, "proportionalSizeMinValue");
  const maxValue = styleValue(style, "proportionalSizeMaxValue");
  if (!(Number.isFinite(minValue) && Number.isFinite(maxValue))) return null;
  if (maxValue <= minValue) return null;
  const minRadius = styleValue(style, "proportionalSizeMinRadius");
  const maxRadius = styleValue(style, "proportionalSizeMaxRadius");
  if (!(Number.isFinite(minRadius) && Number.isFinite(maxRadius))) return null;
  return { property, minValue, maxValue, minRadius, maxRadius };
}

/**
 * The proportional `interpolate` expression mapping
 * `proportionalSizeMinValue..proportionalSizeMaxValue` onto
 * `proportionalSizeMinRadius..proportionalSizeMaxRadius`, or `null` when
 * proportional sizing does not apply (see {@link proportionalSizeRange}).
 *
 * @param style - The layer style.
 * @returns The `interpolate` expression, or `null`.
 */
export function proportionalRadiusExpression(style: LayerStyle): unknown[] | null {
  const range = proportionalSizeRange(style);
  if (!range) return null;
  return [
    "interpolate",
    ["linear"],
    ["to-number", ["get", range.property], range.minValue],
    range.minValue,
    range.minRadius,
    range.maxValue,
    range.maxRadius,
  ];
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
  // Per-rule symbol sizes (rule-based mode) override the base radius for
  // features a rule matches; unmatched features keep the base value.
  return ruleOverrideValue(style, "circleRadius", baseCircleRadiusValue(style)) as
    | number
    | unknown[];
}

/** The layer-level circle radius before per-rule overrides. */
function baseCircleRadiusValue(style: LayerStyle): number | unknown[] {
  return proportionalRadiusExpression(style) ?? styleValue(style, "circleRadius");
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
  if (styleValue(style, "vectorStyleMode") === "rule-based") {
    return withSimpleStyleColor(style, "stroke", ruleBasedLineColorExpression(style));
  }
  const vectorColor = vectorColorExpression(style, strokeColor);
  const resolved =
    vectorColor === strokeColor
      ? strokeColor
      : styleValue(style, "vectorStyleMode") === "expression"
        ? vectorColor
        : ["case", ["==", ["geometry-type"], "Polygon"], strokeColor, vectorColor];
  return withSimpleStyleColor(style, "stroke", resolved);
}

/**
 * The line color for the rule-based renderer: line geometry takes the rule
 * color, polygon outlines take the per-rule stroke color override (falling
 * back to the flat layer stroke). Both channels are built inside one shared
 * zoom wrapper, since composing two independently zoom-stepped expressions in
 * a single `case` would nest `["zoom"]` below the top level, which MapLibre
 * rejects.
 */
function ruleBasedLineColorExpression(style: LayerStyle): VectorColorValue {
  const strokeColor = styleValue(style, "strokeColor");
  const { rules, elseRule } = effectiveVectorRules(style);
  const elseColor = elseRule && isHexColor(elseRule.color) ? elseRule.color : strokeColor;
  const elseOutline =
    (readRuleOverride(elseRule ?? undefined, "strokeColor") as string | undefined) ?? strokeColor;
  const hasOutlineOverride =
    rules.some((rule) => rule.strokeColor !== undefined) || elseOutline !== strokeColor;
  if (rules.length === 0 && elseColor === strokeColor && !hasOutlineOverride) {
    return strokeColor;
  }
  return zoomWrappedRuleValue(rules, (active) => {
    const colorValue: unknown =
      active.length === 0
        ? elseColor
        : ["case", ...active.flatMap((rule) => [rule.filter, rule.color]), elseColor];
    const outlineValue: unknown = !hasOutlineOverride
      ? strokeColor
      : active.length === 0
        ? elseOutline
        : [
            "case",
            ...active.flatMap((rule) => [rule.filter, rule.strokeColor ?? strokeColor]),
            elseOutline,
          ];
    if (colorValue === strokeColor && outlineValue === strokeColor) {
      return strokeColor;
    }
    return ["case", ["==", ["geometry-type"], "Polygon"], outlineValue, colorValue];
  }) as VectorColorValue;
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
