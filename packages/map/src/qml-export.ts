import {
  DEFAULT_LAYER_STYLE,
  isHexColor,
  parseJsonExpression,
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
  type MarkerShape,
  type VectorRule,
  type VectorStyleStop,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { detectGeometryProfile, type GeometryProfile } from "./geojson-loader";
import { OGC_SCALE_DENOMINATOR_AT_ZOOM_0 } from "./sld-export";

/** Default font family written to exported QML label text-styles. */
const DEFAULT_FONT_FAMILY = "Open Sans";

/**
 * GeoLibre marker shapes that map onto a QGIS SimpleMarker `name`. QGIS has a
 * richer shape set than SLD, so `diamond` maps directly (SLD had no equivalent).
 */
const MARKER_QGIS_NAME: Partial<Record<MarkerShape, string>> = {
  circle: "circle",
  square: "square",
  triangle: "triangle",
  star: "star",
  cross: "cross",
  diamond: "diamond",
};

export interface QmlExportResult {
  /** A complete QGIS QML style document (`<qgis>`), as XML text. */
  qml: string;
  /**
   * Human-readable notes about anything that could not be represented exactly
   * (3D extrusion, heatmap/cluster point renderers, fill patterns, a raw color
   * expression), so the export never fails silently. Empty when the symbology
   * mapped cleanly.
   */
  warnings: string[];
}

/**
 * The layer fields the QML exporter reads. Kept structural (rather than the full
 * {@link GeoLibreLayer}) so it is easy to unit-test with a minimal fixture.
 */
export type QmlExportableLayer = Pick<
  GeoLibreLayer,
  "id" | "name" | "type" | "style" | "opacity" | "visible"
>;

export interface QmlExportOptions {
  /** Font family written to exported label text-styles. Defaults to Open Sans. */
  fontFamily?: string;
}

/** The QGIS symbol geometry class a layer uses, from its geometry profile. */
type SymbolGeometry = "fill" | "line" | "marker";

/** Escape a value for XML text/attribute content. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a number without scientific notation or trailing zeros (never `-0`). */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(6)) || 0);
}

/**
 * Convert a `#rrggbb` hex color into QGIS's `r,g,b,a` string (each 0-255). A
 * non-hex value falls back to opaque black so the export never emits an invalid
 * color. The alpha multiplies the 0..1 `opacity` into the 0-255 range.
 */
function hexToRgba(hex: string, opacity = 1): string {
  const clean = isHexColor(hex) ? hex.trim() : "#000000";
  const r = Number.parseInt(clean.slice(1, 3), 16);
  const g = Number.parseInt(clean.slice(3, 5), 16);
  const b = Number.parseInt(clean.slice(5, 7), 16);
  const a = Math.max(0, Math.min(255, Math.round(opacity * 255)));
  return `${r},${g},${b},${a}`;
}

/** One `<Option name="…" type="QString" value="…"/>` line. */
function option(name: string, value: string): string {
  return `<Option name="${name}" type="QString" value="${xmlEscape(value)}"/>`;
}

/** The fill/stroke/marker fields a symbol layer draws with. */
interface SymbolPaint {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  markerShape: string;
  markerSize: number;
}

/** The flat (single-symbol) paint from a style. A point layer without a shape
 * marker renders as a plain circle sized from the circle radius (diameter), not
 * the marker size. */
function basePaint(style: LayerStyle): SymbolPaint {
  const markerEnabled = styleValue(style, "markerEnabled");
  return {
    fillColor: styleValue(style, "fillColor"),
    fillOpacity: styleValue(style, "fillOpacity"),
    strokeColor: styleValue(style, "strokeColor"),
    strokeWidth: styleValue(style, "strokeWidth"),
    markerShape: markerEnabled ? styleValue(style, "markerShape") : "circle",
    markerSize: markerEnabled
      ? styleValue(style, "markerSize")
      : styleValue(style, "circleRadius") * 2,
  };
}

/** The single-symbol primary color for a geometry: stroke for lines, the marker
 * color for a shape-marker point layer, otherwise the fill. */
function singleColor(style: LayerStyle, geometry: SymbolGeometry): string {
  if (geometry === "line") return styleValue(style, "strokeColor");
  if (geometry === "marker" && styleValue(style, "markerEnabled")) {
    return styleValue(style, "markerColor");
  }
  return styleValue(style, "fillColor");
}

/**
 * A `<symbol>` of the given geometry class. `color` is the primary color (fill
 * for fill/marker symbols, line for line symbols) so a categorized/graduated/
 * rule class can override just that channel. `opacity` folds into the fill/line
 * alpha; the symbol's own `alpha` is left at 1.
 */
function symbolXml(
  geometry: SymbolGeometry,
  name: string,
  color: string,
  paint: SymbolPaint,
  opacity: number,
  warnings: string[],
): string {
  const open = `<symbol type="${geometry}" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0">`;
  let layer: string;
  if (geometry === "fill") {
    layer = [
      '<layer class="SimpleFill" enabled="1" locked="0" pass="0">',
      '<Option type="Map">',
      option("color", hexToRgba(color, paint.fillOpacity * opacity)),
      option("outline_color", hexToRgba(paint.strokeColor, opacity)),
      option("outline_width", num(paint.strokeWidth)),
      option("outline_width_unit", "Pixel"),
      option("outline_style", "solid"),
      option("style", "solid"),
      "</Option>",
      "</layer>",
    ].join("");
  } else if (geometry === "line") {
    layer = [
      '<layer class="SimpleLine" enabled="1" locked="0" pass="0">',
      '<Option type="Map">',
      option("line_color", hexToRgba(color, opacity)),
      option("line_width", num(paint.strokeWidth)),
      option("line_width_unit", "Pixel"),
      option("line_style", "solid"),
      option("capstyle", "round"),
      option("joinstyle", "round"),
      "</Option>",
      "</layer>",
    ].join("");
  } else {
    let shapeName = "circle";
    const size = paint.markerSize;
    const mapped = MARKER_QGIS_NAME[paint.markerShape as MarkerShape];
    if (mapped) {
      shapeName = mapped;
    } else if (paint.markerShape && paint.markerShape !== "circle") {
      warnings.push(
        `The "${paint.markerShape}" marker has no QGIS equivalent; points use a circle instead.`,
      );
    }
    layer = [
      '<layer class="SimpleMarker" enabled="1" locked="0" pass="0">',
      '<Option type="Map">',
      option("name", shapeName),
      option("color", hexToRgba(color, paint.fillOpacity * opacity)),
      option("size", num(size)),
      option("size_unit", "Pixel"),
      option("outline_color", hexToRgba(paint.strokeColor, opacity)),
      option("outline_width", num(paint.strokeWidth)),
      option("outline_width_unit", "Pixel"),
      option("outline_style", "solid"),
      "</Option>",
      "</layer>",
    ].join("");
  }
  return `${open}${layer}</symbol>`;
}

/** Pick the QGIS symbol geometry class from the layer's geometry profile. */
function symbolGeometry(profile: GeometryProfile): SymbolGeometry {
  if (profile.hasPolygon) return "fill";
  if (profile.hasLine) return "line";
  return "marker";
}

/** Translate a GeoLibre rule's MapLibre filter (JSON) into a QGIS expression, or
 * null when it uses an operator QGIS cannot express. Reverses
 * {@link qgisFilterToMapbox} in the importer. */
function mapboxFilterToQgis(expression: unknown): string | null {
  if (!Array.isArray(expression)) return null;
  const [op, ...rest] = expression;

  const comparison: Record<string, string> = {
    "==": "=",
    "!=": "<>",
    "<": "<",
    "<=": "<=",
    ">": ">",
    ">=": ">=",
  };
  if (typeof op === "string" && op in comparison && rest.length === 2) {
    const property = getProp(rest[0]);
    const literal = getLiteral(rest[1]);
    if (property === null || literal === null) return null;
    return `${quoteField(property)} ${comparison[op]} ${quoteLiteral(literal)}`;
  }

  if ((op === "all" || op === "any") && rest.length > 0) {
    const children = rest.map(mapboxFilterToQgis);
    if (children.some((child) => child === null)) return null;
    const joiner = op === "all" ? " AND " : " OR ";
    return children.map((child) => `(${child})`).join(joiner);
  }

  if (op === "!" && rest.length === 1) {
    const child = mapboxFilterToQgis(rest[0]);
    return child === null ? null : `NOT (${child})`;
  }

  if (op === "in" && rest.length >= 2) {
    const property = getProp(rest[0]);
    if (property === null) return null;
    const haystack = rest[1];
    const rawValues =
      rest.length === 2 &&
      Array.isArray(haystack) &&
      haystack[0] === "literal" &&
      Array.isArray(haystack[1])
        ? (haystack[1] as unknown[])
        : rest.slice(1);
    const values = rawValues.map(getLiteral);
    if (values.length === 0 || values.some((value) => value === null)) {
      return null;
    }
    return `${quoteField(property)} IN (${values
      .map((value) => quoteLiteral(value as string | number | boolean))
      .join(", ")})`;
  }

  return null;
}

/** A QGIS double-quoted field reference (`"name"`), escaping embedded quotes. */
function quoteField(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A QGIS literal: single-quoted string (escaping `'`), or bare number/boolean. */
function quoteLiteral(value: string | number | boolean): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replace(/'/g, "''")}'`;
}

/** Read the property name from `["get", "p"]`. */
function getProp(node: unknown): string | null {
  if (Array.isArray(node) && node[0] === "get" && typeof node[1] === "string") {
    return node[1];
  }
  return null;
}

/** Read a scalar literal (string/number/boolean), unwrapping `["literal", v]`. */
function getLiteral(node: unknown): string | number | boolean | null {
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return node;
  }
  if (Array.isArray(node) && node[0] === "literal") return getLiteral(node[1]);
  return null;
}

/** Build the `<labeling>` block for a layer whose labels are enabled, or "". */
function labelingXml(style: LayerStyle, fontFamily: string, warnings: string[]): string {
  const labels = style.labels ?? DEFAULT_LAYER_STYLE.labels;
  if (!labels.enabled) return "";

  let field = labels.field.trim();
  if (!field && labels.expression.trim()) {
    warnings.push(
      "The label expression has no direct QML equivalent; the label field is exported instead.",
    );
  }
  if (!field) return "";

  const buffer =
    labels.haloWidth > 0
      ? `<text-buffer bufferDraw="1" bufferSize="${num(
          labels.haloWidth,
        )}" bufferSizeUnits="Pixel" bufferColor="${hexToRgba(labels.haloColor)}"/>`
      : '<text-buffer bufferDraw="0"/>';

  // QGIS `placement` is a small enum. GeoLibre only distinguishes point vs line
  // placement, so this uses a simplified encoding: 2 for line placement, 1
  // otherwise. The importer only checks for "2" to recover line placement.
  const placementCode = labels.placement === "line" ? "2" : "1";

  return [
    '<labeling type="simple">',
    `<settings fieldName="${xmlEscape(field)}" isExpression="0">`,
    `<text-style fontFamily="${xmlEscape(fontFamily)}" fontSize="${num(
      labels.size,
    )}" fontSizeUnit="Pixel" textColor="${hexToRgba(labels.color)}" textOpacity="1">`,
    buffer,
    "</text-style>",
    `<placement placement="${placementCode}"/>`,
    "</settings>",
    "</labeling>",
  ].join("");
}

/** Wrap symbols + renderer body in a `<renderer-v2>` and the `<qgis>` document. */
function document(rendererBody: string, labeling: string): string {
  return [
    "<!DOCTYPE qgis>",
    '<qgis version="3.34.0" styleCategories="Symbology|Labeling">',
    rendererBody,
    labeling,
    "</qgis>",
  ].join("\n");
}

/** The single-symbol renderer. */
function singleRenderer(
  geometry: SymbolGeometry,
  style: LayerStyle,
  opacity: number,
  warnings: string[],
): string {
  const symbol = symbolXml(
    geometry,
    "0",
    singleColor(style, geometry),
    basePaint(style),
    opacity,
    warnings,
  );
  return `<renderer-v2 type="singleSymbol" forceraster="0" symbollevels="0" enableorderby="0"><symbols>${symbol}</symbols></renderer-v2>`;
}

/** The categorized renderer (one category + symbol per stop, plus a default). */
function categorizedRenderer(
  geometry: SymbolGeometry,
  style: LayerStyle,
  opacity: number,
  property: string,
  stops: VectorStyleStop[],
  warnings: string[],
): string {
  const paint = basePaint(style);
  const categories: string[] = [];
  const symbols: string[] = [];
  let index = 0;
  let dropped = false;
  for (const stop of stops) {
    if (String(stop.value).trim().length === 0 || !isHexColor(stop.color)) {
      dropped = true;
      continue;
    }
    const value = xmlEscape(String(stop.value));
    const label = xmlEscape(stop.label || String(stop.value));
    categories.push(
      `<category value="${value}" symbol="${index}" label="${label}" render="true"/>`,
    );
    symbols.push(symbolXml(geometry, String(index), stop.color, paint, opacity, warnings));
    index += 1;
  }
  if (dropped) {
    warnings.push(
      "Some categorized categories had a blank value or invalid color and were skipped.",
    );
  }
  // The empty-value default category is QGIS's catch-all (the match fallback);
  // its color is the layer's single-symbol color for the geometry (markerColor
  // for a shape-marker point layer, stroke for lines, otherwise fill).
  categories.push(`<category value="" symbol="${index}" label="" render="true"/>`);
  symbols.push(
    symbolXml(geometry, String(index), singleColor(style, geometry), paint, opacity, warnings),
  );
  return `<renderer-v2 type="categorizedSymbol" attr="${xmlEscape(
    property,
  )}" forceraster="0" symbollevels="0" enableorderby="0"><categories>${categories.join(
    "",
  )}</categories><symbols>${symbols.join("")}</symbols></renderer-v2>`;
}

/** The graduated renderer (continuous ramp written as discrete class ranges). */
function graduatedRenderer(
  geometry: SymbolGeometry,
  style: LayerStyle,
  opacity: number,
  property: string,
  stops: VectorStyleStop[],
  warnings: string[],
): string {
  const paint = basePaint(style);
  const numeric = stops
    .map((stop) => ({
      color: stop.color,
      label: stop.label,
      value: typeof stop.value === "number" ? stop.value : Number.parseFloat(String(stop.value)),
    }))
    .filter((stop) => Number.isFinite(stop.value) && isHexColor(stop.color))
    .sort((a, b) => a.value - b.value);
  if (numeric.length < stops.length) {
    warnings.push(
      "Some graduated stops had a non-numeric value or invalid color and were skipped.",
    );
  }

  warnings.push(
    "The graduated color ramp was written as discrete QML class ranges (QGIS graduated convention); the continuous interpolation is approximated and features below the lowest class are left unclassified.",
  );

  const ranges: string[] = [];
  const symbols: string[] = [];
  for (let index = 0; index < numeric.length; index += 1) {
    const stop = numeric[index];
    const next = numeric[index + 1];
    // Each class covers [stop.value, next.value); the last is open-ended above.
    // The stop value is the class lower bound, so the exact stops round-trip.
    const upper = next ? next.value : Infinity;
    const label = stop.label || `${num(stop.value)} - ${next ? num(next.value) : "∞"}`;
    ranges.push(
      `<range lower="${num(stop.value)}" upper="${
        Number.isFinite(upper) ? num(upper) : ""
      }" symbol="${index}" label="${xmlEscape(label)}" render="true"/>`,
    );
    symbols.push(symbolXml(geometry, String(index), stop.color, paint, opacity, warnings));
  }
  return `<renderer-v2 type="graduatedSymbol" attr="${xmlEscape(
    property,
  )}" graduatedMethod="GraduatedColor" forceraster="0" symbollevels="0" enableorderby="0"><ranges>${ranges.join(
    "",
  )}</ranges><symbols>${symbols.join("")}</symbols></renderer-v2>`;
}

/**
 * One rule's symbol paint: the layer's base paint with the rule's per-rule
 * overrides (outline color/width, opacity, size) folded in. A per-rule
 * circle radius only overrides the marker size when the layer renders plain
 * circles (a shape marker's size is its own setting the rule cannot change).
 */
function rulePaintFor(entry: VectorRule, paint: SymbolPaint, style: LayerStyle): SymbolPaint {
  return {
    ...paint,
    strokeColor: isHexColor(entry.strokeColor) ? (entry.strokeColor as string) : paint.strokeColor,
    strokeWidth:
      typeof entry.strokeWidth === "number" && Number.isFinite(entry.strokeWidth)
        ? entry.strokeWidth
        : paint.strokeWidth,
    fillOpacity:
      typeof entry.fillOpacity === "number" && Number.isFinite(entry.fillOpacity)
        ? entry.fillOpacity
        : paint.fillOpacity,
    markerSize:
      typeof entry.circleRadius === "number" &&
      Number.isFinite(entry.circleRadius) &&
      !styleValue(style, "markerEnabled")
        ? entry.circleRadius * 2
        : paint.markerSize,
  };
}

/**
 * A rule's `scalemindenom`/`scalemaxdenom` attributes from its zoom range.
 * Higher zoom means a smaller scale denominator, so the rule's `maxZoom`
 * becomes the minimum denominator and its `minZoom` the maximum.
 */
function ruleScaleAttributes(rule: VectorRule): string {
  let out = "";
  if (typeof rule.maxZoom === "number" && Number.isFinite(rule.maxZoom)) {
    out += ` scalemindenom="${num(OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / 2 ** rule.maxZoom)}"`;
  }
  if (typeof rule.minZoom === "number" && Number.isFinite(rule.minZoom)) {
    out += ` scalemaxdenom="${num(OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / 2 ** rule.minZoom)}"`;
  }
  return out;
}

/**
 * The rule-based renderer. Nested rules (a rule naming another as its
 * `parentId`) are written as QGIS's native rule tree; per-rule scale ranges
 * become `scalemindenom`/`scalemaxdenom`; a disabled rule keeps its subtree but
 * gets `checkstate="0"` (the QGIS rule checkbox); per-rule symbol overrides
 * (outline color/width, opacity, size) are folded into each rule's
 * symbol. The ELSE rule stays a top-level catch-all.
 */
function ruleRenderer(
  geometry: SymbolGeometry,
  style: LayerStyle,
  opacity: number,
  rules: VectorRule[],
  warnings: string[],
): string {
  const paint = basePaint(style);
  const symbols: string[] = [];
  const elseRule = rules.find((entry) => entry.isElse);
  const concrete = rules.filter((entry) => !entry.isElse);
  const byId = new Map(concrete.map((entry) => [entry.id, entry]));
  const childrenOf = new Map<string, VectorRule[]>();
  const roots: VectorRule[] = [];
  for (const entry of concrete) {
    const parent =
      entry.parentId && entry.parentId !== entry.id ? byId.get(entry.parentId) : undefined;
    if (parent) {
      const siblings = childrenOf.get(parent.id);
      if (siblings) siblings.push(entry);
      else childrenOf.set(parent.id, [entry]);
    } else {
      roots.push(entry);
    }
  }

  const emitted = new Set<string>();
  const emitRule = (entry: VectorRule): string => {
    if (emitted.has(entry.id)) return "";
    emitted.add(entry.id);
    const kids = childrenOf.get(entry.id) ?? [];
    const isGroup = kids.length > 0;
    // A rule's own filter only (QGIS ANDs ancestor filters natively). A group
    // may have a blank filter (no extra constraint); a blank leaf filter is an
    // authoring error the live map also skips. Validated before the children
    // are emitted so a dropped group does not leave orphan symbols behind.
    let filterAttribute = "";
    if (entry.filter.trim() || !isGroup) {
      const parsed = parseJsonExpression(entry.filter);
      const filter = parsed ? mapboxFilterToQgis(parsed) : null;
      if (filter === null) {
        warnings.push(
          `The rule "${entry.label || entry.filter}" uses a filter with no QGIS equivalent and was skipped.`,
        );
        return "";
      }
      filterAttribute = ` filter="${xmlEscape(filter)}"`;
    }
    const children = kids.map(emitRule).join("");
    let symbolAttribute = "";
    if (!isGroup) {
      if (!isHexColor(entry.color)) {
        warnings.push(
          `The rule "${entry.label || entry.filter}" has an invalid color and was skipped.`,
        );
        return "";
      }
      const rulePaint = rulePaintFor(entry, paint, style);
      symbolAttribute = ` symbol="${symbols.length}"`;
      symbols.push(
        symbolXml(geometry, String(symbols.length), entry.color, rulePaint, opacity, warnings),
      );
    }
    const checkstate = entry.enabled === false ? ' checkstate="0"' : "";
    const attributes = `${filterAttribute}${symbolAttribute}${ruleScaleAttributes(
      entry,
    )}${checkstate} label="${xmlEscape(entry.label || "")}" key="rule-${xmlEscape(entry.id)}"`;
    return children.length > 0 ? `<rule${attributes}>${children}</rule>` : `<rule${attributes}/>`;
  };

  const ruleXml = roots.map(emitRule).join("");
  // The ELSE rule catches features no other rule matched; its color falls back
  // to the layer's single-symbol color for the geometry when the else rule has
  // no valid color.
  const elseColor =
    elseRule && isHexColor(elseRule.color) ? elseRule.color : singleColor(style, geometry);
  const elseCheckstate = elseRule?.enabled === false ? ' checkstate="0"' : "";
  const elseXml = `<rule filter="ELSE" symbol="${symbols.length}"${elseCheckstate} label="${xmlEscape(
    elseRule?.label || "",
  )}" key="ruleelse"/>`;
  symbols.push(
    symbolXml(
      geometry,
      String(symbols.length),
      elseColor,
      elseRule ? rulePaintFor(elseRule, paint, style) : paint,
      opacity,
      warnings,
    ),
  );
  return `<renderer-v2 type="RuleRenderer" forceraster="0" symbollevels="0" enableorderby="0"><rules key="root">${ruleXml}${elseXml}</rules><symbols>${symbols.join(
    "",
  )}</symbols></renderer-v2>`;
}

/**
 * Serialize a vector layer's GeoLibre symbology into a QGIS QML style document,
 * the native style format QGIS users have on disk. The
 * single/categorized/graduated/rule-based renderers map onto QGIS's
 * singleSymbol/categorizedSymbol/graduatedSymbol/RuleRenderer with fill, line,
 * or marker symbols chosen from the layer geometry; labels become a simple
 * labeling block. Anything QGIS cannot represent (3D extrusion, heatmap/cluster
 * points, fill patterns, a raw color expression) degrades gracefully and is
 * reported in {@link QmlExportResult.warnings} rather than dropped silently.
 *
 * The layer's opacity folds into the symbol color alpha, matching the other
 * symbology exporters.
 *
 * @param layer   The layer whose `style` is exported.
 * @param geojson The layer's features, used only to pick the symbol geometry
 *                class (fill/line/marker). When `null`, a fill symbol is used.
 */
export function buildQml(
  layer: QmlExportableLayer,
  geojson: FeatureCollection | null,
  options: QmlExportOptions = {},
): QmlExportResult {
  const warnings: string[] = [];
  const style = layer.style;
  const opacity = layer.opacity;
  const fontFamily = options.fontFamily?.trim() || DEFAULT_FONT_FAMILY;

  const profile: GeometryProfile = geojson
    ? detectGeometryProfile(geojson)
    : { hasPoint: false, hasLine: false, hasPolygon: true };
  if (!profile.hasPoint && !profile.hasLine && !profile.hasPolygon) {
    profile.hasPolygon = true;
  }
  const geometry = symbolGeometry(profile);

  if (styleValue(style, "extrusionEnabled")) {
    warnings.push("3D extrusion has no QML equivalent; the layer is exported as a flat 2D style.");
  }
  const pointRenderer = styleValue(style, "pointRenderer");
  if (geometry === "marker" && (pointRenderer === "heatmap" || pointRenderer === "cluster")) {
    warnings.push(
      `The ${pointRenderer} point renderer has no QML equivalent; points are exported as plain markers.`,
    );
  }
  if (geometry === "fill" && styleValue(style, "fillPattern") !== "none") {
    warnings.push(
      "The fill pattern has no portable QML equivalent; the polygon uses a flat fill instead.",
    );
  }
  if (styleValue(style, "strokeWidthUnit") === "meters") {
    warnings.push(
      "The stroke width is in map units (meters); it is exported as a fixed pixel width.",
    );
  }
  if (styleValue(style, "proportionalSizeEnabled")) {
    warnings.push(
      "Proportional (attribute-driven) symbol size has no portable QML equivalent; a fixed size is exported instead.",
    );
  }

  const mode = styleValue(style, "vectorStyleMode");
  const property = styleValue(style, "vectorStyleProperty").trim();
  const stops = styleValue(style, "vectorStyleStops");
  const validCategorized = stops.filter(
    (stop) => String(stop.value).trim().length > 0 && isHexColor(stop.color),
  ).length;
  const validGraduated = stops.filter(
    (stop) =>
      isHexColor(stop.color) &&
      Number.isFinite(
        typeof stop.value === "number" ? stop.value : Number.parseFloat(String(stop.value)),
      ),
  ).length;

  let renderer: string;
  if (mode === "categorized" && property && validCategorized > 0) {
    renderer = categorizedRenderer(geometry, style, opacity, property, stops, warnings);
  } else if (mode === "graduated" && property && validGraduated >= 2) {
    renderer = graduatedRenderer(geometry, style, opacity, property, stops, warnings);
  } else if (mode === "rule-based" && styleValue(style, "vectorRules").length > 0) {
    renderer = ruleRenderer(geometry, style, opacity, styleValue(style, "vectorRules"), warnings);
  } else {
    if (mode === "expression") {
      warnings.push(
        "The custom color expression has no QML equivalent; the layer is exported with its fallback color.",
      );
    } else if (mode === "categorized" || mode === "graduated" || mode === "rule-based") {
      warnings.push(
        `The ${mode} renderer had no valid classes to export; the layer is exported as a single symbol.`,
      );
    }
    renderer = singleRenderer(geometry, style, opacity, warnings);
  }

  const labeling = labelingXml(style, fontFamily, warnings);

  return {
    qml: formatQml(document(renderer, labeling)),
    warnings: [...new Set(warnings)],
  };
}

/**
 * Pretty-print the QML by inserting newlines and indentation between tags. The
 * document is built as a flat string for simplicity; this pass makes it readable
 * without a DOM serializer (which is unavailable in the Node test environment).
 */
function formatQml(xml: string): string {
  const tokens = xml.replace(/>\s*</g, "><").replace(/></g, ">\n<").split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const token of tokens) {
    const isClosing = /^<\//.test(token);
    const isSelfContained =
      /^<[^!?][^>]*\/>$/.test(token) ||
      /^<!/.test(token) ||
      /^<\?/.test(token) ||
      /^<([\w:-]+)(\s[^>]*)?>.*<\/\1>$/.test(token);
    if (isClosing) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + token);
    if (!isClosing && !isSelfContained && /^<[^!?]/.test(token)) depth += 1;
  }
  return out.join("\n");
}
