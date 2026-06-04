import {
  DEFAULT_LAYER_STYLE,
  type LayerType,
  type VectorStyleMode,
  type VectorStyleStop,
  styleValue,
  useAppStore,
} from "@geolibre/core";
import {
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  Separator,
  Slider,
} from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from "react";

interface StylePanelProps {
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
  );
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

const VECTOR_COLOR_RAMPS = [
  {
    value: "viridis",
    label: "Viridis",
    colors: ["#440154", "#31688e", "#35b779", "#fde725"],
  },
  {
    value: "plasma",
    label: "Plasma",
    colors: ["#0d0887", "#9c179e", "#ed7953", "#f0f921"],
  },
  {
    value: "inferno",
    label: "Inferno",
    colors: ["#000004", "#781c6d", "#ed6925", "#fcffa4"],
  },
  {
    value: "magma",
    label: "Magma",
    colors: ["#000004", "#721f81", "#f1605d", "#fcfdbf"],
  },
  {
    value: "cividis",
    label: "Cividis",
    colors: ["#00204d", "#575d6d", "#a59c74", "#ffea46"],
  },
  {
    value: "turbo",
    label: "Turbo",
    colors: ["#30123b", "#4777ef", "#1ccfd0", "#b9e642", "#fb8022", "#7a0403"],
  },
  {
    value: "spectral",
    label: "Spectral",
    colors: ["#9e0142", "#f46d43", "#ffffbf", "#66c2a5", "#5e4fa2"],
  },
  {
    value: "blues",
    label: "Blues",
    colors: ["#eff6ff", "#93c5fd", "#2563eb", "#1e3a8a"],
  },
  {
    value: "greens",
    label: "Greens",
    colors: ["#f0fdf4", "#86efac", "#16a34a", "#14532d"],
  },
  {
    value: "oranges",
    label: "Oranges",
    colors: ["#fff7ed", "#fdba74", "#f97316", "#7c2d12"],
  },
] as const;

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

function getVectorColorRamp(value: string) {
  return (
    VECTOR_COLOR_RAMPS.find((colorRamp) => colorRamp.value === value) ??
    VECTOR_COLOR_RAMPS[0]
  );
}

function interpolateRampColors(colorRamp: string, count: number): string[] {
  const colors = getVectorColorRamp(colorRamp).colors;
  if (count <= 1) return [colors[colors.length - 1]];
  return Array.from({ length: count }, (_, index) => {
    const scaled = (index / (count - 1)) * (colors.length - 1);
    const lowerIndex = Math.floor(scaled);
    const upperIndex = Math.min(colors.length - 1, Math.ceil(scaled));
    const ratio = scaled - lowerIndex;
    return interpolateHexColor(colors[lowerIndex], colors[upperIndex], ratio);
  });
}

function interpolateHexColor(from: string, to: string, ratio: number): string {
  const start = parseHexColor(from);
  const end = parseHexColor(to);
  return rgbToHex({
    r: Math.round(start.r + (end.r - start.r) * ratio),
    g: Math.round(start.g + (end.g - start.g) * ratio),
    b: Math.round(start.b + (end.b - start.b) * ratio),
  });
}

function parseHexColor(value: string): { b: number; g: number; r: number } {
  const numeric = Number.parseInt(value.slice(1), 16);
  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  };
}

function rgbToHex(color: { b: number; g: number; r: number }): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function createEqualIntervalBreaks(
  min: number,
  max: number,
  count: number,
): number[] {
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 0 : index / (count - 1);
    return min + (max - min) * ratio;
  });
}

function createQuantileBreaks(values: number[], count: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return Array.from({ length: count }, (_, index) => {
    const position =
      count === 1 ? 0 : (index / (count - 1)) * (sorted.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(sorted.length - 1, Math.ceil(position));
    const ratio = position - lowerIndex;
    return (
      sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * ratio
    );
  });
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
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (typeof next === "number") onChange(next);
        }}
      />
    </div>
  );
}

export function StylePanel({ onResizeStart }: StylePanelProps) {
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const [isCollapsed, setIsCollapsed] = useState(isMobileViewport);
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

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Style panel"
      className="absolute -left-1 top-0 z-20 hidden h-full w-2 cursor-col-resize select-none border-l border-transparent hover:border-primary md:block"
      onMouseDown={onResizeStart}
    />
  );

  if (isCollapsed) {
    return (
      <aside className="flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-l md:border-t-0 md:py-2">
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
      <aside className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0">
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
    layer.metadata.sourceKind === "stac-search-cog";
  const isDeckVectorLayer = hasExternalDeckLayer(layer);
  const isRasterTileLayer = layer.metadata.tileType === "raster";
  const isThreeDTilesLayer = layer.type === "3d-tiles";
  const hasVectorPaintControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "mbtiles" ||
      hasExternalNativeLayers(layer) ||
      hasExternalDeckLayer(layer));
  const hasExtrusionControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    supportsExtrusionControls(layer);
  const hasRasterPaintControls =
    isRasterPaintLayer(layer.type) || isRasterTileLayer;
  const extrusionEnabled = styleValue(style, "extrusionEnabled");
  const extrusionHeightPropertyOptions = getAttributePropertyNames(layer);
  const vectorStylePropertyOptions = extrusionHeightPropertyOptions;
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
  const applyBeforeId = () => {
    updateLayer(layer.id, {
      beforeId: draftBeforeId.trim() || undefined,
    });
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
  const beforeIdControl = (
    <div className="space-y-2">
      <Label htmlFor="beforeId">Before ID</Label>
      <Input
        id="beforeId"
        value={draftBeforeId}
        placeholder="MapLibre layer ID"
        onChange={(event) => setDraftBeforeId(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          applyBeforeId();
        }}
      />
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
                className="grid grid-cols-[2.25rem_1fr_2rem] items-center gap-2"
              >
                <Input
                  type="color"
                  aria-label={`Class ${index + 1} color`}
                  className="h-9 p-1"
                  value={stop.color}
                  onChange={(event) =>
                    updateDraftVectorStyleStop(index, {
                      color: event.target.value,
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
  const twoDimensionalControls = (
    <>
      {draftVectorStyleMode === "single" ? (
        <div className="space-y-2">
          <Label htmlFor="fillColor">Fill color</Label>
          <Input
            id="fillColor"
            type="color"
            value={style.fillColor}
            onChange={(e) =>
              setLayerStyle(layer.id, { fillColor: e.target.value })
            }
          />
        </div>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="strokeColor">Outline color</Label>
        <Input
          id="strokeColor"
          type="color"
          value={style.strokeColor}
          onChange={(e) =>
            setLayerStyle(layer.id, { strokeColor: e.target.value })
          }
        />
      </div>
      <NumericStyleInput
        id="strokeWidth"
        label="Stroke width"
        min={0}
        max={20}
        step={0.5}
        value={style.strokeWidth}
        onChange={(strokeWidth) => setLayerStyle(layer.id, { strokeWidth })}
      />
      <NumericStyleInput
        id="fillOpacity"
        label="Fill opacity"
        min={0}
        max={1}
        step={0.05}
        value={style.fillOpacity}
        onChange={(fillOpacity) => setLayerStyle(layer.id, { fillOpacity })}
      />
      <NumericStyleInput
        id="circleRadius"
        label="Circle radius"
        min={1}
        max={50}
        step={1}
        value={style.circleRadius}
        onChange={(circleRadius) => setLayerStyle(layer.id, { circleRadius })}
      />
    </>
  );
  const extrusionControls = (
    <>
      {draftVectorStyleMode === "single" ? (
        <div className="space-y-2">
          <Label htmlFor="extrusionColor">Extrusion color</Label>
          <Input
            id="extrusionColor"
            type="color"
            value={draftExtrusionColor}
            onChange={(event) => setDraftExtrusionColor(event.target.value)}
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
      <aside className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0">
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
      <aside className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0">
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
    <aside className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0">
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
          {vectorSymbologyControls}
          {!hasExtrusionControls || !extrusionEnabled ? (
            twoDimensionalControls
          ) : (
            extrusionControls
          )}
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
