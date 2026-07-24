/**
 * Rich auto-legend derivation for the on-map Legend panel.
 *
 * Builds display-ready legend entries from the visible layers' symbology:
 * geometry-aware swatches, per-class rows for graduated / categorized /
 * rule-based vectors, proportional-symbol size ramps, gradient bars for
 * heatmaps and continuous raster colormaps, and class rows for classified
 * rasters (including Raster Attribute Table land-cover labels). Hand-authored
 * entries from {@link LegendConfig.customEntries} replace a layer's derived
 * rows or render as standalone sections, and per-item overrides (rename /
 * hide / reorder) apply on top.
 *
 * Kept pure (no React, no map, no i18n) so it is unit testable; the panel
 * injects locale and the colormap resolver.
 */
import {
  effectiveVectorRules,
  isHexColor,
  styleValue,
  type GeoLibreLayer,
  type LegendConfig,
  type LegendCustomEntry,
  type LegendCustomItem,
  type LegendItemOverride,
  type VectorStyleStop,
} from "@geolibre/core";
import { isRasterLike, layerSwatchShape, type LayerSwatchShape } from "./layer-swatch";
import {
  diagramSwatches,
  isVectorStyledLayer,
  NON_LEGEND_TYPES,
  pointMarkerSwatch,
} from "./print-legend";
import type { LegendMarker } from "./print-layout";
import { savedRasterAttributeTable } from "./raster-attribute-table";
// Deep import (not the @geolibre/plugins barrel): the barrel pulls browser-only
// plugin modules, and this derivation must stay importable from node tests.
import { savedRasterSymbology, type RasterSymbology } from "@geolibre/plugins/raster-symbology";

/** Neutral fallback color, matching the Layers panel / print legend. */
const NEUTRAL = "#94a3b8";

/** Upper bound on class rows per entry; past this the tail is elided. */
export const MAX_LEGEND_ROWS = 100;

/** Colors sampled per gradient bar. */
const GRADIENT_SAMPLES = 6;

/**
 * The map's heatmap ramp colors (mirrors `HEATMAP_COLOR_RAMP` in
 * `@geolibre/map`'s style-mapper, minus the fully-transparent zero stop so the
 * bar starts visible).
 */
export const HEATMAP_RAMP_COLORS: readonly string[] = [
  "rgb(103,169,207)",
  "rgb(209,229,240)",
  "rgb(253,219,199)",
  "rgb(239,138,98)",
  "rgb(178,24,43)",
];

/** One row (class / rule / size step / custom item) under a legend entry. */
export interface AutoLegendRow {
  /** Stable override key (`<entryId>::p:<index>` in the panel namespace). */
  key: string;
  /** Effective label after applying any user override. */
  label: string;
  /** The auto-generated label (for the rename editor's clear-to-default). */
  defaultLabel: string;
  color: string;
  shape: LayerSwatchShape;
  /** Point marker preview for marker rows (shape / custom SVG). */
  marker?: LegendMarker;
  /** Circle radius or line width in px for proportional-size rows. */
  size?: number;
  /** Hidden by a user override; the panel dims it in edit mode. */
  hidden: boolean;
}

/** A continuous color bar with optional numeric end labels. */
export interface AutoLegendGradient {
  colors: string[];
  /** Numeric label under the start of the bar; null renders a generic "Low". */
  minLabel: string | null;
  /** Numeric label under the end of the bar; null renders a generic "High". */
  maxLabel: string | null;
}

/** One legend entry: a layer (auto or custom-overridden) or a custom section. */
export interface AutoLegendEntry {
  /** Layer id, or the `custom:` id of a standalone section. */
  id: string;
  /** Effective heading after label overrides. */
  name: string;
  /** The auto-generated heading (for the rename editor's placeholder). */
  defaultName: string;
  /** Geometry-driven glyph for the heading row. */
  shape: LayerSwatchShape;
  /** Single-symbol chip drawn next to the heading (marker-aware). */
  headerSwatch: { color: string; marker?: LegendMarker } | null;
  /** Caption above class rows (the classified attribute), when meaningful. */
  fieldLabel?: string;
  rows: AutoLegendRow[];
  gradient: AutoLegendGradient | null;
  /** Compound opacity applied to this entry's swatches. */
  opacity: number;
  /** Entry comes from {@link LegendConfig.customEntries}. */
  custom: boolean;
  /** True for a standalone `custom:` section (no backing layer). */
  standalone: boolean;
  /** Hidden by a user override; the panel dims it in edit mode. */
  hidden: boolean;
}

/** Injected environment for {@link buildAutoLegend}. */
export interface AutoLegendOptions {
  /** BCP-47 locale for number formatting; defaults to the runtime locale. */
  locale?: string;
  /**
   * Resolves a named raster colormap to its anchor colors (the panel passes
   * `colormapColors` from `@geolibre/plugins`); null falls back to grayscale.
   */
  resolveColormapColors?: (name: string) => readonly string[] | null;
}

/** Prefix for standalone custom-section ids (not tied to a layer). */
export const CUSTOM_SECTION_PREFIX = "custom:";

/** Stable per-row override key within an entry (panel namespace). */
export function legendRowKey(entryId: string, index: number): string {
  return `${entryId}::p:${index}`;
}

/**
 * Abbreviate a number for legend readability (e.g. 8918925.75 → "8.9M").
 * Abbreviation starts at 10,000: 4-digit values are often years, and "5,000"
 * is no harder to read than "5.0K".
 */
export function formatLegendNumber(value: number, locale?: string): string {
  const abs = Math.abs(value);
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString(locale, one)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toLocaleString(locale, one)}K`;
  if (Number.isInteger(value)) return value.toLocaleString(locale);
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
}

/**
 * Label for the class starting at `bounds[i]`: a range up to the next bound,
 * open-ended (`≥`) for the top class. Bounds are class lower bounds, matching
 * the graduated renderer's stops and the classified raster's breaks.
 */
function rangeLabel(bounds: number[], index: number, locale?: string): string {
  const from = formatLegendNumber(bounds[index], locale);
  if (index >= bounds.length - 1) return `≥ ${from}`;
  return `${from} – ${formatLegendNumber(bounds[index + 1], locale)}`;
}

/** Effective label: a non-blank override wins, else the fallback. */
function effectiveLabel(override: LegendItemOverride | undefined, fallback: string): string {
  const trimmed = override?.label?.trim();
  return trimmed ? trimmed : fallback;
}

/** Linear interpolation between the entries of a numeric pair. */
function lerp(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio;
}

interface RawRow {
  label: string;
  color: string;
  shape: LayerSwatchShape;
  marker?: LegendMarker;
  size?: number;
}

/** Vector class rows (graduated ranges / categorized values). */
function stopRows(
  stops: VectorStyleStop[],
  mode: "graduated" | "categorized",
  shape: LayerSwatchShape,
  locale?: string,
): RawRow[] {
  const limited = stops.slice(0, MAX_LEGEND_ROWS);
  if (mode === "categorized") {
    return limited.map((stop) => ({
      label: stop.label?.trim() || String(stop.value ?? ""),
      color: stop.color || NEUTRAL,
      shape,
    }));
  }
  const bounds = limited.map((stop) => Number(stop.value));
  return limited.map((stop, index) => ({
    label: stop.label?.trim() || rangeLabel(bounds, index, locale),
    color: stop.color || NEUTRAL,
    shape,
  }));
}

/** Rule-based renderer rows (mirrors the live map's effective rules). */
function ruleRows(layer: GeoLibreLayer, shape: LayerSwatchShape): RawRow[] {
  const { rules, elseRule } = effectiveVectorRules(layer.style);
  const rows: RawRow[] = rules.slice(0, MAX_LEGEND_ROWS).map((rule) => ({
    label: rule.label || JSON.stringify(rule.filter),
    color: rule.color,
    shape,
  }));
  if (elseRule && isHexColor(elseRule.color)) {
    rows.push({ label: elseRule.label || "Other", color: elseRule.color, shape });
  }
  return rows;
}

/* ── Advanced-expression derivation ──────────────────────────────────────── */

/** A comparison leaf like `["<", ["get", "year"], 1900]`, normalized. */
function parseComparison(
  expression: unknown,
): { op: string; property: string; value: number | string } | null {
  if (!Array.isArray(expression) || expression.length !== 3) return null;
  const [op, a, b] = expression;
  if (typeof op !== "string" || !["<", "<=", ">", ">=", "==", "!="].includes(op)) return null;
  const getter = (side: unknown): string | null =>
    Array.isArray(side) && side[0] === "get" && typeof side[1] === "string" ? side[1] : null;
  const literal = (side: unknown): number | string | null =>
    typeof side === "number" || typeof side === "string" ? side : null;
  const property = getter(a) ?? getter(b);
  const value = literal(b) ?? literal(a);
  if (property === null || value === null) return null;
  // Normalize "value op get" to "get op value" so labels read naturally.
  const flipped = getter(a) === null;
  const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };
  return { op: flipped ? (flip[op] ?? op) : op, property, value };
}

/** Format a comparison literal: numbers abbreviated, strings verbatim. */
function comparisonValue(value: number | string, locale?: string): string {
  return typeof value === "number" ? formatLegendNumber(value, locale) : value;
}

/**
 * A readable label for a `case` branch condition: `["all", [">=", …, a],
 * ["<", …, b]]` becomes "a – b", a bare comparison becomes "< 1900" /
 * "≥ 2010" / the value itself for equality. Returns null when the shape is
 * not recognized (the caller falls back to the raw filter text).
 */
function conditionLabel(condition: unknown, locale?: string): string | null {
  if (Array.isArray(condition) && condition[0] === "all" && condition.length === 3) {
    const first = parseComparison(condition[1]);
    const second = parseComparison(condition[2]);
    if (first && second && first.property === second.property) {
      const low = first.op.startsWith(">") ? first : second.op.startsWith(">") ? second : null;
      const high = first.op.startsWith("<") ? first : second.op.startsWith("<") ? second : null;
      if (low && high) {
        return `${comparisonValue(low.value, locale)} – ${comparisonValue(high.value, locale)}`;
      }
    }
  }
  const comparison = parseComparison(condition);
  if (!comparison) return null;
  const value = comparisonValue(comparison.value, locale);
  if (comparison.op === "==") return value;
  const symbol = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "!=": "≠" }[comparison.op];
  return `${symbol} ${value}`;
}

/** The `["get", property]` name inside an expression input, if any. */
function expressionProperty(expression: unknown): string | undefined {
  if (!Array.isArray(expression)) return undefined;
  if (expression[0] === "get" && typeof expression[1] === "string") return expression[1];
  for (const entry of expression) {
    const property = expressionProperty(entry);
    if (property) return property;
  }
  return undefined;
}

type ExpressionParts = {
  rows: RawRow[];
  gradient: AutoLegendGradient | null;
  fieldLabel?: string;
};

/**
 * Derive legend classes from a data-driven color expression: `step` becomes
 * range rows, `match` categorical rows (plus "Other" for the fallback),
 * `case` rows labelled from their conditions, and `interpolate` a gradient.
 * Walks nested expressions so a classifier wrapped in e.g. a zoom
 * interpolation is still found. Returns null when no classifier with plain
 * string color outputs is present.
 */
function classifierParts(
  expression: unknown,
  shape: LayerSwatchShape,
  locale?: string,
): ExpressionParts | null {
  if (!Array.isArray(expression)) return null;
  const direct = directClassifierParts(expression, shape, locale);
  if (direct) return direct;
  // Not a plain classifier at this level (or its outputs are themselves
  // expressions): walk children so e.g. a match nested inside a zoom
  // interpolation is still found.
  for (const entry of expression) {
    const parts = classifierParts(entry, shape, locale);
    if (parts) return parts;
  }
  return null;
}

/** A classifier at exactly this level, or null (no recursion). */
function directClassifierParts(
  expression: unknown[],
  shape: LayerSwatchShape,
  locale?: string,
): ExpressionParts | null {
  const head = expression[0];

  if (head === "step" && expression.length >= 5 && typeof expression[2] === "string") {
    const base = expression[2];
    const stops: number[] = [];
    const outputs: string[] = [];
    for (let index = 3; index + 1 < expression.length; index += 2) {
      const stop = expression[index];
      const output = expression[index + 1];
      if (typeof stop !== "number" || typeof output !== "string") return null;
      stops.push(stop);
      outputs.push(output);
    }
    const rows: RawRow[] = [
      { label: `< ${formatLegendNumber(stops[0], locale)}`, color: base, shape },
      ...outputs.map((color, index) => ({
        label:
          index + 1 < stops.length
            ? `${formatLegendNumber(stops[index], locale)} – ${formatLegendNumber(stops[index + 1], locale)}`
            : `≥ ${formatLegendNumber(stops[index], locale)}`,
        color,
        shape,
      })),
    ];
    return {
      rows: rows.slice(0, MAX_LEGEND_ROWS),
      gradient: null,
      fieldLabel: expressionProperty(expression[1]),
    };
  }

  if (head === "match" && expression.length >= 5) {
    const rows: RawRow[] = [];
    for (let index = 2; index + 1 < expression.length - 1; index += 2) {
      const value = expression[index];
      const output = expression[index + 1];
      if (typeof output !== "string") return null;
      const label = Array.isArray(value)
        ? value.map((entry) => comparisonValue(entry as number | string, locale)).join(", ")
        : comparisonValue(value as number | string, locale);
      rows.push({ label, color: output, shape });
    }
    const fallback = expression[expression.length - 1];
    if (rows.length === 0) return null;
    if (typeof fallback === "string") rows.push({ label: "Other", color: fallback, shape });
    return {
      rows: rows.slice(0, MAX_LEGEND_ROWS),
      gradient: null,
      fieldLabel: expressionProperty(expression[1]),
    };
  }

  if (head === "case" && expression.length >= 4) {
    const rows: RawRow[] = [];
    let property: string | undefined;
    for (let index = 1; index + 1 < expression.length; index += 2) {
      const condition = expression[index];
      const output = expression[index + 1];
      if (typeof output !== "string") return null;
      rows.push({
        label: conditionLabel(condition, locale) ?? JSON.stringify(condition),
        color: output,
        shape,
      });
      property ??= expressionProperty(condition);
    }
    const fallback = expression[expression.length - 1];
    if (rows.length === 0) return null;
    if (typeof fallback === "string") rows.push({ label: "Other", color: fallback, shape });
    return { rows: rows.slice(0, MAX_LEGEND_ROWS), gradient: null, fieldLabel: property };
  }

  if (head === "interpolate" && expression.length >= 7) {
    const stops: number[] = [];
    const colors: string[] = [];
    for (let index = 3; index + 1 < expression.length; index += 2) {
      const stop = expression[index];
      const color = expression[index + 1];
      if (typeof stop !== "number" || typeof color !== "string") return null;
      stops.push(stop);
      colors.push(color);
    }
    if (colors.length < 2) return null;
    return {
      rows: [],
      gradient: {
        colors,
        minLabel: formatLegendNumber(stops[0], locale),
        maxLabel: formatLegendNumber(stops[stops.length - 1], locale),
      },
      fieldLabel: expressionProperty(expression[2]),
    };
  }

  return null;
}

/**
 * Legend parts for an advanced-expression layer, parsed from its stored
 * MapLibre color expression. Null when the expression is empty, invalid JSON,
 * or contains no recognizable classifier — the caller then falls back to the
 * single-symbol swatch.
 */
export function expressionLegendParts(
  expressionJson: string,
  shape: LayerSwatchShape,
  locale?: string,
): ExpressionParts | null {
  const raw = expressionJson.trim();
  if (!raw) return null;
  let expression: unknown;
  try {
    expression = JSON.parse(raw);
  } catch {
    return null;
  }
  return classifierParts(expression, shape, locale);
}

/**
 * Proportional-symbol size rows: min / middle / max symbol sizes with their
 * data values, mirroring the interpolate the map renders. Circles for points,
 * line strokes for lines.
 */
function proportionalSizeRows(
  layer: GeoLibreLayer,
  shape: LayerSwatchShape,
  locale?: string,
): RawRow[] {
  const style = layer.style;
  const color = styleValue(style, "fillColor") || NEUTRAL;
  const minValue = styleValue(style, "proportionalSizeMinValue");
  const maxValue = styleValue(style, "proportionalSizeMaxValue");
  const minRadius = styleValue(style, "proportionalSizeMinRadius");
  const maxRadius = styleValue(style, "proportionalSizeMaxRadius");
  const rowShape: LayerSwatchShape = shape === "line" ? "line" : "circle";
  return [0, 0.5, 1].map((ratio) => ({
    label: formatLegendNumber(lerp(minValue, maxValue, ratio), locale),
    color,
    shape: rowShape,
    size: lerp(minRadius, maxRadius, ratio),
  }));
}

/** Grayscale fallback when a named colormap has not been sampled yet. */
const GRAYSCALE: readonly string[] = ["#1f2937", "#9ca3af", "#f9fafb"];

/**
 * Anchor colors for a raster symbology's ramp: the user's custom colors when
 * set, else the named colormap (built-in ramps resolve directly; sprite
 * colormaps via the injected resolver), else grayscale. Honors `reversed`.
 */
function rasterRampColors(
  symbology: Pick<RasterSymbology, "ramp" | "customColors"> | null,
  colormap: string,
  reversed: boolean,
  resolve: (name: string) => readonly string[] | null,
): string[] {
  const custom = symbology?.customColors;
  const anchors =
    custom && custom.length >= 2 ? custom : (resolve(symbology?.ramp ?? colormap) ?? GRAYSCALE);
  const colors = [...anchors];
  return reversed ? colors.reverse() : colors;
}

/** Evenly sample `count` colors along a list of gradient anchors. */
function sampleColors(anchors: readonly string[], count: number): string[] {
  if (anchors.length === 0) return [];
  // count === 1 would divide by zero below (NaN index → undefined color).
  if (count <= 1) return count === 1 ? [anchors[0]] : [];
  if (anchors.length === 1) return Array(count).fill(anchors[0]);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(anchors[Math.round((i * (anchors.length - 1)) / (count - 1))]);
  }
  return out;
}

/** Reads `metadata.rasterState` fields the legend needs, defensively. */
function readRasterRenderState(layer: GeoLibreLayer): {
  mode: "single" | "rgb" | "index";
  colormap: string;
  reversed: boolean;
  rescale: [number, number] | null;
} {
  const raw =
    layer.metadata.rasterState &&
    typeof layer.metadata.rasterState === "object" &&
    !Array.isArray(layer.metadata.rasterState)
      ? (layer.metadata.rasterState as Record<string, unknown>)
      : {};
  const first = Array.isArray(raw.rescale) ? raw.rescale[0] : null;
  const rescale =
    Array.isArray(first) &&
    first.length === 2 &&
    typeof first[0] === "number" &&
    typeof first[1] === "number"
      ? ([first[0], first[1]] as [number, number])
      : null;
  return {
    mode: raw.mode === "rgb" ? "rgb" : raw.mode === "index" ? "index" : "single",
    colormap: typeof raw.colormap === "string" ? raw.colormap : "",
    reversed: raw.reversed === true,
    rescale,
  };
}

/** Raster entry parts: RAT / classified class rows, or a continuous gradient. */
function rasterParts(
  layer: GeoLibreLayer,
  locale: string | undefined,
  resolve: (name: string) => readonly string[] | null,
): { rows: RawRow[]; gradient: AutoLegendGradient | null; fieldLabel?: string } {
  const state = readRasterRenderState(layer);
  const symbology = savedRasterSymbology(layer);

  if (symbology?.classified) {
    // Class labels: prefer the Raster Attribute Table's names (land-cover
    // classes like NLCD) when the applied classification matches it 1:1.
    const table = savedRasterAttributeTable(layer);
    const anchors = rasterRampColors(symbology, state.colormap, state.reversed, resolve);
    const count = Math.max(1, symbology.classCount);
    const colors = sampleColors(anchors, count);
    if (table && table.rows.length === count) {
      return {
        rows: table.rows.slice(0, MAX_LEGEND_ROWS).map((row, index) => ({
          label: row.label,
          color: row.color || colors[index] || NEUTRAL,
          shape: "square" as const,
        })),
        gradient: null,
      };
    }
    const bounds = symbology.breaks.slice(0, -1);
    const rows = colors.slice(0, MAX_LEGEND_ROWS).map((color, index) => ({
      // Classified breaks carry an explicit top edge, so the last class is a
      // closed range rather than the graduated renderer's open-ended "≥".
      label:
        index < count - 1
          ? rangeLabel(bounds, index, locale)
          : `${formatLegendNumber(symbology.breaks[index], locale)} – ${formatLegendNumber(
              symbology.breaks[count],
              locale,
            )}`,
      color,
      shape: "square" as const,
    }));
    return { rows, gradient: null };
  }

  // Continuous single-band / index colormap: a gradient bar. Palette rasters
  // (embedded color tables) have per-value classes the app cannot enumerate
  // synchronously; they fall through to a plain heading row, and the "Create
  // legend from palette" action fills a custom entry instead.
  if ((state.mode === "single" && state.colormap !== "palette") || state.mode === "index") {
    const anchors = rasterRampColors(symbology, state.colormap, state.reversed, resolve);
    const rescale = state.rescale ?? (state.mode === "index" ? [-1, 1] : null);
    return {
      rows: [],
      gradient: {
        colors: sampleColors(anchors, GRADIENT_SAMPLES),
        minLabel: rescale ? formatLegendNumber(rescale[0], locale) : null,
        maxLabel: rescale ? formatLegendNumber(rescale[1], locale) : null,
      },
    };
  }

  return { rows: [], gradient: null };
}

/** Entry parts derived from a vector layer's symbology. */
function vectorParts(
  layer: GeoLibreLayer,
  shape: LayerSwatchShape,
  locale: string | undefined,
): {
  rows: RawRow[];
  gradient: AutoLegendGradient | null;
  headerSwatch: { color: string; marker?: LegendMarker } | null;
  fieldLabel?: string;
} {
  const style = layer.style;
  const mode = styleValue(style, "vectorStyleMode");
  const stops = styleValue(style, "vectorStyleStops");
  const diagrams: RawRow[] = diagramSwatches(layer).map((swatch) => ({
    label: swatch.label,
    color: swatch.color,
    shape: "square" as const,
  }));

  // A density heatmap renders no per-feature symbols: the entry is the ramp.
  if (shape === "circle" && styleValue(style, "pointRenderer") === "heatmap") {
    return {
      rows: diagrams,
      gradient: { colors: [...HEATMAP_RAMP_COLORS], minLabel: null, maxLabel: null },
      headerSwatch: null,
    };
  }

  const sizeRows =
    styleValue(style, "proportionalSizeEnabled") &&
    styleValue(style, "proportionalSizeProperty") !== "" &&
    (shape === "circle" || shape === "line")
      ? proportionalSizeRows(layer, shape, locale)
      : [];

  if ((mode === "graduated" || mode === "categorized") && stops.length > 0) {
    return {
      rows: [...stopRows(stops, mode, shape, locale), ...sizeRows, ...diagrams],
      gradient: null,
      headerSwatch: null,
      fieldLabel: styleValue(style, "vectorStyleProperty") || undefined,
    };
  }
  if (mode === "rule-based") {
    const rows = ruleRows(layer, shape);
    if (rows.length > 0) {
      return {
        rows: [...rows, ...sizeRows, ...diagrams],
        gradient: null,
        headerSwatch: null,
      };
    }
  }
  if (mode === "expression") {
    const parts = expressionLegendParts(styleValue(style, "vectorStyleExpression"), shape, locale);
    if (parts) {
      return {
        rows: [...parts.rows, ...sizeRows, ...diagrams],
        gradient: parts.gradient,
        headerSwatch: null,
        fieldLabel: parts.fieldLabel,
      };
    }
  }

  const marker = pointMarkerSwatch(style);
  const headerSwatch = marker
    ? { color: marker.color, marker: marker.marker }
    : { color: styleValue(style, "fillColor") || NEUTRAL };
  const fieldLabel =
    sizeRows.length > 0 ? styleValue(style, "proportionalSizeProperty") || undefined : undefined;
  return { rows: [...sizeRows, ...diagrams], gradient: null, headerSwatch, fieldLabel };
}

/** Rows for a hand-authored entry. */
function customRows(entry: LegendCustomEntry): RawRow[] {
  return entry.items.slice(0, MAX_LEGEND_ROWS).map((item) => ({
    label: item.label,
    color: item.color,
    shape: item.shape ?? ("square" as const),
  }));
}

/** Compound swatch opacity for a layer (layer opacity × fill opacity). */
function entryOpacity(layer: GeoLibreLayer): number {
  const layerOpacity = typeof layer.opacity === "number" ? layer.opacity : 1;
  const fillOpacity = isVectorStyledLayer(layer) ? styleValue(layer.style, "fillOpacity") : 1;
  const compound = layerOpacity * (typeof fillOpacity === "number" ? fillOpacity : 1);
  return Math.min(1, Math.max(0.15, compound));
}

/** Reorder entries to follow `order` (top-first); unlisted keep their spot. */
function orderEntries(entries: AutoLegendEntry[], order: string[]): AutoLegendEntry[] {
  if (order.length === 0) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const ordered: AutoLegendEntry[] = [];
  for (const id of order) {
    const entry = byId.get(id);
    if (entry && !seen.has(id)) {
      ordered.push(entry);
      seen.add(id);
    }
  }
  for (const entry of entries) {
    if (!seen.has(entry.id)) ordered.push(entry);
  }
  return ordered;
}

/**
 * Build the on-map legend from the visible layers plus the user's
 * {@link LegendConfig}: derived entries (top-of-stack first), hand-authored
 * replacements and standalone sections, then order / rename / hide overrides.
 * Hidden entries and rows are INCLUDED with their `hidden` flag set so the
 * panel's edit mode can dim and unhide them; display mode filters them out.
 */
export function buildAutoLegend(
  layers: GeoLibreLayer[],
  config: LegendConfig,
  options: AutoLegendOptions = {},
): AutoLegendEntry[] {
  const { locale } = options;
  const resolve = options.resolveColormapColors ?? (() => null);
  const customEntries = config.customEntries ?? {};
  const entries: AutoLegendEntry[] = [];

  // Store order is bottom-first; the legend reads top-first.
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    const custom = customEntries[layer.id];
    if (!custom && NON_LEGEND_TYPES.has(layer.type)) continue;

    const shape = layerSwatchShape(layer);
    let rows: RawRow[];
    let gradient: AutoLegendGradient | null = null;
    let headerSwatch: { color: string; marker?: LegendMarker } | null = null;
    let fieldLabel: string | undefined;
    let defaultName = layer.name;

    if (custom) {
      rows = customRows(custom);
      defaultName = custom.title?.trim() || layer.name;
    } else if (isRasterLike(layer)) {
      const parts = rasterParts(layer, locale, resolve);
      rows = parts.rows;
      gradient = parts.gradient;
      fieldLabel = parts.fieldLabel;
    } else {
      const parts = vectorParts(layer, shape, locale);
      rows = parts.rows;
      gradient = parts.gradient;
      headerSwatch = parts.headerSwatch;
      fieldLabel = parts.fieldLabel;
    }

    entries.push(
      finishEntry(layer.id, defaultName, shape, headerSwatch, fieldLabel, rows, gradient, {
        config,
        custom: Boolean(custom),
        standalone: false,
        opacity: custom ? 1 : entryOpacity(layer),
      }),
    );
  }

  // Standalone custom sections (ids not backed by a layer), in insertion order.
  const layerIds = new Set(layers.map((layer) => layer.id));
  for (const [id, entry] of Object.entries(customEntries)) {
    if (layerIds.has(id)) continue;
    entries.push(
      finishEntry(
        id,
        entry.title?.trim() || "Legend",
        "square",
        null,
        undefined,
        customRows(entry),
        null,
        {
          config,
          custom: true,
          standalone: true,
          opacity: 1,
        },
      ),
    );
  }

  return orderEntries(entries, config.order);
}

/** Apply per-entry / per-row overrides and assemble the final entry. */
function finishEntry(
  id: string,
  defaultName: string,
  shape: LayerSwatchShape,
  headerSwatch: { color: string; marker?: LegendMarker } | null,
  fieldLabel: string | undefined,
  rows: RawRow[],
  gradient: AutoLegendGradient | null,
  context: { config: LegendConfig; custom: boolean; standalone: boolean; opacity: number },
): AutoLegendEntry {
  const { config } = context;
  const entryOverride = config.overrides[id];
  return {
    id,
    name: effectiveLabel(entryOverride, defaultName),
    defaultName,
    shape,
    headerSwatch,
    ...(fieldLabel ? { fieldLabel } : {}),
    rows: rows.map((row, index) => {
      const key = legendRowKey(id, index);
      const override = config.overrides[key];
      return {
        key,
        label: effectiveLabel(override, row.label),
        defaultLabel: row.label,
        color: row.color,
        shape: row.shape,
        ...(row.marker ? { marker: row.marker } : {}),
        ...(row.size !== undefined ? { size: row.size } : {}),
        hidden: Boolean(override?.hidden),
      };
    }),
    gradient,
    opacity: context.opacity,
    custom: context.custom,
    standalone: context.standalone,
    hidden: Boolean(entryOverride?.hidden),
  };
}

/* ── LegendConfig mutation helpers (custom entries & panel state) ────────── */

/** Return a copy of `config` with `id`'s custom entry set (or replaced). */
export function setLegendCustomEntry(
  config: LegendConfig,
  id: string,
  entry: LegendCustomEntry,
): LegendConfig {
  return { ...config, customEntries: { ...config.customEntries, [id]: entry } };
}

/**
 * Return a copy of `config` without `id`'s custom entry (reverting a layer to
 * automatic derivation, or deleting a standalone section). Also drops the id
 * from `order` and its per-row overrides so nothing stale lingers.
 */
export function removeLegendCustomEntry(config: LegendConfig, id: string): LegendConfig {
  const customEntries = { ...config.customEntries };
  delete customEntries[id];
  const overrides: LegendConfig["overrides"] = {};
  const rowPrefix = `${id}::`;
  for (const [key, value] of Object.entries(config.overrides)) {
    if (key === id || key.startsWith(rowPrefix)) continue;
    overrides[key] = value;
  }
  const next: LegendConfig = {
    ...config,
    overrides,
    order: config.order.filter((entryId) => entryId !== id),
    customEntries,
  };
  if (Object.keys(customEntries).length === 0) delete next.customEntries;
  return next;
}

/**
 * Serialize the rendered legend to pretty-printed JSON for export: the title
 * plus one entry per visible section with its effective (override-applied)
 * labels, colors, shapes, and gradient. Hidden entries and rows are omitted —
 * the export mirrors what the panel shows. Each section's items are the same
 * `{label, color}` shape "Add from dictionary" accepts, so an exported legend
 * can be rebuilt by hand elsewhere.
 */
export function serializeLegend(entries: AutoLegendEntry[], title: string): string {
  const payload = {
    title,
    entries: entries
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
        title: entry.name,
        ...(entry.fieldLabel ? { field: entry.fieldLabel } : {}),
        ...(entry.headerSwatch ? { color: entry.headerSwatch.color, shape: entry.shape } : {}),
        items: entry.rows
          .filter((row) => !row.hidden)
          .map((row) => ({
            label: row.label,
            color: row.color,
            shape: row.shape,
            ...(row.size !== undefined ? { size: row.size } : {}),
          })),
        ...(entry.gradient
          ? {
              gradient: {
                colors: entry.gradient.colors,
                ...(entry.gradient.minLabel !== null ? { min: entry.gradient.minLabel } : {}),
                ...(entry.gradient.maxLabel !== null ? { max: entry.gradient.maxLabel } : {}),
              },
            }
          : {}),
      })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse hand-entered legend items from a dictionary: either a JSON object of
 * `{"label": "color"}` pairs (the shape `Map.add_legend(legend_dict=…)` and
 * the legacy Legend control accept), or one `label: color` line per item.
 * Returns null when nothing parseable is present, so the editor can keep its
 * Add button disabled rather than creating an empty section.
 */
export function parseLegendDictionary(text: string): LegendCustomItem[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const items: LegendCustomItem[] = [];
      for (const [label, color] of Object.entries(parsed)) {
        if (typeof color !== "string" || !label.trim() || !color.trim()) return null;
        items.push({ label, color: color.trim() });
      }
      return items.length > 0 ? items : null;
    } catch {
      return null;
    }
  }

  const items: LegendCustomItem[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    // "label: color", or "label, color" for colors without commas. Split on
    // the LAST separator so labels like "1900 – 1929: Developed" still work
    // when the color itself has none.
    const colon = entry.lastIndexOf(":");
    const comma = entry.lastIndexOf(",");
    const split = colon >= 0 ? colon : comma;
    if (split <= 0 || split === entry.length - 1) return null;
    const label = entry.slice(0, split).trim();
    const color = entry.slice(split + 1).trim();
    if (!label || !color) return null;
    items.push({ label, color });
  }
  return items.length > 0 ? items : null;
}

/** A unique id for a new standalone custom section. */
export function newCustomSectionId(config: LegendConfig): string {
  const taken = new Set(Object.keys(config.customEntries ?? {}));
  let index = 1;
  while (taken.has(`${CUSTOM_SECTION_PREFIX}${index}`)) index += 1;
  return `${CUSTOM_SECTION_PREFIX}${index}`;
}
