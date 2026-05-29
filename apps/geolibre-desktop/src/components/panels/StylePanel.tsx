import { useAppStore } from "@geolibre/core";
import { Button, Input, Label, ScrollArea, Separator } from "@geolibre/ui";
import {
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
  );
}

export function StylePanel() {
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const [isCollapsed, setIsCollapsed] = useState(isMobileViewport);

  const layer = layers.find((l) => l.id === selectedLayerId);

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
      <aside className="flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-64 md:border-l md:border-t-0">
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

  return (
    <aside className="flex max-h-56 w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-64 md:border-l md:border-t-0">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-sm font-semibold">
          Style — {layer.name}
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
