import { useState } from "react";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { isPlaceholderLayer, placeholderMessage } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  ScrollArea,
  Separator,
  Slider,
} from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Info,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  ZoomIn,
} from "lucide-react";

interface LayerPanelProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

export function LayerPanel({ mapControllerRef }: LayerPanelProps) {
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const setLayerVisibility = useAppStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const reorderLayer = useAppStore((s) => s.reorderLayer);
  const removeLayer = useAppStore((s) => s.removeLayer);
  const [metadataLayer, setMetadataLayer] = useState<GeoLibreLayer | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  if (isCollapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center border-r bg-card py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Expand layers"
          aria-label="Expand layers"
          onClick={() => setIsCollapsed(false)}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <div className="mt-3 flex flex-col items-center gap-2 text-muted-foreground">
          <Layers className="h-4 w-4" />
          <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] font-semibold uppercase tracking-wide">
            Layers
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-sm font-semibold">Layers</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Collapse layers"
          aria-label="Collapse layers"
          onClick={() => setIsCollapsed(true)}
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {layers.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No layers. Add GeoJSON from the toolbar.
            </p>
          )}
          {[...layers].reverse().map((layer) => (
            <div
              key={layer.id}
              className={`rounded-md border p-2 ${
                selectedLayerId === layer.id
                  ? "border-primary bg-primary/5"
                  : "border-transparent bg-muted/30"
              }`}
              onClick={() => selectLayer(layer.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") selectLayer(layer.id);
              }}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-muted"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLayerVisibility(layer.id, !layer.visible);
                  }}
                >
                  {layer.visible ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
                <span className="flex-1 truncate text-sm font-medium">
                  {layer.name}
                </span>
                <span className="text-[10px] uppercase text-muted-foreground">
                  {layer.type}
                </span>
              </div>
              {isPlaceholderLayer(layer) && (
                <p className="mt-1 text-[10px] text-amber-600">
                  {placeholderMessage(layer)}
                </p>
              )}
              <div className="mt-2 flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground">Opacity</span>
                <Slider
                  className="flex-1"
                  min={0}
                  max={1}
                  step={0.05}
                  value={[layer.opacity]}
                  onValueChange={([v]) =>
                    setLayerOpacity(layer.id, v ?? layer.opacity)
                  }
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="mt-2 flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Move up"
                  onClick={(e) => {
                    e.stopPropagation();
                    reorderLayer(layer.id, "up");
                  }}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Move down"
                  onClick={(e) => {
                    e.stopPropagation();
                    reorderLayer(layer.id, "down");
                  }}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Zoom to layer"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (layer.geojson) {
                      mapControllerRef.current?.fitLayer(layer);
                    } else {
                      // TODO(v0.3): zoom to layer for non-GeoJSON types
                      console.info("Zoom to layer not available for this type");
                    }
                  }}
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Metadata"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMetadataLayer(layer);
                  }}
                >
                  <Info className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeLayer(layer.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {/* TODO(v0.3): Add PMTiles, COG, FlatGeobuf, GeoParquet layer types */}
        Advanced formats: see docs/roadmap.md
      </p>
      <Dialog open={!!metadataLayer} onOpenChange={(open) => { if (!open) setMetadataLayer(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{metadataLayer?.name} Metadata</DialogTitle>
            <DialogDescription>Layer metadata and source information</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80">
            <pre className="whitespace-pre-wrap break-all text-xs">
              {metadataLayer && JSON.stringify(
                { ...metadataLayer.metadata, sourcePath: metadataLayer.sourcePath },
                null,
                2,
              )}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
