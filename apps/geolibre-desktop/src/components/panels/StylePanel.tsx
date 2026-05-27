import { useAppStore } from "@geolibre/core";
import { Input, Label, ScrollArea, Separator } from "@geolibre/ui";

export function StylePanel() {
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);

  const layer = layers.find((l) => l.id === selectedLayerId);

  if (!layer) {
    return (
      <aside className="flex w-64 shrink-0 flex-col border-l bg-card">
        <div className="border-b px-3 py-2 text-sm font-semibold">Style</div>
        <p className="p-4 text-xs text-muted-foreground">
          Select a layer to edit its style.
        </p>
      </aside>
    );
  }

  const { style } = layer;

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l bg-card">
      <div className="border-b px-3 py-2 text-sm font-semibold">
        Style — {layer.name}
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
