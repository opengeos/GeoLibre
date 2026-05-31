import {
  DEFAULT_LAYER_STYLE,
  type LayerStyle,
  type LayerType,
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
  SlidersHorizontal,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useState,
} from "react";

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
    type === "raster" ||
    type === "wms" ||
    type === "wmts" ||
    type === "xyz"
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

function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

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
  const [expressionError, setExpressionError] = useState<string | null>(null);

  const layer = layers.find((l) => l.id === selectedLayerId);

  useEffect(() => {
    if (!layer) {
      setDraftBeforeId("");
      setDraftColorExpression("");
      setDraftHeightExpression("");
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
      setExpressionError(null);
      return;
    }

    setDraftBeforeId(layer.beforeId ?? "");
    setDraftColorExpression(
      styleValue(layer.style, "extrusionColorExpression"),
    );
    setDraftHeightExpression(
      styleValue(layer.style, "extrusionHeightExpression"),
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
    setExpressionError(null);
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
  const hasVectorPaintControls =
    !isRasterTileLayer &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "mbtiles" ||
      hasExternalNativeLayers(layer) ||
      hasExternalDeckLayer(layer));
  const hasExtrusionControls =
    !isRasterTileLayer &&
    supportsExtrusionControls(layer);
  const hasRasterPaintControls =
    isRasterPaintLayer(layer.type) || isRasterTileLayer;
  const extrusionEnabled = styleValue(style, "extrusionEnabled");
  const extrusionHeightPropertyOptions = getAttributePropertyNames(layer);
  const extrusionHeightProperties = extrusionHeightPropertyOptions.includes(
    draftExtrusionHeightProperty,
  )
    ? extrusionHeightPropertyOptions
    : [
        draftExtrusionHeightProperty,
        ...extrusionHeightPropertyOptions,
      ].filter(Boolean);
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
        setExpressionError(colorError);
        return;
      }

      const heightError = validateExpressionJson(
        draftHeightExpression,
        "Height expression",
      );
      if (heightError) {
        setExpressionError(heightError);
        return;
      }
    }

    setExpressionError(null);
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
        <div className="p-3">{beforeIdControl}</div>
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
          {hasExtrusionControls && (
            <div className="space-y-2">
              <Label>Visualization</Label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={!extrusionEnabled}
                    onChange={() =>
                      setLayerStyle(layer.id, { extrusionEnabled: false })
                    }
                  />
                  2D
                </label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={extrusionEnabled}
                    onChange={() =>
                      setLayerStyle(layer.id, { extrusionEnabled: true })
                    }
                  />
                  3D extrusion
                </label>
              </div>
            </div>
          )}
          {(!hasExtrusionControls || !extrusionEnabled) ? (
            <>
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
              <div className="space-y-2">
                <Label htmlFor="strokeColor">Stroke color</Label>
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
                onChange={(strokeWidth) =>
                  setLayerStyle(layer.id, { strokeWidth })
                }
              />
              <NumericStyleInput
                id="fillOpacity"
                label="Fill opacity"
                min={0}
                max={1}
                step={0.05}
                value={style.fillOpacity}
                onChange={(fillOpacity) =>
                  setLayerStyle(layer.id, { fillOpacity })
                }
              />
              <NumericStyleInput
                id="circleRadius"
                label="Circle radius"
                min={1}
                max={50}
                step={1}
                value={style.circleRadius}
                onChange={(circleRadius) =>
                  setLayerStyle(layer.id, { circleRadius })
                }
              />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="extrusionColor">Extrusion color</Label>
                <Input
                  id="extrusionColor"
                  type="color"
                  value={draftExtrusionColor}
                  onChange={(event) =>
                    setDraftExtrusionColor(event.target.value)
                  }
                />
              </div>
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
                    setExpressionError(null);
                  }}
                />
                Advanced expressions
              </label>
              {draftAdvancedExtrusionEnabled ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="extrusionColorExpression">
                      Color expression
                    </Label>
                    <textarea
                      id="extrusionColorExpression"
                      className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
                      value={draftColorExpression}
                      onChange={(event) => {
                        setDraftColorExpression(event.target.value);
                        setExpressionError(null);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="extrusionHeightExpression">
                      Height expression
                    </Label>
                    <textarea
                      id="extrusionHeightExpression"
                      className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
                      value={draftHeightExpression}
                      onChange={(event) => {
                        setDraftHeightExpression(event.target.value);
                        setExpressionError(null);
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="extrusionHeightProperty">
                      Height property
                    </Label>
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
                    step={0.1}
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
              {expressionError && (
                <p className="text-xs text-destructive">{expressionError}</p>
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
            </>
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
