import {
  DEFAULT_LAYER_STYLE,
  type LabelStyle,
  type LayerStyle,
  type VectorRule,
  type VectorStyleStop,
} from "@geolibre/core";
import { XMLParser } from "fast-xml-parser";
import { OGC_SCALE_DENOMINATOR_AT_ZOOM_0 } from "./sld-export";

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
 * Everything a parsed SLD document contributes to a layer's symbology. Mirrors
 * the Mapbox importer's result shape: the {@link style} and {@link labels}
 * patches are kept separate so the caller can merge each over the layer's
 * existing style (labels are a nested object).
 */
export interface SldImportResult {
  /**
   * Flat {@link LayerStyle} fields recovered from the SLD symbolizers (fill,
   * stroke, opacity, point size, renderer mode + stops/rules, zoom range). Only
   * keys the importer could determine are present, so it merges cleanly over the
   * layer's current style and leaves everything else untouched.
   */
  style: Partial<Omit<LayerStyle, "labels">>;
  /**
   * Label fields recovered from a `TextSymbolizer`, or `null` when the SLD had
   * no label symbolizer. When present it always includes `enabled: true`.
   */
  labels: Partial<LabelStyle> | null;
  /**
   * Notes about anything that could not be represented exactly (an untranslatable
   * filter, a non-flat symbolizer, mixed renderer shapes), so the import never
   * silently drops symbology.
   */
  warnings: string[];
  /**
   * How many SLD rules the importer understood (render rules plus a label rule).
   * Zero means the file carried no symbology to apply.
   */
  matchedRuleCount: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Strip sld:/se:/ogc: prefixes so 1.0.0 (CssParameter) and 1.1.0 (SvgParameter,
  // se: namespace) documents parse into the same shape.
  removeNSPrefix: true,
  // Keep text and attribute values as raw strings; numbers are parsed where the
  // schema calls for one so a categorized string category like "01" is not
  // silently turned into the number 1.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

/** Wrap a possibly-absent or single value as an array (fast-xml-parser collapses
 * a lone repeated element to an object and multiples to an array). */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text content of an element (string leaf, or an object's `#text`). */
function nodeText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (isNode(value)) {
    const text = value["#text"];
    if (typeof text === "string") return text.trim() || null;
    if (typeof text === "number") return String(text);
  }
  return null;
}

function toNum(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Collect a `Fill`/`Stroke`/`Font` element's `CssParameter` (SLD 1.0.0) and
 * `SvgParameter` (SLD 1.1.0 / SE) children into a name→value map.
 */
function paramMap(container: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isNode(container)) return map;
  for (const key of ["CssParameter", "SvgParameter"]) {
    for (const param of toArray(container[key])) {
      if (!isNode(param)) continue;
      const name = param["@_name"];
      const value = nodeText(param);
      if (typeof name === "string" && value !== null) map.set(name, value);
    }
  }
  return map;
}

/** The fill/stroke/point fields one symbolizer contributes. */
interface RulePaint {
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  pointSize?: number;
}

/** Read `fill`/`fill-opacity` from a `Fill` element into the paint. */
function readFill(fill: unknown, paint: RulePaint): void {
  const params = paramMap(fill);
  const color = params.get("fill");
  if (color) paint.fillColor = color;
  const opacity = toNum(params.get("fill-opacity") ?? null);
  if (opacity !== null) paint.fillOpacity = opacity;
}

/** Read `stroke`/`stroke-width` from a `Stroke` element into the paint. */
function readStroke(stroke: unknown, paint: RulePaint): void {
  const params = paramMap(stroke);
  const color = params.get("stroke");
  if (color) paint.strokeColor = color;
  const width = toNum(params.get("stroke-width") ?? null);
  if (width !== null) paint.strokeWidth = width;
}

/** Extract the flat paint from one rule's render symbolizers. */
function readRulePaint(rule: XmlNode): RulePaint {
  const paint: RulePaint = {};
  const polygon = toArray(rule.PolygonSymbolizer)[0];
  if (isNode(polygon)) {
    readFill(polygon.Fill, paint);
    readStroke(polygon.Stroke, paint);
  }
  const line = toArray(rule.LineSymbolizer)[0];
  if (isNode(line)) readStroke(line.Stroke, paint);
  const point = toArray(rule.PointSymbolizer)[0];
  if (isNode(point)) {
    const graphic = point.Graphic;
    if (isNode(graphic)) {
      const mark = toArray(graphic.Mark)[0];
      if (isNode(mark)) {
        readFill(mark.Fill, paint);
        readStroke(mark.Stroke, paint);
      }
      const size = toNum(nodeText(graphic.Size));
      if (size !== null) paint.pointSize = size;
    }
  }
  return paint;
}

/** Whether a rule carries any render (non-text) symbolizer. */
function hasRenderSymbolizer(rule: XmlNode): boolean {
  return (
    rule.PolygonSymbolizer !== undefined ||
    rule.LineSymbolizer !== undefined ||
    rule.PointSymbolizer !== undefined
  );
}

/** A single `PropertyIs…` comparison recovered from a filter. */
interface Comparison {
  op: string;
  property: string;
  literal: string;
}

const COMPARISON_OPS = [
  "PropertyIsEqualTo",
  "PropertyIsNotEqualTo",
  "PropertyIsLessThan",
  "PropertyIsLessThanOrEqualTo",
  "PropertyIsGreaterThan",
  "PropertyIsGreaterThanOrEqualTo",
] as const;

/** Read a `PropertyName`/`Literal` pair from a comparison element. */
function readComparisonBody(node: unknown): { property: string; literal: string } | null {
  if (!isNode(node)) return null;
  const property = nodeText(node.PropertyName);
  const literal = nodeText(node.Literal);
  if (property === null || literal === null) return null;
  return { property, literal };
}

/**
 * The single comparison a filter body is, when it is one `PropertyIs…` with a
 * property and literal (not an And/Or/Not), else null.
 */
function asSingleComparison(filterBody: XmlNode): Comparison | null {
  const keys = Object.keys(filterBody).filter((key) => !key.startsWith("@_") && key !== "#text");
  if (keys.length !== 1) return null;
  const op = keys[0];
  if (!(COMPARISON_OPS as readonly string[]).includes(op)) return null;
  const body = readComparisonBody(toArray(filterBody[op])[0]);
  if (!body) return null;
  return { op, property: body.property, literal: body.literal };
}

/** The lower/upper bound a filter body is, when it is a `>= [AND <]` range. */
interface Range {
  property: string;
  lower: number;
  upper: number | null;
}

function asRange(filterBody: XmlNode): Range | null {
  // A single `>=` with no upper bound (the last class break the exporter emits).
  const single = asSingleComparison(filterBody);
  if (single && single.op === "PropertyIsGreaterThanOrEqualTo") {
    const lower = toNum(single.literal);
    if (lower !== null) return { property: single.property, lower, upper: null };
  }
  const and = filterBody.And;
  if (!isNode(and)) return null;
  const ge = readComparisonBody(toArray(and.PropertyIsGreaterThanOrEqualTo)[0]);
  const lt = readComparisonBody(toArray(and.PropertyIsLessThan)[0]);
  if (!ge || !lt || ge.property !== lt.property) return null;
  const lower = toNum(ge.literal);
  const upper = toNum(lt.literal);
  if (lower === null || upper === null) return null;
  return { property: ge.property, lower, upper };
}

/** A scalar literal, parsed to a number when it looks numeric (for round-trip). */
function literalValue(literal: string): string | number {
  const parsed = Number.parseFloat(literal);
  return Number.isFinite(parsed) && String(parsed) === literal.trim()
    ? parsed
    : literal;
}

/**
 * Translate a parsed `<ogc:Filter>` body into a MapLibre filter expression, or
 * null when it uses a predicate GeoLibre cannot express. The reverse of
 * {@link mapboxFilterToOgc}; supports the comparison and logical operators
 * (`PropertyIsEqualTo`/…, `And`, `Or`, `Not`).
 */
function ogcToMapbox(filterBody: unknown): unknown[] | null {
  if (!isNode(filterBody)) return null;
  const comparisonMap: Record<string, string> = {
    PropertyIsEqualTo: "==",
    PropertyIsNotEqualTo: "!=",
    PropertyIsLessThan: "<",
    PropertyIsLessThanOrEqualTo: "<=",
    PropertyIsGreaterThan: ">",
    PropertyIsGreaterThanOrEqualTo: ">=",
  };

  const keys = Object.keys(filterBody).filter(
    (key) => !key.startsWith("@_") && key !== "#text",
  );
  // Combine multiple predicates at one level as an implicit `all` (a defensive
  // case; a well-formed Filter has a single root predicate).
  if (keys.length > 1) {
    const children = keys.flatMap((key) =>
      toArray(filterBody[key]).map((entry) => ogcToMapbox({ [key]: entry })),
    );
    if (children.some((child) => child === null)) return null;
    return ["all", ...(children as unknown[])];
  }
  if (keys.length === 0) return null;
  const op = keys[0];

  if (op in comparisonMap) {
    const body = readComparisonBody(toArray(filterBody[op])[0]);
    if (!body) return null;
    return [comparisonMap[op], ["get", body.property], literalValue(body.literal)];
  }

  if (op === "And" || op === "Or") {
    const inner = toArray(filterBody[op])[0];
    if (!isNode(inner)) return null;
    const children: (unknown[] | null)[] = [];
    for (const key of Object.keys(inner).filter(
      (key) => !key.startsWith("@_") && key !== "#text",
    )) {
      for (const entry of toArray(inner[key])) {
        children.push(ogcToMapbox({ [key]: entry }));
      }
    }
    if (children.length === 0 || children.some((child) => child === null)) {
      return null;
    }
    return [op === "And" ? "all" : "any", ...(children as unknown[])];
  }

  if (op === "Not") {
    const inner = toArray(filterBody[op])[0];
    const child = ogcToMapbox(inner);
    return child === null ? null : ["!", child];
  }

  return null;
}

/** Recover the label patch from a `TextSymbolizer`. */
function readLabels(text: XmlNode, warnings: string[]): Partial<LabelStyle> {
  const labels: Partial<LabelStyle> = { enabled: true };

  const label = text.Label;
  const field = isNode(label) ? nodeText(label.PropertyName) : null;
  if (field) {
    labels.field = field;
    labels.expression = "";
  } else {
    warnings.push(
      "The label had no simple attribute field; labels were enabled but you may need to pick a field.",
    );
  }

  const font = paramMap(text.Font);
  const size = toNum(font.get("font-size") ?? null);
  if (size !== null) labels.size = size;

  const placement = text.LabelPlacement;
  if (isNode(placement)) {
    if (placement.LinePlacement !== undefined) {
      labels.placement = "line";
    } else if (isNode(placement.PointPlacement)) {
      labels.placement = "point";
      const point = placement.PointPlacement;
      const anchor = readAnchor(point.AnchorPoint);
      if (anchor && VALID_LABEL_ANCHORS.has(anchor)) {
        labels.anchor = anchor as LabelStyle["anchor"];
      }
      if (isNode(point.Displacement)) {
        const dx = toNum(nodeText(point.Displacement.DisplacementX));
        const dy = toNum(nodeText(point.Displacement.DisplacementY));
        if (dx !== null) labels.offsetX = dx;
        // SLD Y grows upward; GeoLibre offsetY grows downward.
        if (dy !== null) labels.offsetY = -dy;
      }
      const rotation = toNum(nodeText(point.Rotation));
      if (rotation !== null) labels.rotation = rotation;
    }
  }

  const halo = text.Halo;
  if (isNode(halo)) {
    const radius = toNum(nodeText(halo.Radius));
    if (radius !== null) labels.haloWidth = radius;
    const haloColor = paramMap(halo.Fill).get("fill");
    if (haloColor) labels.haloColor = haloColor;
  }

  const color = paramMap(text.Fill).get("fill");
  if (color) labels.color = color;

  return labels;
}

/** SLD `AnchorPoint` (0..1, origin bottom-left) → a MapLibre `text-anchor`. */
function readAnchor(anchorPoint: unknown): string | null {
  if (!isNode(anchorPoint)) return null;
  const x = toNum(nodeText(anchorPoint.AnchorPointX));
  const y = toNum(nodeText(anchorPoint.AnchorPointY));
  if (x === null || y === null) return null;
  const horizontal = x < 0.33 ? "left" : x > 0.66 ? "right" : "";
  const vertical = y < 0.33 ? "bottom" : y > 0.66 ? "top" : "";
  if (!horizontal && !vertical) return "center";
  if (horizontal && vertical) return `${vertical}-${horizontal}`;
  return horizontal || vertical;
}

/** Convert an SLD scale denominator into a MapLibre zoom level. */
function scaleToZoom(denominator: number): number {
  const zoom = Math.log2(OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / denominator);
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, Math.round(zoom)));
}

/** Apply a rule's `Min`/`MaxScaleDenominator` to the patch's zoom window. */
function applyScale(rule: XmlNode, patch: Partial<Omit<LayerStyle, "labels">>): void {
  // Higher zoom ⇒ smaller scale denominator, so MinScaleDenominator sets maxZoom.
  const minScale = toNum(nodeText(rule.MinScaleDenominator));
  if (minScale !== null && minScale > 0) patch.maxZoom = scaleToZoom(minScale);
  const maxScale = toNum(nodeText(rule.MaxScaleDenominator));
  if (maxScale !== null && maxScale > 0) patch.minZoom = scaleToZoom(maxScale);
}

/** Apply a rule's recovered flat paint to the style patch. */
function applyPaint(
  paint: RulePaint,
  patch: Partial<Omit<LayerStyle, "labels">>,
): void {
  if (paint.fillColor !== undefined) patch.fillColor = paint.fillColor;
  if (paint.fillOpacity !== undefined) patch.fillOpacity = paint.fillOpacity;
  if (paint.strokeColor !== undefined) patch.strokeColor = paint.strokeColor;
  if (paint.strokeWidth !== undefined) {
    patch.strokeWidth = paint.strokeWidth;
    // SLD stroke widths are pixel widths, so reset any prior "meters" unit.
    patch.strokeWidthUnit = "pixels";
  }
  // SLD graphic Size is the mark diameter; GeoLibre circleRadius is the radius.
  if (paint.pointSize !== undefined) patch.circleRadius = paint.pointSize / 2;
}

/** A render rule paired with its parsed filter body (null for else/plain). */
interface RenderRule {
  node: XmlNode;
  paint: RulePaint;
  filterBody: XmlNode | null;
  isElse: boolean;
}

/**
 * Parse an OGC SLD document into a GeoLibre symbology patch. Classifies the
 * FeatureTypeStyle's rules into GeoLibre's renderer model:
 *
 * - one plain rule ⇒ `single`;
 * - all filters are `PropertyIsEqualTo` on one property ⇒ `categorized`;
 * - all filters are numeric ranges on one property ⇒ `graduated`;
 * - otherwise ⇒ `rule-based` (each filter translated back to a MapLibre filter).
 *
 * Reverses what {@link buildSld} produces (so a GeoLibre export round-trips) and
 * imports a hand-written or QGIS/GeoServer SLD as far as its symbolizers map onto
 * GeoLibre's model. Anything that cannot be represented is reported in
 * {@link SldImportResult.warnings} rather than dropped silently.
 *
 * @param xml The SLD document text.
 */
export function parseSld(xml: string): SldImportResult {
  const warnings: string[] = [];
  const patch: Partial<Omit<LayerStyle, "labels">> = {};
  let labels: Partial<LabelStyle> | null = null;

  let root: unknown;
  try {
    root = parser.parse(xml);
  } catch {
    warnings.push("The file could not be parsed as XML; nothing was imported.");
    return { style: patch, labels, warnings, matchedRuleCount: 0 };
  }

  const sld = isNode(root) ? root.StyledLayerDescriptor : undefined;
  if (!isNode(sld)) {
    warnings.push(
      "This file is not an SLD (no StyledLayerDescriptor); nothing was imported.",
    );
    return { style: patch, labels, warnings, matchedRuleCount: 0 };
  }

  // First NamedLayer/UserLayer → first UserStyle → first FeatureTypeStyle.
  const namedLayer =
    toArray(sld.NamedLayer)[0] ?? toArray(sld.UserLayer)[0];
  const userStyles = isNode(namedLayer)
    ? toArray(namedLayer.UserStyle)
    : [];
  if (userStyles.length > 1) {
    warnings.push("The SLD has multiple styles; only the first was imported.");
  }
  const userStyle = userStyles[0];
  const featureTypeStyles = isNode(userStyle)
    ? toArray(userStyle.FeatureTypeStyle)
    : [];
  if (featureTypeStyles.length > 1) {
    warnings.push(
      "The style has multiple FeatureTypeStyles; only the first was imported.",
    );
  }
  const featureTypeStyle = featureTypeStyles[0];
  const rules = isNode(featureTypeStyle)
    ? toArray(featureTypeStyle.Rule).filter(isNode)
    : [];

  if (rules.length === 0) {
    warnings.push("The SLD had no rules; nothing was imported.");
    return { style: patch, labels, warnings, matchedRuleCount: 0 };
  }

  // Split into render rules (fill/line/point) and the label symbolizer, taking
  // the first TextSymbolizer as the layer's labels.
  const renderRules: RenderRule[] = [];
  let matchedRuleCount = 0;
  for (const rule of rules) {
    const textSymbolizer = toArray(rule.TextSymbolizer)[0];
    if (labels === null && isNode(textSymbolizer)) {
      labels = readLabels(textSymbolizer, warnings);
      // A label-only rule still counts as understood symbology.
      if (!hasRenderSymbolizer(rule)) matchedRuleCount += 1;
    }
    if (!hasRenderSymbolizer(rule)) continue;
    const filter = rule.Filter;
    renderRules.push({
      node: rule,
      paint: readRulePaint(rule),
      filterBody: isNode(filter) ? filter : null,
      isElse: rule.ElseFilter !== undefined,
    });
    matchedRuleCount += 1;
  }

  if (renderRules.length > 0) {
    classifyRenderRules(renderRules, patch, warnings);
    // Scale denominators are the same on every rule the exporter emits; read the
    // window from the first render rule.
    applyScale(renderRules[0].node, patch);
  }

  if (matchedRuleCount === 0) {
    warnings.push(
      "No polygon, line, point, or label symbolizers were found; nothing was imported.",
    );
  }

  return { style: patch, labels, warnings, matchedRuleCount };
}

/** Classify the render rules and write the renderer fields onto the patch. */
function classifyRenderRules(
  renderRules: RenderRule[],
  patch: Partial<Omit<LayerStyle, "labels">>,
  warnings: string[],
): void {
  const filtered = renderRules.filter((rule) => !rule.isElse && rule.filterBody);
  const elseRule = renderRules.find((rule) => rule.isElse);

  // The first render rule supplies the flat style (stroke/width/opacity/size are
  // constant across an exported renderer's rules).
  applyPaint(renderRules[0].paint, patch);

  // No filtered rules ⇒ a plain single-symbol style.
  if (filtered.length === 0) {
    patch.vectorStyleMode = "single";
    return;
  }

  // Categorized: every filter is `PropertyIsEqualTo` on one shared property.
  const comparisons = filtered.map((rule) =>
    rule.filterBody ? asSingleComparison(rule.filterBody) : null,
  );
  if (
    comparisons.every(
      (comparison) =>
        comparison?.op === "PropertyIsEqualTo" &&
        comparison.property === comparisons[0]?.property,
    )
  ) {
    const property = comparisons[0]!.property;
    const stops: VectorStyleStop[] = [];
    for (let index = 0; index < filtered.length; index += 1) {
      const color = filtered[index].paint.fillColor;
      if (color === undefined) continue;
      stops.push({ value: literalValue(comparisons[index]!.literal), color });
    }
    if (stops.length > 0) {
      patch.vectorStyleMode = "categorized";
      patch.vectorStyleProperty = property;
      patch.vectorStyleStops = stops;
      // The ElseFilter rule's fill is the `match` fallback color.
      if (elseRule?.paint.fillColor) patch.fillColor = elseRule.paint.fillColor;
      return;
    }
  }

  // Graduated: every filter is a numeric range on one shared property; the lower
  // bounds and colors become the interpolation stops.
  const ranges = filtered.map((rule) =>
    rule.filterBody ? asRange(rule.filterBody) : null,
  );
  if (
    ranges.every(
      (range) => range && range.property === ranges[0]?.property,
    )
  ) {
    const stops: VectorStyleStop[] = [];
    for (let index = 0; index < filtered.length; index += 1) {
      const color = filtered[index].paint.fillColor;
      if (color === undefined) continue;
      stops.push({ value: ranges[index]!.lower, color });
    }
    stops.sort((a, b) => Number(a.value) - Number(b.value));
    if (stops.length >= 2) {
      patch.vectorStyleMode = "graduated";
      patch.vectorStyleProperty = ranges[0]!.property;
      patch.vectorStyleStops = stops;
      return;
    }
  }

  // Otherwise a rule-based renderer: translate each filter back to a MapLibre
  // filter, keeping the rules that translate.
  const vectorRules: VectorRule[] = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const rule = filtered[index];
    const expression = rule.filterBody ? ogcToMapbox(rule.filterBody) : null;
    if (expression === null) {
      warnings.push(
        "A rule used a filter that could not be read; it was skipped.",
      );
      continue;
    }
    vectorRules.push({
      id: `sld-rule-${index}`,
      label: "",
      filter: JSON.stringify(expression),
      color: rule.paint.fillColor ?? DEFAULT_LAYER_STYLE.fillColor,
      isElse: false,
    });
  }
  const elseColor = elseRule?.paint.fillColor ?? DEFAULT_LAYER_STYLE.fillColor;
  vectorRules.push({
    id: "sld-rule-else",
    label: "",
    filter: "",
    color: elseColor,
    isElse: true,
  });
  patch.vectorStyleMode = "rule-based";
  patch.vectorRules = vectorRules;
  patch.fillColor = elseColor;
}

/**
 * Merge a parsed SLD import over a base {@link LayerStyle}, producing the next
 * style. The label patch is merged into the nested {@link LayerStyle.labels}
 * object so a partial label import keeps the base's other label fields. Mirrors
 * {@link applyMapboxStyleImport}.
 *
 * @param base The layer's current style.
 * @param result The output of {@link parseSld}.
 */
export function applySldImport(
  base: LayerStyle,
  result: SldImportResult,
): LayerStyle {
  return {
    ...base,
    ...result.style,
    labels: result.labels
      ? { ...base.labels, ...result.labels }
      : base.labels,
  };
}
