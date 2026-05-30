import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useState,
} from "react";
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
  GripVertical,
  Info,
  Layers,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  ZoomIn,
} from "lucide-react";

interface LayerPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

const BACKGROUND_SELECTION_ID = "__geolibre-background__";

function layerTypeLabel(layer: GeoLibreLayer): string {
  if (layer.type === "geojson" || layer.type === "vector-tiles") {
    return "vector";
  }
  return layer.type;
}

function hasNativeIdentifyLayers(layer: GeoLibreLayer): boolean {
  if (layer.metadata.identifiable === false) return false;

  return (
    Array.isArray(layer.metadata.nativeLayerIds) &&
    layer.metadata.nativeLayerIds.length > 0
  );
}

function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
  );
}

export function LayerPanel({
  mapControllerRef,
  onResizeStart,
}: LayerPanelProps) {
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const setBasemapVisible = useAppStore((s) => s.setBasemapVisible);
  const setBasemapOpacity = useAppStore((s) => s.setBasemapOpacity);
  const setLayerVisibility = useAppStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const reorderLayer = useAppStore((s) => s.reorderLayer);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const removeLayer = useAppStore((s) => s.removeLayer);
  const [metadataLayer, setMetadataLayer] = useState<GeoLibreLayer | null>(
    null,
  );
  const [layerPendingRemoval, setLayerPendingRemoval] =
    useState<GeoLibreLayer | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(isMobileViewport);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropTargetLayerId, setDropTargetLayerId] = useState<string | null>(
    null,
  );
  const visibleLayers = [...layers].reverse();
  const backgroundSelected = selectedLayerId === BACKGROUND_SELECTION_ID;
  const allLayersVisible =
    basemapVisible && layers.every((layer) => layer.visible);
  const toggleAllLayers = () => {
    const nextVisible = !allLayersVisible;
    for (const layer of layers) {
      setLayerVisibility(layer.id, nextVisible);
    }
    setBasemapVisible(nextVisible);
  };
  const draggedDisplayIndex = draggedLayerId
    ? visibleLayers.findIndex((layer) => layer.id === draggedLayerId)
    : -1;

  const resetDragState = () => {
    setDraggedLayerId(null);
    setDropTargetLayerId(null);
  };

  const handleLayerDragStart = (
    event: ReactDragEvent<HTMLElement>,
    layerId: string,
  ) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
    setDraggedLayerId(layerId);
  };

  const handleLayerDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    layerId: string,
  ) => {
    if (!draggedLayerId || draggedLayerId === layerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetLayerId(layerId);
  };

  const handleLayerDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    layerId: string,
    displayIndex: number,
  ) => {
    if (!draggedLayerId || draggedLayerId === layerId) {
      resetDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveLayer(draggedLayerId, layers.length - 1 - displayIndex);
    resetDragState();
  };

  if (isCollapsed) {
    return (
      <aside className="flex h-11 w-full shrink-0 items-center gap-2 border-b bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-b-0 md:border-r md:py-2">
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
        <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
          <Layers className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
            Layers
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex max-h-56 w-full shrink-0 flex-col border-b bg-card md:max-h-none md:w-[var(--layer-panel-width)] md:border-b-0 md:border-r">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Layers panel"
        className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize select-none border-r border-transparent hover:border-primary md:block"
        onMouseDown={onResizeStart}
      />
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-sm font-semibold">Layers</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={allLayersVisible ? "Hide all layers" : "Show all layers"}
            aria-label={
              allLayersVisible ? "Hide all layers" : "Show all layers"
            }
            onClick={toggleAllLayers}
          >
            {allLayersVisible ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
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
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {layers.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No data layers. Add data from the toolbar.
            </p>
          )}
          {visibleLayers.map((layer, displayIndex) => {
            const canIdentify =
              layer.type === "geojson" ||
              layer.type === "vector-tiles" ||
              (layer.type === "mbtiles" &&
                layer.metadata.tileType === "vector") ||
              hasNativeIdentifyLayers(layer);
            const identifyActive = identifyLayerId === layer.id;
            return (
              <div
                key={layer.id}
                className={`relative rounded-md border p-2 transition-colors ${
                  selectedLayerId === layer.id
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
                } ${draggedLayerId === layer.id ? "opacity-50" : ""}`}
                onDragOver={(e) => handleLayerDragOver(e, layer.id)}
                onDrop={(e) => handleLayerDrop(e, layer.id, displayIndex)}
                onDragEnd={resetDragState}
                onClick={() => selectLayer(layer.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") selectLayer(layer.id);
                }}
                role="button"
                tabIndex={0}
              >
                {dropTargetLayerId === layer.id &&
                  draggedDisplayIndex > displayIndex && (
                    <div className="pointer-events-none absolute -top-1 left-2 right-2 h-1 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" />
                  )}
                {dropTargetLayerId === layer.id &&
                  draggedDisplayIndex >= 0 &&
                  draggedDisplayIndex < displayIndex && (
                    <div className="pointer-events-none absolute -bottom-1 left-2 right-2 h-1 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" />
                  )}
                <div className="flex items-center gap-1">
                  <span
                    role="button"
                    tabIndex={0}
                    draggable
                    title="Drag to reorder"
                    aria-label={`Drag ${layer.name} to reorder`}
                    className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                    onClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => handleLayerDragStart(e, layer.id)}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
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
                    {layerTypeLabel(layer)}
                  </span>
                </div>
                {isPlaceholderLayer(layer) && (
                  <p className="mt-1 text-[10px] text-amber-600">
                    {placeholderMessage(layer)}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">
                    Opacity
                  </span>
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
                      mapControllerRef.current?.fitLayer(layer);
                    }}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`h-7 w-7 ${
                      identifyActive
                        ? "border border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground"
                        : ""
                    }`}
                    title={
                      canIdentify
                        ? identifyActive
                          ? "Deactivate identify"
                          : "Identify features"
                        : "Identify is only available for vector layers"
                    }
                    disabled={!canIdentify}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canIdentify) return;
                      selectLayer(layer.id);
                      setIdentifyLayer(identifyActive ? null : layer.id);
                    }}
                  >
                    <MousePointerClick className="h-3.5 w-3.5" />
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
                    title="Remove layer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setLayerPendingRemoval(layer);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
          <div
            className={`rounded-md border p-2 transition-colors ${
              backgroundSelected
                ? "border-primary bg-primary/5"
                : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
            }`}
            onClick={() => selectLayer(BACKGROUND_SELECTION_ID)}
            onKeyDown={(e) => {
              if (e.key === "Enter") selectLayer(BACKGROUND_SELECTION_ID);
            }}
            role="button"
            tabIndex={0}
          >
            <div className="flex items-center gap-1">
              <span
                title="Background cannot be reordered"
                className="rounded p-0.5 text-muted-foreground/50"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted"
                title={basemapVisible ? "Hide background" : "Show background"}
                aria-label={
                  basemapVisible ? "Hide background" : "Show background"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setBasemapVisible(!basemapVisible);
                }}
              >
                {basemapVisible ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate text-sm font-medium">
                Background
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">
                basemap
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Opacity</span>
              <Slider
                className="flex-1"
                min={0}
                max={1}
                step={0.05}
                value={[basemapOpacity]}
                onValueChange={([v]) => setBasemapOpacity(v ?? basemapOpacity)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {/* TODO(v0.3): Add PMTiles, COG, FlatGeobuf, GeoParquet layer types */}
        Advanced formats: see docs/roadmap.md
      </p>
      <Dialog
        open={!!metadataLayer}
        onOpenChange={(open) => {
          if (!open) setMetadataLayer(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{metadataLayer?.name} Metadata</DialogTitle>
            <DialogDescription>
              Layer metadata and source information
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-80">
            <pre className="whitespace-pre-wrap break-all text-xs">
              {metadataLayer &&
                JSON.stringify(
                  {
                    ...metadataLayer.metadata,
                    sourcePath: metadataLayer.sourcePath,
                  },
                  null,
                  2,
                )}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!layerPendingRemoval}
        onOpenChange={(open) => {
          if (!open) setLayerPendingRemoval(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove layer?</DialogTitle>
            <DialogDescription>
              This removes {layerPendingRemoval?.name ?? "this layer"} from the
              project and map.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLayerPendingRemoval(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (!layerPendingRemoval) return;
                removeLayer(layerPendingRemoval.id);
                setLayerPendingRemoval(null);
              }}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
