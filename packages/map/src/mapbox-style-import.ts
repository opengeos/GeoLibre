import {
  DEFAULT_LAYER_STYLE,
  MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0,
  type LabelStyle,
  type LayerStyle,
  type VectorStyleStop,
} from "@geolibre/core";

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

/** The `text-anchor` values GeoLibre's {@link LabelStyle.anchor} accepts. */
const VALID_LABEL_ANCHORS = new Set<string>([
  "center",
  "left",
  "right",
  "top",
  "bottom",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

/**
 * Everything a parsed Mapbox GL style contributes to a layer's symbology. The
 * {@link style} patch and {@link labels} patch are kept separate so the caller
 * can merge each over the layer's existing style (labels are a nested object).
 */
export interface MapboxStyleImportResult {
  /**
   * Flat {@link LayerStyle} fields recovered from the style's paint/layout (fill,
   * stroke, radius, renderer mode, extrusion, heatmap, zoom range). Only keys the
   * importer could determine are present, so it merges cleanly over the layer's
   * current style and leaves everything else untouched.
   */
  style: Partial<Omit<LayerStyle, "labels">>;
  /**
   * Label fields recovered from a `symbol` layer, or `null` when the style had no
   * label layer. When present it always includes `enabled: true`.
   */
  labels: Partial<LabelStyle> | null;
  /**
   * Notes about anything that could not be represented exactly (an unrecognized
   * expression, a data-driven opacity, a cluster source), so the import never
   * silently drops symbology.
   */
  warnings: string[];
  /**
   * How many of the style's render layers the importer understood (fill,
   * fill-extrusion, line, circle, heatmap, symbol). Zero means the file carried
   * no vector symbology to apply.
   */
  matchedLayerCount: number;
}

/** A minimal structural view of a Mapbox GL layer, so tests need no full spec. */
interface RawStyleLayer {
  type?: unknown;
  paint?: Record<string, unknown> | null;
  layout?: Record<string, unknown> | null;
  minzoom?: unknown;
  maxzoom?: unknown;
}

/** The recovered color renderer for one color paint property. */
interface ParsedColor {
  /** The flat/fallback color (used for `single` and as the mode fallback). */
  color?: string;
  mode?: LayerStyle["vectorStyleMode"];
  property?: string;
  stops?: VectorStyleStop[];
  expression?: string;
  rules?: LayerStyle["vectorRules"];
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Warn (rather than silently keep the old value) when a numeric paint property
 * is present but data-driven in a shape the importer cannot flatten, mirroring
 * how `fill-opacity` is handled.
 */
function warnUnreadableNumber(
  value: unknown,
  description: string,
  warnings: string[],
): void {
  if (value !== undefined && asFiniteNumber(value) === null) {
    warnings.push(
      `The ${description} is data-driven in a way that could not be read; the layer keeps its current ${description}.`,
    );
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Match `["get", "prop"]`, returning the property name. */
function getProperty(node: unknown): string | null {
  const array = asArray(node);
  if (!array || array[0] !== "get") return null;
  return asString(array[1]);
}

/**
 * Match the field text-field / categorized input shapes the exporter emits,
 * returning the underlying property name:
 * `["to-string", ["get", p]]`, `["to-string", ["coalesce", ["get", p], ""]]`,
 * or `["to-number", ["get", p], fallback]`. Also accepts a bare `["get", p]`,
 * which a hand-written or third-party style commonly uses as a match/interpolate
 * input or a text-field.
 */
function wrappedProperty(node: unknown): string | null {
  const bare = getProperty(node);
  if (bare) return bare;
  const array = asArray(node);
  if (!array) return null;
  const op = array[0];
  if (op === "to-string" || op === "to-number") {
    const inner = array[1];
    const direct = getProperty(inner);
    if (direct) return direct;
    const innerArray = asArray(inner);
    if (innerArray && innerArray[0] === "coalesce") {
      return getProperty(innerArray[1]);
    }
  }
  return null;
}

/**
 * Reverse a color paint value (string or MapLibre expression) back into a
 * GeoLibre renderer. Recognizes the exact shapes the exporter produces:
 * `match` (categorized), `interpolate`/`linear` over a numeric field
 * (graduated), and `case` (rule-based); any other expression is preserved as an
 * `expression` renderer. A `coalesce` simplestyle wrapper is unwrapped first.
 */
function parseColorValue(value: unknown, warnings: string[]): ParsedColor {
  const flat = asString(value);
  if (flat !== null) return { color: flat, mode: "single" };

  const array = asArray(value);
  if (!array) return {};

  // Unwrap the simplestyle per-feature override the exporter wraps colors in
  // (`["coalesce", ["get", key], base]`) and read the base renderer.
  if (array[0] === "coalesce" && array.length === 3) {
    return parseColorValue(array[2], warnings);
  }

  // Unwrap the polygon-outline geometry guard the exporter wraps line colors in
  // (`["case", ["==", ["geometry-type"], "Polygon"], stroke, vectorColor]`) so a
  // line-only categorized/graduated layer recovers its renderer from the else
  // branch. Only this specific 4-element shape, not a real rule-based `case`.
  // Accepted ambiguity: a genuine one-rule rule-based `case` whose sole rule
  // filters on `geometry-type == "Polygon"` would be read as this guard; that
  // exact shape is vanishingly rare and structurally indistinguishable.
  if (
    array[0] === "case" &&
    array.length === 4 &&
    isPolygonGeometryTest(array[1])
  ) {
    return parseColorValue(array[3], warnings);
  }

  if (array[0] === "match") return parseMatch(array, warnings);
  if (array[0] === "interpolate") return parseInterpolateColor(array, warnings);
  if (array[0] === "case") return parseCase(array);

  // An expression GeoLibre did not author (or cannot classify): keep it verbatim
  // so the styling still renders through the `expression` renderer.
  return { mode: "expression", expression: JSON.stringify(value) };
}

/** Whether a node is `["==", ["geometry-type"], "Polygon"]`. */
function isPolygonGeometryTest(node: unknown): boolean {
  const array = asArray(node);
  if (!array || array[0] !== "==" || array.length !== 3) return false;
  const left = asArray(array[1]);
  return (
    !!left && left[0] === "geometry-type" && array[2] === "Polygon"
  );
}

/** Parse `["match", ["to-string", ["get", p]], v1, c1, ..., fallback]`. */
function parseMatch(array: unknown[], warnings: string[]): ParsedColor {
  const property = wrappedProperty(array[1]);
  // match with an odd tail (pairs + fallback); need at least one pair.
  const body = array.slice(2);
  const fallback = asString(body[body.length - 1]);
  if (!property || fallback === null || body.length < 3) {
    warnings.push(
      "A `match` color expression could not be read as a categorized renderer; kept it as a raw expression.",
    );
    return { mode: "expression", expression: JSON.stringify(array) };
  }
  const stops: VectorStyleStop[] = [];
  let droppedArm = false;
  for (let index = 0; index < body.length - 1; index += 2) {
    const rawValue = body[index];
    const color = asString(body[index + 1]);
    // A non-string arm color (an expression or rgba object) has no flat-color
    // equivalent; skip it but flag the loss rather than dropping it silently.
    if (color === null) {
      droppedArm = true;
      continue;
    }
    // A match arm's label may be an array of values sharing one output
    // (`["match", input, [v1, v2], color, ...]`); expand each into its own stop.
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const raw of values) {
      stops.push({
        value: typeof raw === "number" ? raw : String(raw),
        color,
      });
    }
  }
  if (droppedArm) {
    warnings.push(
      "Some categorized categories used a non-flat color and were skipped.",
    );
  }
  return { mode: "categorized", property, stops, color: fallback };
}

/**
 * Parse `["interpolate", ["linear"], ["to-number", ["get", p], x], v1, c1, ...]`
 * as a graduated color renderer. A different interpolation input (`zoom`,
 * `heatmap-density`) is not graduated color, so it is preserved as an
 * expression.
 */
function parseInterpolateColor(
  array: unknown[],
  warnings: string[],
): ParsedColor {
  const property = wrappedProperty(array[2]);
  if (!property) {
    return { mode: "expression", expression: JSON.stringify(array) };
  }
  const body = array.slice(3);
  const stops: VectorStyleStop[] = [];
  let droppedStop = false;
  for (let index = 0; index + 1 < body.length; index += 2) {
    const value = asFiniteNumber(body[index]);
    const color = asString(body[index + 1]);
    if (value === null || color === null) {
      droppedStop = true;
      continue;
    }
    stops.push({ value, color });
  }
  if (droppedStop && stops.length >= 2) {
    warnings.push(
      "Some graduated stops used a non-flat color and were skipped.",
    );
  }
  if (stops.length < 2) {
    warnings.push(
      "An `interpolate` color expression had too few stops to read as a graduated renderer; kept it as a raw expression.",
    );
    return { mode: "expression", expression: JSON.stringify(array) };
  }
  return { mode: "graduated", property, stops };
}

/** Parse `["case", filter1, color1, ..., elseColor]` as a rule-based renderer. */
function parseCase(array: unknown[]): ParsedColor {
  const body = array.slice(1);
  const elseColor = asString(body[body.length - 1]) ?? DEFAULT_LAYER_STYLE.fillColor;
  const rules: LayerStyle["vectorRules"] = [];
  for (let index = 0; index + 1 < body.length; index += 2) {
    const filter = body[index];
    const color = asString(body[index + 1]);
    if (color === null) continue;
    rules.push({
      id: `import-rule-${rules.length}`,
      label: "",
      filter: JSON.stringify(filter),
      color,
      isElse: false,
    });
  }
  rules.push({
    id: "import-rule-else",
    label: "",
    filter: "",
    color: elseColor,
    isElse: true,
  });
  return { mode: "rule-based", rules, color: elseColor };
}

/**
 * Apply a parsed color renderer to the style patch. `single`/`expression` leave
 * the flat fallback in `fillColor`; the attribute-driven modes carry the
 * property, stops, or rules across.
 */
function applyColorRenderer(
  parsed: ParsedColor,
  patch: Partial<Omit<LayerStyle, "labels">>,
): void {
  if (parsed.mode) patch.vectorStyleMode = parsed.mode;
  if (parsed.color !== undefined) patch.fillColor = parsed.color;
  if (parsed.property !== undefined) patch.vectorStyleProperty = parsed.property;
  if (parsed.stops !== undefined) patch.vectorStyleStops = parsed.stops;
  if (parsed.expression !== undefined) {
    patch.vectorStyleExpression = parsed.expression;
  }
  if (parsed.rules !== undefined) patch.vectorRules = parsed.rules;
}

/** Recover the flat stroke color from a line-color paint value. */
function parseStrokeColor(value: unknown): string | null {
  const array = asArray(value);
  // Unwrap the simplestyle per-feature override the exporter wraps line/outline
  // colors in (`["coalesce", ["get","stroke"], base]`) when simpleStyleEnabled,
  // matching parseColorValue, so the flat stroke is still recovered.
  if (array && array[0] === "coalesce" && array.length === 3) {
    return parseStrokeColor(array[2]);
  }
  const flat = asString(value);
  if (flat !== null) return flat;
  // The polygon-outline guard keeps the flat stroke in the polygon branch.
  if (
    array &&
    array[0] === "case" &&
    array.length === 4 &&
    isPolygonGeometryTest(array[1])
  ) {
    return asString(array[2]);
  }
  return null;
}

/** The proportional-size (graduated symbol) fields, if a size value encodes one. */
interface ParsedProportional {
  property: string;
  minValue: number;
  maxValue: number;
  minRadius: number;
  maxRadius: number;
}

/**
 * Detect the exporter's proportional-size expression
 * `["interpolate", ["linear"], ["to-number", ["get", p], minV], minV, minR,
 * maxV, maxR]` on a `circle-radius`/`line-width` value.
 */
function parseProportional(value: unknown): ParsedProportional | null {
  const array = asArray(value);
  if (!array || array[0] !== "interpolate") return null;
  const interpolation = asArray(array[1]);
  if (!interpolation || interpolation[0] !== "linear") return null;
  const property = wrappedProperty(array[2]);
  if (!property) return null;
  const body = array.slice(3);
  if (body.length !== 4) return null;
  const minValue = asFiniteNumber(body[0]);
  const minRadius = asFiniteNumber(body[1]);
  const maxValue = asFiniteNumber(body[2]);
  const maxRadius = asFiniteNumber(body[3]);
  if (
    minValue === null ||
    minRadius === null ||
    maxValue === null ||
    maxRadius === null
  ) {
    return null;
  }
  return { property, minValue, maxValue, minRadius, maxRadius };
}

function applyProportional(
  parsed: ParsedProportional,
  patch: Partial<Omit<LayerStyle, "labels">>,
): void {
  patch.proportionalSizeEnabled = true;
  patch.proportionalSizeProperty = parsed.property;
  patch.proportionalSizeMinValue = parsed.minValue;
  patch.proportionalSizeMaxValue = parsed.maxValue;
  patch.proportionalSizeMinRadius = parsed.minRadius;
  patch.proportionalSizeMaxRadius = parsed.maxRadius;
}

/**
 * Recover a `line-width` paint value: a plain number is a pixel width; the
 * exporter's zoom-driven `["interpolate", ["exponential", 2], ["zoom"], 0, w0,
 * 24, w24]` is a "map units" (meters) width, reversed via the zoom-0 stop.
 */
function parseLineWidth(
  value: unknown,
  patch: Partial<Omit<LayerStyle, "labels">>,
  warnings: string[],
): void {
  const flat = asFiniteNumber(value);
  if (flat !== null) {
    patch.strokeWidth = flat;
    patch.strokeWidthUnit = "pixels";
    return;
  }
  const proportional = parseProportional(value);
  if (proportional) {
    applyProportional(proportional, patch);
    return;
  }
  const array = asArray(value);
  if (array && array[0] === "interpolate") {
    const interpolation = asArray(array[1]);
    const input = asArray(array[2]);
    if (
      interpolation &&
      interpolation[0] === "exponential" &&
      input &&
      input[0] === "zoom" &&
      // The reverse only holds when the first stop is zoom 0 (as the exporter
      // emits); a different first stop is not a GeoLibre meters width.
      asFiniteNumber(array[3]) === 0
    ) {
      const widthAtZoom0 = asFiniteNumber(array[4]);
      if (widthAtZoom0 !== null) {
        patch.strokeWidth =
          widthAtZoom0 * MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0;
        patch.strokeWidthUnit = "meters";
        return;
      }
    }
  }
  warnings.push(
    "A line width expression could not be read; the layer keeps its current stroke width.",
  );
}

/**
 * Recover the extrusion height config from a `fill-extrusion-height` value. The
 * exporter emits `["*", ["to-number", ["get", p], 0], scale]` (property +
 * scale) in the common case, or an arbitrary advanced expression; reverse each.
 * A flat number (e.g. the `0` emitted when no property is set) leaves the
 * defaults untouched.
 */
function parseExtrusionHeight(
  value: unknown,
  patch: Partial<Omit<LayerStyle, "labels">>,
  warnings: string[],
): void {
  const array = asArray(value);
  if (!array) {
    // GeoLibre has no constant-height field (height is attribute-driven), so a
    // flat non-zero height cannot be represented; warn rather than drop silently.
    const flat = asFiniteNumber(value);
    if (flat !== null && flat !== 0) {
      warnings.push(
        "A constant extrusion height could not be represented; the layer keeps its current height.",
      );
    }
    return;
  }
  if (array[0] === "*" && array.length === 3) {
    const property = wrappedProperty(array[1]);
    const scale = asFiniteNumber(array[2]);
    if (property && scale !== null) {
      patch.extrusionHeightProperty = property;
      patch.extrusionHeightScale = scale;
      return;
    }
  }
  // Any other expression round-trips through the advanced height expression.
  patch.extrusionAdvancedStyleEnabled = true;
  patch.extrusionHeightExpression = JSON.stringify(value);
}

function clampZoom(value: unknown): number | null {
  const number = asFiniteNumber(value);
  if (number === null) return null;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, number));
}

/** Apply a render layer's `minzoom`/`maxzoom` to the patch's zoom window. */
function applyZoomRange(
  layer: RawStyleLayer,
  patch: Partial<Omit<LayerStyle, "labels">>,
): void {
  const min = clampZoom(layer.minzoom);
  const max = clampZoom(layer.maxzoom);
  // Normalize so a malformed style with minzoom > maxzoom does not import an
  // inverted window that hides the layer, matching the exporter's zoomRange().
  if (min !== null && max !== null) {
    patch.minZoom = Math.min(min, max);
    patch.maxZoom = Math.max(min, max);
    return;
  }
  if (min !== null) patch.minZoom = min;
  if (max !== null) patch.maxZoom = max;
}

/** Build the label patch from a `symbol` layer's layout/paint. */
function parseLabelLayer(
  layer: RawStyleLayer,
  warnings: string[],
): Partial<LabelStyle> {
  const layout = layer.layout ?? {};
  const paint = layer.paint ?? {};
  const labels: Partial<LabelStyle> = { enabled: true };

  const textField = layout["text-field"];
  const field = wrappedProperty(textField);
  if (field) {
    labels.field = field;
    labels.expression = "";
  } else if (Array.isArray(textField)) {
    labels.expression = JSON.stringify(textField);
  } else if (typeof textField === "string") {
    // A Mapbox token string like "{name}" maps to a single attribute field.
    // A literal or multi-token string ("{a} ({b})") has no GeoLibre equivalent,
    // so leave the field unset and fall through to the "no text field" warning
    // rather than storing a non-expression that would fail JSON.parse later.
    const token = textField.trim().match(/^\{([^{}]+)\}$/);
    if (token) {
      labels.field = token[1];
      labels.expression = "";
    }
  }

  const size = asFiniteNumber(layout["text-size"]);
  if (size !== null) labels.size = size;

  // MapLibre offers "line" and "line-center"; both are line placement here.
  const placement = layout["symbol-placement"];
  labels.placement =
    placement === "line" || placement === "line-center" ? "line" : "point";

  if (typeof layout["text-allow-overlap"] === "boolean") {
    labels.allowOverlap = layout["text-allow-overlap"];
  }
  const anchor = asString(layout["text-anchor"]);
  // Only accept anchors GeoLibre supports; an unknown value keeps the base.
  if (anchor && VALID_LABEL_ANCHORS.has(anchor)) {
    labels.anchor = anchor as LabelStyle["anchor"];
  }

  const offset = asArray(layout["text-offset"]);
  if (offset) {
    const offsetX = asFiniteNumber(offset[0]);
    const offsetY = asFiniteNumber(offset[1]);
    if (offsetX !== null) labels.offsetX = offsetX;
    if (offsetY !== null) labels.offsetY = offsetY;
  }
  const rotation = asFiniteNumber(layout["text-rotate"]);
  if (rotation !== null) labels.rotation = rotation;
  const maxWidth = asFiniteNumber(layout["text-max-width"]);
  if (maxWidth !== null) labels.maxWidth = maxWidth;
  const transform = asString(layout["text-transform"]);
  if (transform === "uppercase" || transform === "lowercase" || transform === "none") {
    labels.transform = transform;
  }

  const color = asString(paint["text-color"]);
  if (color) labels.color = color;
  const haloColor = asString(paint["text-halo-color"]);
  if (haloColor) labels.haloColor = haloColor;
  const haloWidth = asFiniteNumber(paint["text-halo-width"]);
  if (haloWidth !== null) labels.haloWidth = haloWidth;

  const min = clampZoom(layer.minzoom);
  const max = clampZoom(layer.maxzoom);
  if (min !== null) labels.minZoom = min;
  if (max !== null) labels.maxZoom = max;

  if (labels.field === undefined && labels.expression === undefined) {
    warnings.push(
      "The label layer had no text field; labels were enabled but you may need to pick a field.",
    );
  }
  return labels;
}

/**
 * Parse a Mapbox GL / MapLibre style document into a GeoLibre symbology patch.
 * Reverses what {@link buildMapboxStyle} produces (fill/line/circle/heatmap/
 * fill-extrusion render layers, categorized/graduated/rule-based/expression
 * color renderers, proportional and "map units" sizing, and labels) so a style
 * exported from GeoLibre round-trips, and a hand-written or third-party style
 * imports as far as its paint maps onto GeoLibre's model. Anything that cannot
 * be represented is reported in {@link MapboxStyleImportResult.warnings} rather
 * than dropped silently.
 *
 * When several render layers share a color renderer (a mixed-geometry export),
 * the geometry whose baked fallback color matches GeoLibre's field wins: a
 * polygon `fill` first, then a `circle` (its fallback is `fillColor`), then a
 * `line` (whose fallback is `strokeColor`, recovered separately).
 *
 * Note: the exporter folds the layer's opacity into the paint opacity, and a
 * Mapbox style has no separate layer-opacity field, so the recovered
 * `fillOpacity`/`extrusionOpacity` reproduce the same rendered opacity with the
 * layer at full opacity. Re-importing a style from a layer whose opacity was not
 * 1 collapses the two into one value (the visual result is unchanged).
 *
 * @param input Parsed style JSON (an object with a `layers` array).
 * @returns The recovered {@link LayerStyle} patch, label patch, and warnings.
 */
export function parseMapboxStyle(input: unknown): MapboxStyleImportResult {
  const warnings: string[] = [];
  const patch: Partial<Omit<LayerStyle, "labels">> = {};
  let labels: Partial<LabelStyle> | null = null;
  let matchedLayerCount = 0;

  const root = input as { layers?: unknown } | null;
  const rawLayers = asArray(root?.layers);
  if (!rawLayers) {
    warnings.push(
      "This file is not a Mapbox GL style (no `layers` array); nothing was imported.",
    );
    return { style: patch, labels, warnings, matchedLayerCount: 0 };
  }

  const layers = rawLayers.filter(
    (layer): layer is RawStyleLayer =>
      typeof layer === "object" && layer !== null,
  );
  const byType = (type: string) =>
    layers.filter((layer) => layer.type === type);

  // A color renderer (categorized/graduated/rule-based/expression) is shared by
  // every geometry in an exported style, so read it once from the highest-
  // priority geometry present and let the others contribute only their
  // stroke/radius. Track whether the color mode has been claimed.
  let colorClaimed = false;

  // Only the first render layer of each type feeds the single GeoLibre style, so
  // warn when a style stacks several (a sub-styled fill, multiple label configs)
  // rather than dropping the extras silently.
  for (const type of ["fill", "fill-extrusion", "line", "circle", "symbol"]) {
    if (byType(type).length > 1) {
      warnings.push(
        `The style has multiple ${type} layers; only the first was imported.`,
      );
    }
  }

  const [fill] = byType("fill");
  const [extrusion] = byType("fill-extrusion");
  const [line] = byType("line");
  const [circle] = byType("circle");
  const [heatmap] = byType("heatmap");
  const [symbol] = byType("symbol");

  if (extrusion) {
    matchedLayerCount += 1;
    patch.extrusionEnabled = true;
    const paint = extrusion.paint ?? {};
    const color = parseColorValue(paint["fill-extrusion-color"], warnings);
    if (color.mode && color.mode !== "single") {
      applyColorRenderer(color, patch);
      // extrusionColorValue() uses extrusionColor as the renderer's fallback, so
      // route the recovered fallback there too (not just fillColor) or an
      // extruded categorized/rule layer keeps its old fallback after import.
      if (color.color !== undefined) patch.extrusionColor = color.color;
      colorClaimed = true;
    } else if (color.color) {
      patch.extrusionColor = color.color;
    }
    const opacity = asFiniteNumber(paint["fill-extrusion-opacity"]);
    if (opacity !== null) patch.extrusionOpacity = opacity;
    if (paint["fill-extrusion-height"] !== undefined) {
      parseExtrusionHeight(paint["fill-extrusion-height"], patch, warnings);
    }
    const base = asFiniteNumber(paint["fill-extrusion-base"]);
    if (base !== null) patch.extrusionBase = base;
    applyZoomRange(extrusion, patch);
  } else if (fill) {
    matchedLayerCount += 1;
    patch.extrusionEnabled = false;
    const paint = fill.paint ?? {};
    const fillColor = parseColorValue(paint["fill-color"], warnings);
    applyColorRenderer(fillColor, patch);
    // Only claim the shared renderer when fill-color actually yielded one, so a
    // fill layer with a missing/unparseable color does not block a later
    // line/circle layer from contributing the color.
    if (fillColor.mode) colorClaimed = true;
    const opacity = paint["fill-opacity"];
    const flatOpacity = asFiniteNumber(opacity);
    if (flatOpacity !== null) {
      patch.fillOpacity = flatOpacity;
    } else if (opacity !== undefined) {
      warnings.push(
        "The fill opacity is data-driven; the layer keeps its current fill opacity.",
      );
    }
    const outline = parseStrokeColor(paint["fill-outline-color"]);
    if (outline) patch.strokeColor = outline;
    applyZoomRange(fill, patch);
  }

  if (line) {
    matchedLayerCount += 1;
    const paint = line.paint ?? {};
    const stroke = parseStrokeColor(paint["line-color"]);
    if (stroke) patch.strokeColor = stroke;
    // Defer the color-renderer claim to the circle layer when one is present:
    // line-color's baked fallback is strokeColor, but applyColorRenderer routes
    // a fallback into fillColor, which is the point (circle) fallback. Letting a
    // point+line export's circle claim the renderer keeps fillColor correct; a
    // line-only layer still claims here (its fillColor is not rendered anyway).
    if (!colorClaimed && !circle) {
      const color = parseColorValue(paint["line-color"], warnings);
      if (color.mode && color.mode !== "single") {
        // Take the renderer (mode/property/stops/rules), but not the fallback
        // color: line-color's baked fallback is strokeColor (already recovered
        // above), whereas applyColorRenderer would route it into fillColor.
        applyColorRenderer({ ...color, color: undefined }, patch);
        colorClaimed = true;
      }
    }
    if (paint["line-width"] !== undefined) {
      parseLineWidth(paint["line-width"], patch, warnings);
    }
    applyZoomRange(line, patch);
  }

  if (circle) {
    matchedLayerCount += 1;
    patch.pointRenderer = "single";
    const paint = circle.paint ?? {};
    if (!colorClaimed) {
      applyColorRenderer(
        parseColorValue(paint["circle-color"], warnings),
        patch,
      );
      colorClaimed = true;
    }
    const radius = paint["circle-radius"];
    const flatRadius = asFiniteNumber(radius);
    if (flatRadius !== null) {
      patch.circleRadius = flatRadius;
    } else {
      const proportional = parseProportional(radius);
      if (proportional) {
        applyProportional(proportional, patch);
      } else {
        warnUnreadableNumber(radius, "circle radius", warnings);
      }
    }
    // circlePaint writes the layer's fillOpacity into circle-opacity, so a
    // point-only export (no fill layer) recovers its opacity here.
    const opacity = paint["circle-opacity"];
    const flatOpacity = asFiniteNumber(opacity);
    if (flatOpacity !== null) {
      patch.fillOpacity = flatOpacity;
    } else if (opacity !== undefined) {
      warnings.push(
        "The circle opacity is data-driven; the layer keeps its current fill opacity.",
      );
    }
    const strokeColor = asString(paint["circle-stroke-color"]);
    if (strokeColor) patch.strokeColor = strokeColor;
    const strokeWidth = asFiniteNumber(paint["circle-stroke-width"]);
    if (strokeWidth !== null) {
      patch.strokeWidth = strokeWidth;
      // circle-stroke-width is always literal pixels, so reset the shared unit in
      // case a line layer in the same style set it to "meters".
      patch.strokeWidthUnit = "pixels";
    } else {
      warnUnreadableNumber(paint["circle-stroke-width"], "point stroke width", warnings);
    }
    applyZoomRange(circle, patch);
  }

  if (heatmap) {
    matchedLayerCount += 1;
    // GeoLibre has a single point renderer, so a style with both a circle and a
    // heatmap layer (e.g. split by zoom) collapses to the heatmap; flag the loss.
    if (circle) {
      warnings.push(
        "The style has both circle and heatmap point layers; imported as a heatmap.",
      );
    }
    patch.pointRenderer = "heatmap";
    const paint = heatmap.paint ?? {};
    const radius = asFiniteNumber(paint["heatmap-radius"]);
    if (radius !== null) patch.heatmapRadius = radius;
    else warnUnreadableNumber(paint["heatmap-radius"], "heatmap radius", warnings);
    const intensity = asFiniteNumber(paint["heatmap-intensity"]);
    if (intensity !== null) patch.heatmapIntensity = intensity;
    else
      warnUnreadableNumber(
        paint["heatmap-intensity"],
        "heatmap intensity",
        warnings,
      );
    applyZoomRange(heatmap, patch);
  }

  if (symbol) {
    matchedLayerCount += 1;
    labels = parseLabelLayer(symbol, warnings);
  }

  if (matchedLayerCount === 0) {
    warnings.push(
      "No fill, line, circle, heatmap, or label layers were found; nothing was imported.",
    );
  }

  return { style: patch, labels, warnings, matchedLayerCount };
}

/**
 * Merge a parsed import over a base {@link LayerStyle}, producing the next style.
 * The label patch is merged into the nested {@link LayerStyle.labels} object so a
 * partial label import keeps the base's other label fields.
 *
 * @param base The layer's current style.
 * @param result The output of {@link parseMapboxStyle}.
 * @returns The next {@link LayerStyle} with the imported symbology applied.
 */
export function applyMapboxStyleImport(
  base: LayerStyle,
  result: MapboxStyleImportResult,
): LayerStyle {
  return {
    ...base,
    ...result.style,
    labels: result.labels
      ? { ...base.labels, ...result.labels }
      : base.labels,
  };
}
