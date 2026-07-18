import {
  DEFAULT_LAYER_STYLE,
  type DiagramField,
  type DiagramSizeMode,
  type DiagramType,
  type ExpressionVariable,
  type FillPattern,
  type GeometryGeneratorType,
  type LabelStyle,
  type LayerType,
  type LineDecoration,
  type MarkerShape,
  type PointRenderer,
  type StrokeWidthUnit,
  VECTOR_COLOR_RAMPS,
  type VectorRule,
  type VectorStyleMode,
  type VectorStyleStop,
  collectDiagramData,
  createEqualIntervalBreaks,
  createQuantileBreaks,
  geojsonHasZCoordinates,
  interpolateRampColors,
  isStyleLibraryTargetLayer,
  parseJsonExpression,
  removeTrailingJsonCommas,
  styleValue,
  useAppStore,
  validateMapExpression,
} from "@geolibre/core";
import {
  Button,
  ColorField,
  ColorRampSelect,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
  Slider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@geolibre/ui";
import {
  RASTER_SOURCE_KIND,
  SKETCHES_SOURCE_KIND,
  countAtlasDroppedDiagrams,
} from "@geolibre/plugins";
import { type MapController } from "@geolibre/map";
import type { ParseKeys, TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AttributeFormSection } from "./AttributeFormSection";
import { LayerJoinsSection } from "./LayerJoinsSection";
import { VirtualFieldsSection } from "./VirtualFieldsSection";
import { RasterSymbologySection } from "./RasterSymbologySection";
import { ExpressionBuilderDialog } from "../expressions/ExpressionBuilderDialog";
import {
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Info,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  SlidersHorizontal,
  SquareFunction,
  Trash2,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { clamp } from "../../lib/clamp";
import {
  getAttributePropertyNames,
  standardExpressionVariables,
} from "../../lib/expression-inputs";

/**
 * Data-defined label overrides (GH #1320): one row per {@link LabelStyle}
 * expression field, with the Expression Builder context enforcing each
 * destination's result type (size/opacity/priority are numbers, color a
 * color, visibility a boolean filter).
 */
const LABEL_OVERRIDE_PROPERTIES = [
  {
    key: "size",
    field: "sizeExpression",
    context: "number",
    expectedType: "number",
  },
  {
    key: "color",
    field: "colorExpression",
    context: "color",
    expectedType: "color",
  },
  {
    key: "opacity",
    field: "opacityExpression",
    context: "number",
    expectedType: "number",
  },
  {
    key: "visibility",
    field: "visibilityExpression",
    context: "filter",
    expectedType: "boolean",
  },
  {
    key: "priority",
    field: "priorityExpression",
    context: "number",
    expectedType: "number",
  },
] as const;
type LabelOverrideProperty = (typeof LABEL_OVERRIDE_PROPERTIES)[number];

// Override validity is checked on every panel render, and compiling through
// the style spec is far more expensive than a lookup, so results are memoized
// by expected type + source (module scope: this section renders below the
// component's early returns, where a useMemo would violate the rules of
// hooks). Bounded so a pathological stream of distinct expressions cannot
// grow it without limit.
const labelOverrideValidityCache = new Map<string, boolean>();
const LABEL_OVERRIDE_VALIDITY_CACHE_MAX = 256;

function labelOverrideInvalid(
  value: string,
  expectedType: "number" | "color" | "boolean",
): boolean {
  const key = `${expectedType}:${value}`;
  const cached = labelOverrideValidityCache.get(key);
  if (cached !== undefined) return cached;
  const invalid = !validateMapExpression(value, { expectedType }).ok;
  if (labelOverrideValidityCache.size >= LABEL_OVERRIDE_VALIDITY_CACHE_MAX) {
    labelOverrideValidityCache.clear();
  }
  labelOverrideValidityCache.set(key, invalid);
  return invalid;
}

interface StylePanelProps {
  mapControllerRef: RefObject<MapController | null>;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /**
   * When this flips to `true` the panel collapses to its thin rail (it is not
   * unmounted). Used to clear room when the notebook opens beside the map; the
   * user can still expand it again.
   */
  autoCollapse?: boolean;
  /**
   * Controlled collapse state for the shared right-sidebar (`replace-style`)
   * mode. When defined, the panel's own collapse state is ignored and the
   * parent fully owns expand/collapse: the collapse/expand buttons call
   * {@link onCollapsedChange} instead of toggling internal state, and
   * `autoCollapse` no longer applies. Leave undefined for the standalone panel.
   */
  collapsed?: boolean;
  /** Notify the parent of a collapse/expand request in controlled mode. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * In the shared right-sidebar mode, suppress the panel's own collapsed rail:
   * when collapsed the panel renders nothing because a single shared rail (owned
   * by the host) lists the Style entry instead of two adjacent rails.
   */
  hideOwnRail?: boolean;
}

function isRasterPaintLayer(type: LayerType): boolean {
  return type === "raster" || type === "wms" || type === "wmts" || type === "xyz";
}

function hasExternalNativeLayers(layer: { metadata: Record<string, unknown> }) {
  return Array.isArray(layer.metadata.nativeLayerIds) && layer.metadata.nativeLayerIds.length > 0;
}

function hasExternalDeckLayer(layer: { metadata: Record<string, unknown> }) {
  return layer.metadata.externalDeckLayer === true;
}

function hasTextMarkerFeatures(layer: {
  geojson?: {
    features?: Array<{
      geometry?: { type?: string } | null;
      properties?: Record<string, unknown> | null;
    }>;
  };
}): boolean {
  return (layer.geojson?.features ?? []).some((feature) => {
    const geometryType = feature.geometry?.type;
    if (geometryType !== "Point" && geometryType !== "MultiPoint") {
      return false;
    }
    const properties = feature.properties;
    return properties?.__gm_shape === "text_marker" || properties?.shape === "text_marker";
  });
}

function supportsExtrusionControls(layer: {
  type: LayerType;
  source: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): boolean {
  if (layer.type === "geojson" || layer.type === "vector-tiles" || layer.type === "mbtiles") {
    return true;
  }

  if (layer.type === "pmtiles") {
    return layer.metadata.tileType === "vector" || layer.source.type === "vector";
  }

  if (layer.type === "flatgeobuf") {
    return hasPolygonGeometryMetadata(layer.metadata.geometryTypes);
  }

  if (layer.type === "arcgis") {
    return true;
  }

  if (hasExternalDeckLayer(layer)) {
    return true;
  }

  return (
    hasExternalNativeLayers(layer) &&
    layer.metadata.tileType !== "raster" &&
    layer.source.type !== "raster"
  );
}

function hasPolygonGeometryMetadata(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  return value.some(
    (geometryType) =>
      typeof geometryType === "string" && geometryType.toLowerCase().includes("polygon"),
  );
}

/**
 * True when a GeoJSON layer contains only point geometry, so the heatmap and
 * cluster renderers (which only make sense for points) can be offered.
 */
function isPointOnlyGeoJsonLayer(layer: {
  type: LayerType;
  geojson?: { features?: Array<{ geometry?: { type?: string } | null }> };
}): boolean {
  if (layer.type !== "geojson") return false;
  const features = layer.geojson?.features ?? [];
  if (features.length === 0) return false;
  return features.every((feature) => {
    const type = feature.geometry?.type;
    return type === "Point" || type === "MultiPoint";
  });
}

interface GeometryFlags {
  hasPoint: boolean;
  hasLine: boolean;
  hasPolygon: boolean;
}

// Sample the layer's geometry so the proportional-size, fill-pattern, and marker
// sections only appear where they apply. When the layer has no in-memory GeoJSON
// (tile/external layers whose geometry is unknown here) every flag is true so the
// controls stay available rather than being hidden incorrectly.
function getGeometryFlags(layer: {
  geojson?: { features?: Array<{ geometry?: { type?: string } | null }> };
}): GeometryFlags {
  const features = layer.geojson?.features;
  if (!features || features.length === 0) {
    return { hasPoint: true, hasLine: true, hasPolygon: true };
  }
  const flags: GeometryFlags = {
    hasPoint: false,
    hasLine: false,
    hasPolygon: false,
  };
  const limit = Math.min(features.length, 2000);
  for (let index = 0; index < limit; index += 1) {
    const type = features[index]?.geometry?.type;
    if (type === "Point" || type === "MultiPoint") flags.hasPoint = true;
    else if (type === "LineString" || type === "MultiLineString") flags.hasLine = true;
    else if (type === "Polygon" || type === "MultiPolygon") flags.hasPolygon = true;
    if (flags.hasPoint && flags.hasLine && flags.hasPolygon) break;
  }
  return flags;
}

const MARKER_SHAPE_OPTIONS: ReadonlyArray<{
  value: MarkerShape;
  labelKey: ParseKeys;
}> = [
  { value: "circle", labelKey: "style.symbology.markerShapes.circle" },
  { value: "square", labelKey: "style.symbology.markerShapes.square" },
  { value: "triangle", labelKey: "style.symbology.markerShapes.triangle" },
  { value: "diamond", labelKey: "style.symbology.markerShapes.diamond" },
  { value: "star", labelKey: "style.symbology.markerShapes.star" },
  { value: "cross", labelKey: "style.symbology.markerShapes.cross" },
  { value: "pin", labelKey: "style.symbology.markerShapes.pin" },
  { value: "custom", labelKey: "style.symbology.markerShapes.custom" },
];

// Glyphs for the marker gallery preview only; they render in the chosen marker
// color (currentColor). The map renders the precise canvas-drawn shapes.
const MARKER_GLYPHS: Record<MarkerShape, string> = {
  circle: "●",
  square: "■",
  triangle: "▲",
  diamond: "◆",
  star: "★",
  cross: "✚",
  pin: "⦿",
  custom: "⬢",
};

const FILL_PATTERN_OPTIONS: ReadonlyArray<{
  value: FillPattern;
  labelKey: ParseKeys;
}> = [
  { value: "none", labelKey: "style.symbology.fillPatterns.none" },
  { value: "hatch", labelKey: "style.symbology.fillPatterns.hatch" },
  { value: "cross-hatch", labelKey: "style.symbology.fillPatterns.crossHatch" },
  { value: "horizontal", labelKey: "style.symbology.fillPatterns.horizontal" },
  { value: "vertical", labelKey: "style.symbology.fillPatterns.vertical" },
  { value: "dots", labelKey: "style.symbology.fillPatterns.dots" },
  { value: "svg", labelKey: "style.symbology.fillPatterns.svg" },
];

/** Create a blank rule-based filter rule with a unique id. */
function createVectorRule(isElse: boolean, color: string): VectorRule {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rule-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    label: isElse ? "Else" : "",
    filter: "",
    color,
    isElse,
  };
}

/** One row of the rule editor's tree-ordered rule list. */
interface RuleTreeRow {
  rule: VectorRule;
  depth: number;
  /** True when other rules name this rule as their parent (a group). */
  isGroup: boolean;
}

/**
 * Order the concrete (non-else) rules as a depth-first tree walk following
 * `parentId`, so children render indented under their parent. Rules with a
 * dangling parent id render as roots; rules trapped in a `parentId` cycle are
 * appended at the end so they stay visible and editable.
 */
function ruleTreeRows(rules: VectorRule[]): RuleTreeRow[] {
  const concrete = rules.filter((rule) => !rule.isElse);
  const byId = new Map(concrete.map((rule) => [rule.id, rule]));
  const childrenOf = new Map<string, VectorRule[]>();
  const roots: VectorRule[] = [];
  for (const rule of concrete) {
    const parent = rule.parentId && rule.parentId !== rule.id ? byId.get(rule.parentId) : undefined;
    if (parent) {
      const siblings = childrenOf.get(parent.id);
      if (siblings) siblings.push(rule);
      else childrenOf.set(parent.id, [rule]);
    } else {
      roots.push(rule);
    }
  }
  const rows: RuleTreeRow[] = [];
  const seen = new Set<string>();
  const visit = (rule: VectorRule, depth: number) => {
    if (seen.has(rule.id)) return;
    seen.add(rule.id);
    const children = childrenOf.get(rule.id) ?? [];
    rows.push({ rule, depth, isGroup: children.length > 0 });
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const rule of concrete) visit(rule, 0);
  return rows;
}

/**
 * A rule's effective zoom range: its own bounds intersected with every
 * ancestor's, mirroring how `effectiveVectorRules` resolves the tree for
 * rendering. Used to warn when the intersection is empty (the rule never
 * applies), which the rule's own fields alone cannot reveal.
 */
function effectiveRuleZoomRange(
  rules: VectorRule[],
  rule: VectorRule,
): { minZoom?: number; maxZoom?: number } {
  const byId = new Map(rules.filter((entry) => !entry.isElse).map((entry) => [entry.id, entry]));
  let minZoom = rule.minZoom;
  let maxZoom = rule.maxZoom;
  const seen = new Set([rule.id]);
  let parent = rule.parentId && rule.parentId !== rule.id ? byId.get(rule.parentId) : undefined;
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (parent.minZoom !== undefined) {
      minZoom = minZoom === undefined ? parent.minZoom : Math.max(minZoom, parent.minZoom);
    }
    if (parent.maxZoom !== undefined) {
      maxZoom = maxZoom === undefined ? parent.maxZoom : Math.min(maxZoom, parent.maxZoom);
    }
    parent =
      parent.parentId && parent.parentId !== parent.id ? byId.get(parent.parentId) : undefined;
  }
  return { minZoom, maxZoom };
}

/** Ids of a rule and all rules nested (transitively) under it. */
function ruleSubtreeIds(rules: VectorRule[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of rules) {
      if (rule.isElse || ids.has(rule.id)) continue;
      if (rule.parentId && ids.has(rule.parentId)) {
        ids.add(rule.id);
        grew = true;
      }
    }
  }
  return ids;
}

interface RuleNumberInputProps {
  label: string;
  value: number | undefined;
  min: number;
  max?: number;
  step: number;
  placeholder: string;
  onChange: (value: number | undefined) => void;
}

/** A compact numeric input where a blank value means "inherit the layer value". */
function RuleNumberInput({
  label,
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: RuleNumberInputProps) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        className="h-8"
        placeholder={placeholder}
        value={value ?? ""}
        aria-label={label}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const next = Number(raw);
          if (!Number.isFinite(next)) return;
          // Clamp into the field's domain before it reaches the store, so an
          // out-of-range typed value (e.g. a negative width) never persists.
          onChange(clamp(next, min, max ?? Number.POSITIVE_INFINITY));
        }}
      />
    </label>
  );
}

function getPropertyValues(
  layer: {
    geojson?: {
      features?: Array<{
        properties?: Record<string, unknown> | null;
      }>;
    };
  },
  property: string,
): unknown[] {
  if (!property) return [];

  return (layer.geojson?.features ?? [])
    .map((feature) => feature.properties?.[property])
    .filter((value) => value !== null && value !== undefined);
}

const VECTOR_STYLE_COLORS = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];

const VECTOR_STYLE_CLASS_COUNTS = Array.from({ length: 12 }, (_, index) => index + 1);

const GRADUATED_CLASSIFICATION_SCHEMES: ReadonlyArray<{
  value: string;
  labelKey: ParseKeys;
}> = [
  { value: "equal-interval", labelKey: "style.symbology.schemeEqualInterval" },
  { value: "quantile", labelKey: "style.symbology.schemeQuantile" },
  { value: "natural-breaks", labelKey: "style.symbology.schemeNaturalBreaks" },
];

const CATEGORIZED_CLASSIFICATION_SCHEMES: ReadonlyArray<{
  value: string;
  labelKey: ParseKeys;
}> = [
  { value: "top-values", labelKey: "style.symbology.schemeTopValues" },
  { value: "alphabetical", labelKey: "style.symbology.schemeAlphabetical" },
  { value: "first-values", labelKey: "style.symbology.schemeFirstValues" },
];

// Exported for the Style Manager, which regenerates a layer's stops when a
// ramp preset is applied to an already-classified layer.
export function createGraduatedStops(
  layer: Parameters<typeof getPropertyValues>[0],
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
): VectorStyleStop[] {
  const values = getPropertyValues(layer, property)
    .map((value) => Number(value))
    .filter(Number.isFinite);
  const count = clampClassCount(classCount, 2);
  const colors = interpolateRampColors(colorRamp, count);
  if (values.length === 0) {
    return colors.map((color, index) => ({ value: index, color }));
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ value: min, color: colors.at(-1) ?? "#2563eb" }];

  const breaks =
    classificationScheme === "quantile"
      ? createQuantileBreaks(values, count)
      : classificationScheme === "natural-breaks"
        ? createNaturalBreaks(values, count)
        : createEqualIntervalBreaks(min, max, count);

  // Natural breaks can yield fewer breaks than the requested count when the
  // layer has fewer unique values; align the color count so none are dropped.
  const stopColors =
    breaks.length === count ? colors : interpolateRampColors(colorRamp, breaks.length);

  return breaks.map((value, index) => ({
    value: Number(value.toPrecision(8)),
    color: stopColors[index] ?? stopColors.at(-1) ?? "#2563eb",
  }));
}

// Exported for the Style Manager (see createGraduatedStops above).
export function createCategorizedStops(
  layer: Parameters<typeof getPropertyValues>[0],
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
): VectorStyleStop[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  for (const value of getPropertyValues(layer, property)) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstSeen.has(key)) firstSeen.set(key, firstSeen.size);
  }

  const count = clampClassCount(classCount, 1);
  const categories = Array.from(counts.entries()).sort((a, b) => {
    if (classificationScheme === "alphabetical") {
      return a[0].localeCompare(b[0], undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    if (classificationScheme === "first-values") {
      return (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
    }
    return b[1] - a[1] || a[0].localeCompare(b[0]);
  });
  const colors = interpolateRampColors(colorRamp, Math.min(count, categories.length || count));

  return categories.slice(0, count).map(([value], index) => ({
    value,
    color: colors[index] ?? nextStopColor(index),
  }));
}

function createDefaultStops(
  layer: Parameters<typeof getPropertyValues>[0],
  mode: VectorStyleMode,
  property: string,
  classCount: number,
  colorRamp: string,
  classificationScheme: string,
): VectorStyleStop[] {
  if (mode === "graduated") {
    return createGraduatedStops(layer, property, classCount, colorRamp, classificationScheme);
  }
  if (mode === "categorized") {
    return createCategorizedStops(layer, property, classCount, colorRamp, classificationScheme);
  }
  return styleValue(DEFAULT_LAYER_STYLE, "vectorStyleStops");
}

function clampClassCount(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(12, Math.max(min, Math.round(value)));
}

function normalizeVectorStyleClassCount(mode: VectorStyleMode, value: number): number {
  return clampClassCount(value, mode === "categorized" ? 1 : 2);
}

function defaultClassificationScheme(mode: VectorStyleMode): string {
  return mode === "categorized" ? "top-values" : "equal-interval";
}

function normalizeClassificationScheme(mode: VectorStyleMode, scheme: string): string {
  const options =
    mode === "categorized" ? CATEGORIZED_CLASSIFICATION_SCHEMES : GRADUATED_CLASSIFICATION_SCHEMES;
  return options.some((option) => option.value === scheme)
    ? scheme
    : defaultClassificationScheme(mode);
}

const MAX_NATURAL_BREAK_SAMPLES = 1000;

function downsampleSortedValues(values: number[], maxSamples: number): number[] {
  if (values.length <= maxSamples) return values;
  const result: number[] = [];
  const step = (values.length - 1) / (maxSamples - 1);
  for (let index = 0; index < maxSamples; index += 1) {
    result.push(values[Math.round(index * step)]);
  }
  return result;
}

function createNaturalBreaks(values: number[], count: number): number[] {
  const unique = Array.from(new Set(values)).sort((a, b) => a - b);
  // The Jenks DP below is roughly O(n^2 * k); cap the input so large layers
  // do not freeze the Style panel on the UI thread.
  const sorted = downsampleSortedValues(unique, MAX_NATURAL_BREAK_SAMPLES);
  if (sorted.length <= count) return sorted;

  const lowerClassLimits = Array.from({ length: sorted.length + 1 }, () =>
    Array(count + 1).fill(0),
  );
  const varianceCombinations = Array.from({ length: sorted.length + 1 }, () =>
    Array(count + 1).fill(Number.POSITIVE_INFINITY),
  );

  for (let classIndex = 1; classIndex <= count; classIndex += 1) {
    lowerClassLimits[1][classIndex] = 1;
    varianceCombinations[1][classIndex] = 0;
  }

  for (let valueIndex = 2; valueIndex <= sorted.length; valueIndex += 1) {
    let sum = 0;
    let sumSquares = 0;
    let weight = 0;

    for (let lowerIndex = 1; lowerIndex <= valueIndex; lowerIndex += 1) {
      const currentIndex = valueIndex - lowerIndex + 1;
      const value = sorted[currentIndex - 1];
      weight += 1;
      sum += value;
      sumSquares += value * value;
      const variance = sumSquares - (sum * sum) / weight;
      const previousIndex = currentIndex - 1;
      if (previousIndex === 0) continue;

      for (let classIndex = 2; classIndex <= count; classIndex += 1) {
        const candidate = variance + varianceCombinations[previousIndex][classIndex - 1];
        if (varianceCombinations[valueIndex][classIndex] >= candidate) {
          lowerClassLimits[valueIndex][classIndex] = currentIndex;
          varianceCombinations[valueIndex][classIndex] = candidate;
        }
      }
    }

    lowerClassLimits[valueIndex][1] = 1;
    varianceCombinations[valueIndex][1] = sumSquares - (sum * sum) / Math.max(1, weight);
  }

  const breaks = Array(count).fill(sorted[0]) as number[];
  breaks[count - 1] = sorted[sorted.length - 1];
  let valueIndex = sorted.length;
  for (let classIndex = count; classIndex >= 2; classIndex -= 1) {
    const lowerClassLimit = lowerClassLimits[valueIndex][classIndex] - 1;
    breaks[classIndex - 2] = sorted[Math.max(0, lowerClassLimit)];
    valueIndex = lowerClassLimit;
  }
  return breaks;
}

function chooseDefaultStyleProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  mode: VectorStyleMode,
  properties: string[],
  currentProperty: string,
): string {
  if (mode === "graduated") {
    if (currentProperty && isNumericProperty(layer, currentProperty)) {
      return currentProperty;
    }
    return chooseGraduatedProperty(layer, properties);
  }

  if (mode === "categorized") {
    if (currentProperty && isCategoricalProperty(layer, currentProperty)) {
      return currentProperty;
    }
    return (
      properties.find((property) => isCategoricalProperty(layer, property)) ?? properties[0] ?? ""
    );
  }

  return currentProperty;
}

function isNumericProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  property: string,
): boolean {
  const values = getPropertyValues(layer, property);
  const numericValues = values.map((value) => Number(value)).filter(Number.isFinite);
  return numericValues.length > 1;
}

function chooseGraduatedProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  properties: string[],
): string {
  let bestProperty = "";
  let bestScore = -1;

  for (const property of properties) {
    const values = getPropertyValues(layer, property)
      .map((value) => Number(value))
      .filter(Number.isFinite);
    if (values.length < 2) continue;

    const range = Math.max(...values) - Math.min(...values);
    const score = new Set(values).size * Math.log10(Math.max(1, range) + 1);
    if (score > bestScore) {
      bestProperty = property;
      bestScore = score;
    }
  }

  return bestProperty;
}

function isCategoricalProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  property: string,
): boolean {
  const values = getPropertyValues(layer, property).map((value) => String(value));
  const uniqueCount = new Set(values).size;
  return uniqueCount > 1 && uniqueCount <= 12;
}

function normalizeVectorStyleStops(
  mode: VectorStyleMode,
  stops: VectorStyleStop[],
): VectorStyleStop[] {
  return stops
    .map((stop) => ({
      value:
        mode === "graduated" && typeof stop.value === "string"
          ? Number.parseFloat(stop.value)
          : typeof stop.value === "string"
            ? stop.value.trim()
            : stop.value,
      color: stop.color.trim(),
    }))
    .filter((stop) => {
      if (!/^#[0-9a-f]{6}$/i.test(stop.color)) return false;
      if (mode === "graduated") {
        return typeof stop.value === "number" && Number.isFinite(stop.value);
      }
      return String(stop.value).trim().length > 0;
    });
}

function nextStopColor(index: number): string {
  return VECTOR_STYLE_COLORS[index % VECTOR_STYLE_COLORS.length];
}

function validateExpressionJson(value: string, label: string, t: TFunction): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
    if (!Array.isArray(parsed)) {
      return t("style.expressionErrors.notArray", { label });
    }
    // Every MapLibre expression starts with a string operator. Reject e.g.
    // `["to-number", …]` used as a filter or a bare value array, which parses as
    // JSON but compiles to an expression MapLibre rejects at runtime.
    if (typeof parsed[0] !== "string") {
      return t("style.expressionErrors.notOperator", { label });
    }
    return null;
  } catch (error) {
    return t("style.expressionErrors.notJson", {
      label,
      message: error instanceof Error ? error.message : "unknown parse error",
    });
  }
}

// Shared shell classes for every expanded StylePanel return branch. On phones
// (max-md) it overlays the map as a bottom sheet instead of squeezing it.
const STYLE_PANEL_ASIDE_CLASS =
  "relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--style-panel-width)] md:border-s md:border-t-0";

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

function stepPrecision(step: number): number {
  const [, decimals = ""] = String(step).split(".");
  return decimals.length;
}

interface NumericStyleInputProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  tooltip?: string;
}

function NumericStyleInput({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  tooltip,
}: NumericStyleInputProps) {
  const { t } = useTranslation();
  const normalize = (next: number) => Number(clamp(next, min, max).toFixed(stepPrecision(step)));

  const stepValue = (direction: 1 | -1) => {
    onChange(normalize(value + direction * step));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tooltip}
                className="inline-flex cursor-help rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          className="pe-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(normalize(next));
          }}
        />
        <div className="absolute end-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
          <button
            type="button"
            className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
            aria-label={t("style.increaseValue", { label })}
            onClick={() => stepValue(1)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
            aria-label={t("style.decreaseValue", { label })}
            onClick={() => stepValue(-1)}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface StopValueInputProps {
  index: number;
  isNumeric: boolean;
  value: string | number;
  onChange: (value: string) => void;
}

function StopValueInput({ index, isNumeric, value, onChange }: StopValueInputProps) {
  const { t } = useTranslation();
  const label = t("style.symbology.classValue", { index: index + 1 });

  if (!isNumeric) {
    return (
      <Input
        type="text"
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const stepValue = (direction: 1 | -1) => {
    const current = Number(value);
    const next = Number.isFinite(current) ? current + direction : direction;
    onChange(String(next));
  };

  return (
    <div className="relative">
      <Input
        type="number"
        step="any"
        aria-label={label}
        className="pe-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="absolute end-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
        <button
          type="button"
          className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
          aria-label={t("style.increaseValue", { label })}
          onClick={() => stepValue(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
          aria-label={t("style.decreaseValue", { label })}
          onClick={() => stepValue(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface RasterStyleSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}

function RasterStyleSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (next) => next.toFixed(2),
}: RasterStyleSliderProps) {
  // Double-clicking the value label (or the slider track) swaps the read-only
  // value for an inline numeric input, so users can type an exact value instead
  // of dragging to it (#832). Enter/blur commits the clamped value, Escape cancels.
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const precision = stepPrecision(step);
  // Guard so each edit session commits (or cancels) at most once: Enter and
  // Escape both tear down the input, and React still fires onBlur on the
  // unmounting element. Without this, blur would re-commit after Enter or
  // commit a cancelled draft after Escape.
  const handledRef = useRef(false);

  const commit = (raw: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const parsed = Number(raw);
    // Treat an empty/whitespace entry like Escape: cancel rather than commit 0
    // (Number("") === 0 would otherwise silently reset the slider to its min).
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Number(clamp(parsed, min, max).toFixed(precision)));
    }
    setEditing(false);
  };

  const cancel = () => {
    handledRef.current = true;
    setEditing(false);
  };

  const startEditing = () => {
    handledRef.current = false;
    setDraft(String(value));
    setEditing(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        {editing ? (
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            autoFocus
            aria-label={t("style.raster.valueAria", { label })}
            className="h-6 w-20 px-1.5 py-0 text-end font-mono text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit((event.target as HTMLInputElement).value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="shrink-0 cursor-text font-mono text-xs text-muted-foreground hover:text-foreground"
            title={t("style.raster.exactValueHint")}
            aria-label={t("style.raster.editValueAria", { label })}
            onDoubleClick={startEditing}
          >
            {format(value)}
          </button>
        )}
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]: number[]) => {
          if (typeof next === "number") onChange(next);
        }}
        onDoubleClick={startEditing}
      />
    </div>
  );
}

export function StylePanel({
  mapControllerRef,
  onResizeStart,
  autoCollapse = false,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  hideOwnRail = false,
}: StylePanelProps) {
  const { t } = useTranslation();
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const projectName = useAppStore((s) => s.projectName);
  const [internalCollapsed, setInternalCollapsed] = useState(getIsMobileViewport);
  // In the shared right-sidebar mode the parent owns collapse (controlled);
  // otherwise the panel manages it locally. `setIsCollapsed` routes to whichever
  // owner applies so every existing call site keeps working.
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;
  const setIsCollapsed = useCallback(
    (value: boolean) => {
      if (isControlled) onCollapsedChange?.(value);
      else setInternalCollapsed(value);
    },
    [isControlled, onCollapsedChange],
  );
  // Collapse to the rail when `autoCollapse` flips on (e.g. the notebook opens),
  // and restore the prior expand/collapse state when it flips back off (notebook
  // closes). Both act only on the transition so the user can still toggle the
  // panel manually while `autoCollapse` stays on. `isCollapsed` is in the deps
  // only to keep the captured value fresh; the guards make pure `isCollapsed`
  // changes a no-op while `autoCollapse` is stable. The ref starts as null (not
  // `autoCollapse`) so a mount with `autoCollapse` already true reads as a
  // null→true transition and still collapses. Skipped entirely in controlled
  // mode, where the parent (shared rail) owns collapse and never passes
  // `autoCollapse`.
  const prevAutoCollapse = useRef<boolean | null>(null);
  const collapsedBeforeAuto = useRef(isCollapsed);
  useEffect(() => {
    if (isControlled) return;
    const wasAuto = prevAutoCollapse.current;
    prevAutoCollapse.current = autoCollapse;
    if (autoCollapse && !wasAuto) {
      collapsedBeforeAuto.current = internalCollapsed;
      setInternalCollapsed(true);
    } else if (!autoCollapse && wasAuto) {
      setInternalCollapsed(collapsedBeforeAuto.current);
    }
  }, [autoCollapse, internalCollapsed, isControlled]);
  const [draftBeforeId, setDraftBeforeId] = useState("");
  const [showBasemapStyleLayers, setShowBasemapStyleLayers] = useState(false);
  const [draftColorExpression, setDraftColorExpression] = useState("");
  const [draftHeightExpression, setDraftHeightExpression] = useState("");
  const [draftVectorStyleMode, setDraftVectorStyleMode] = useState<VectorStyleMode>(
    DEFAULT_LAYER_STYLE.vectorStyleMode,
  );
  const [draftVectorStyleProperty, setDraftVectorStyleProperty] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleProperty,
  );
  const [draftVectorStyleClassCount, setDraftVectorStyleClassCount] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleClassCount,
  );
  const [draftVectorStyleColorRamp, setDraftVectorStyleColorRamp] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleColorRamp,
  );
  const [draftVectorStyleClassificationScheme, setDraftVectorStyleClassificationScheme] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme,
  );
  const [draftVectorStyleStops, setDraftVectorStyleStops] = useState<VectorStyleStop[]>(
    DEFAULT_LAYER_STYLE.vectorStyleStops,
  );
  const [draftVectorStyleExpression, setDraftVectorStyleExpression] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleExpression,
  );
  const [draftExtrusionColor, setDraftExtrusionColor] = useState(
    DEFAULT_LAYER_STYLE.extrusionColor,
  );
  const [draftExtrusionOpacity, setDraftExtrusionOpacity] = useState(
    DEFAULT_LAYER_STYLE.extrusionOpacity,
  );
  const [draftExtrusionHeightProperty, setDraftExtrusionHeightProperty] = useState(
    DEFAULT_LAYER_STYLE.extrusionHeightProperty,
  );
  const [draftExtrusionHeightScale, setDraftExtrusionHeightScale] = useState(
    DEFAULT_LAYER_STYLE.extrusionHeightScale,
  );
  const [draftExtrusionBase, setDraftExtrusionBase] = useState(DEFAULT_LAYER_STYLE.extrusionBase);
  const [draftAdvancedExtrusionEnabled, setDraftAdvancedExtrusionEnabled] = useState(
    DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled,
  );
  const [vectorStyleError, setVectorStyleError] = useState<string | null>(null);
  const [extrusionError, setExtrusionError] = useState<string | null>(null);
  // Which expression surface the shared Expression Builder is editing; null
  // when the builder is closed. Targets carry the owning layer id so an edit
  // can never be applied to a different layer than the one it was opened for
  // (GH #1306).
  const [expressionBuilderTarget, setExpressionBuilderTarget] = useState<
    | { kind: "rule"; ruleId: string; index: number; layerId: string }
    | { kind: "style"; layerId: string }
    | { kind: "label"; layerId: string }
    | {
        kind: "labelOverride";
        property: LabelOverrideProperty;
        layerId: string;
      }
    | null
  >(null);
  // Close the builder when the selected layer changes: its fields, sample
  // features, and target expression all belong to the previous layer.
  useEffect(() => {
    setExpressionBuilderTarget(null);
  }, [selectedLayerId]);

  const layer = layers.find((l) => l.id === selectedLayerId);

  useEffect(() => {
    if (!layer) {
      setDraftBeforeId("");
      setDraftColorExpression("");
      setDraftHeightExpression("");
      setDraftVectorStyleMode(DEFAULT_LAYER_STYLE.vectorStyleMode);
      setDraftVectorStyleProperty(DEFAULT_LAYER_STYLE.vectorStyleProperty);
      setDraftVectorStyleClassCount(DEFAULT_LAYER_STYLE.vectorStyleClassCount);
      setDraftVectorStyleColorRamp(DEFAULT_LAYER_STYLE.vectorStyleColorRamp);
      setDraftVectorStyleClassificationScheme(DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme);
      setDraftVectorStyleStops(DEFAULT_LAYER_STYLE.vectorStyleStops);
      setDraftVectorStyleExpression(DEFAULT_LAYER_STYLE.vectorStyleExpression);
      setDraftExtrusionColor(DEFAULT_LAYER_STYLE.extrusionColor);
      setDraftExtrusionOpacity(DEFAULT_LAYER_STYLE.extrusionOpacity);
      setDraftExtrusionHeightProperty(DEFAULT_LAYER_STYLE.extrusionHeightProperty);
      setDraftExtrusionHeightScale(DEFAULT_LAYER_STYLE.extrusionHeightScale);
      setDraftExtrusionBase(DEFAULT_LAYER_STYLE.extrusionBase);
      setDraftAdvancedExtrusionEnabled(DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled);
      setVectorStyleError(null);
      setExtrusionError(null);
      return;
    }

    setDraftBeforeId(layer.beforeId ?? "");
    setDraftColorExpression(styleValue(layer.style, "extrusionColorExpression"));
    setDraftHeightExpression(styleValue(layer.style, "extrusionHeightExpression"));
    const vectorStyleMode = styleValue(layer.style, "vectorStyleMode");
    setDraftVectorStyleMode(vectorStyleMode);
    setDraftVectorStyleProperty(styleValue(layer.style, "vectorStyleProperty"));
    setDraftVectorStyleClassCount(
      normalizeVectorStyleClassCount(
        vectorStyleMode,
        styleValue(layer.style, "vectorStyleClassCount"),
      ),
    );
    setDraftVectorStyleColorRamp(styleValue(layer.style, "vectorStyleColorRamp"));
    setDraftVectorStyleClassificationScheme(
      normalizeClassificationScheme(
        vectorStyleMode,
        styleValue(layer.style, "vectorStyleClassificationScheme"),
      ),
    );
    setDraftVectorStyleStops(styleValue(layer.style, "vectorStyleStops"));
    setDraftVectorStyleExpression(styleValue(layer.style, "vectorStyleExpression"));
    setDraftExtrusionColor(styleValue(layer.style, "extrusionColor"));
    setDraftExtrusionOpacity(styleValue(layer.style, "extrusionOpacity"));
    setDraftExtrusionHeightProperty(styleValue(layer.style, "extrusionHeightProperty"));
    setDraftExtrusionHeightScale(styleValue(layer.style, "extrusionHeightScale"));
    setDraftExtrusionBase(styleValue(layer.style, "extrusionBase"));
    setDraftAdvancedExtrusionEnabled(styleValue(layer.style, "extrusionAdvancedStyleEnabled"));
    setVectorStyleError(null);
    setExtrusionError(null);
  }, [
    layer?.beforeId,
    layer?.id,
    layer?.style.extrusionAdvancedStyleEnabled,
    layer?.style.extrusionBase,
    layer?.style.extrusionColor,
    layer?.style.extrusionColorExpression,
    layer?.style.extrusionHeightProperty,
    layer?.style.extrusionHeightExpression,
    layer?.style.extrusionHeightScale,
    layer?.style.extrusionOpacity,
    layer?.style.vectorStyleExpression,
    layer?.style.vectorStyleClassCount,
    layer?.style.vectorStyleClassificationScheme,
    layer?.style.vectorStyleColorRamp,
    layer?.style.vectorStyleMode,
    layer?.style.vectorStyleProperty,
    layer?.style.vectorStyleStops,
  ]);

  // Reset the "show basemap layers" advanced toggle back to its clean default
  // whenever a different layer is selected. Keyed on the layer id alone so it
  // does not re-collapse while the user edits other style fields.
  useEffect(() => {
    setShowBasemapStyleLayers(false);
  }, [layer?.id]);

  // Heatmap/cluster apply to point layers in two render paths: core GeoJSON
  // layers (drag-drop, processing results) and Add Vector Layer point layers in
  // the geojson render mode (the maplibre-gl-vector control renders those, so
  // type stays "geojson"; tile-rendered layers become "vector-tiles"). Memoize
  // the point-only scan so a large layer isn't re-scanned on every panel render.
  // Must run before the early returns below so the hook order stays stable.
  const isPointOnly = useMemo(() => (layer ? isPointOnlyGeoJsonLayer(layer) : false), [layer]);
  // Memoized so the per-feature geometry scan (up to 2000 features) does not
  // re-run on every render, e.g. while typing in a rule filter textarea. Kept
  // before the early returns below so the hook order stays stable.
  const geometryFlags = useMemo(
    () => (layer ? getGeometryFlags(layer) : { hasPoint: true, hasLine: true, hasPolygon: true }),
    [layer],
  );
  // Expression Builder inputs, memoized for stable identities: the dialog
  // memoizes its validation/preview/field-type work off these props, so fresh
  // arrays on every panel render would defeat that memoization while the
  // dialog is open (and, combined with the diagnostics console interceptor,
  // could re-render in a loop). Kept before the early returns below so the
  // hook order stays stable.
  const builderFeatures = useMemo(() => layer?.geojson?.features ?? [], [layer]);
  const builderFieldNames = useMemo(() => (layer ? getAttributePropertyNames(layer) : []), [layer]);
  // Zoom and variables snapshot the camera via getState() when the builder
  // opens instead of subscribing: the dialog is modal (the map cannot move
  // while it is open), and mapView subscriptions would re-render this whole
  // panel on every map move even with the builder closed.
  const { zoom: builderZoom, variables: builderVariables } = useMemo<{
    zoom: number;
    variables: ExpressionVariable[];
  }>(() => {
    const { zoom, center } = useAppStore.getState().mapView;
    return {
      zoom,
      variables: standardExpressionVariables({
        projectName,
        layerName: layer?.name ?? "",
        featureCount: builderFeatures.length,
        zoom,
        centerLat: center[1],
      }),
    };
    // expressionBuilderTarget is an intentional dep: it re-snapshots the
    // camera each time the builder opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, layer, builderFeatures, expressionBuilderTarget]);
  // Diagram-loss notices: whether the feature cap truncates the drawable
  // dataset (derived from the real scan — features without an anchor or a
  // positive value don't consume the cap, so the raw count alone would
  // false-positive), and whether the icon atlas drops diagrams that don't fit
  // its height/texture bound (e.g. a large diagram size on many features).
  // Dependencies are the geojson and the specific diagram style fields (not
  // the layer object, which is recreated on every style edit) so unrelated
  // panel edits never re-run the feature scan. Kept before the early returns
  // below so the hook order stays stable.
  const diagramGeojson = layer?.geojson;
  const diagramStyleType = layer ? styleValue(layer.style, "diagramType") : "none";
  const diagramStyleFields = layer
    ? styleValue(layer.style, "diagramFields")
    : DEFAULT_LAYER_STYLE.diagramFields;
  const diagramStyleSizeMode = layer
    ? styleValue(layer.style, "diagramSizeMode")
    : DEFAULT_LAYER_STYLE.diagramSizeMode;
  const diagramStyleSize = layer
    ? styleValue(layer.style, "diagramSize")
    : DEFAULT_LAYER_STYLE.diagramSize;
  const diagramStyleSizeProperty = layer ? styleValue(layer.style, "diagramSizeProperty") : "";
  const { diagramTruncated, diagramDrawnCount, diagramAtlasDropped } = useMemo(() => {
    if (!layer || !diagramGeojson || diagramStyleType === "none") {
      return {
        diagramTruncated: false,
        diagramDrawnCount: 0,
        diagramAtlasDropped: 0,
      };
    }
    // One shared scan feeds both notices; countAtlasDroppedDiagrams reuses it
    // instead of rescanning the features.
    const diagramData = collectDiagramData(diagramGeojson, layer.style);
    return {
      diagramTruncated: diagramData.truncated,
      // The notice reports the count actually charted: truncation can come
      // from either the draw cap or the raw-scan cap, so the drawn count is
      // the only number that is accurate in both cases.
      diagramDrawnCount: diagramData.data.length,
      diagramAtlasDropped: countAtlasDroppedDiagrams(
        { geojson: diagramGeojson, style: layer.style },
        diagramData,
      ),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layer.style is
    // intentionally represented by the specific diagram fields below.
  }, [
    diagramGeojson,
    diagramStyleType,
    diagramStyleFields,
    diagramStyleSizeMode,
    diagramStyleSize,
    diagramStyleSizeProperty,
  ]);
  // Numeric-attribute candidates for the diagram field pickers. Unlike
  // graduated classification (which needs a value spread), one finite value
  // qualifies. Memoized on the geojson/metadata (not the layer object) so
  // unrelated panel edits never re-run the per-property feature scans. Kept
  // before the early returns below so the hook order stays stable.
  const diagramMetadata = layer?.metadata;
  const diagramNumericProperties = useMemo(() => {
    if (!diagramGeojson) return [];
    const probe = { geojson: diagramGeojson, metadata: diagramMetadata ?? {} };
    return getAttributePropertyNames(probe).filter((property) =>
      getPropertyValues(probe, property).some((value) => {
        // Blank strings coerce to 0 via Number(""), which would qualify a
        // text column that merely has an empty cell somewhere; require an
        // actual number or a non-blank numeric string.
        if (typeof value === "number") return Number.isFinite(value);
        return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
      }),
    );
  }, [diagramGeojson, diagramMetadata]);
  // Whether the layer's coordinates carry real Z values (e.g. GPX track
  // elevations), which unlocks the "3D (Z values)" visualization mode.
  // Memoized on the geojson reference (not the layer object, which is
  // recreated on every style edit) because the scan touches every coordinate
  // when no Z is present. Kept before the early returns below so the hook
  // order stays stable.
  const supportsElevation3d = useMemo(
    () =>
      layer?.type === "geojson" && layer.geojson ? geojsonHasZCoordinates(layer.geojson) : false,
    [layer?.type, layer?.geojson],
  );

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("style.resizePanel")}
      className="absolute -start-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-s border-transparent hover:border-primary md:block"
      onPointerDown={onResizeStart}
    />
  );

  if (isCollapsed) {
    // In the shared right-sidebar mode the host renders a single rail listing
    // Style alongside the plugin panel, so the panel shows nothing of its own
    // when collapsed (avoids two adjacent rails).
    if (hideOwnRail) return null;
    return (
      <aside
        aria-label={t("style.panelLabelCollapsed")}
        className="flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-s md:border-t-0 md:py-2"
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t("style.expand")}
          aria-label={t("style.expand")}
          onClick={() => setIsCollapsed(false)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
            {t("sharedRail.style")}
          </span>
        </div>
      </aside>
    );
  }

  if (!layer) {
    return (
      <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-sm font-semibold">{t("style.heading")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("style.collapse")}
            aria-label={t("style.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <p className="p-4 text-xs text-muted-foreground">{t("style.selectLayerHint")}</p>
      </aside>
    );
  }

  const { style } = layer;
  const isDeckRasterLayer =
    layer.metadata.sourceKind === "cog-url" ||
    layer.metadata.sourceKind === "geotiff-url" ||
    layer.metadata.sourceKind === "maplibre-gl-raster" ||
    layer.metadata.sourceKind === "stac-search-cog";
  const isDeckVectorLayer = hasExternalDeckLayer(layer);
  const isRasterTileLayer = layer.metadata.tileType === "raster";
  const isThreeDTilesLayer = layer.type === "3d-tiles";
  const hasVectorPaintControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    !isDeckRasterLayer &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "mbtiles" ||
      hasExternalNativeLayers(layer) ||
      hasExternalDeckLayer(layer));
  const hasExtrusionControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    !isDeckRasterLayer &&
    supportsExtrusionControls(layer);
  const hasRasterPaintControls =
    isRasterPaintLayer(layer.type) || isRasterTileLayer || isDeckRasterLayer;
  const hasTextMarkerControls = layer.type === "geojson" && hasTextMarkerFeatures(layer);
  // isPointOnly is memoized above the early returns to keep hook order stable.
  const isCoreGeoJsonPoint =
    isPointOnly && !hasExternalNativeLayers(layer) && !hasExternalDeckLayer(layer);
  const isVectorControlPoint =
    hasExternalNativeLayers(layer) &&
    !hasExternalDeckLayer(layer) &&
    layer.type === "geojson" &&
    layer.metadata.sourceKind === "maplibre-gl-vector" &&
    layer.metadata.geometryType === "point";
  const supportsPointRenderer = isCoreGeoJsonPoint || isVectorControlPoint;
  // The "Sketches" layer mixes geometry types under one style, so "Circle
  // radius" only applies to its point markers and is misleading otherwise (#483).
  const isSketchLayer = layer.metadata.sourceKind === SKETCHES_SOURCE_KIND;
  const strokeWidthUnit = styleValue(style, "strokeWidthUnit");
  // The unit only affects line/polygon-outline rendering. Point layers always
  // stroke in pixels, so never present meters semantics (label/range/selector)
  // for them, even if a hand-edited project set "meters".
  const strokeWidthInMeters = strokeWidthUnit === "meters" && !supportsPointRenderer;
  const pointRenderer = styleValue(style, "pointRenderer");
  const extrusionEnabled = styleValue(style, "extrusionEnabled");
  const elevation3dEnabled = styleValue(style, "elevation3dEnabled");
  // Effective 3D Z-value mode: the saved flag can outlive the data's Z values
  // (e.g. a processing tool rewrote the geometry), in which case the renderer
  // falls back to 2D — the panel must match so a Visualization radio is
  // always selected and 2D controls stay usable.
  const elevation3dActive = elevation3dEnabled && supportsElevation3d;
  const extrusionHeightPropertyOptions = getAttributePropertyNames(layer);
  const vectorStylePropertyOptions = extrusionHeightPropertyOptions;
  const labels: LabelStyle = {
    ...DEFAULT_LAYER_STYLE.labels,
    ...styleValue(style, "labels"),
  };
  const updateLabels = (patch: Partial<LabelStyle>) =>
    setLayerStyle(layer.id, { labels: { ...labels, ...patch } });
  // The label expression must be a JSON array (a MapLibre expression). Flag a
  // non-empty value that does not round-trip as an array so the user sees that
  // it is ignored (layer-sync falls back to the field / no label) instead of
  // silently producing nothing.
  const labelExpressionInvalid = (() => {
    if (!labels.expression.trim()) return false;
    try {
      return !Array.isArray(JSON.parse(labels.expression));
    } catch {
      return true;
    }
  })();
  const extrusionHeightProperties = extrusionHeightPropertyOptions.includes(
    draftExtrusionHeightProperty,
  )
    ? extrusionHeightPropertyOptions
    : [draftExtrusionHeightProperty, ...extrusionHeightPropertyOptions].filter(Boolean);
  const currentVectorStops = styleValue(style, "vectorStyleStops");
  const vectorStyleSettingsChanged =
    draftVectorStyleMode !== styleValue(style, "vectorStyleMode") ||
    draftVectorStyleProperty !== styleValue(style, "vectorStyleProperty") ||
    draftVectorStyleClassCount !== styleValue(style, "vectorStyleClassCount") ||
    draftVectorStyleColorRamp !== styleValue(style, "vectorStyleColorRamp") ||
    draftVectorStyleClassificationScheme !== styleValue(style, "vectorStyleClassificationScheme") ||
    draftVectorStyleExpression !== styleValue(style, "vectorStyleExpression") ||
    JSON.stringify(draftVectorStyleStops) !== JSON.stringify(currentVectorStops);
  const regenerateDraftVectorStyleStops = (
    mode: VectorStyleMode,
    property: string,
    classCount: number,
    colorRamp: string,
    classificationScheme: string,
  ) => {
    setDraftVectorStyleStops(
      createDefaultStops(layer, mode, property, classCount, colorRamp, classificationScheme),
    );
  };
  const extrusionSettingsChanged =
    draftExtrusionColor !== styleValue(style, "extrusionColor") ||
    draftExtrusionOpacity !== styleValue(style, "extrusionOpacity") ||
    draftExtrusionHeightProperty !== styleValue(style, "extrusionHeightProperty") ||
    draftExtrusionHeightScale !== styleValue(style, "extrusionHeightScale") ||
    draftExtrusionBase !== styleValue(style, "extrusionBase") ||
    draftAdvancedExtrusionEnabled !== styleValue(style, "extrusionAdvancedStyleEnabled") ||
    draftColorExpression !== styleValue(style, "extrusionColorExpression") ||
    draftHeightExpression !== styleValue(style, "extrusionHeightExpression");
  const updateDraftVectorStyleMode = (mode: VectorStyleMode) => {
    setDraftVectorStyleMode(mode);
    setVectorStyleError(null);
    if (mode === "graduated" || mode === "categorized") {
      const classCount = normalizeVectorStyleClassCount(mode, draftVectorStyleClassCount);
      const classificationScheme = normalizeClassificationScheme(
        mode,
        draftVectorStyleClassificationScheme,
      );
      const property = chooseDefaultStyleProperty(
        layer,
        mode,
        vectorStylePropertyOptions,
        draftVectorStyleProperty,
      );
      setDraftVectorStyleProperty(property);
      setDraftVectorStyleClassCount(classCount);
      setDraftVectorStyleClassificationScheme(classificationScheme);
      regenerateDraftVectorStyleStops(
        mode,
        property,
        classCount,
        draftVectorStyleColorRamp,
        classificationScheme,
      );
    }
  };
  const updateDraftVectorStyleProperty = (property: string) => {
    setDraftVectorStyleProperty(property);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      property,
      draftVectorStyleClassCount,
      draftVectorStyleColorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleClassCount = (value: number) => {
    const classCount = normalizeVectorStyleClassCount(draftVectorStyleMode, value);
    setDraftVectorStyleClassCount(classCount);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      classCount,
      draftVectorStyleColorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleColorRamp = (colorRamp: string) => {
    setDraftVectorStyleColorRamp(colorRamp);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      draftVectorStyleClassCount,
      colorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleClassificationScheme = (scheme: string) => {
    const classificationScheme = normalizeClassificationScheme(draftVectorStyleMode, scheme);
    setDraftVectorStyleClassificationScheme(classificationScheme);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      draftVectorStyleClassCount,
      draftVectorStyleColorRamp,
      classificationScheme,
    );
  };
  const updateDraftVectorStyleStop = (index: number, patch: Partial<VectorStyleStop>) => {
    setDraftVectorStyleStops((stops) =>
      stops.map((stop, stopIndex) => (stopIndex === index ? { ...stop, ...patch } : stop)),
    );
  };
  const addDraftVectorStyleStop = () => {
    setDraftVectorStyleStops((stops) => [
      ...stops,
      {
        value: draftVectorStyleMode === "graduated" ? stops.length : "",
        color: nextStopColor(stops.length),
      },
    ]);
  };
  const removeDraftVectorStyleStop = (index: number) => {
    setDraftVectorStyleStops((stops) => stops.filter((_, stopIndex) => stopIndex !== index));
  };
  const applyVectorStyleSettings = () => {
    if (draftVectorStyleMode === "expression") {
      const expressionError = validateExpressionJson(
        draftVectorStyleExpression,
        t("style.expressionLabels.style"),
        t,
      );
      if (expressionError) {
        setVectorStyleError(expressionError);
        return;
      }
    }

    const stops = normalizeVectorStyleStops(draftVectorStyleMode, draftVectorStyleStops);
    if (
      (draftVectorStyleMode === "graduated" || draftVectorStyleMode === "categorized") &&
      !draftVectorStyleProperty
    ) {
      setVectorStyleError(t("style.symbology.errorChooseAttribute"));
      return;
    }
    if (draftVectorStyleMode === "graduated" && stops.length < 2) {
      setVectorStyleError(t("style.symbology.errorGraduatedStops"));
      return;
    }
    if (draftVectorStyleMode === "categorized" && stops.length === 0) {
      setVectorStyleError(t("style.symbology.errorCategorizedStops"));
      return;
    }

    setVectorStyleError(null);
    setLayerStyle(layer.id, {
      vectorStyleMode: draftVectorStyleMode,
      vectorStyleProperty: draftVectorStyleProperty,
      vectorStyleClassCount: draftVectorStyleClassCount,
      vectorStyleColorRamp: draftVectorStyleColorRamp,
      vectorStyleClassificationScheme: draftVectorStyleClassificationScheme,
      vectorStyleStops: stops,
      vectorStyleExpression: draftVectorStyleExpression.trim(),
    });
  };
  const applyBeforeId = (value: string) => {
    // Picking another user layer is a one-shot reorder in the layer list;
    // beforeId metadata only works for raw MapLibre (basemap) layer ids.
    const otherLayers = layers.filter((l) => l.id !== layer.id);
    const targetIndex = otherLayers.findIndex((l) => l.id === value);
    if (targetIndex >= 0) {
      setDraftBeforeId("");
      // Move first so the sync triggered by each store update already sees
      // the correct array position.
      moveLayer(layer.id, targetIndex);
      if (layer.beforeId) updateLayer(layer.id, { beforeId: undefined });
      return;
    }
    setDraftBeforeId(value);
    const nextBeforeId = value.trim() || undefined;
    if (nextBeforeId !== layer.beforeId) {
      updateLayer(layer.id, { beforeId: nextBeforeId });
    }
  };
  const applyExtrusionSettings = () => {
    if (draftAdvancedExtrusionEnabled) {
      const colorError = validateExpressionJson(
        draftColorExpression,
        t("style.expressionLabels.color"),
        t,
      );
      if (colorError) {
        setExtrusionError(colorError);
        return;
      }

      const heightError = validateExpressionJson(
        draftHeightExpression,
        t("style.expressionLabels.height"),
        t,
      );
      if (heightError) {
        setExtrusionError(heightError);
        return;
      }
    }

    setExtrusionError(null);
    setLayerStyle(layer.id, {
      extrusionColor: draftExtrusionColor,
      extrusionOpacity: draftExtrusionOpacity,
      extrusionHeightProperty: draftExtrusionHeightProperty,
      extrusionHeightScale: draftExtrusionHeightScale,
      extrusionBase: draftExtrusionBase,
      extrusionAdvancedStyleEnabled: draftAdvancedExtrusionEnabled,
      extrusionColorExpression: draftColorExpression.trim(),
      extrusionHeightExpression: draftHeightExpression.trim(),
    });
  };
  // NOTE: not reactive to basemap switches — the ref does not trigger a
  // re-render, so the list refreshes on the next store-driven render.
  const basemapStyleLayerIds = mapControllerRef.current?.getBasemapStyleLayerIds() ?? [];
  const otherLayers = layers.filter((l) => l.id !== layer.id);
  // While 3D (Z values) is active the basemap group below is hidden, so a
  // saved basemap target surfaces under "Saved (unavailable)" instead of
  // leaving the select pointing at a missing option.
  const beforeIdHiddenByElevation3d =
    elevation3dActive && basemapStyleLayerIds.includes(draftBeforeId);
  const orphanedBeforeId =
    draftBeforeId &&
    (beforeIdHiddenByElevation3d ||
      (!basemapStyleLayerIds.includes(draftBeforeId) &&
        !otherLayers.some((l) => l.id === draftBeforeId)))
      ? draftBeforeId
      : null;
  // The basemap style exposes dozens of internal layer ids that overwhelm the
  // dropdown for standard users (issue #834). Keep them behind an opt-in
  // "advanced" toggle so the default list only shows the user's own layers —
  // but reveal them automatically if the current value is one of them.
  const valueIsBasemapStyleLayer = basemapStyleLayerIds.includes(draftBeforeId);
  const basemapStyleLayersVisible = showBasemapStyleLayers || valueIsBasemapStyleLayer;
  const beforeIdControl = (
    <div className="space-y-2">
      <Label htmlFor="beforeId">{t("addData.shared.insertBelow")}</Label>
      <Select
        id="beforeId"
        value={draftBeforeId}
        onChange={(event) => applyBeforeId(event.target.value)}
      >
        <option value="">{t("style.layerOrderDefault")}</option>
        {orphanedBeforeId && (
          <optgroup label={t("style.beforeIdSavedUnavailable")}>
            <option value={orphanedBeforeId}>{orphanedBeforeId}</option>
          </optgroup>
        )}
        {otherLayers.length > 0 && (
          <optgroup label={t("addData.shared.layersGroup")}>
            {[...otherLayers].reverse().map((otherLayer) => (
              <option key={otherLayer.id} value={otherLayer.id}>
                {otherLayer.name}
              </option>
            ))}
          </optgroup>
        )}
        {/* The 3D Z-value render (deck.gl overlay) honors store order for
            user layers but has no MapLibre layer to insert below a basemap
            style layer, so hide that group rather than offer a silently
            ignored setting. */}
        {basemapStyleLayerIds.length > 0 && basemapStyleLayersVisible && !elevation3dActive && (
          <optgroup label={t("addData.shared.basemapLayersGroup")}>
            {basemapStyleLayerIds.map((styleLayerId) => (
              <option key={styleLayerId} value={styleLayerId}>
                {styleLayerId}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {basemapStyleLayerIds.length > 0 && !valueIsBasemapStyleLayer && !elevation3dActive && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-controls="beforeId"
            checked={showBasemapStyleLayers}
            onChange={(event) => setShowBasemapStyleLayers(event.target.checked)}
          />
          {t("addData.shared.showBasemapLayers")}
        </label>
      )}
    </div>
  );
  const minZoom = styleValue(style, "minZoom");
  const maxZoom = styleValue(style, "maxZoom");
  const setMinZoom = (value: number) => {
    const next = clamp(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: next,
      maxZoom: Math.max(next, maxZoom),
    });
  };
  const setMaxZoom = (value: number) => {
    const next = clamp(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: Math.min(next, minZoom),
      maxZoom: next,
    });
  };
  const zoomRangeControls = (
    <div className="grid grid-cols-2 gap-3">
      <NumericStyleInput
        id={`${layer.id}-minZoom`}
        label={t("style.visibility.minZoom")}
        tooltip={t("style.visibility.minZoomTooltip")}
        min={MIN_LAYER_ZOOM}
        max={maxZoom}
        step={1}
        value={minZoom}
        onChange={setMinZoom}
      />
      <NumericStyleInput
        id={`${layer.id}-maxZoom`}
        label={t("style.visibility.maxZoom")}
        tooltip={t("style.visibility.maxZoomTooltip")}
        min={minZoom}
        max={MAX_LAYER_ZOOM}
        step={1}
        value={maxZoom}
        onChange={setMaxZoom}
      />
    </div>
  );
  const usesAttributeSymbology =
    draftVectorStyleMode === "graduated" || draftVectorStyleMode === "categorized";
  const vectorClassificationSchemeOptions =
    draftVectorStyleMode === "categorized"
      ? CATEGORIZED_CLASSIFICATION_SCHEMES
      : GRADUATED_CLASSIFICATION_SCHEMES;
  const vectorClassCountOptions = VECTOR_STYLE_CLASS_COUNTS.filter((classCount) =>
    draftVectorStyleMode === "categorized" ? true : classCount >= 2,
  );

  // --- Rule-based renderer (immediate writes to style.vectorRules) ---
  const currentRules = styleValue(style, "vectorRules");
  const concreteRules = currentRules.filter((rule) => !rule.isElse);
  const ruleRows = ruleTreeRows(currentRules);
  const elseRule = currentRules.find((rule) => rule.isElse) ?? null;
  const setVectorRules = (rules: VectorRule[]) => setLayerStyle(layer.id, { vectorRules: rules });
  const updateVectorRule = (id: string, patch: Partial<VectorRule>) =>
    setVectorRules(currentRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const addChildVectorRule = (parentId: string) => {
    const child = {
      ...createVectorRule(false, nextStopColor(concreteRules.length)),
      parentId,
    };
    // Insert after the parent's whole subtree so the child lands last among
    // its siblings in the tree walk and the else rule stays at the end.
    const subtree = ruleSubtreeIds(currentRules, parentId);
    let insertAt = currentRules.length;
    for (let index = 0; index < currentRules.length; index += 1) {
      if (subtree.has(currentRules[index].id)) insertAt = index + 1;
    }
    const next = [...currentRules];
    next.splice(insertAt, 0, child);
    setVectorRules(next);
  };
  const addVectorRule = () => {
    const next = createVectorRule(false, nextStopColor(concreteRules.length));
    // Keep the catch-all else rule last so it reads as the fallback.
    setVectorRules(elseRule ? [...concreteRules, next, elseRule] : [...concreteRules, next]);
  };
  const removeVectorRule = (id: string) => {
    // Removing a group removes its whole subtree; orphaned children would
    // otherwise silently become top-level rules and change what draws.
    const doomed = ruleSubtreeIds(currentRules, id);
    setVectorRules(currentRules.filter((rule) => !doomed.has(rule.id)));
  };
  const setElseRuleColor = (color: string) => {
    if (elseRule) {
      updateVectorRule(elseRule.id, { color });
      return;
    }
    setVectorRules([...currentRules, createVectorRule(true, color)]);
  };
  const setElseRuleEnabled = (enabled: boolean) => {
    if (elseRule) {
      updateVectorRule(elseRule.id, { enabled: enabled ? undefined : false });
      return;
    }
    // No else record yet (its absence means enabled): unchecking materializes
    // a disabled one, which is what hides features matching no rule.
    if (!enabled) {
      setVectorRules([
        ...currentRules,
        { ...createVectorRule(true, style.fillColor), enabled: false },
      ]);
    }
  };

  // --- Shared Expression Builder (GH #1306) ---
  // builderFeatures / builderFieldNames / builderVariables are memoized above
  // the early returns so the dialog's props keep stable identities.
  const builderRule =
    expressionBuilderTarget?.kind === "rule"
      ? currentRules.find((rule) => rule.id === expressionBuilderTarget.ruleId)
      : undefined;
  const builderInitialExpression =
    expressionBuilderTarget?.kind === "rule"
      ? (builderRule?.filter ?? "")
      : expressionBuilderTarget?.kind === "style"
        ? draftVectorStyleExpression
        : expressionBuilderTarget?.kind === "labelOverride"
          ? labels[expressionBuilderTarget.property.field] || ""
          : labels.expression;
  const builderTargetLabel =
    expressionBuilderTarget?.kind === "rule"
      ? t("style.symbology.ruleFilter", { index: expressionBuilderTarget.index })
      : expressionBuilderTarget?.kind === "style"
        ? t("style.symbology.colorExpression")
        : expressionBuilderTarget?.kind === "labelOverride"
          ? t(`style.labels.dataDefined.${expressionBuilderTarget.property.key}Target`)
          : t("style.labels.expression");
  const applyBuilderExpression = (expression: string) => {
    if (!expressionBuilderTarget) return;
    // Never write through to a different layer than the builder was opened
    // for (the selection-change effect closes the dialog, this is the guard
    // against applying across a race).
    if (expressionBuilderTarget.layerId !== layer.id) return;
    if (expressionBuilderTarget.kind === "rule") {
      updateVectorRule(expressionBuilderTarget.ruleId, { filter: expression });
    } else if (expressionBuilderTarget.kind === "style") {
      setDraftVectorStyleExpression(expression);
      setVectorStyleError(null);
    } else if (expressionBuilderTarget.kind === "labelOverride") {
      updateLabels({
        [expressionBuilderTarget.property.field]: expression,
      } as Partial<LabelStyle>);
    } else {
      updateLabels({ expression });
    }
  };
  // Only mounted while open: the dialog memoizes validation/preview work off
  // props that this panel recreates each render, so keeping it mounted would
  // rescan the layer's features on every unrelated panel re-render.
  const expressionBuilderDialog = expressionBuilderTarget ? (
    <ExpressionBuilderDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setExpressionBuilderTarget(null);
      }}
      targetLabel={builderTargetLabel}
      context={
        expressionBuilderTarget.kind === "rule"
          ? "filter"
          : expressionBuilderTarget.kind === "style"
            ? "color"
            : expressionBuilderTarget.kind === "labelOverride"
              ? expressionBuilderTarget.property.context
              : "value"
      }
      initialExpression={builderInitialExpression}
      features={builderFeatures}
      fieldNames={builderFieldNames}
      zoom={builderZoom}
      variables={builderVariables}
      onApply={applyBuilderExpression}
    />
  ) : null;

  // --- Geometry-gated sections (proportional size, fill pattern, markers) ---
  // geometryFlags is memoized above the early returns.
  const showProportionalControls =
    hasVectorPaintControls &&
    pointRenderer !== "heatmap" &&
    // Proportional sizing drives circle-radius, marker icon-size (the
    // interpolate scales the baked sprite, see markerIconSizeValue in
    // @geolibre/map), and line-width, so it applies to any single-renderer
    // point layer (with or without a marker icon) and to layers that carry
    // lines.
    ((geometryFlags.hasPoint && pointRenderer === "single") || geometryFlags.hasLine);
  const showFillPatternControls =
    hasVectorPaintControls && !extrusionEnabled && geometryFlags.hasPolygon;
  const showMarkerControls =
    hasVectorPaintControls && supportsPointRenderer && pointRenderer === "single";
  // The symbology-pack renders (inverted mask, line decorations, geometry
  // generator) are drawn by the core GeoJSON render path
  // (applyVectorDataRenderLayers), so they don't apply to vector tiles,
  // external deck layers, or control-painted (external native) layers — hide
  // the controls there rather than offer a silent no-op.
  const supportsDerivedGeometry =
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    !hasExternalNativeLayers(layer);
  const showLineDecorationControls =
    hasVectorPaintControls &&
    !extrusionEnabled &&
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    !hasExternalNativeLayers(layer) &&
    (geometryFlags.hasLine || geometryFlags.hasPolygon);
  const showGeneratorControls =
    hasVectorPaintControls && !extrusionEnabled && supportsDerivedGeometry;

  const proportionalEnabled = styleValue(style, "proportionalSizeEnabled");
  const proportionalProperty = styleValue(style, "proportionalSizeProperty");
  const proportionalMinValue = styleValue(style, "proportionalSizeMinValue");
  const proportionalMaxValue = styleValue(style, "proportionalSizeMaxValue");
  const proportionalMinRadius = styleValue(style, "proportionalSizeMinRadius");
  const proportionalMaxRadius = styleValue(style, "proportionalSizeMaxRadius");
  // A small graduated-size legend: evenly spaced sample values mapped onto the
  // interpolated radius range, mirroring what the map renders.
  const proportionalLegend =
    proportionalEnabled &&
    proportionalMaxValue > proportionalMinValue &&
    proportionalMinRadius <= proportionalMaxRadius
      ? Array.from({ length: 5 }, (_, index) => {
          const ratio = index / 4;
          return {
            value: proportionalMinValue + ratio * (proportionalMaxValue - proportionalMinValue),
            radius: proportionalMinRadius + ratio * (proportionalMaxRadius - proportionalMinRadius),
          };
        })
      : [];

  const fillPattern = styleValue(style, "fillPattern");
  const markerEnabled = styleValue(style, "markerEnabled");
  const markerShape = styleValue(style, "markerShape");

  const vectorSymbologyControls = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="vectorStyleMode">{t("style.symbology.styleType")}</Label>
        <Select
          id="vectorStyleMode"
          value={draftVectorStyleMode}
          onChange={(event) => updateDraftVectorStyleMode(event.target.value as VectorStyleMode)}
        >
          <option value="single">{t("style.symbology.modeSingle")}</option>
          <option value="graduated">{t("style.symbology.modeGraduated")}</option>
          <option value="categorized">{t("style.symbology.modeCategorized")}</option>
          <option value="rule-based">{t("style.symbology.modeRuleBased")}</option>
          <option value="expression">{t("style.symbology.modeExpression")}</option>
        </Select>
      </div>
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleProperty">{t("style.symbology.attribute")}</Label>
          <Select
            id="vectorStyleProperty"
            value={draftVectorStyleProperty}
            onChange={(event) => updateDraftVectorStyleProperty(event.target.value)}
            disabled={vectorStylePropertyOptions.length === 0}
          >
            {vectorStylePropertyOptions.length === 0 ? (
              <option value="">{t("style.labels.noAttributes")}</option>
            ) : (
              vectorStylePropertyOptions.map((property) => (
                <option key={property} value={property}>
                  {property}
                </option>
              ))
            )}
          </Select>
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vectorStyleClassCount">{t("style.symbology.classes")}</Label>
            <Select
              id="vectorStyleClassCount"
              value={String(draftVectorStyleClassCount)}
              onChange={(event) => updateDraftVectorStyleClassCount(Number(event.target.value))}
            >
              {vectorClassCountOptions.map((classCount) => (
                <option key={classCount} value={classCount}>
                  {classCount}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vectorStyleClassificationScheme">{t("style.symbology.scheme")}</Label>
            <Select
              id="vectorStyleClassificationScheme"
              value={draftVectorStyleClassificationScheme}
              onChange={(event) => updateDraftVectorStyleClassificationScheme(event.target.value)}
            >
              {vectorClassificationSchemeOptions.map((scheme) => (
                <option key={scheme.value} value={scheme.value}>
                  {t(scheme.labelKey)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleColorRamp">{t("style.symbology.colormap")}</Label>
          <ColorRampSelect
            id="vectorStyleColorRamp"
            aria-label={t("style.symbology.colormap")}
            value={draftVectorStyleColorRamp}
            onValueChange={updateDraftVectorStyleColorRamp}
            ramps={VECTOR_COLOR_RAMPS}
          />
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>
              {draftVectorStyleMode === "graduated"
                ? t("style.symbology.stops")
                : t("style.symbology.categories")}
            </Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("style.addClass")}
              aria-label={t("style.addClass")}
              onClick={addDraftVectorStyleStop}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="space-y-2">
            {draftVectorStyleStops.map((stop, index) => (
              <div key={index} className="grid grid-cols-[auto_1fr_2rem] items-center gap-2">
                <ColorField
                  fill={false}
                  aria-label={t("style.symbology.classColor", {
                    index: index + 1,
                  })}
                  eyedropperLabel={t("style.symbology.classColorPick", {
                    index: index + 1,
                  })}
                  className="h-9 w-9 p-1"
                  buttonClassName="h-9 w-9"
                  value={stop.color}
                  onChange={(color) =>
                    updateDraftVectorStyleStop(index, {
                      color,
                    })
                  }
                />
                <StopValueInput
                  index={index}
                  isNumeric={draftVectorStyleMode === "graduated"}
                  value={stop.value}
                  onChange={(value) =>
                    updateDraftVectorStyleStop(index, {
                      value,
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t("style.removeClass")}
                  aria-label={t("style.removeClass")}
                  onClick={() => removeDraftVectorStyleStop(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {draftVectorStyleMode === "expression" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vectorStyleExpression">{t("style.symbology.colorExpression")}</Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("style.expressionBuilder.openBuilder")}
              aria-label={t("style.expressionBuilder.openBuilder")}
              onClick={() => setExpressionBuilderTarget({ kind: "style", layerId: layer.id })}
            >
              <SquareFunction className="h-3.5 w-3.5" />
            </Button>
          </div>
          <textarea
            id="vectorStyleExpression"
            className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            placeholder='["match", ["get", "CONTINENT"], "Asia", "#2563eb", "#94a3b8"]'
            value={draftVectorStyleExpression}
            onChange={(event) => {
              setDraftVectorStyleExpression(event.target.value);
              setVectorStyleError(null);
            }}
          />
        </div>
      )}
      {draftVectorStyleMode === "rule-based" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("style.symbology.rules")}</Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("style.symbology.addRule")}
              aria-label={t("style.symbology.addRule")}
              onClick={addVectorRule}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          {concreteRules.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("style.symbology.noRulesPrefix")}
              <code>{'["==", ["get", "TYPE"], "park"]'}</code>
              {t("style.symbology.noRulesSuffix")}
            </p>
          ) : null}
          {ruleRows.map(({ rule, depth, isGroup }, index) => (
            <div
              key={rule.id}
              className="space-y-2 rounded-md border border-input p-2"
              style={depth > 0 ? { marginInlineStart: `${Math.min(depth, 4) * 12}px` } : undefined}
            >
              <div className="grid grid-cols-[auto_auto_1fr_2rem_2rem] items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.enabled !== false}
                  title={t("style.symbology.ruleEnabled", {
                    index: index + 1,
                  })}
                  aria-label={t("style.symbology.ruleEnabled", {
                    index: index + 1,
                  })}
                  onChange={(event) =>
                    updateVectorRule(rule.id, {
                      enabled: event.target.checked ? undefined : false,
                    })
                  }
                />
                <ColorField
                  fill={false}
                  aria-label={t("style.symbology.ruleColor", {
                    index: index + 1,
                  })}
                  eyedropperLabel={t("style.symbology.ruleColorPick", {
                    index: index + 1,
                  })}
                  className="h-9 w-9 p-1"
                  buttonClassName="h-9 w-9"
                  value={rule.color}
                  onChange={(color) => updateVectorRule(rule.id, { color })}
                />
                <Input
                  aria-label={t("style.symbology.ruleLabel", {
                    index: index + 1,
                  })}
                  placeholder={t("style.symbology.labelPlaceholder")}
                  value={rule.label}
                  onChange={(event) => updateVectorRule(rule.id, { label: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t("style.symbology.ruleAddChild")}
                  aria-label={t("style.symbology.ruleAddChild")}
                  onClick={() => addChildVectorRule(rule.id)}
                >
                  <CornerDownRight className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t("style.symbology.removeRule")}
                  aria-label={t("style.symbology.removeRule")}
                  onClick={() => removeVectorRule(rule.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex items-start gap-1">
                <textarea
                  aria-label={t("style.symbology.ruleFilter", {
                    index: index + 1,
                  })}
                  className="min-h-16 w-full flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
                  placeholder='["==", ["get", "TYPE"], "park"]'
                  value={rule.filter}
                  onChange={(event) => updateVectorRule(rule.id, { filter: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title={t("style.expressionBuilder.openBuilderForRule", {
                    index: index + 1,
                  })}
                  aria-label={t("style.expressionBuilder.openBuilderForRule", {
                    index: index + 1,
                  })}
                  onClick={() =>
                    setExpressionBuilderTarget({
                      kind: "rule",
                      ruleId: rule.id,
                      index: index + 1,
                      layerId: layer.id,
                    })
                  }
                >
                  <SquareFunction className="h-3.5 w-3.5" />
                </Button>
              </div>
              {rule.filter.trim() && !parseJsonExpression(rule.filter) ? (
                <p className="text-xs text-destructive">{t("style.symbology.filterInvalid")}</p>
              ) : null}
              {isGroup ? (
                <p className="text-xs text-muted-foreground">
                  {t("style.symbology.ruleGroupNote")}
                </p>
              ) : null}
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  {t("style.symbology.ruleOptions")}
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <RuleNumberInput
                      label={t("style.symbology.ruleMinZoom")}
                      value={rule.minZoom}
                      min={0}
                      max={24}
                      step={1}
                      placeholder={t("style.symbology.ruleInherit")}
                      onChange={(minZoom) => updateVectorRule(rule.id, { minZoom })}
                    />
                    <RuleNumberInput
                      label={t("style.symbology.ruleMaxZoom")}
                      value={rule.maxZoom}
                      min={0}
                      max={24}
                      step={1}
                      placeholder={t("style.symbology.ruleInherit")}
                      onChange={(maxZoom) => updateVectorRule(rule.id, { maxZoom })}
                    />
                  </div>
                  {(() => {
                    // Warn on the effective (ancestor-intersected) range, not
                    // just the rule's own fields: a child's individually valid
                    // range can still be emptied by a parent's narrower one.
                    const effective = effectiveRuleZoomRange(currentRules, rule);
                    return effective.minZoom !== undefined &&
                      effective.maxZoom !== undefined &&
                      effective.minZoom >= effective.maxZoom ? (
                      <p className="text-xs text-destructive">
                        {t("style.symbology.ruleZoomInvalid")}
                      </p>
                    ) : null;
                  })()}
                  {!isGroup ? (
                    <>
                      <div className="grid grid-cols-3 gap-2">
                        {strokeWidthUnit !== "meters" ? (
                          // Per-rule pixel widths do not apply in meters mode
                          // (the meters width is a zoom interpolation MapLibre
                          // cannot nest inside a per-rule case), so hide the
                          // field rather than accept a silent no-op.
                          <RuleNumberInput
                            label={t("style.symbology.ruleStrokeWidth")}
                            value={rule.strokeWidth}
                            min={0}
                            step={0.5}
                            placeholder={t("style.symbology.ruleInherit")}
                            onChange={(strokeWidth) => updateVectorRule(rule.id, { strokeWidth })}
                          />
                        ) : null}
                        <RuleNumberInput
                          label={t("style.symbology.ruleFillOpacity")}
                          value={rule.fillOpacity}
                          min={0}
                          max={1}
                          step={0.1}
                          placeholder={t("style.symbology.ruleInherit")}
                          onChange={(fillOpacity) => updateVectorRule(rule.id, { fillOpacity })}
                        />
                        {!markerEnabled ? (
                          <RuleNumberInput
                            label={t("style.symbology.ruleCircleSize")}
                            value={rule.circleRadius}
                            min={0}
                            step={1}
                            placeholder={t("style.symbology.ruleInherit")}
                            onChange={(circleRadius) => updateVectorRule(rule.id, { circleRadius })}
                          />
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={rule.strokeColor !== undefined}
                            onChange={(event) =>
                              updateVectorRule(rule.id, {
                                strokeColor: event.target.checked
                                  ? styleValue(style, "strokeColor")
                                  : undefined,
                              })
                            }
                          />
                          {t("style.symbology.ruleOutlineColor")}
                        </label>
                        {rule.strokeColor !== undefined ? (
                          <ColorField
                            fill={false}
                            aria-label={t("style.symbology.ruleOutlineColor")}
                            eyedropperLabel={t("style.symbology.ruleOutlineColorPick", {
                              index: index + 1,
                            })}
                            className="h-8 w-8 p-1"
                            buttonClassName="h-8 w-8"
                            value={rule.strokeColor}
                            onChange={(strokeColor) => updateVectorRule(rule.id, { strokeColor })}
                          />
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
              </details>
            </div>
          ))}
          <div className="grid grid-cols-[auto_auto_1fr] items-center gap-2 rounded-md border border-dashed border-input p-2">
            {/* No else record yet means enabled; unchecking materializes a
                disabled record so features matching no rule are hidden
                (QGIS-style), not painted with the base style. */}
            <input
              type="checkbox"
              checked={elseRule ? elseRule.enabled !== false : true}
              title={t("style.symbology.elseRuleEnabled")}
              aria-label={t("style.symbology.elseRuleEnabled")}
              onChange={(event) => setElseRuleEnabled(event.target.checked)}
            />
            <ColorField
              fill={false}
              aria-label={t("style.symbology.elseRuleColor")}
              eyedropperLabel={t("style.symbology.elseRuleColorPick")}
              className="h-9 w-9 p-1"
              buttonClassName="h-9 w-9"
              value={elseRule?.color ?? style.fillColor}
              onChange={setElseRuleColor}
            />
            <span className="text-xs text-muted-foreground">
              {t("style.symbology.elseAllOtherFeatures")}
            </span>
          </div>
        </div>
      )}
      {/* With rule-based already active, rule edits write straight to the
          store and render live, so the Apply button would never enable again —
          a permanently disabled button reads as "your edits are not applied".
          Replace it with a hint saying edits are live; the button returns as
          soon as the user drafts a different style type. */}
      {draftVectorStyleMode === "rule-based" &&
      draftVectorStyleMode === styleValue(style, "vectorStyleMode") ? (
        <p className="text-xs text-muted-foreground">{t("style.symbology.rulesApplyLive")}</p>
      ) : (
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={!vectorStyleSettingsChanged}
          onClick={applyVectorStyleSettings}
        >
          {t("style.symbology.applyStyleType")}
        </Button>
      )}
      {draftVectorStyleMode === "rule-based" &&
        draftVectorStyleMode !== styleValue(style, "vectorStyleMode") && (
          <p className="text-xs text-muted-foreground">{t("style.symbology.applyHint")}</p>
        )}
      {vectorStyleError && <p className="text-xs text-destructive">{vectorStyleError}</p>}
    </div>
  );
  const proportionalSizeControls = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="proportionalSizeEnabled">{t("style.symbology.proportionalSize")}</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            id="proportionalSizeEnabled"
            type="checkbox"
            checked={proportionalEnabled}
            onChange={(event) =>
              setLayerStyle(layer.id, {
                proportionalSizeEnabled: event.target.checked,
              })
            }
          />
          {t("style.symbology.sizeByValue")}
        </label>
      </div>
      {proportionalEnabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor="proportionalSizeProperty">{t("style.symbology.sizeField")}</Label>
            <Select
              id="proportionalSizeProperty"
              value={proportionalProperty}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  proportionalSizeProperty: event.target.value,
                })
              }
              disabled={vectorStylePropertyOptions.length === 0}
            >
              {vectorStylePropertyOptions.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                <>
                  <option value="">{t("style.symbology.chooseField")}</option>
                  {vectorStylePropertyOptions.map((property) => (
                    <option key={property} value={property}>
                      {property}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="proportionalSizeMinValue"
              label={t("style.symbology.minValue")}
              min={-1_000_000_000}
              max={1_000_000_000}
              step={1}
              value={proportionalMinValue}
              onChange={(proportionalSizeMinValue) =>
                setLayerStyle(layer.id, { proportionalSizeMinValue })
              }
            />
            <NumericStyleInput
              id="proportionalSizeMaxValue"
              label={t("style.symbology.maxValue")}
              min={-1_000_000_000}
              max={1_000_000_000}
              step={1}
              value={proportionalMaxValue}
              onChange={(proportionalSizeMaxValue) =>
                setLayerStyle(layer.id, { proportionalSizeMaxValue })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="proportionalSizeMinRadius"
              label={t("style.symbology.minSize")}
              min={0}
              max={100}
              step={1}
              value={proportionalMinRadius}
              onChange={(proportionalSizeMinRadius) =>
                setLayerStyle(layer.id, { proportionalSizeMinRadius })
              }
            />
            <NumericStyleInput
              id="proportionalSizeMaxRadius"
              label={t("style.symbology.maxSize")}
              min={0}
              max={100}
              step={1}
              value={proportionalMaxRadius}
              onChange={(proportionalSizeMaxRadius) =>
                setLayerStyle(layer.id, { proportionalSizeMaxRadius })
              }
            />
          </div>
          {proportionalLegend.length > 0 && proportionalProperty ? (
            <div className="space-y-1">
              <Label>{t("style.symbology.sizeLegend")}</Label>
              <div className="flex items-end justify-between gap-2 rounded-md border border-input p-3">
                {proportionalLegend.map((entry, index) => (
                  <div key={index} className="flex flex-col items-center gap-1">
                    <span
                      aria-hidden="true"
                      className="rounded-full bg-primary/70"
                      style={{
                        width: entry.radius * 2,
                        height: entry.radius * 2,
                      }}
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {entry.value.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
  const fillPatternControls = (
    <div className="space-y-3">
      {supportsDerivedGeometry && (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="invertedFillEnabled">{t("style.symbology.invertedFill")}</Label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              id="invertedFillEnabled"
              type="checkbox"
              checked={styleValue(style, "invertedFillEnabled")}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  invertedFillEnabled: event.target.checked,
                })
              }
            />
            {t("style.symbology.invertedFillHint")}
          </label>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="fillPattern">{t("style.symbology.fillPattern")}</Label>
        <Select
          id="fillPattern"
          value={fillPattern}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              fillPattern: event.target.value as FillPattern,
            })
          }
        >
          {FILL_PATTERN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </Select>
      </div>
      {fillPattern !== "none" && fillPattern !== "svg" ? (
        <div className="space-y-2">
          <Label htmlFor="fillPatternColor">{t("style.symbology.patternColor")}</Label>
          <ColorField
            id="fillPatternColor"
            value={styleValue(style, "fillPatternColor")}
            onChange={(fillPatternColor) => setLayerStyle(layer.id, { fillPatternColor })}
          />
        </div>
      ) : null}
      {fillPattern === "svg" ? (
        <div className="space-y-2">
          <Label htmlFor="fillPatternSvg">{t("style.symbology.patternSvg")}</Label>
          <textarea
            id="fillPatternSvg"
            className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            placeholder={t("style.symbology.svgPlaceholder")}
            value={styleValue(style, "fillPatternSvg")}
            onChange={(event) => setLayerStyle(layer.id, { fillPatternSvg: event.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
  const markerControls = (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="markerEnabled">{t("style.symbology.marker")}</Label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            id="markerEnabled"
            type="checkbox"
            checked={markerEnabled}
            onChange={(event) => setLayerStyle(layer.id, { markerEnabled: event.target.checked })}
          />
          {t("style.symbology.useMarkerIcon")}
        </label>
      </div>
      {markerEnabled && (
        <>
          <div className="space-y-2">
            <Label>{t("style.symbology.markerShape")}</Label>
            <div className="grid grid-cols-4 gap-2">
              {MARKER_SHAPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={t(option.labelKey)}
                  aria-label={t(option.labelKey)}
                  aria-pressed={markerShape === option.value}
                  onClick={() => setLayerStyle(layer.id, { markerShape: option.value })}
                  className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-md border text-[9px] ${
                    markerShape === option.value
                      ? "border-primary ring-1 ring-primary"
                      : "border-input hover:border-primary/50"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="text-base leading-none"
                    style={{
                      color:
                        option.value === "custom" ? undefined : styleValue(style, "markerColor"),
                    }}
                  >
                    {MARKER_GLYPHS[option.value]}
                  </span>
                  <span className="truncate">{t(option.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>
          {markerShape !== "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="markerColor">{t("style.symbology.markerColor")}</Label>
              <ColorField
                id="markerColor"
                value={styleValue(style, "markerColor")}
                onChange={(markerColor) => setLayerStyle(layer.id, { markerColor })}
              />
            </div>
          ) : null}
          <NumericStyleInput
            id="markerSize"
            label={t("style.symbology.markerSize")}
            min={6}
            max={96}
            step={1}
            value={styleValue(style, "markerSize")}
            onChange={(markerSize) => setLayerStyle(layer.id, { markerSize })}
          />
          {markerShape === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="markerSvg">{t("style.symbology.markerSvg")}</Label>
              <textarea
                id="markerSvg"
                className="min-h-20 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
                placeholder={t("style.symbology.svgPlaceholder")}
                value={styleValue(style, "markerSvg")}
                onChange={(event) => setLayerStyle(layer.id, { markerSvg: event.target.value })}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
  // --- Line decorations (repeated arrow/marker symbols along lines) ---
  const lineDecoration = styleValue(style, "lineDecoration");
  const lineDecorationControls = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="lineDecoration">{t("style.decorations.heading")}</Label>
        <Select
          id="lineDecoration"
          value={lineDecoration}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              lineDecoration: event.target.value as LineDecoration,
            })
          }
        >
          <option value="none">{t("style.decorations.typeNone")}</option>
          <option value="arrow">{t("style.decorations.typeArrow")}</option>
          <option value="triangle">{t("style.decorations.typeTriangle")}</option>
          <option value="circle">{t("style.decorations.typeCircle")}</option>
          <option value="square">{t("style.decorations.typeSquare")}</option>
        </Select>
      </div>
      {lineDecoration !== "none" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="lineDecorationColor">{t("style.decorations.color")}</Label>
            <ColorField
              id="lineDecorationColor"
              value={styleValue(style, "lineDecorationColor") || styleValue(style, "strokeColor")}
              onChange={(lineDecorationColor) => setLayerStyle(layer.id, { lineDecorationColor })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="lineDecorationSize"
              label={t("style.decorations.size")}
              min={4}
              max={64}
              step={1}
              value={styleValue(style, "lineDecorationSize")}
              onChange={(lineDecorationSize) => setLayerStyle(layer.id, { lineDecorationSize })}
            />
            <NumericStyleInput
              id="lineDecorationSpacing"
              label={t("style.decorations.spacing")}
              min={10}
              max={500}
              step={5}
              value={styleValue(style, "lineDecorationSpacing")}
              onChange={(lineDecorationSpacing) =>
                setLayerStyle(layer.id, { lineDecorationSpacing })
              }
            />
          </div>
        </>
      )}
    </div>
  );
  // --- Geometry generator (per-feature derived geometry symbology) ---
  const generatorType = styleValue(style, "geometryGenerator");
  const generatorControls = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="geometryGenerator">{t("style.generator.type")}</Label>
        <Select
          id="geometryGenerator"
          value={generatorType}
          onChange={(event) =>
            setLayerStyle(layer.id, {
              geometryGenerator: event.target.value as GeometryGeneratorType,
            })
          }
        >
          <option value="none">{t("style.generator.typeNone")}</option>
          <option value="centroid">{t("style.generator.typeCentroid")}</option>
          <option value="bounding-box">{t("style.generator.typeBoundingBox")}</option>
          <option value="convex-hull">{t("style.generator.typeConvexHull")}</option>
          <option value="buffer">{t("style.generator.typeBuffer")}</option>
        </Select>
      </div>
      {generatorType !== "none" && (
        <>
          {generatorType === "buffer" && (
            <NumericStyleInput
              id="geometryGeneratorBufferDistance"
              label={t("style.generator.bufferDistance")}
              min={-100000}
              max={1000000}
              step={10}
              value={styleValue(style, "geometryGeneratorBufferDistance")}
              onChange={(geometryGeneratorBufferDistance) =>
                setLayerStyle(layer.id, { geometryGeneratorBufferDistance })
              }
            />
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="geometryGeneratorFillColor">{t("style.generator.fillColor")}</Label>
              <ColorField
                id="geometryGeneratorFillColor"
                value={styleValue(style, "geometryGeneratorFillColor")}
                onChange={(geometryGeneratorFillColor) =>
                  setLayerStyle(layer.id, { geometryGeneratorFillColor })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="geometryGeneratorStrokeColor">
                {t("style.generator.strokeColor")}
              </Label>
              <ColorField
                id="geometryGeneratorStrokeColor"
                value={styleValue(style, "geometryGeneratorStrokeColor")}
                onChange={(geometryGeneratorStrokeColor) =>
                  setLayerStyle(layer.id, { geometryGeneratorStrokeColor })
                }
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="geometryGeneratorStrokeWidth"
              label={t("style.generator.strokeWidth")}
              min={0}
              max={20}
              step={0.5}
              value={styleValue(style, "geometryGeneratorStrokeWidth")}
              onChange={(geometryGeneratorStrokeWidth) =>
                setLayerStyle(layer.id, { geometryGeneratorStrokeWidth })
              }
            />
            <NumericStyleInput
              id="geometryGeneratorOpacity"
              label={t("style.generator.opacity")}
              min={0}
              max={1}
              step={0.05}
              value={styleValue(style, "geometryGeneratorOpacity")}
              onChange={(geometryGeneratorOpacity) =>
                setLayerStyle(layer.id, { geometryGeneratorOpacity })
              }
            />
          </div>
          {generatorType === "centroid" && (
            <NumericStyleInput
              id="geometryGeneratorCircleRadius"
              label={t("style.generator.circleRadius")}
              min={1}
              max={40}
              step={1}
              value={styleValue(style, "geometryGeneratorCircleRadius")}
              onChange={(geometryGeneratorCircleRadius) =>
                setLayerStyle(layer.id, { geometryGeneratorCircleRadius })
              }
            />
          )}
        </>
      )}
    </div>
  );
  // --- Diagram symbology (per-feature pie/bar charts, immediate writes) ---
  // The numeric-attribute candidates (diagramNumericProperties) are memoized
  // above the early returns.
  const diagramType = styleValue(style, "diagramType");
  const diagramFields = styleValue(style, "diagramFields");
  const diagramSizeMode = styleValue(style, "diagramSizeMode");
  const setDiagramFields = (fields: DiagramField[]) =>
    setLayerStyle(layer.id, { diagramFields: fields });
  const addDiagramField = () => {
    const used = new Set(diagramFields.map((field) => field.property));
    const property = diagramNumericProperties.find((candidate) => !used.has(candidate)) ?? "";
    setDiagramFields([...diagramFields, { property, color: nextStopColor(diagramFields.length) }]);
  };
  const updateDiagramField = (index: number, patch: Partial<DiagramField>) =>
    setDiagramFields(
      diagramFields.map((field, i) => (i === index ? { ...field, ...patch } : field)),
    );
  const removeDiagramField = (index: number) =>
    setDiagramFields(diagramFields.filter((_, i) => i !== index));
  const showDiagramControls =
    hasVectorPaintControls &&
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    (!supportsPointRenderer || pointRenderer === "single") &&
    (diagramNumericProperties.length > 0 || diagramFields.length > 0);

  const diagramControls = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="diagramType">{t("style.diagrams.chartType")}</Label>
        <Select
          id="diagramType"
          value={diagramType}
          onChange={(event) => {
            const nextType = event.target.value as DiagramType;
            // Seed the field list on first enable so a chart appears without
            // hunting for the add button.
            setLayerStyle(layer.id, { diagramType: nextType });
            if (
              nextType !== "none" &&
              diagramFields.length === 0 &&
              diagramNumericProperties.length > 0
            ) {
              setDiagramFields(
                diagramNumericProperties.slice(0, 2).map((property, index) => ({
                  property,
                  color: nextStopColor(index),
                })),
              );
            }
          }}
        >
          <option value="none">{t("style.diagrams.typeNone")}</option>
          <option value="pie">{t("style.diagrams.typePie")}</option>
          <option value="donut">{t("style.diagrams.typeDonut")}</option>
          <option value="bar">{t("style.diagrams.typeBar")}</option>
          <option value="stacked-bar">{t("style.diagrams.typeStackedBar")}</option>
        </Select>
      </div>
      {diagramType !== "none" && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t("style.diagrams.fields")}</Label>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-7 w-7"
                title={t("style.diagrams.addField")}
                aria-label={t("style.diagrams.addField")}
                onClick={addDiagramField}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {diagramFields.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("style.diagrams.noFields")}</p>
            ) : (
              <div className="space-y-2">
                {diagramFields.map((field, index) => (
                  <div key={index} className="grid grid-cols-[auto_1fr_2rem] items-center gap-2">
                    <ColorField
                      fill={false}
                      aria-label={t("style.symbology.classColor", {
                        index: index + 1,
                      })}
                      eyedropperLabel={t("style.symbology.classColorPick", {
                        index: index + 1,
                      })}
                      className="h-9 w-9 p-1"
                      buttonClassName="h-9 w-9"
                      value={field.color}
                      onChange={(color) => updateDiagramField(index, { color })}
                    />
                    <Select
                      aria-label={t("style.diagrams.fieldAttribute", {
                        index: index + 1,
                      })}
                      value={field.property}
                      onChange={(event) =>
                        updateDiagramField(index, {
                          property: event.target.value,
                        })
                      }
                    >
                      <option value="">{t("style.symbology.chooseField")}</option>
                      {diagramNumericProperties.map((property) => (
                        <option key={property} value={property}>
                          {property}
                        </option>
                      ))}
                      {field.property !== "" &&
                      !diagramNumericProperties.includes(field.property) ? (
                        <option value={field.property}>{field.property}</option>
                      ) : null}
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t("style.diagrams.removeField")}
                      aria-label={t("style.diagrams.removeField")}
                      onClick={() => removeDiagramField(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="diagramSizeMode">{t("style.diagrams.sizeMode")}</Label>
            <Select
              id="diagramSizeMode"
              value={diagramSizeMode}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  diagramSizeMode: event.target.value as DiagramSizeMode,
                })
              }
            >
              <option value="fixed">{t("style.diagrams.sizeFixed")}</option>
              <option value="sum">{t("style.diagrams.sizeSum")}</option>
              <option value="attribute">{t("style.diagrams.sizeAttribute")}</option>
            </Select>
          </div>
          {diagramSizeMode === "attribute" && (
            <div className="space-y-2">
              <Label htmlFor="diagramSizeProperty">{t("style.diagrams.sizeField")}</Label>
              <Select
                id="diagramSizeProperty"
                value={styleValue(style, "diagramSizeProperty")}
                onChange={(event) =>
                  setLayerStyle(layer.id, {
                    diagramSizeProperty: event.target.value,
                  })
                }
              >
                <option value="">{t("style.symbology.chooseField")}</option>
                {diagramNumericProperties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))}
                {styleValue(style, "diagramSizeProperty") !== "" &&
                !diagramNumericProperties.includes(styleValue(style, "diagramSizeProperty")) ? (
                  <option value={styleValue(style, "diagramSizeProperty")}>
                    {styleValue(style, "diagramSizeProperty")}
                  </option>
                ) : null}
              </Select>
            </div>
          )}
          <NumericStyleInput
            id="diagramSize"
            label={t("style.diagrams.size")}
            min={8}
            max={120}
            step={1}
            value={styleValue(style, "diagramSize")}
            onChange={(diagramSize) => setLayerStyle(layer.id, { diagramSize })}
          />
          {diagramTruncated && (
            <p className="text-xs text-muted-foreground">
              {t("style.diagrams.truncated", { count: diagramDrawnCount })}
            </p>
          )}
          {diagramAtlasDropped > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("style.diagrams.atlasFull", { count: diagramAtlasDropped })}
            </p>
          )}
          <NumericStyleInput
            id="diagramMinZoom"
            label={t("style.diagrams.minZoom")}
            min={0}
            max={24}
            step={1}
            value={styleValue(style, "diagramMinZoom")}
            onChange={(diagramMinZoom) => setLayerStyle(layer.id, { diagramMinZoom })}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={styleValue(style, "diagramDeclutter")}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  diagramDeclutter: event.target.checked,
                })
              }
            />
            {t("style.diagrams.declutter")}
          </label>
        </>
      )}
    </div>
  );

  // One pass over the override fields for both the rows and the invalid
  // banner; the style-spec compile behind the invalid flag is memoized per
  // distinct expression (labelOverrideInvalid), so re-renders cost lookups,
  // not recompiles. The `|| ""` guards against a hand-edited project file
  // storing null for an expression field (the type says string, but the
  // value comes from untrusted JSON); the invalid flag surfaces the
  // renderer's fallback to the literal control (the builder's Apply is
  // disabled for invalid expressions, but a hand-edited file can still carry
  // one). Validation runs through the style spec with the row's expected
  // result type, mirroring the builder's own check, so a type mismatch
  // (e.g. a string-producing size expression) is flagged too, not just
  // malformed JSON.
  const labelOverrideStates = LABEL_OVERRIDE_PROPERTIES.map((property) => {
    const value = (labels[property.field] || "").trim();
    return {
      property,
      value,
      invalid: value !== "" && labelOverrideInvalid(value, property.expectedType),
    };
  });
  const labelControls = (
    <div className="space-y-3">
      <label htmlFor="labelsEnabled" className="flex items-center gap-2 text-sm font-medium">
        <input
          id="labelsEnabled"
          type="checkbox"
          checked={labels.enabled}
          onChange={(event) => updateLabels({ enabled: event.target.checked })}
        />
        {t("style.labels.show")}
      </label>
      {labels.enabled ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="labelField">{t("style.labels.field")}</Label>
            <Select
              id="labelField"
              value={labels.field}
              disabled={vectorStylePropertyOptions.length === 0}
              onChange={(event) => updateLabels({ field: event.target.value })}
            >
              {vectorStylePropertyOptions.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                <>
                  <option value="">{t("style.labels.selectField")}</option>
                  {vectorStylePropertyOptions.map((property) => (
                    <option key={property} value={property}>
                      {property}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="labelPlacement">{t("style.labels.placement")}</Label>
            <Select
              id="labelPlacement"
              value={labels.placement}
              onChange={(event) =>
                updateLabels({
                  placement: event.target.value as "point" | "line",
                })
              }
            >
              <option value="point">{t("style.labels.placementPoint")}</option>
              <option value="line">{t("style.labels.placementLine")}</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelSize"
              label={t("style.labels.textSize")}
              min={6}
              max={48}
              step={1}
              value={labels.size}
              onChange={(size) => updateLabels({ size })}
            />
            <NumericStyleInput
              id="labelHaloWidth"
              label={t("style.labels.haloWidth")}
              min={0}
              max={8}
              step={0.5}
              value={labels.haloWidth}
              onChange={(haloWidth) => updateLabels({ haloWidth })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="labelColor">{t("style.labels.textColor")}</Label>
              <ColorField
                id="labelColor"
                value={labels.color}
                onChange={(color) => updateLabels({ color })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelHaloColor">{t("style.labels.haloColor")}</Label>
              <ColorField
                id="labelHaloColor"
                value={labels.haloColor}
                onChange={(haloColor) => updateLabels({ haloColor })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelMinZoom"
              label={t("style.labels.minZoom")}
              min={0}
              max={labels.maxZoom}
              step={1}
              value={labels.minZoom}
              onChange={(minZoom) => updateLabels({ minZoom: Math.min(minZoom, labels.maxZoom) })}
            />
            <NumericStyleInput
              id="labelMaxZoom"
              label={t("style.labels.maxZoom")}
              min={labels.minZoom}
              max={24}
              step={1}
              value={labels.maxZoom}
              onChange={(maxZoom) => updateLabels({ maxZoom: Math.max(maxZoom, labels.minZoom) })}
            />
          </div>
          <label
            htmlFor="labelAllowOverlap"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <input
              id="labelAllowOverlap"
              type="checkbox"
              checked={labels.allowOverlap}
              onChange={(event) => updateLabels({ allowOverlap: event.target.checked })}
            />
            {t("style.labels.allowOverlap")}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="labelAnchor">{t("style.labels.anchor")}</Label>
              <Select
                id="labelAnchor"
                value={labels.anchor}
                onChange={(event) =>
                  updateLabels({
                    anchor: event.target.value as LabelStyle["anchor"],
                  })
                }
              >
                <option value="center">{t("style.labels.anchorCenter")}</option>
                <option value="left">{t("style.labels.anchorLeft")}</option>
                <option value="right">{t("style.labels.anchorRight")}</option>
                <option value="top">{t("style.labels.anchorTop")}</option>
                <option value="bottom">{t("style.labels.anchorBottom")}</option>
                <option value="top-left">{t("style.labels.anchorTopLeft")}</option>
                <option value="top-right">{t("style.labels.anchorTopRight")}</option>
                <option value="bottom-left">{t("style.labels.anchorBottomLeft")}</option>
                <option value="bottom-right">{t("style.labels.anchorBottomRight")}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelTransform">{t("style.labels.transform")}</Label>
              <Select
                id="labelTransform"
                value={labels.transform}
                onChange={(event) =>
                  updateLabels({
                    transform: event.target.value as LabelStyle["transform"],
                  })
                }
              >
                <option value="none">{t("style.labels.transformNone")}</option>
                <option value="uppercase">{t("style.labels.transformUppercase")}</option>
                <option value="lowercase">{t("style.labels.transformLowercase")}</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelOffsetX"
              label={t("style.labels.offsetX")}
              min={-10}
              max={10}
              step={0.25}
              value={labels.offsetX}
              onChange={(offsetX) => updateLabels({ offsetX })}
            />
            <NumericStyleInput
              id="labelOffsetY"
              label={t("style.labels.offsetY")}
              min={-10}
              max={10}
              step={0.25}
              value={labels.offsetY}
              onChange={(offsetY) => updateLabels({ offsetY })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelRotation"
              label={t("style.labels.rotation")}
              min={-180}
              max={180}
              step={5}
              value={labels.rotation}
              onChange={(rotation) => updateLabels({ rotation })}
            />
            <NumericStyleInput
              id="labelMaxWidth"
              label={t("style.labels.maxWidth")}
              min={1}
              max={40}
              step={1}
              value={labels.maxWidth}
              onChange={(maxWidth) => updateLabels({ maxWidth })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="labelDedupe">{t("style.labels.dedupe")}</Label>
            <Select
              id="labelDedupe"
              value={labels.dedupe}
              onChange={(event) =>
                updateLabels({
                  dedupe: event.target.value as LabelStyle["dedupe"],
                })
              }
            >
              <option value="off">{t("style.labels.dedupeOff")}</option>
              <option value="unique">{t("style.labels.dedupeUnique")}</option>
              <option value="concatenate">{t("style.labels.dedupeConcatenate")}</option>
            </Select>
            {labels.dedupe !== "off" ? (
              <p className="text-xs text-muted-foreground">{t("style.labels.dedupeHint")}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="labelExpression">{t("style.labels.expression")}</Label>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-7 w-7"
                title={t("style.expressionBuilder.openBuilder")}
                aria-label={t("style.expressionBuilder.openBuilder")}
                onClick={() => setExpressionBuilderTarget({ kind: "label", layerId: layer.id })}
              >
                <SquareFunction className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              id="labelExpression"
              aria-invalid={labelExpressionInvalid}
              className={[
                "min-h-16 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0",
                labelExpressionInvalid ? "border-destructive" : "border-input",
              ].join(" ")}
              placeholder={'["concat", ["get", "name"], " (", ["get", "pop"], ")"]'}
              value={labels.expression}
              onChange={(event) => updateLabels({ expression: event.target.value })}
            />
            <p
              className={[
                "text-xs",
                labelExpressionInvalid ? "text-destructive" : "text-muted-foreground",
              ].join(" ")}
            >
              {labelExpressionInvalid
                ? t("style.labels.expressionInvalid")
                : t("style.labels.expressionHint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t("style.labels.dataDefined.heading")}</Label>
            {labelOverrideStates.map(({ property, value, invalid }) => {
              return (
                <div key={property.key} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs">
                    {t(`style.labels.dataDefined.${property.key}`)}
                  </span>
                  <code
                    className={[
                      "min-w-0 flex-1 truncate font-mono text-xs",
                      invalid ? "text-destructive" : "text-muted-foreground",
                    ].join(" ")}
                    title={invalid ? t("style.labels.expressionInvalid") : value || undefined}
                  >
                    {value || t("style.labels.dataDefined.notSet")}
                  </code>
                  <Button
                    type="button"
                    variant={value ? "secondary" : "outline"}
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    title={t(`style.labels.dataDefined.${property.key}Target`)}
                    aria-label={t(`style.labels.dataDefined.${property.key}Target`)}
                    onClick={() =>
                      setExpressionBuilderTarget({
                        kind: "labelOverride",
                        property,
                        layerId: layer.id,
                      })
                    }
                  >
                    <SquareFunction className="h-3.5 w-3.5" />
                  </Button>
                  {value ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      title={t("style.labels.dataDefined.clear")}
                      aria-label={t("style.labels.dataDefined.clear")}
                      onClick={() =>
                        updateLabels({
                          [property.field]: "",
                        } as Partial<LabelStyle>)
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {labelOverrideStates.some((state) => state.invalid) ? (
              <p className="text-xs text-destructive">{t("style.labels.expressionInvalid")}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("style.labels.dataDefined.hint")}</p>
          </div>
        </>
      ) : null}
    </div>
  );
  const twoDimensionalControls = (
    <>
      {supportsPointRenderer ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="pointRenderer">{t("style.symbology.pointRenderer")}</Label>
            <Select
              id="pointRenderer"
              value={pointRenderer}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  pointRenderer: event.target.value as PointRenderer,
                })
              }
            >
              <option value="single">{t("style.symbology.pointRendererSingle")}</option>
              <option value="heatmap">{t("style.symbology.pointRendererHeatmap")}</option>
              <option value="cluster">{t("style.symbology.pointRendererClustered")}</option>
            </Select>
          </div>
          {pointRenderer === "heatmap" ? (
            <>
              <NumericStyleInput
                id="heatmapRadius"
                label={t("style.symbology.heatmapRadius")}
                min={1}
                max={100}
                step={1}
                value={styleValue(style, "heatmapRadius")}
                onChange={(heatmapRadius) => setLayerStyle(layer.id, { heatmapRadius })}
              />
              <NumericStyleInput
                id="heatmapIntensity"
                label={t("style.symbology.heatmapIntensity")}
                min={0.1}
                max={5}
                step={0.1}
                value={styleValue(style, "heatmapIntensity")}
                onChange={(heatmapIntensity) => setLayerStyle(layer.id, { heatmapIntensity })}
              />
            </>
          ) : null}
          {pointRenderer === "cluster" ? (
            <>
              <NumericStyleInput
                id="clusterRadius"
                label={t("style.symbology.clusterRadius")}
                min={10}
                max={200}
                step={5}
                value={styleValue(style, "clusterRadius")}
                onChange={(clusterRadius) => setLayerStyle(layer.id, { clusterRadius })}
              />
              <NumericStyleInput
                id="clusterMaxZoom"
                label={t("style.symbology.clusterMaxZoom")}
                min={0}
                max={24}
                step={1}
                value={styleValue(style, "clusterMaxZoom")}
                onChange={(clusterMaxZoom) => setLayerStyle(layer.id, { clusterMaxZoom })}
              />
            </>
          ) : null}
          <Separator />
        </>
      ) : null}
      {/* The heatmap renderer ignores fill/stroke/circle/data-driven styling, so
          hide those controls when it is selected. */}
      {pointRenderer === "heatmap" ? null : (
        <>
          {draftVectorStyleMode === "single" ? (
            <div className="space-y-2">
              <Label htmlFor="fillColor">{t("style.elevation3d.fillColor")}</Label>
              <ColorField
                id="fillColor"
                value={style.fillColor}
                onChange={(fillColor) => setLayerStyle(layer.id, { fillColor })}
                allowTransparent
                fallbackColor={DEFAULT_LAYER_STYLE.fillColor}
                transparentLabel={t("style.symbology.transparent")}
                transparentSwatchLabel={t("style.symbology.transparentSwatch")}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="strokeColor">{t("style.elevation3d.outlineColor")}</Label>
            <ColorField
              id="strokeColor"
              value={style.strokeColor}
              onChange={(strokeColor) => setLayerStyle(layer.id, { strokeColor })}
              allowTransparent
              fallbackColor={DEFAULT_LAYER_STYLE.strokeColor}
              transparentLabel={t("style.symbology.transparent")}
              transparentSwatchLabel={t("style.symbology.transparentSwatch")}
            />
          </div>
          <NumericStyleInput
            id="strokeWidth"
            label={
              strokeWidthInMeters
                ? t("style.elevation3d.strokeWidthMeters")
                : t("style.elevation3d.strokeWidth")
            }
            min={0}
            max={strokeWidthInMeters ? 100000 : 20}
            step={strokeWidthInMeters ? 1 : 0.5}
            value={style.strokeWidth}
            onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
          />
          {supportsPointRenderer ? null : (
            <div className="space-y-2">
              <Label htmlFor="strokeWidthUnit">{t("style.symbology.strokeWidthUnit")}</Label>
              <Select
                id="strokeWidthUnit"
                value={strokeWidthUnit}
                onChange={(event) => {
                  const nextUnit = event.target.value as StrokeWidthUnit;
                  // Meters and pixels are not freely convertible (pixel size
                  // depends on zoom), so a large meters width would render as a
                  // map-filling pixel width when switched back. Reset to the pixel
                  // default when leaving meters with an out-of-range value.
                  setLayerStyle(layer.id, {
                    strokeWidthUnit: nextUnit,
                    ...(nextUnit === "pixels" && style.strokeWidth > 20
                      ? { strokeWidth: DEFAULT_LAYER_STYLE.strokeWidth }
                      : {}),
                  });
                }}
              >
                <option value="pixels">{t("style.symbology.strokeWidthUnitPixels")}</option>
                <option value="meters">{t("style.symbology.strokeWidthUnitMeters")}</option>
              </Select>
            </div>
          )}
          <NumericStyleInput
            id="fillOpacity"
            label={t("style.elevation3d.fillOpacity")}
            min={0}
            max={1}
            step={0.05}
            value={style.fillOpacity}
            onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
          />
          {isSketchLayer ? null : (
            <NumericStyleInput
              id="circleRadius"
              label={t("style.elevation3d.circleRadius")}
              min={1}
              max={50}
              step={1}
              value={style.circleRadius}
              onChange={(circleRadius) => setLayerStyle(layer.id, { circleRadius })}
            />
          )}
          {hasTextMarkerControls ? (
            <>
              <Separator />
              <div className="space-y-2">
                <Label htmlFor="textColor">{t("style.labels.textColor")}</Label>
                <ColorField
                  id="textColor"
                  value={styleValue(style, "textColor")}
                  onChange={(textColor) => setLayerStyle(layer.id, { textColor })}
                />
              </div>
              <NumericStyleInput
                id="textSize"
                label={t("style.labels.textSize")}
                min={6}
                max={96}
                step={1}
                value={styleValue(style, "textSize")}
                onChange={(textSize) => setLayerStyle(layer.id, { textSize })}
              />
              <div className="space-y-2">
                <Label htmlFor="textHaloColor">{t("style.symbology.textHaloColor")}</Label>
                <ColorField
                  id="textHaloColor"
                  value={styleValue(style, "textHaloColor")}
                  onChange={(textHaloColor) => setLayerStyle(layer.id, { textHaloColor })}
                />
              </div>
              <NumericStyleInput
                id="textHaloWidth"
                label={t("style.symbology.textHaloWidth")}
                min={0}
                max={8}
                step={0.5}
                value={styleValue(style, "textHaloWidth")}
                onChange={(textHaloWidth) => setLayerStyle(layer.id, { textHaloWidth })}
              />
            </>
          ) : null}
        </>
      )}
    </>
  );
  const extrusionControls = (
    <>
      {draftVectorStyleMode === "single" ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionColor">{t("style.extrusion.color")}</Label>
          <ColorField
            id="extrusionColor"
            value={draftExtrusionColor}
            onChange={(color) => setDraftExtrusionColor(color)}
          />
        </div>
      ) : null}
      <NumericStyleInput
        id="extrusionOpacity"
        label={t("style.extrusion.opacity")}
        min={0}
        max={1}
        step={0.05}
        value={draftExtrusionOpacity}
        onChange={setDraftExtrusionOpacity}
      />
      <label
        htmlFor="extrusionAdvancedStyleEnabled"
        className="flex items-center gap-2 text-sm font-medium"
      >
        <input
          id="extrusionAdvancedStyleEnabled"
          type="checkbox"
          checked={draftAdvancedExtrusionEnabled}
          onChange={(event) => {
            setDraftAdvancedExtrusionEnabled(event.target.checked);
            setExtrusionError(null);
          }}
        />
        {t("style.extrusion.advanced")}
      </label>
      {draftAdvancedExtrusionEnabled ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionHeightExpression">{t("style.extrusion.heightExpression")}</Label>
          <textarea
            id="extrusionHeightExpression"
            className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            value={draftHeightExpression}
            onChange={(event) => {
              setDraftHeightExpression(event.target.value);
              setExtrusionError(null);
            }}
          />
        </div>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor="extrusionHeightProperty">{t("style.extrusion.heightProperty")}</Label>
            <Select
              id="extrusionHeightProperty"
              value={draftExtrusionHeightProperty}
              onChange={(event) => setDraftExtrusionHeightProperty(event.target.value)}
              disabled={extrusionHeightProperties.length === 0}
            >
              {extrusionHeightProperties.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                extrusionHeightProperties.map((property) => (
                  <option key={property} value={property}>
                    {property}
                  </option>
                ))
              )}
            </Select>
          </div>
          <NumericStyleInput
            id="extrusionHeightScale"
            label={t("style.extrusion.heightScale")}
            min={0}
            max={10000}
            step={0.00001}
            value={draftExtrusionHeightScale}
            onChange={setDraftExtrusionHeightScale}
          />
          <NumericStyleInput
            id="extrusionBase"
            label={t("style.extrusion.base")}
            min={0}
            max={100000}
            step={1}
            value={draftExtrusionBase}
            onChange={setDraftExtrusionBase}
          />
        </>
      )}
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={!extrusionSettingsChanged}
        onClick={applyExtrusionSettings}
      >
        {t("style.extrusion.apply")}
      </Button>
      {extrusionError && <p className="text-xs text-destructive">{extrusionError}</p>}
    </>
  );

  // Controls for the "3D (Z values)" mode: only the knobs the deck.gl render
  // honors (flat colors, widths, and the elevation transform). Data-driven
  // symbology, point renderers, patterns, markers, and labels are 2D-only.
  const elevation3dControls = (
    <>
      <div className="space-y-2">
        <Label htmlFor="fillColor">{t("style.elevation3d.fillColor")}</Label>
        <ColorField
          id="fillColor"
          value={style.fillColor}
          onChange={(fillColor) => setLayerStyle(layer.id, { fillColor })}
          allowTransparent
          fallbackColor={DEFAULT_LAYER_STYLE.fillColor}
          transparentLabel={t("style.symbology.transparent")}
          transparentSwatchLabel={t("style.symbology.transparentSwatch")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="strokeColor">{t("style.elevation3d.outlineColor")}</Label>
        <ColorField
          id="strokeColor"
          value={style.strokeColor}
          onChange={(strokeColor) => setLayerStyle(layer.id, { strokeColor })}
          allowTransparent
          fallbackColor={DEFAULT_LAYER_STYLE.strokeColor}
          transparentLabel={t("style.symbology.transparent")}
          transparentSwatchLabel={t("style.symbology.transparentSwatch")}
        />
      </div>
      {/* The 3D render honors meter-based widths (lineWidthUnits), so mirror
          the 2D control's range/label switch or the tighter pixel clamp would
          silently destroy a meters width on the next edit. */}
      <NumericStyleInput
        id="strokeWidth"
        label={
          strokeWidthInMeters
            ? t("style.elevation3d.strokeWidthMeters")
            : t("style.elevation3d.strokeWidth")
        }
        min={0}
        max={strokeWidthInMeters ? 100000 : 20}
        step={strokeWidthInMeters ? 1 : 0.5}
        value={style.strokeWidth}
        onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
      />
      <NumericStyleInput
        id="fillOpacity"
        label={t("style.elevation3d.fillOpacity")}
        min={0}
        max={1}
        step={0.05}
        value={style.fillOpacity}
        onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
      />
      {/* Sketches mix geometry types under one style, so "Circle radius" is
          suppressed there for the same reason as in the 2D controls (#483). */}
      {geometryFlags.hasPoint && !isSketchLayer ? (
        <NumericStyleInput
          id="circleRadius"
          label={t("style.elevation3d.circleRadius")}
          min={1}
          max={50}
          step={1}
          value={style.circleRadius}
          onChange={(circleRadius) => setLayerStyle(layer.id, { circleRadius })}
        />
      ) : null}
      <Separator />
      <NumericStyleInput
        id="elevation3dVerticalScale"
        label={t("style.elevation3d.verticalScale")}
        min={0}
        max={100}
        step={0.1}
        value={styleValue(style, "elevation3dVerticalScale")}
        onChange={(elevation3dVerticalScale) =>
          setLayerStyle(layer.id, { elevation3dVerticalScale })
        }
        tooltip={t("style.elevation3d.verticalScaleTooltip")}
      />
      <NumericStyleInput
        id="elevation3dOffset"
        label={t("style.elevation3d.offset")}
        min={-10000}
        max={10000}
        step={10}
        value={styleValue(style, "elevation3dOffset")}
        onChange={(elevation3dOffset) => setLayerStyle(layer.id, { elevation3dOffset })}
        tooltip={t("style.elevation3d.offsetTooltip")}
      />
    </>
  );

  if (hasRasterPaintControls) {
    return (
      <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">
            {t("style.headingWithLayer", { name: layer.name })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t("style.collapse")}
            aria-label={t("style.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          {/* Padding on the inner content with extra right clearance so the
              overlay scrollbar never covers a control's right edge. */}
          <div className="space-y-4 p-3 pe-5">
            {beforeIdControl}
            {zoomRangeControls}
            <RasterStyleSlider
              label={t("style.raster.opacity")}
              value={layer.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setLayerOpacity(layer.id, value)}
            />
            {!isDeckRasterLayer && (
              <>
                <RasterStyleSlider
                  label={t("style.raster.brightnessMin")}
                  value={styleValue(style, "rasterBrightnessMin")}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) => setLayerStyle(layer.id, { rasterBrightnessMin: value })}
                />
                <RasterStyleSlider
                  label={t("style.raster.brightnessMax")}
                  value={styleValue(style, "rasterBrightnessMax")}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) => setLayerStyle(layer.id, { rasterBrightnessMax: value })}
                />
                <RasterStyleSlider
                  label={t("style.raster.saturation")}
                  value={styleValue(style, "rasterSaturation")}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(value) => setLayerStyle(layer.id, { rasterSaturation: value })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant={styleValue(style, "rasterSaturation") <= -1 ? "default" : "outline"}
                  className="w-full"
                  aria-pressed={styleValue(style, "rasterSaturation") <= -1}
                  title={t("style.raster.greyscaleHint")}
                  onClick={() =>
                    setLayerStyle(layer.id, {
                      rasterSaturation:
                        styleValue(style, "rasterSaturation") <= -1
                          ? DEFAULT_LAYER_STYLE.rasterSaturation
                          : -1,
                    })
                  }
                >
                  {t("style.raster.greyscale")}
                </Button>
                <RasterStyleSlider
                  label={t("style.raster.contrast")}
                  value={styleValue(style, "rasterContrast")}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(value) => setLayerStyle(layer.id, { rasterContrast: value })}
                />
                <RasterStyleSlider
                  label={t("style.raster.hueRotate")}
                  value={styleValue(style, "rasterHueRotate")}
                  min={0}
                  max={360}
                  step={1}
                  onChange={(value) => setLayerStyle(layer.id, { rasterHueRotate: value })}
                  format={(value) => value.toFixed(0)}
                />
              </>
            )}
            {layer.metadata.sourceKind === RASTER_SOURCE_KIND && (
              <RasterSymbologySection layer={layer} mapControllerRef={mapControllerRef} />
            )}
            <Separator />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              title={t("style.raster.resetHint")}
              onClick={() => {
                setLayerOpacity(layer.id, 1);
                if (!isDeckRasterLayer) {
                  setLayerStyle(layer.id, {
                    rasterBrightnessMin: DEFAULT_LAYER_STYLE.rasterBrightnessMin,
                    rasterBrightnessMax: DEFAULT_LAYER_STYLE.rasterBrightnessMax,
                    rasterSaturation: DEFAULT_LAYER_STYLE.rasterSaturation,
                    rasterContrast: DEFAULT_LAYER_STYLE.rasterContrast,
                    rasterHueRotate: DEFAULT_LAYER_STYLE.rasterHueRotate,
                  });
                }
              }}
            >
              {t("style.raster.reset")}
            </Button>
          </div>
        </ScrollArea>
        <Separator />
        <p className="p-2 text-[10px] text-muted-foreground">
          {isDeckRasterLayer ? t("style.raster.footerDeck") : t("style.raster.footerMaplibre")}
        </p>
      </aside>
    );
  }

  if (!hasVectorPaintControls) {
    return (
      <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">
            {t("style.headingWithLayer", { name: layer.name })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title={t("style.collapse")}
            aria-label={t("style.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 p-3">{beforeIdControl}</div>
        <p className="p-4 text-xs text-muted-foreground">{t("style.noControls")}</p>
        <Separator />
        <p className="p-2 text-[10px] text-muted-foreground">
          {t("style.selectedLayerType", { type: layer.type })}
        </p>
      </aside>
    );
  }

  return (
    <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
      {resizeHandle}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-sm font-semibold">
          {t("style.headingWithLayer", { name: layer.name })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {/* Only the layer types the Style Manager can apply to; this vector
              panel also serves mbtiles/plugin/deck layers, where the dialog
              would open with Apply/Save disabled. */}
          {isStyleLibraryTargetLayer(layer.type) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("style.openStyleManager")}
              aria-label={t("style.openStyleManager")}
              onClick={() => setStyleManagerOpen(true)}
            >
              <Palette className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("style.collapse")}
            aria-label={t("style.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        {/* Padding lives on the inner content (not the ScrollArea root) with
            extra right clearance so the overlay scrollbar never covers the
            right edge of a control (e.g. the "Transparent" label). */}
        <div className="space-y-4 p-3 pe-5">
          {beforeIdControl}
          {/* The 3D Z-value render (deck.gl) does not honor the MapLibre
              min/max zoom range, so hide the controls rather than show a
              silently-ignored setting. */}
          {!elevation3dActive && zoomRangeControls}
          {hasExtrusionControls && (
            <div className="space-y-2">
              <Label>{t("style.visualization")}</Label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={!extrusionEnabled && !elevation3dActive}
                    onChange={() => {
                      setExtrusionError(null);
                      setLayerStyle(layer.id, {
                        extrusionEnabled: false,
                        elevation3dEnabled: false,
                      });
                    }}
                  />
                  {t("style.mode2d")}
                </label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={extrusionEnabled && !elevation3dActive}
                    onChange={() => {
                      setVectorStyleError(null);
                      setLayerStyle(layer.id, {
                        extrusionEnabled: true,
                        elevation3dEnabled: false,
                      });
                    }}
                  />
                  {t("style.mode3dExtrusion")}
                </label>
                {supportsElevation3d && (
                  <label className="col-span-2 flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                    <input
                      type="radio"
                      name={`style-mode-${layer.id}`}
                      checked={elevation3dActive}
                      onChange={() => {
                        setExtrusionError(null);
                        setLayerStyle(layer.id, {
                          extrusionEnabled: false,
                          elevation3dEnabled: true,
                        });
                      }}
                    />
                    {t("style.elevation3d.mode")}
                  </label>
                )}
              </div>
            </div>
          )}
          {/* Data-driven coloring doesn't apply to the heatmap renderer or the
              flat-styled 3D Z-value render. */}
          {pointRenderer === "heatmap" || elevation3dActive ? null : vectorSymbologyControls}
          {elevation3dActive
            ? elevation3dControls
            : !hasExtrusionControls || !extrusionEnabled
              ? twoDimensionalControls
              : extrusionControls}
          {!elevation3dActive && (!hasExtrusionControls || !extrusionEnabled) && (
            <>
              {showProportionalControls && (
                <>
                  <Separator />
                  {proportionalSizeControls}
                </>
              )}
              {showFillPatternControls && (
                <>
                  <Separator />
                  {fillPatternControls}
                </>
              )}
              {showLineDecorationControls && (
                <>
                  <Separator />
                  {lineDecorationControls}
                </>
              )}
              {showMarkerControls && (
                <>
                  <Separator />
                  {markerControls}
                </>
              )}
              {showDiagramControls && (
                <>
                  <Separator />
                  <p className="text-sm font-semibold">{t("style.diagrams.heading")}</p>
                  {diagramControls}
                </>
              )}
              {showGeneratorControls && (
                <>
                  <Separator />
                  <p className="text-sm font-semibold">{t("style.generator.heading")}</p>
                  {generatorControls}
                </>
              )}
            </>
          )}
          {/* Attribute labels apply to vector features, not the heatmap density
              surface or the 3D extrusion / 3D Z-value renders. */}
          {!extrusionEnabled && !elevation3dActive && pointRenderer !== "heatmap" ? (
            <>
              <Separator />
              <p className="text-sm font-semibold">{t("style.labels.heading")}</p>
              {labelControls}
            </>
          ) : null}
          {/* Persistent attribute joins need the layer's features in the store
              (layer.geojson); tile/service layers without an inline attribute
              table cannot be a join target. */}
          {layer.geojson ? (
            <>
              <Separator />
              {/* Keyed by layer so the add-join draft never survives a layer
                  switch (a stale draft could reference the new target itself). */}
              <LayerJoinsSection key={layer.id} layer={layer} />
              <Separator />
              {/* Virtual fields need the layer's features in the store too
                  (the expressions evaluate against layer.geojson). Keyed for
                  the same draft-lifetime reason as the joins section. */}
              <VirtualFieldsSection key={`vf-${layer.id}`} layer={layer} />
            </>
          ) : null}
          {/* The Attribute Form designer configures how attribute values are
              edited, so it needs the layer's features in the store too. Keyed
              like Joins so an open field draft never survives a layer switch. */}
          {layer.geojson ? (
            <>
              <Separator />
              <AttributeFormSection key={`af-${layer.id}`} layer={layer} />
            </>
          ) : null}
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {extrusionEnabled
          ? t("style.extrusion.footer")
          : elevation3dActive
            ? t("style.elevation3d.footer")
            : isDeckVectorLayer
              ? t("style.footerDeck")
              : t("style.footerMaplibre")}
      </p>
      {expressionBuilderDialog}
    </aside>
  );
}
