import {
  DEFAULT_LAYER_STYLE,
  type LabelStyle,
  type LayerType,
  type PointRenderer,
  type StrokeWidthUnit,
  VECTOR_COLOR_RAMPS,
  type VectorStyleMode,
  type VectorStyleStop,
  createEqualIntervalBreaks,
  createQuantileBreaks,
  getVectorColorRamp,
  interpolateRampColors,
  styleValue,
  useAppStore,
} from "@geolibre/core";
import {
  Button,
  ColorField,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
  Slider,
} from "@geolibre/ui";
import { RASTER_SOURCE_KIND, SKETCHES_SOURCE_KIND } from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import { RasterSymbologySection } from "./RasterSymbologySection";
import {
  ChevronDown,
  ChevronUp,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";

interface StylePanelProps {
  mapControllerRef: RefObject<MapController | null>;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /**
   * When this flips to `true` the panel collapses to its thin rail (it is not
   * unmounted). Used to clear room when the notebook opens beside the map; the
   * user can still expand it again.
   */
  autoCollapse?: boolean;
}

function isRasterPaintLayer(type: LayerType): boolean {
  return (
    type === "raster" || type === "wms" || type === "wmts" || type === "xyz"
  );
}

function hasExternalNativeLayers(layer: { metadata: Record<string, unknown> }) {
  return (
    Array.isArray(layer.metadata.nativeLayerIds) &&
    layer.metadata.nativeLayerIds.length > 0
  );
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
    return (
      properties?.__gm_shape === "text_marker" ||
      properties?.shape === "text_marker"
    );
  });
}

function supportsExtrusionControls(layer: {
  type: LayerType;
  source: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): boolean {
  if (
    layer.type === "geojson" ||
    layer.type === "vector-tiles" ||
    layer.type === "mbtiles"
  ) {
    return true;
  }

  if (layer.type === "pmtiles") {
    return (
      layer.metadata.tileType === "vector" || layer.source.type === "vector"
    );
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
      typeof geometryType === "string" &&
      geometryType.toLowerCase().includes("polygon"),
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

function getMetadataFieldNames(metadata: Record<string, unknown>): string[] {
  const fieldValues = [
    metadata.fields,
    metadata.columns,
    metadata.properties,
    metadata.attributeFields,
  ];
  const names = new Set<string>();

  for (const value of fieldValues) {
    if (!Array.isArray(value)) continue;
    for (const field of value) {
      if (typeof field === "string") {
        names.add(field);
        continue;
      }
      if (
        field &&
        typeof field === "object" &&
        "name" in field &&
        typeof field.name === "string"
      ) {
        names.add(field.name);
      }
    }
  }

  return Array.from(names);
}

function getAttributePropertyNames(layer: {
  geojson?: {
    features?: Array<{
      properties?: Record<string, unknown> | null;
    }>;
  };
  metadata: Record<string, unknown>;
}): string[] {
  const names = new Set<string>();

  for (const feature of layer.geojson?.features ?? []) {
    for (const key of Object.keys(feature.properties ?? {})) {
      names.add(key);
    }
  }

  for (const key of getMetadataFieldNames(layer.metadata)) {
    names.add(key);
  }

  return Array.from(names).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
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

const VECTOR_STYLE_COLORS = [
  "#2563eb",
  "#16a34a",
  "#f59e0b",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
];

const VECTOR_STYLE_CLASS_COUNTS = Array.from({ length: 12 }, (_, index) =>
  index + 1,
);

const GRADUATED_CLASSIFICATION_SCHEMES = [
  { value: "equal-interval", label: "Equal interval" },
  { value: "quantile", label: "Quantile" },
  { value: "natural-breaks", label: "Natural breaks" },
] as const;

const CATEGORIZED_CLASSIFICATION_SCHEMES = [
  { value: "top-values", label: "Most frequent" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "first-values", label: "First values" },
] as const;

function createGraduatedStops(
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
    breaks.length === count
      ? colors
      : interpolateRampColors(colorRamp, breaks.length);

  return breaks.map((value, index) => ({
    value: Number(value.toPrecision(8)),
    color: stopColors[index] ?? stopColors.at(-1) ?? "#2563eb",
  }));
}

function createCategorizedStops(
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
  const colors = interpolateRampColors(
    colorRamp,
    Math.min(count, categories.length || count),
  );

  return categories
    .slice(0, count)
    .map(([value], index) => ({
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
    return createGraduatedStops(
      layer,
      property,
      classCount,
      colorRamp,
      classificationScheme,
    );
  }
  if (mode === "categorized") {
    return createCategorizedStops(
      layer,
      property,
      classCount,
      colorRamp,
      classificationScheme,
    );
  }
  return styleValue(DEFAULT_LAYER_STYLE, "vectorStyleStops");
}

function clampClassCount(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(12, Math.max(min, Math.round(value)));
}

function normalizeVectorStyleClassCount(
  mode: VectorStyleMode,
  value: number,
): number {
  return clampClassCount(value, mode === "categorized" ? 1 : 2);
}

function defaultClassificationScheme(mode: VectorStyleMode): string {
  return mode === "categorized" ? "top-values" : "equal-interval";
}

function normalizeClassificationScheme(
  mode: VectorStyleMode,
  scheme: string,
): string {
  const options =
    mode === "categorized"
      ? CATEGORIZED_CLASSIFICATION_SCHEMES
      : GRADUATED_CLASSIFICATION_SCHEMES;
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
        const candidate =
          variance + varianceCombinations[previousIndex][classIndex - 1];
        if (varianceCombinations[valueIndex][classIndex] >= candidate) {
          lowerClassLimits[valueIndex][classIndex] = currentIndex;
          varianceCombinations[valueIndex][classIndex] = candidate;
        }
      }
    }

    lowerClassLimits[valueIndex][1] = 1;
    varianceCombinations[valueIndex][1] =
      sumSquares - (sum * sum) / Math.max(1, weight);
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
      properties.find((property) => isCategoricalProperty(layer, property)) ??
      properties[0] ??
      ""
    );
  }

  return currentProperty;
}

function isNumericProperty(
  layer: Parameters<typeof getPropertyValues>[0],
  property: string,
): boolean {
  const values = getPropertyValues(layer, property);
  const numericValues = values
    .map((value) => Number(value))
    .filter(Number.isFinite);
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
  const values = getPropertyValues(layer, property).map((value) =>
    String(value),
  );
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

function validateExpressionJson(value: string, label: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
    if (!Array.isArray(parsed)) {
      return `${label} must be a JSON array expression.`;
    }
    return null;
  } catch (error) {
    return `${label} is not valid JSON: ${
      error instanceof Error ? error.message : "unknown parse error"
    }`;
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Shared shell classes for every expanded StylePanel return branch. On phones
// (max-md) it overlays the map as a bottom sheet instead of squeezing it.
const STYLE_PANEL_ASIDE_CLASS =
  "relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0";

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
}

function NumericStyleInput({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: NumericStyleInputProps) {
  const normalize = (next: number) =>
    Number(clampNumber(next, min, max).toFixed(stepPrecision(step)));

  const stepValue = (direction: 1 | -1) => {
    onChange(normalize(value + direction * step));
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          className="pr-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(normalize(next));
          }}
        />
        <div className="absolute right-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
          <button
            type="button"
            className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
            aria-label={`Increase ${label}`}
            onClick={() => stepValue(1)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
            aria-label={`Decrease ${label}`}
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

function StopValueInput({
  index,
  isNumeric,
  value,
  onChange,
}: StopValueInputProps) {
  const label = `Class ${index + 1} value`;

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
        className="pr-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="absolute right-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
        <button
          type="button"
          className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
          aria-label={`Increase ${label}`}
          onClick={() => stepValue(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
          aria-label={`Decrease ${label}`}
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
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {format(value)}
        </span>
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
      />
    </div>
  );
}

export function StylePanel({
  mapControllerRef,
  onResizeStart,
  autoCollapse = false,
}: StylePanelProps) {
  const { t } = useTranslation();
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const [isCollapsed, setIsCollapsed] = useState(getIsMobileViewport);
  // Collapse to the rail when `autoCollapse` flips on (e.g. the notebook opens),
  // and restore the prior expand/collapse state when it flips back off (notebook
  // closes). Both act only on the transition so the user can still toggle the
  // panel manually while `autoCollapse` stays on. `isCollapsed` is in the deps
  // only to keep the captured value fresh; the guards make pure `isCollapsed`
  // changes a no-op while `autoCollapse` is stable.
  const prevAutoCollapse = useRef(autoCollapse);
  const collapsedBeforeAuto = useRef(isCollapsed);
  useEffect(() => {
    const wasAuto = prevAutoCollapse.current;
    prevAutoCollapse.current = autoCollapse;
    if (autoCollapse && !wasAuto) {
      collapsedBeforeAuto.current = isCollapsed;
      setIsCollapsed(true);
    } else if (!autoCollapse && wasAuto) {
      setIsCollapsed(collapsedBeforeAuto.current);
    }
  }, [autoCollapse, isCollapsed]);
  const [draftBeforeId, setDraftBeforeId] = useState("");
  const [draftColorExpression, setDraftColorExpression] = useState("");
  const [draftHeightExpression, setDraftHeightExpression] = useState("");
  const [draftVectorStyleMode, setDraftVectorStyleMode] =
    useState<VectorStyleMode>(DEFAULT_LAYER_STYLE.vectorStyleMode);
  const [draftVectorStyleProperty, setDraftVectorStyleProperty] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleProperty,
  );
  const [draftVectorStyleClassCount, setDraftVectorStyleClassCount] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleClassCount,
  );
  const [draftVectorStyleColorRamp, setDraftVectorStyleColorRamp] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleColorRamp,
  );
  const [
    draftVectorStyleClassificationScheme,
    setDraftVectorStyleClassificationScheme,
  ] = useState(DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme);
  const [draftVectorStyleStops, setDraftVectorStyleStops] = useState<
    VectorStyleStop[]
  >(DEFAULT_LAYER_STYLE.vectorStyleStops);
  const [draftVectorStyleExpression, setDraftVectorStyleExpression] = useState(
    DEFAULT_LAYER_STYLE.vectorStyleExpression,
  );
  const [draftExtrusionColor, setDraftExtrusionColor] = useState(
    DEFAULT_LAYER_STYLE.extrusionColor,
  );
  const [draftExtrusionOpacity, setDraftExtrusionOpacity] = useState(
    DEFAULT_LAYER_STYLE.extrusionOpacity,
  );
  const [draftExtrusionHeightProperty, setDraftExtrusionHeightProperty] =
    useState(DEFAULT_LAYER_STYLE.extrusionHeightProperty);
  const [draftExtrusionHeightScale, setDraftExtrusionHeightScale] = useState(
    DEFAULT_LAYER_STYLE.extrusionHeightScale,
  );
  const [draftExtrusionBase, setDraftExtrusionBase] = useState(
    DEFAULT_LAYER_STYLE.extrusionBase,
  );
  const [draftAdvancedExtrusionEnabled, setDraftAdvancedExtrusionEnabled] =
    useState(DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled);
  const [vectorStyleError, setVectorStyleError] = useState<string | null>(null);
  const [extrusionError, setExtrusionError] = useState<string | null>(null);

  const layer = layers.find((l) => l.id === selectedLayerId);

  useEffect(() => {
    if (!layer) {
      setDraftBeforeId("");
      setDraftColorExpression("");
      setDraftHeightExpression("");
      setDraftVectorStyleMode(DEFAULT_LAYER_STYLE.vectorStyleMode);
      setDraftVectorStyleProperty(DEFAULT_LAYER_STYLE.vectorStyleProperty);
      setDraftVectorStyleClassCount(
        DEFAULT_LAYER_STYLE.vectorStyleClassCount,
      );
      setDraftVectorStyleColorRamp(DEFAULT_LAYER_STYLE.vectorStyleColorRamp);
      setDraftVectorStyleClassificationScheme(
        DEFAULT_LAYER_STYLE.vectorStyleClassificationScheme,
      );
      setDraftVectorStyleStops(DEFAULT_LAYER_STYLE.vectorStyleStops);
      setDraftVectorStyleExpression(DEFAULT_LAYER_STYLE.vectorStyleExpression);
      setDraftExtrusionColor(DEFAULT_LAYER_STYLE.extrusionColor);
      setDraftExtrusionOpacity(DEFAULT_LAYER_STYLE.extrusionOpacity);
      setDraftExtrusionHeightProperty(
        DEFAULT_LAYER_STYLE.extrusionHeightProperty,
      );
      setDraftExtrusionHeightScale(DEFAULT_LAYER_STYLE.extrusionHeightScale);
      setDraftExtrusionBase(DEFAULT_LAYER_STYLE.extrusionBase);
      setDraftAdvancedExtrusionEnabled(
        DEFAULT_LAYER_STYLE.extrusionAdvancedStyleEnabled,
      );
      setVectorStyleError(null);
      setExtrusionError(null);
      return;
    }

    setDraftBeforeId(layer.beforeId ?? "");
    setDraftColorExpression(
      styleValue(layer.style, "extrusionColorExpression"),
    );
    setDraftHeightExpression(
      styleValue(layer.style, "extrusionHeightExpression"),
    );
    const vectorStyleMode = styleValue(layer.style, "vectorStyleMode");
    setDraftVectorStyleMode(vectorStyleMode);
    setDraftVectorStyleProperty(styleValue(layer.style, "vectorStyleProperty"));
    setDraftVectorStyleClassCount(
      normalizeVectorStyleClassCount(
        vectorStyleMode,
        styleValue(layer.style, "vectorStyleClassCount"),
      ),
    );
    setDraftVectorStyleColorRamp(
      styleValue(layer.style, "vectorStyleColorRamp"),
    );
    setDraftVectorStyleClassificationScheme(
      normalizeClassificationScheme(
        vectorStyleMode,
        styleValue(layer.style, "vectorStyleClassificationScheme"),
      ),
    );
    setDraftVectorStyleStops(styleValue(layer.style, "vectorStyleStops"));
    setDraftVectorStyleExpression(
      styleValue(layer.style, "vectorStyleExpression"),
    );
    setDraftExtrusionColor(styleValue(layer.style, "extrusionColor"));
    setDraftExtrusionOpacity(styleValue(layer.style, "extrusionOpacity"));
    setDraftExtrusionHeightProperty(
      styleValue(layer.style, "extrusionHeightProperty"),
    );
    setDraftExtrusionHeightScale(
      styleValue(layer.style, "extrusionHeightScale"),
    );
    setDraftExtrusionBase(styleValue(layer.style, "extrusionBase"));
    setDraftAdvancedExtrusionEnabled(
      styleValue(layer.style, "extrusionAdvancedStyleEnabled"),
    );
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

  // Heatmap/cluster apply to point layers in two render paths: core GeoJSON
  // layers (drag-drop, processing results) and Add Vector Layer point layers in
  // the geojson render mode (the maplibre-gl-vector control renders those, so
  // type stays "geojson"; tile-rendered layers become "vector-tiles"). Memoize
  // the point-only scan so a large layer isn't re-scanned on every panel render.
  // Must run before the early returns below so the hook order stays stable.
  const isPointOnly = useMemo(
    () => (layer ? isPointOnlyGeoJsonLayer(layer) : false),
    [layer],
  );

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Style panel"
      className="absolute -left-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-l border-transparent hover:border-primary md:block"
      onPointerDown={onResizeStart}
    />
  );

  if (isCollapsed) {
    return (
      <aside
        aria-label="Layer style (collapsed)"
        className="flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-l md:border-t-0 md:py-2"
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Expand style"
          aria-label="Expand style"
          onClick={() => setIsCollapsed(false)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
            Style
          </span>
        </div>
      </aside>
    );
  }

  if (!layer) {
    return (
      <aside aria-label="Layer style" className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-sm font-semibold">Style</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Collapse style"
            aria-label="Collapse style"
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <p className="p-4 text-xs text-muted-foreground">
          Select a layer to edit its style.
        </p>
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
  const hasTextMarkerControls =
    layer.type === "geojson" && hasTextMarkerFeatures(layer);
  // isPointOnly is memoized above the early returns to keep hook order stable.
  const isCoreGeoJsonPoint =
    isPointOnly &&
    !hasExternalNativeLayers(layer) &&
    !hasExternalDeckLayer(layer);
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
  const strokeWidthInMeters =
    strokeWidthUnit === "meters" && !supportsPointRenderer;
  const pointRenderer = styleValue(style, "pointRenderer");
  const extrusionEnabled = styleValue(style, "extrusionEnabled");
  const extrusionHeightPropertyOptions = getAttributePropertyNames(layer);
  const vectorStylePropertyOptions = extrusionHeightPropertyOptions;
  const labels: LabelStyle = {
    ...DEFAULT_LAYER_STYLE.labels,
    ...styleValue(style, "labels"),
  };
  const updateLabels = (patch: Partial<LabelStyle>) =>
    setLayerStyle(layer.id, { labels: { ...labels, ...patch } });
  const extrusionHeightProperties = extrusionHeightPropertyOptions.includes(
    draftExtrusionHeightProperty,
  )
    ? extrusionHeightPropertyOptions
    : [draftExtrusionHeightProperty, ...extrusionHeightPropertyOptions].filter(
        Boolean,
      );
  const currentVectorStops = styleValue(style, "vectorStyleStops");
  const vectorStyleSettingsChanged =
    draftVectorStyleMode !== styleValue(style, "vectorStyleMode") ||
    draftVectorStyleProperty !== styleValue(style, "vectorStyleProperty") ||
    draftVectorStyleClassCount !==
      styleValue(style, "vectorStyleClassCount") ||
    draftVectorStyleColorRamp !== styleValue(style, "vectorStyleColorRamp") ||
    draftVectorStyleClassificationScheme !==
      styleValue(style, "vectorStyleClassificationScheme") ||
    draftVectorStyleExpression !== styleValue(style, "vectorStyleExpression") ||
    JSON.stringify(draftVectorStyleStops) !==
      JSON.stringify(currentVectorStops);
  const regenerateDraftVectorStyleStops = (
    mode: VectorStyleMode,
    property: string,
    classCount: number,
    colorRamp: string,
    classificationScheme: string,
  ) => {
    setDraftVectorStyleStops(
      createDefaultStops(
        layer,
        mode,
        property,
        classCount,
        colorRamp,
        classificationScheme,
      ),
    );
  };
  const extrusionSettingsChanged =
    draftExtrusionColor !== styleValue(style, "extrusionColor") ||
    draftExtrusionOpacity !== styleValue(style, "extrusionOpacity") ||
    draftExtrusionHeightProperty !==
      styleValue(style, "extrusionHeightProperty") ||
    draftExtrusionHeightScale !== styleValue(style, "extrusionHeightScale") ||
    draftExtrusionBase !== styleValue(style, "extrusionBase") ||
    draftAdvancedExtrusionEnabled !==
      styleValue(style, "extrusionAdvancedStyleEnabled") ||
    draftColorExpression !== styleValue(style, "extrusionColorExpression") ||
    draftHeightExpression !== styleValue(style, "extrusionHeightExpression");
  const updateDraftVectorStyleMode = (mode: VectorStyleMode) => {
    setDraftVectorStyleMode(mode);
    setVectorStyleError(null);
    if (mode === "graduated" || mode === "categorized") {
      const classCount = normalizeVectorStyleClassCount(
        mode,
        draftVectorStyleClassCount,
      );
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
    const classCount = normalizeVectorStyleClassCount(
      draftVectorStyleMode,
      value,
    );
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
    const classificationScheme = normalizeClassificationScheme(
      draftVectorStyleMode,
      scheme,
    );
    setDraftVectorStyleClassificationScheme(classificationScheme);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      draftVectorStyleClassCount,
      draftVectorStyleColorRamp,
      classificationScheme,
    );
  };
  const updateDraftVectorStyleStop = (
    index: number,
    patch: Partial<VectorStyleStop>,
  ) => {
    setDraftVectorStyleStops((stops) =>
      stops.map((stop, stopIndex) =>
        stopIndex === index ? { ...stop, ...patch } : stop,
      ),
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
    setDraftVectorStyleStops((stops) =>
      stops.filter((_, stopIndex) => stopIndex !== index),
    );
  };
  const applyVectorStyleSettings = () => {
    if (draftVectorStyleMode === "expression") {
      const expressionError = validateExpressionJson(
        draftVectorStyleExpression,
        "Style expression",
      );
      if (expressionError) {
        setVectorStyleError(expressionError);
        return;
      }
    }

    const stops = normalizeVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleStops,
    );
    if (
      (draftVectorStyleMode === "graduated" ||
        draftVectorStyleMode === "categorized") &&
      !draftVectorStyleProperty
    ) {
      setVectorStyleError("Choose an attribute for this style mode.");
      return;
    }
    if (draftVectorStyleMode === "graduated" && stops.length < 2) {
      setVectorStyleError(
        "Graduated style requires at least two numeric stops.",
      );
      return;
    }
    if (draftVectorStyleMode === "categorized" && stops.length === 0) {
      setVectorStyleError("Categorized style requires at least one category.");
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
        "Color expression",
      );
      if (colorError) {
        setExtrusionError(colorError);
        return;
      }

      const heightError = validateExpressionJson(
        draftHeightExpression,
        "Height expression",
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
  const basemapStyleLayerIds =
    mapControllerRef.current?.getBasemapStyleLayerIds() ?? [];
  const otherLayers = layers.filter((l) => l.id !== layer.id);
  const orphanedBeforeId =
    draftBeforeId &&
    !basemapStyleLayerIds.includes(draftBeforeId) &&
    !otherLayers.some((l) => l.id === draftBeforeId)
      ? draftBeforeId
      : null;
  const beforeIdControl = (
    <div className="space-y-2">
      <Label htmlFor="beforeId">Insert before</Label>
      <Select
        id="beforeId"
        value={draftBeforeId}
        onChange={(event) => applyBeforeId(event.target.value)}
      >
        <option value="">Layer order (default)</option>
        {orphanedBeforeId && (
          <optgroup label="Saved (unavailable)">
            <option value={orphanedBeforeId}>{orphanedBeforeId}</option>
          </optgroup>
        )}
        {otherLayers.length > 0 && (
          <optgroup label="Layers">
            {[...otherLayers].reverse().map((otherLayer) => (
              <option key={otherLayer.id} value={otherLayer.id}>
                {otherLayer.name}
              </option>
            ))}
          </optgroup>
        )}
        {basemapStyleLayerIds.length > 0 && (
          <optgroup label="Basemap layers">
            {basemapStyleLayerIds.map((styleLayerId) => (
              <option key={styleLayerId} value={styleLayerId}>
                {styleLayerId}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
  const minZoom = styleValue(style, "minZoom");
  const maxZoom = styleValue(style, "maxZoom");
  const setMinZoom = (value: number) => {
    const next = clampNumber(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: next,
      maxZoom: Math.max(next, maxZoom),
    });
  };
  const setMaxZoom = (value: number) => {
    const next = clampNumber(value, MIN_LAYER_ZOOM, MAX_LAYER_ZOOM);
    setLayerStyle(layer.id, {
      minZoom: Math.min(next, minZoom),
      maxZoom: next,
    });
  };
  const zoomRangeControls = (
    <div className="grid grid-cols-2 gap-3">
      <NumericStyleInput
        id={`${layer.id}-minZoom`}
        label="Min zoom"
        min={MIN_LAYER_ZOOM}
        max={maxZoom}
        step={1}
        value={minZoom}
        onChange={setMinZoom}
      />
      <NumericStyleInput
        id={`${layer.id}-maxZoom`}
        label="Max zoom"
        min={minZoom}
        max={MAX_LAYER_ZOOM}
        step={1}
        value={maxZoom}
        onChange={setMaxZoom}
      />
    </div>
  );
  const usesAttributeSymbology =
    draftVectorStyleMode === "graduated" ||
    draftVectorStyleMode === "categorized";
  const vectorClassificationSchemeOptions =
    draftVectorStyleMode === "categorized"
      ? CATEGORIZED_CLASSIFICATION_SCHEMES
      : GRADUATED_CLASSIFICATION_SCHEMES;
  const vectorClassCountOptions = VECTOR_STYLE_CLASS_COUNTS.filter(
    (classCount) =>
      draftVectorStyleMode === "categorized" ? true : classCount >= 2,
  );
  const colorRampPreview =
    getVectorColorRamp(draftVectorStyleColorRamp).colors;
  const vectorSymbologyControls = (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="vectorStyleMode">Style type</Label>
        <Select
          id="vectorStyleMode"
          value={draftVectorStyleMode}
          onChange={(event) =>
            updateDraftVectorStyleMode(event.target.value as VectorStyleMode)
          }
        >
          <option value="single">Single symbology</option>
          <option value="graduated">Graduated</option>
          <option value="categorized">Categorized</option>
          <option value="expression">Advanced expression</option>
        </Select>
      </div>
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleProperty">Attribute</Label>
          <Select
            id="vectorStyleProperty"
            value={draftVectorStyleProperty}
            onChange={(event) =>
              updateDraftVectorStyleProperty(event.target.value)
            }
            disabled={vectorStylePropertyOptions.length === 0}
          >
            {vectorStylePropertyOptions.length === 0 ? (
              <option value="">No attributes found</option>
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
            <Label htmlFor="vectorStyleClassCount">Classes</Label>
            <Select
              id="vectorStyleClassCount"
              value={String(draftVectorStyleClassCount)}
              onChange={(event) =>
                updateDraftVectorStyleClassCount(Number(event.target.value))
              }
            >
              {vectorClassCountOptions.map((classCount) => (
                <option key={classCount} value={classCount}>
                  {classCount}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vectorStyleClassificationScheme">Scheme</Label>
            <Select
              id="vectorStyleClassificationScheme"
              value={draftVectorStyleClassificationScheme}
              onChange={(event) =>
                updateDraftVectorStyleClassificationScheme(event.target.value)
              }
            >
              {vectorClassificationSchemeOptions.map((scheme) => (
                <option key={scheme.value} value={scheme.value}>
                  {scheme.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleColorRamp">Colormap</Label>
          <Select
            id="vectorStyleColorRamp"
            value={draftVectorStyleColorRamp}
            onChange={(event) =>
              updateDraftVectorStyleColorRamp(event.target.value)
            }
          >
            {VECTOR_COLOR_RAMPS.map((colorRamp) => (
              <option key={colorRamp.value} value={colorRamp.value}>
                {colorRamp.label}
              </option>
            ))}
          </Select>
          <div
            aria-hidden="true"
            className="h-2 rounded-sm border"
            style={{
              background: `linear-gradient(90deg, ${colorRampPreview.join(
                ", ",
              )})`,
            }}
          />
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>
              {draftVectorStyleMode === "graduated" ? "Stops" : "Categories"}
            </Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title="Add class"
              aria-label="Add class"
              onClick={addDraftVectorStyleStop}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="space-y-2">
            {draftVectorStyleStops.map((stop, index) => (
              <div
                key={index}
                className="grid grid-cols-[auto_1fr_2rem] items-center gap-2"
              >
                <ColorField
                  fill={false}
                  aria-label={`Class ${index + 1} color`}
                  eyedropperLabel={`Pick class ${index + 1} color from the screen`}
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
                  title="Remove class"
                  aria-label="Remove class"
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
          <Label htmlFor="vectorStyleExpression">Color expression</Label>
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
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={!vectorStyleSettingsChanged}
        onClick={applyVectorStyleSettings}
      >
        Apply style type
      </Button>
      {vectorStyleError && (
        <p className="text-xs text-destructive">{vectorStyleError}</p>
      )}
    </div>
  );
  const labelControls = (
    <div className="space-y-3">
      <label
        htmlFor="labelsEnabled"
        className="flex items-center gap-2 text-sm font-medium"
      >
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
            <Label htmlFor="labelPlacement">
              {t("style.labels.placement")}
            </Label>
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
              <Label htmlFor="labelColor">
                {t("style.labels.textColor")}
              </Label>
              <ColorField
                id="labelColor"
                value={labels.color}
                onChange={(color) => updateLabels({ color })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelHaloColor">
                {t("style.labels.haloColor")}
              </Label>
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
              onChange={(minZoom) =>
                updateLabels({ minZoom: Math.min(minZoom, labels.maxZoom) })
              }
            />
            <NumericStyleInput
              id="labelMaxZoom"
              label={t("style.labels.maxZoom")}
              min={labels.minZoom}
              max={24}
              step={1}
              value={labels.maxZoom}
              onChange={(maxZoom) =>
                updateLabels({ maxZoom: Math.max(maxZoom, labels.minZoom) })
              }
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
              onChange={(event) =>
                updateLabels({ allowOverlap: event.target.checked })
              }
            />
            {t("style.labels.allowOverlap")}
          </label>
          <div className="space-y-2">
            <Label htmlFor="labelExpression">
              {t("style.labels.expression")}
            </Label>
            <textarea
              id="labelExpression"
              className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
              placeholder={'["concat", ["get", "name"], " (", ["get", "pop"], ")"]'}
              value={labels.expression}
              onChange={(event) =>
                updateLabels({ expression: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("style.labels.expressionHint")}
            </p>
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
            <Label htmlFor="pointRenderer">Point renderer</Label>
            <Select
              id="pointRenderer"
              value={pointRenderer}
              onChange={(event) =>
                setLayerStyle(layer.id, {
                  pointRenderer: event.target.value as PointRenderer,
                })
              }
            >
              <option value="single">Single symbol</option>
              <option value="heatmap">Heatmap</option>
              <option value="cluster">Clustered</option>
            </Select>
          </div>
          {pointRenderer === "heatmap" ? (
            <>
              <NumericStyleInput
                id="heatmapRadius"
                label="Heatmap radius"
                min={1}
                max={100}
                step={1}
                value={styleValue(style, "heatmapRadius")}
                onChange={(heatmapRadius) =>
                  setLayerStyle(layer.id, { heatmapRadius })
                }
              />
              <NumericStyleInput
                id="heatmapIntensity"
                label="Heatmap intensity"
                min={0.1}
                max={5}
                step={0.1}
                value={styleValue(style, "heatmapIntensity")}
                onChange={(heatmapIntensity) =>
                  setLayerStyle(layer.id, { heatmapIntensity })
                }
              />
            </>
          ) : null}
          {pointRenderer === "cluster" ? (
            <>
              <NumericStyleInput
                id="clusterRadius"
                label="Cluster radius (px)"
                min={10}
                max={200}
                step={5}
                value={styleValue(style, "clusterRadius")}
                onChange={(clusterRadius) =>
                  setLayerStyle(layer.id, { clusterRadius })
                }
              />
              <NumericStyleInput
                id="clusterMaxZoom"
                label="Cluster max zoom"
                min={0}
                max={24}
                step={1}
                value={styleValue(style, "clusterMaxZoom")}
                onChange={(clusterMaxZoom) =>
                  setLayerStyle(layer.id, { clusterMaxZoom })
                }
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
          <Label htmlFor="fillColor">Fill color</Label>
          <ColorField
            id="fillColor"
            value={style.fillColor}
            onChange={(fillColor) => setLayerStyle(layer.id, { fillColor })}
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="strokeColor">Outline color</Label>
        <ColorField
          id="strokeColor"
          value={style.strokeColor}
          onChange={(strokeColor) => setLayerStyle(layer.id, { strokeColor })}
        />
      </div>
      <NumericStyleInput
        id="strokeWidth"
        label={strokeWidthInMeters ? "Stroke width (meters)" : "Stroke width"}
        min={0}
        max={strokeWidthInMeters ? 100000 : 20}
        step={strokeWidthInMeters ? 1 : 0.5}
        value={style.strokeWidth}
        onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
      />
      {supportsPointRenderer ? null : (
        <div className="space-y-2">
          <Label htmlFor="strokeWidthUnit">Stroke width unit</Label>
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
            <option value="pixels">Pixels (constant on screen)</option>
            <option value="meters">Meters (scales with map)</option>
          </Select>
        </div>
      )}
      <NumericStyleInput
        id="fillOpacity"
        label="Fill opacity"
        min={0}
        max={1}
        step={0.05}
        value={style.fillOpacity}
        onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
      />
      {isSketchLayer ? null : (
        <NumericStyleInput
          id="circleRadius"
          label="Circle radius"
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
            <Label htmlFor="textColor">Text color</Label>
            <ColorField
              id="textColor"
              value={styleValue(style, "textColor")}
              onChange={(textColor) =>
                setLayerStyle(layer.id, { textColor })
              }
            />
          </div>
          <NumericStyleInput
            id="textSize"
            label="Text size"
            min={6}
            max={96}
            step={1}
            value={styleValue(style, "textSize")}
            onChange={(textSize) => setLayerStyle(layer.id, { textSize })}
          />
          <div className="space-y-2">
            <Label htmlFor="textHaloColor">Text halo color</Label>
            <ColorField
              id="textHaloColor"
              value={styleValue(style, "textHaloColor")}
              onChange={(textHaloColor) =>
                setLayerStyle(layer.id, { textHaloColor })
              }
            />
          </div>
          <NumericStyleInput
            id="textHaloWidth"
            label="Text halo width"
            min={0}
            max={8}
            step={0.5}
            value={styleValue(style, "textHaloWidth")}
            onChange={(textHaloWidth) =>
              setLayerStyle(layer.id, { textHaloWidth })
            }
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
          <Label htmlFor="extrusionColor">Extrusion color</Label>
          <ColorField
            id="extrusionColor"
            value={draftExtrusionColor}
            onChange={(color) => setDraftExtrusionColor(color)}
          />
        </div>
      ) : null}
      <NumericStyleInput
        id="extrusionOpacity"
        label="Extrusion opacity"
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
        Advanced height expression
      </label>
      {draftAdvancedExtrusionEnabled ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionHeightExpression">Height expression</Label>
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
            <Label htmlFor="extrusionHeightProperty">Height property</Label>
            <Select
              id="extrusionHeightProperty"
              value={draftExtrusionHeightProperty}
              onChange={(event) =>
                setDraftExtrusionHeightProperty(event.target.value)
              }
              disabled={extrusionHeightProperties.length === 0}
            >
              {extrusionHeightProperties.length === 0 ? (
                <option value="">No attributes found</option>
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
            label="Height scale"
            min={0}
            max={10000}
            step={0.00001}
            value={draftExtrusionHeightScale}
            onChange={setDraftExtrusionHeightScale}
          />
          <NumericStyleInput
            id="extrusionBase"
            label="Base height"
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
        Apply 3D extrusion
      </Button>
      {extrusionError && (
        <p className="text-xs text-destructive">{extrusionError}</p>
      )}
    </>
  );

  if (hasRasterPaintControls) {
    return (
      <aside aria-label="Layer style" className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">
            Style - {layer.name}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="Collapse style"
            aria-label="Collapse style"
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1 p-3">
          <div className="space-y-4">
            {beforeIdControl}
            {zoomRangeControls}
            <RasterStyleSlider
              label="Opacity"
              value={layer.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setLayerOpacity(layer.id, value)}
            />
            {!isDeckRasterLayer && (
              <>
                <RasterStyleSlider
                  label="Brightness Min"
                  value={styleValue(style, "rasterBrightnessMin")}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) =>
                    setLayerStyle(layer.id, { rasterBrightnessMin: value })
                  }
                />
                <RasterStyleSlider
                  label="Brightness Max"
                  value={styleValue(style, "rasterBrightnessMax")}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) =>
                    setLayerStyle(layer.id, { rasterBrightnessMax: value })
                  }
                />
                <RasterStyleSlider
                  label="Saturation"
                  value={styleValue(style, "rasterSaturation")}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(value) =>
                    setLayerStyle(layer.id, { rasterSaturation: value })
                  }
                />
                <RasterStyleSlider
                  label="Contrast"
                  value={styleValue(style, "rasterContrast")}
                  min={-1}
                  max={1}
                  step={0.05}
                  onChange={(value) =>
                    setLayerStyle(layer.id, { rasterContrast: value })
                  }
                />
                <RasterStyleSlider
                  label="Hue Rotate"
                  value={styleValue(style, "rasterHueRotate")}
                  min={0}
                  max={360}
                  step={1}
                  onChange={(value) =>
                    setLayerStyle(layer.id, { rasterHueRotate: value })
                  }
                  format={(value) => value.toFixed(0)}
                />
              </>
            )}
            {layer.metadata.sourceKind === RASTER_SOURCE_KIND && (
              <RasterSymbologySection layer={layer} />
            )}
          </div>
        </ScrollArea>
        <Separator />
        <p className="p-2 text-[10px] text-muted-foreground">
          {isDeckRasterLayer
            ? "Changes apply live to the raster layer opacity."
            : "Changes apply live to MapLibre raster paint properties."}
        </p>
      </aside>
    );
  }

  if (!hasVectorPaintControls) {
    return (
      <aside aria-label="Layer style" className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">
            Style - {layer.name}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            title="Collapse style"
            aria-label="Collapse style"
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-4 p-3">{beforeIdControl}</div>
        <p className="p-4 text-xs text-muted-foreground">
          Style controls are not available for this layer type yet.
        </p>
        <Separator />
        <p className="p-2 text-[10px] text-muted-foreground">
          Selected layer type: {layer.type}
        </p>
      </aside>
    );
  }

  return (
    <aside aria-label="Layer style" className={STYLE_PANEL_ASIDE_CLASS}>
      {resizeHandle}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-sm font-semibold">
          Style - {layer.name}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          title="Collapse style"
          aria-label="Collapse style"
          onClick={() => setIsCollapsed(true)}
        >
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1 p-3">
        <div className="space-y-4">
          {beforeIdControl}
          {zoomRangeControls}
          {hasExtrusionControls && (
            <div className="space-y-2">
              <Label>Visualization</Label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={!extrusionEnabled}
                    onChange={() => {
                      setExtrusionError(null);
                      setLayerStyle(layer.id, { extrusionEnabled: false });
                    }}
                  />
                  2D
                </label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={extrusionEnabled}
                    onChange={() => {
                      setVectorStyleError(null);
                      setLayerStyle(layer.id, { extrusionEnabled: true });
                    }}
                  />
                  3D extrusion
                </label>
              </div>
            </div>
          )}
          {/* Data-driven coloring doesn't apply to the heatmap renderer. */}
          {pointRenderer === "heatmap" ? null : vectorSymbologyControls}
          {!hasExtrusionControls || !extrusionEnabled ? (
            twoDimensionalControls
          ) : (
            extrusionControls
          )}
          {/* Attribute labels apply to vector features, not the heatmap density
              surface or the 3D extrusion render. */}
          {!extrusionEnabled && pointRenderer !== "heatmap" ? (
            <>
              <Separator />
              <p className="text-sm font-semibold">
                {t("style.labels.heading")}
              </p>
              {labelControls}
            </>
          ) : null}
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {extrusionEnabled
          ? "3D extrusion settings apply when saved."
          : isDeckVectorLayer
            ? "Changes apply live to DuckDB deck.gl layer styling."
            : "Changes apply live to MapLibre paint properties."}
      </p>
    </aside>
  );
}
