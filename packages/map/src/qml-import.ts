import {
  DEFAULT_LAYER_STYLE,
  type LabelStyle,
  type LayerStyle,
  type MarkerShape,
  type VectorRule,
  type VectorStyleStop,
} from "@geolibre/core";
import { XMLParser } from "fast-xml-parser";
import { OGC_SCALE_DENOMINATOR_AT_ZOOM_0 } from "./sld-export";

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

/** QGIS SimpleMarker `name` values that map back onto a GeoLibre marker shape. */
const QGIS_NAME_TO_SHAPE: Record<string, MarkerShape> = {
  square: "square",
  triangle: "triangle",
  star: "star",
  cross: "cross",
  diamond: "diamond",
};

/**
 * Everything a parsed QML document contributes to a layer's symbology. Mirrors
 * the SLD/Mapbox importer result shape.
 */
export interface QmlImportResult {
  style: Partial<Omit<LayerStyle, "labels">>;
  labels: Partial<LabelStyle> | null;
  warnings: string[];
  /** How many renderer classes/symbols were understood; 0 means nothing applied. */
  matchedRuleCount: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Keep entity handling off (a hostile DOCTYPE cannot trigger entity
  // expansion); the five predefined entities are decoded manually below.
  processEntities: false,
});

type XmlNode = Record<string, unknown>;

/** Decode the five predefined XML entities and numeric character references. */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#(?:[0-9]+|[xX][0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (match, body) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        // fromCodePoint throws on out-of-range/negative values, so validate the
        // code point (untrusted input) before decoding and keep the raw text
        // otherwise instead of crashing the import.
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
    }
  });
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a decoded string attribute from a node. */
function attr(node: unknown, name: string): string | null {
  if (!isNode(node)) return null;
  const value = node[`@_${name}`];
  if (typeof value === "string") return decodeXmlEntities(value);
  if (typeof value === "number") return String(value);
  return null;
}

function toNum(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert a QGIS `r,g,b[,a]` color into a `#rrggbb` hex string and 0..1 alpha.
 * Returns null when the value is not a QGIS color triple/quad.
 */
function rgbaToHex(value: string | null): { hex: string; alpha: number } | null {
  if (value === null) return null;
  const parts = value.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [r, g, b] = parts;
  const alpha = parts.length >= 4 ? Math.max(0, Math.min(255, parts[3])) / 255 : 1;
  const hex = `#${[r, g, b]
    .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
    .join("")}`;
  return { hex, alpha };
}

/**
 * A symbol layer's option map, reading both the modern `<Option name= value=>`
 * form and the legacy `<prop k= v=>` form.
 */
function optionMap(symbolLayer: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!isNode(symbolLayer)) return map;
  // Modern: <Option type="Map"><Option name= type= value=/></Option>.
  const optionRoot = symbolLayer.Option;
  if (isNode(optionRoot)) {
    for (const opt of toArray(optionRoot.Option)) {
      const name = attr(opt, "name");
      const value = attr(opt, "value");
      if (name !== null && value !== null) map.set(name, value);
    }
  }
  // Legacy: <prop k= v=/>.
  for (const prop of toArray(symbolLayer.prop)) {
    const name = attr(prop, "k");
    const value = attr(prop, "v");
    if (name !== null && value !== null) map.set(name, value);
  }
  return map;
}

/** The fill/stroke/marker fields recovered from one `<symbol>`. */
interface SymbolInfo {
  geometry: "fill" | "line" | "marker" | "unknown";
  /** Primary color: fill for fill/marker symbols, stroke for line symbols. */
  color?: string;
  /** 0..1 opacity from the primary color's alpha. */
  opacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  markerSize?: number;
  markerName?: string;
}

/** Parse one `<symbol>` element into a {@link SymbolInfo}. */
function readSymbol(symbol: unknown): SymbolInfo {
  const type = attr(symbol, "type");
  const geometry: SymbolInfo["geometry"] =
    type === "fill" || type === "line" || type === "marker" ? type : "unknown";
  const info: SymbolInfo = { geometry };
  if (!isNode(symbol)) return info;
  const layer = toArray(symbol.layer)[0];
  const opts = optionMap(layer);

  if (geometry === "line") {
    const line = rgbaToHex(opts.get("line_color") ?? null);
    if (line) {
      info.color = line.hex;
      info.opacity = line.alpha;
    }
    const width = toNum(opts.get("line_width") ?? null);
    if (width !== null) info.strokeWidth = width;
    return info;
  }

  // fill or marker (or unknown treated as fill-ish): both use `color`.
  const fill = rgbaToHex(opts.get("color") ?? null);
  if (fill) {
    info.color = fill.hex;
    info.opacity = fill.alpha;
  }
  const outline = rgbaToHex(opts.get("outline_color") ?? null);
  if (outline) info.strokeColor = outline.hex;
  const outlineWidth = toNum(opts.get("outline_width") ?? null);
  if (outlineWidth !== null) info.strokeWidth = outlineWidth;
  if (geometry === "marker") {
    const size = toNum(opts.get("size") ?? null);
    if (size !== null) info.markerSize = size;
    const name = opts.get("name");
    if (name) info.markerName = name;
  }
  return info;
}

// ---------------------------------------------------------------------------
// QGIS expression → MapLibre filter
// ---------------------------------------------------------------------------

type Token =
  | { kind: "field"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "op"; value: string }
  | { kind: "kw"; value: "AND" | "OR" | "NOT" | "IN" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" };

/** Tokenize a QGIS expression into the subset the parser understands. */
function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Double-quoted field reference; "" is an escaped quote.
      let value = "";
      i += 1;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          break;
        }
        value += input[i];
        i += 1;
      }
      if (input[i] !== '"') return null;
      i += 1;
      tokens.push({ kind: "field", value });
      continue;
    }
    if (ch === "'") {
      // Single-quoted string literal; '' is an escaped quote.
      let value = "";
      i += 1;
      while (i < n) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          break;
        }
        value += input[i];
        i += 1;
      }
      if (input[i] !== "'") return null;
      i += 1;
      tokens.push({ kind: "string", value });
      continue;
    }
    const twoChar = input.slice(i, i + 2);
    if (twoChar === "<>" || twoChar === "!=" || twoChar === "<=" || twoChar === ">=") {
      tokens.push({ kind: "op", value: twoChar === "!=" ? "<>" : twoChar });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
      let value = ch;
      i += 1;
      while (i < n && /[0-9.eE+-]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      // Only accept a well-formed numeric literal; a run like `1-2` (arithmetic,
      // unsupported) must be rejected rather than mis-parsed as a single number.
      if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return null;
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed)) return null;
      tokens.push({ kind: "number", value: parsed });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let word = "";
      while (i < n && /[A-Za-z_]/.test(input[i])) {
        word += input[i];
        i += 1;
      }
      const upper = word.toUpperCase();
      if (upper === "AND" || upper === "OR" || upper === "NOT" || upper === "IN") {
        tokens.push({ kind: "kw", value: upper });
      } else if (upper === "TRUE") {
        tokens.push({ kind: "bool", value: true });
      } else if (upper === "FALSE") {
        tokens.push({ kind: "bool", value: false });
      } else {
        // A bareword (unquoted field name) is accepted as a field reference.
        tokens.push({ kind: "field", value: word });
      }
      continue;
    }
    return null; // Unrecognized character.
  }
  return tokens;
}

/**
 * Parse a QGIS expression into a MapLibre filter, or null when it uses syntax
 * outside the supported subset (comparisons, AND/OR/NOT, IN). Reverses
 * {@link mapboxFilterToQgis}.
 */
function qgisFilterToMapbox(expression: string): unknown[] | null {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseOr(): unknown[] | null {
    let left = parseAnd();
    if (left === null) return null;
    const parts = [left];
    while (peek()?.kind === "kw" && (peek() as { value: string }).value === "OR") {
      next();
      const right = parseAnd();
      if (right === null) return null;
      parts.push(right);
    }
    return parts.length === 1 ? left : ["any", ...parts];
  }

  function parseAnd(): unknown[] | null {
    let left = parseNot();
    if (left === null) return null;
    const parts = [left];
    while (peek()?.kind === "kw" && (peek() as { value: string }).value === "AND") {
      next();
      const right = parseNot();
      if (right === null) return null;
      parts.push(right);
    }
    return parts.length === 1 ? left : ["all", ...parts];
  }

  function parseNot(): unknown[] | null {
    if (peek()?.kind === "kw" && (peek() as { value: string }).value === "NOT") {
      next();
      const child = parseNot();
      return child === null ? null : ["!", child];
    }
    return parsePrimary();
  }

  function parsePrimary(): unknown[] | null {
    const token = peek();
    if (!token) return null;
    if (token.kind === "lparen") {
      next();
      const inner = parseOr();
      if (inner === null || peek()?.kind !== "rparen") return null;
      next();
      return inner;
    }
    if (token.kind === "field") {
      next();
      const field = token.value;
      const opTok = peek();
      if (opTok?.kind === "kw" && opTok.value === "IN") {
        next();
        if (peek()?.kind !== "lparen") return null;
        next();
        const values: (string | number | boolean)[] = [];
        for (;;) {
          const valTok = next();
          if (!valTok) return null;
          if (valTok.kind === "string") values.push(valTok.value);
          else if (valTok.kind === "number") values.push(valTok.value);
          else if (valTok.kind === "bool") values.push(valTok.value);
          else return null;
          const sep = next();
          if (sep?.kind === "rparen") break;
          if (sep?.kind !== "comma") return null;
        }
        if (values.length === 0) return null;
        return ["in", ["get", field], ...values];
      }
      if (opTok?.kind === "op") {
        next();
        const valTok = next();
        if (!valTok) return null;
        let value: string | number | boolean;
        if (valTok.kind === "string") value = valTok.value;
        else if (valTok.kind === "number") value = valTok.value;
        else if (valTok.kind === "bool") value = valTok.value;
        else return null;
        const mapOp: Record<string, string> = {
          "=": "==",
          "<>": "!=",
          "<": "<",
          "<=": "<=",
          ">": ">",
          ">=": ">=",
        };
        const op = mapOp[opTok.value];
        if (!op) return null;
        return [op, ["get", field], value];
      }
      return null;
    }
    return null;
  }

  const result = parseOr();
  if (result === null || pos !== tokens.length) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Renderer + labels
// ---------------------------------------------------------------------------

/** Apply a symbol's flat fields (stroke, width, size, marker) to the patch. */
function applySymbol(
  info: SymbolInfo,
  patch: Partial<Omit<LayerStyle, "labels">>,
  warnings: string[],
): void {
  // A line symbol's color is the line stroke (GeoLibre renders lines from
  // strokeColor), so route it there; a fill/marker symbol's color is the fill.
  if (info.color !== undefined) {
    if (info.geometry === "line") patch.strokeColor = info.color;
    else patch.fillColor = info.color;
  }
  if (info.opacity !== undefined && info.geometry !== "line") {
    patch.fillOpacity = info.opacity;
  }
  if (info.strokeColor !== undefined) patch.strokeColor = info.strokeColor;
  if (info.strokeWidth !== undefined) {
    patch.strokeWidth = info.strokeWidth;
    patch.strokeWidthUnit = "pixels";
  }
  if (info.geometry === "marker") {
    const name = info.markerName;
    const shape = name && name !== "circle" ? QGIS_NAME_TO_SHAPE[name] : undefined;
    if (name && name !== "circle" && shape) {
      patch.markerEnabled = true;
      patch.markerShape = shape;
      if (info.color !== undefined) patch.markerColor = info.color;
      if (info.markerSize !== undefined) patch.markerSize = info.markerSize;
    } else {
      patch.markerEnabled = false;
      if (info.markerSize !== undefined) patch.circleRadius = info.markerSize / 2;
      if (name && name !== "circle") {
        warnings.push(
          `The "${name}" marker has no GeoLibre equivalent; it was imported as a circle.`,
        );
      }
    }
  }
}

/** Build the label patch from a `<labeling type="simple">` block. */
function readLabeling(labeling: unknown, warnings: string[]): Partial<LabelStyle> | null {
  if (!isNode(labeling)) return null;
  const type = attr(labeling, "type");
  const settings = toArray(labeling.settings)[0];
  if (!isNode(settings)) {
    // Rule-based/categorized labeling nests settings under <rules>, which
    // GeoLibre's single label config cannot represent; flag it rather than
    // dropping the labels silently.
    if (type && type !== "simple") {
      warnings.push(`The "${type}" labeling has no GeoLibre equivalent; labels were not imported.`);
    }
    return null;
  }
  const isExpression = attr(settings, "isExpression") === "1";
  const field = attr(settings, "fieldName");
  const defaults = DEFAULT_LAYER_STYLE.labels;
  const labels: Partial<LabelStyle> = {
    enabled: true,
    placement: defaults.placement,
    haloWidth: 0,
  };
  if (field && !isExpression) {
    labels.field = field;
    labels.expression = "";
  } else if (field && isExpression) {
    warnings.push("The label is a QGIS expression; enable labels and pick a field in GeoLibre.");
  }

  const textStyle = toArray(settings["text-style"])[0];
  if (isNode(textStyle)) {
    const size = toNum(attr(textStyle, "fontSize"));
    if (size !== null) labels.size = size;
    const color = rgbaToHex(attr(textStyle, "textColor"));
    if (color) labels.color = color.hex;
    const buffer = toArray(textStyle["text-buffer"])[0];
    if (isNode(buffer) && attr(buffer, "bufferDraw") === "1") {
      const bufferSize = toNum(attr(buffer, "bufferSize"));
      if (bufferSize !== null) labels.haloWidth = bufferSize;
      const bufferColor = rgbaToHex(attr(buffer, "bufferColor"));
      if (bufferColor) labels.haloColor = bufferColor.hex;
    }
  }

  const placement = toArray(settings.placement)[0];
  // The exporter writes placement "2" for line placement; treat that as line and
  // everything else as point.
  if (isNode(placement) && attr(placement, "placement") === "2") {
    labels.placement = "line";
  }
  return labels;
}

/**
 * Parse a QGIS QML style document into a GeoLibre symbology patch. Classifies
 * the `renderer-v2` type (singleSymbol / categorizedSymbol / graduatedSymbol /
 * RuleRenderer) into GeoLibre's renderer model and translates QGIS rule
 * expressions back to MapLibre filters. Reverses {@link buildQml} so a GeoLibre
 * export round-trips, and imports a hand-written or QGIS-authored QML as far as
 * its symbology maps onto GeoLibre's model. Anything that cannot be represented
 * is reported in {@link QmlImportResult.warnings} rather than dropped silently.
 */
export function parseQml(xml: string): QmlImportResult {
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

  const qgis = isNode(root) ? root.qgis : undefined;
  if (!isNode(qgis)) {
    warnings.push("This file is not a QGIS QML style (no <qgis> root); nothing was imported.");
    return { style: patch, labels, warnings, matchedRuleCount: 0 };
  }

  const renderer = toArray(qgis["renderer-v2"])[0];
  let matchedRuleCount = 0;

  if (isNode(renderer)) {
    matchedRuleCount += classifyRenderer(renderer, patch, warnings);
  }

  labels = readLabeling(qgis.labeling, warnings);
  if (labels) matchedRuleCount += 1;

  if (matchedRuleCount === 0) {
    warnings.push("No renderer or labeling was found; nothing was imported.");
  }

  return { style: patch, labels, warnings, matchedRuleCount };
}

/** Read the renderer's symbols into a name → SymbolInfo map. */
function readSymbols(renderer: XmlNode): Map<string, SymbolInfo> {
  const map = new Map<string, SymbolInfo>();
  const symbolsRoot = toArray(renderer.symbols)[0];
  if (!isNode(symbolsRoot)) return map;
  for (const symbol of toArray(symbolsRoot.symbol)) {
    const name = attr(symbol, "name");
    if (name !== null) map.set(name, readSymbol(symbol));
  }
  return map;
}

/** Classify the renderer and write the renderer fields; returns matched count. */
function classifyRenderer(
  renderer: XmlNode,
  patch: Partial<Omit<LayerStyle, "labels">>,
  warnings: string[],
): number {
  const type = attr(renderer, "type");
  const symbols = readSymbols(renderer);
  const first = symbols.values().next().value as SymbolInfo | undefined;
  // A line renderer's per-class color drives the stroke; every other geometry's
  // drives the fill. This routes the categorized/rule fallback color correctly.
  const isLine = first?.geometry === "line";
  // The flat style always comes from the first symbol (stroke/width/size are
  // constant across an exported renderer's symbols).
  if (first) applySymbol(first, patch, warnings);

  if (type === "categorizedSymbol") {
    return classifyCategorized(renderer, symbols, patch, isLine);
  }
  if (type === "graduatedSymbol") {
    return classifyGraduated(renderer, symbols, patch);
  }
  if (type === "RuleRenderer") {
    return classifyRules(renderer, symbols, patch, isLine, warnings);
  }
  // singleSymbol (or unknown with symbols): a plain single style.
  if (first) {
    patch.vectorStyleMode = "single";
    return 1;
  }
  return 0;
}

/** The `symbol`-referenced color of a category/range/rule. */
function symbolColor(symbols: Map<string, SymbolInfo>, ref: string | null): string | undefined {
  if (ref === null) return undefined;
  return symbols.get(ref)?.color;
}

function classifyCategorized(
  renderer: XmlNode,
  symbols: Map<string, SymbolInfo>,
  patch: Partial<Omit<LayerStyle, "labels">>,
  isLine: boolean,
): number {
  const property = attr(renderer, "attr");
  const categoriesRoot = toArray(renderer.categories)[0];
  const categories = isNode(categoriesRoot) ? toArray(categoriesRoot.category) : [];
  if (!property || categories.length === 0) return 0;

  const stops: VectorStyleStop[] = [];
  let fallback: string | undefined;
  for (const category of categories) {
    const value = attr(category, "value");
    const color = symbolColor(symbols, attr(category, "symbol"));
    if (value === null || color === undefined) continue;
    if (value.trim() === "") {
      // QGIS's empty-value default category is the fallback color.
      fallback = color;
      continue;
    }
    const label = attr(category, "label");
    stops.push({
      value: literalValue(value),
      color,
      ...(label && label !== value ? { label } : {}),
    });
  }
  if (stops.length === 0) return 0;
  patch.vectorStyleMode = "categorized";
  patch.vectorStyleProperty = property;
  patch.vectorStyleStops = stops;
  // The fallback drives the stroke for a line renderer, the fill otherwise.
  if (fallback) {
    if (isLine) patch.strokeColor = fallback;
    else patch.fillColor = fallback;
  }
  return stops.length;
}

function classifyGraduated(
  renderer: XmlNode,
  symbols: Map<string, SymbolInfo>,
  patch: Partial<Omit<LayerStyle, "labels">>,
): number {
  const property = attr(renderer, "attr");
  const rangesRoot = toArray(renderer.ranges)[0];
  const ranges = isNode(rangesRoot) ? toArray(rangesRoot.range) : [];
  if (!property || ranges.length === 0) return 0;

  const stops: VectorStyleStop[] = [];
  for (const range of ranges) {
    const lower = toNum(attr(range, "lower"));
    const color = symbolColor(symbols, attr(range, "symbol"));
    if (lower === null || color === undefined) continue;
    // A QGIS range label is a display description of the interval (e.g.
    // "0 - 100") that GeoLibre regenerates from the stop values, so it is not
    // imported as a stop label.
    stops.push({ value: lower, color });
  }
  stops.sort((a, b) => Number(a.value) - Number(b.value));
  if (stops.length < 2) return 0;
  patch.vectorStyleMode = "graduated";
  patch.vectorStyleProperty = property;
  patch.vectorStyleStops = stops;
  return stops.length;
}

/** A rule zoom bound recovered from a QGIS scale denominator, or undefined
 * when the denominator is unusable or lies outside the renderable zoom range. */
function zoomFromDenominator(denominator: number | null, bound: "min" | "max"): number | undefined {
  if (denominator === null || !(denominator > 0)) return undefined;
  const zoom = Math.round(Math.log2(OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / denominator) * 100) / 100;
  // A bound at (or beyond) the zoom extremes is no constraint at all.
  if (bound === "min") return zoom > MIN_LAYER_ZOOM ? zoom : undefined;
  return zoom < MAX_LAYER_ZOOM ? zoom : undefined;
}

/** A per-rule numeric override: the rule symbol's value when it differs from
 * the base (first) symbol's, else undefined so the rule inherits the layer. */
function numberOverride(value: number | undefined, base: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (base !== undefined && Math.abs(value - base) < 1e-9) return undefined;
  return value;
}

/**
 * The per-rule symbol override fields where a rule's symbol differs from the
 * base (first) symbol, whose flat values were applied to the layer. Also used
 * for the ELSE rule so the catch-all keeps its own look when the first rule
 * carries overrides.
 */
function symbolOverrides(
  info: SymbolInfo | undefined,
  base: SymbolInfo | undefined,
): Partial<VectorRule> {
  const strokeColor =
    info?.strokeColor !== undefined && info.strokeColor !== base?.strokeColor
      ? info.strokeColor
      : undefined;
  const strokeWidth = numberOverride(info?.strokeWidth, base?.strokeWidth);
  const fillOpacity = numberOverride(info?.opacity, base?.opacity);
  // A size difference only maps onto circleRadius for a plain circle mark: a
  // shape marker (square/triangle/…) is sized by the layer's markerSize, which
  // circleRadius does not affect (mirrors rulePaintFor in the exporter).
  const markerSize =
    info?.markerName && info.markerName !== "circle"
      ? undefined
      : numberOverride(info?.markerSize, base?.markerSize);
  return {
    ...(strokeColor !== undefined ? { strokeColor } : {}),
    ...(strokeWidth !== undefined ? { strokeWidth } : {}),
    ...(fillOpacity !== undefined ? { fillOpacity } : {}),
    ...(markerSize !== undefined ? { circleRadius: markerSize / 2 } : {}),
  };
}

function classifyRules(
  renderer: XmlNode,
  symbols: Map<string, SymbolInfo>,
  patch: Partial<Omit<LayerStyle, "labels">>,
  isLine: boolean,
  warnings: string[],
): number {
  const rulesRoot = toArray(renderer.rules)[0];
  const rules = isNode(rulesRoot) ? toArray(rulesRoot.rule) : [];
  if (rules.length === 0) return 0;

  // The first symbol's flat style was already applied to the layer, so a
  // rule symbol property becomes a per-rule override only when it differs.
  const base = symbols.values().next().value as SymbolInfo | undefined;

  const vectorRules: VectorRule[] = [];
  let elseColor: string | undefined;
  let elseLabel = "";
  let elseInfo: SymbolInfo | undefined;
  let elseDisabled = false;
  let sawElse = false;
  let index = 0;
  let matched = 0;
  const walk = (nodes: unknown[], parentId: string | undefined): void => {
    for (const rule of nodes) {
      const filter = attr(rule, "filter")?.trim() ?? "";
      const symbolRef = attr(rule, "symbol");
      const info = symbolRef !== null ? symbols.get(symbolRef) : undefined;
      const color = info?.color;
      const label = attr(rule, "label") ?? "";
      const children = isNode(rule) ? toArray(rule.rule) : [];
      const isGroup = children.length > 0;
      const blankFilter = filter === "";
      if (blankFilter || filter.toUpperCase() === "ELSE") {
        // A blank or ELSE rule is the catch-all, but only at the top level and
        // only when it has no children; a blank-filter group is a real group
        // (its filter adds no constraint) and a nested ELSE has no GeoLibre
        // equivalent.
        if (!isGroup && parentId === undefined) {
          elseColor = color;
          elseLabel = label;
          elseInfo = info;
          elseDisabled = attr(rule, "checkstate") === "0";
          sawElse = true;
          matched += 1;
          continue;
        }
        if (!isGroup || !blankFilter) {
          warnings.push(
            "A nested or grouped ELSE rule has no GeoLibre equivalent; it was skipped.",
          );
          continue;
        }
      }
      let filterJson = "";
      if (!blankFilter) {
        const expression = qgisFilterToMapbox(filter);
        if (expression === null) {
          warnings.push("A rule used a QGIS expression that could not be read; it was skipped.");
          continue;
        }
        filterJson = JSON.stringify(expression);
      }
      const id = `qml-rule-${index}`;
      index += 1;
      const minZoom = zoomFromDenominator(toNum(attr(rule, "scalemaxdenom")), "min");
      const maxZoom = zoomFromDenominator(toNum(attr(rule, "scalemindenom")), "max");
      vectorRules.push({
        id,
        label,
        filter: filterJson,
        color: color ?? DEFAULT_LAYER_STYLE.fillColor,
        isElse: false,
        ...(attr(rule, "checkstate") === "0" ? { enabled: false } : {}),
        ...(minZoom !== undefined ? { minZoom } : {}),
        ...(maxZoom !== undefined ? { maxZoom } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...symbolOverrides(info, base),
      });
      matched += 1;
      if (isGroup) walk(children, id);
    }
  };
  walk(rules, undefined);
  if (vectorRules.length === 0) {
    // No rule translated, so a rule-based renderer cannot be built. The flat
    // style from the first symbol was already applied, so fall back to a single
    // symbol rather than reporting the renderer as applied when it was not.
    patch.vectorStyleMode = "single";
    return 1;
  }
  const fallback = elseColor ?? DEFAULT_LAYER_STYLE.fillColor;
  vectorRules.push({
    id: "qml-rule-else",
    label: elseLabel,
    filter: "",
    color: fallback,
    isElse: true,
    // In QGIS a rule tree without an ELSE rule (or with it unchecked) does not
    // draw features matching no rule, so the imported else record is disabled
    // in both cases — the renderer then hides unmatched features the same way.
    ...(elseDisabled || !sawElse ? { enabled: false } : {}),
    // The else symbol keeps its own look (as overrides) when it differs from
    // the first symbol, whose flat values were applied to the layer.
    ...symbolOverrides(elseInfo, base),
  });
  patch.vectorStyleMode = "rule-based";
  patch.vectorRules = vectorRules;
  // The else fallback drives the stroke for a line renderer, the fill otherwise.
  if (isLine) patch.strokeColor = fallback;
  else patch.fillColor = fallback;
  return matched;
}

/** A category value, parsed to a number when written in canonical decimal form. */
function literalValue(value: string): string | number {
  const trimmed = value.trim();
  if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

/**
 * Merge a parsed QML import over a base {@link LayerStyle}. Mirrors
 * {@link applySldImport}/{@link applyMapboxStyleImport}.
 */
export function applyQmlImport(base: LayerStyle, result: QmlImportResult): LayerStyle {
  return {
    ...base,
    ...result.style,
    labels: result.labels ? { ...base.labels, ...result.labels } : base.labels,
  };
}
