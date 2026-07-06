import {
  DEFAULT_LAYER_STYLE,
  type LabelStyle,
  type LayerStyle,
  type VectorStyleStop,
} from "@geolibre/core";

/**
 * Ground resolution (meters per pixel) at MapLibre zoom 0 on the equator for
 * Web Mercator: earth circumference (2*pi*6378137) over the 512px world at zoom
 * 0. The inverse of the constant `metersWidthExpression` uses in
 * `@geolibre/core`; kept local so importing a zoom-driven "map units" stroke
 * width recovers the original ground meters. See {@link parseLineWidth}.
 */
const MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = (2 * Math.PI * 6378137) / 512;

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

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
 * or `["to-number", ["get", p], fallback]`.
 */
function wrappedProperty(node: unknown): string | null {
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
  for (let index = 0; index < body.length - 1; index += 2) {
    const rawValue = body[index];
    const color = asString(body[index + 1]);
    if (color === null) continue;
    const value =
      typeof rawValue === "number" ? rawValue : String(rawValue);
    stops.push({ value, color });
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
  for (let index = 0; index + 1 < body.length; index += 2) {
    const value = asFiniteNumber(body[index]);
    const color = asString(body[index + 1]);
    if (value === null || color === null) continue;
    stops.push({ value, color });
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
  const flat = asString(value);
  if (flat !== null) return flat;
  const array = asArray(value);
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
      input[0] === "zoom"
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

  const field = wrappedProperty(layout["text-field"]);
  if (field) {
    labels.field = field;
    labels.expression = "";
  } else if (layout["text-field"] !== undefined) {
    const textField = layout["text-field"];
    labels.expression = Array.isArray(textField)
      ? JSON.stringify(textField)
      : String(textField);
  }

  const size = asFiniteNumber(layout["text-size"]);
  if (size !== null) labels.size = size;

  labels.placement = layout["symbol-placement"] === "line" ? "line" : "point";

  if (typeof layout["text-allow-overlap"] === "boolean") {
    labels.allowOverlap = layout["text-allow-overlap"];
  }
  const anchor = asString(layout["text-anchor"]);
  if (anchor) labels.anchor = anchor as LabelStyle["anchor"];

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
 * the first geometry that carries the renderer wins: a polygon `fill` before a
 * `line`, and a `line` before a `circle`, matching how the exporter derives
 * each from the same style.
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
      colorClaimed = true;
    } else if (color.color) {
      patch.extrusionColor = color.color;
    }
    const opacity = asFiniteNumber(paint["fill-extrusion-opacity"]);
    if (opacity !== null) patch.extrusionOpacity = opacity;
    applyZoomRange(extrusion, patch);
  } else if (fill) {
    matchedLayerCount += 1;
    patch.extrusionEnabled = false;
    const paint = fill.paint ?? {};
    applyColorRenderer(parseColorValue(paint["fill-color"], warnings), patch);
    colorClaimed = true;
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
    if (!colorClaimed) {
      const color = parseColorValue(paint["line-color"], warnings);
      if (color.mode && color.mode !== "single") {
        applyColorRenderer(color, patch);
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
      if (proportional) applyProportional(proportional, patch);
    }
    const strokeColor = asString(paint["circle-stroke-color"]);
    if (strokeColor) patch.strokeColor = strokeColor;
    const strokeWidth = asFiniteNumber(paint["circle-stroke-width"]);
    if (strokeWidth !== null) patch.strokeWidth = strokeWidth;
    applyZoomRange(circle, patch);
  }

  if (heatmap) {
    matchedLayerCount += 1;
    patch.pointRenderer = "heatmap";
    const paint = heatmap.paint ?? {};
    const radius = asFiniteNumber(paint["heatmap-radius"]);
    if (radius !== null) patch.heatmapRadius = radius;
    const intensity = asFiniteNumber(paint["heatmap-intensity"]);
    if (intensity !== null) patch.heatmapIntensity = intensity;
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
