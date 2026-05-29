import {
  DEFAULT_LAYER_STYLE,
  type LayerStyle,
  type LayerType,
  useAppStore,
} from "@geolibre/core";
import { Button, Input, Label, ScrollArea, Separator, Slider } from "@geolibre/ui";
import {
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
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
  return type === "raster" || type === "wms" || type === "xyz";
}

function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
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
  const [isCollapsed, setIsCollapsed] = useState(isMobileViewport);

  const layer = layers.find((l) => l.id === selectedLayerId);

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
      <aside
        className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0"
      >
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
  const hasVectorPaintControls =
    layer.type === "geojson" || layer.type === "vector-tiles";
  const hasRasterPaintControls = isRasterPaintLayer(layer.type);

  if (hasRasterPaintControls) {
    return (
      <aside
        className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0"
      >
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
            <RasterStyleSlider
              label="Opacity"
              value={layer.opacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => setLayerOpacity(layer.id, value)}
            />
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
          </div>
        </ScrollArea>
        <Separator />
        <p className="p-2 text-[10px] text-muted-foreground">
          Changes apply live to MapLibre raster paint properties.
        </p>
      </aside>
    );
  }

  if (!hasVectorPaintControls) {
    return (
      <aside
        className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0"
      >
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
    <aside
      className="relative flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[var(--style-panel-width)] md:border-l md:border-t-0"
    >
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
          <div className="space-y-2">
            <Label htmlFor="strokeWidth">Stroke width</Label>
            <Input
              id="strokeWidth"
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={style.strokeWidth}
              onChange={(e) =>
                setLayerStyle(layer.id, {
                  strokeWidth: Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fillOpacity">Fill opacity</Label>
            <Input
              id="fillOpacity"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={style.fillOpacity}
              onChange={(e) =>
                setLayerStyle(layer.id, {
                  fillOpacity: Number(e.target.value),
                })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="circleRadius">Circle radius</Label>
            <Input
              id="circleRadius"
              type="number"
              min={1}
              max={50}
              step={1}
              value={style.circleRadius}
              onChange={(e) =>
                setLayerStyle(layer.id, {
                  circleRadius: Number(e.target.value),
                })
              }
            />
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        Changes apply live to MapLibre paint properties.
      </p>
    </aside>
  );
}
