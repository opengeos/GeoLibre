import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isDuckDBQueryLayer, useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { canEditLayerGeometry } from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import { isPlaceholderLayer, placeholderMessage } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  ScrollArea,
  Separator,
  Select,
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
  MoreHorizontal,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilRuler,
  RefreshCw,
  Table2,
  Timer,
  Trash2,
  ZoomIn,
} from "lucide-react";
import {
  getLayerRefreshConfig,
  isRefreshableLayer,
  MIN_REFRESH_INTERVAL_MS,
  refreshGeoJsonLayer,
  setLayerRefreshConfig,
} from "../../lib/layer-refresh";

interface LayerPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** Id of the layer currently in a geometry-edit session, or null. */
  geometryEditLayerId: string | null;
  /** Toggle in-place geometry editing for a layer (toggling off saves). */
  onToggleGeometryEdit: (layerId: string) => void;
  /** Discard the active geometry-edit session without saving. */
  onCancelGeometryEdit: () => void;
  /** Materialize a DuckDB query layer into an editable GeoJSON layer. */
  onMaterializeDuckDBLayer: (layer: GeoLibreLayer) => void;
}

const BACKGROUND_SELECTION_ID = "__geolibre-background__";

const REFRESH_INTERVAL_OPTIONS = [
  { label: "Off", intervalMs: 0 },
  { label: "15 seconds", intervalMs: 15_000 },
  { label: "30 seconds", intervalMs: 30_000 },
  { label: "1 minute", intervalMs: 60_000 },
  { label: "5 minutes", intervalMs: 5 * 60_000 },
  { label: "15 minutes", intervalMs: 15 * 60_000 },
];
const CUSTOM_REFRESH_INTERVAL_VALUE = "custom";
const REFRESH_STATUS_DURATION_MS = 4_000;

type LayerRefreshStatus = {
  type: "refreshing" | "success" | "error";
  message: string;
};

type LayerRefreshTimer = {
  intervalMs: number;
  timer: number;
};

function layerTypeLabel(layer: GeoLibreLayer): string {
  if (layer.type === "geojson" || layer.type === "vector-tiles") {
    return "vector";
  }
  return layer.type;
}

function refreshIntervalOptionValue(intervalMs: number): string {
  if (
    REFRESH_INTERVAL_OPTIONS.some((option) => option.intervalMs === intervalMs)
  ) {
    return String(intervalMs);
  }
  return CUSTOM_REFRESH_INTERVAL_VALUE;
}

function customRefreshIntervalSeconds(intervalMs: number): string {
  if (intervalMs <= 0) return "";
  return String(Math.round(intervalMs / 1000));
}

function parseCustomRefreshIntervalMs(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(seconds * 1000));
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
  geometryEditLayerId,
  onToggleGeometryEdit,
  onCancelGeometryEdit,
  onMaterializeDuckDBLayer,
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
  const updateLayer = useAppStore((s) => s.updateLayer);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [metadataLayer, setMetadataLayer] = useState<GeoLibreLayer | null>(
    null,
  );
  const [layerPendingRemoval, setLayerPendingRemoval] =
    useState<GeoLibreLayer | null>(null);
  const [refreshSettingsLayerId, setRefreshSettingsLayerId] = useState<
    string | null
  >(null);
  const [refreshStatuses, setRefreshStatuses] = useState<
    Record<string, LayerRefreshStatus>
  >({});
  const [refreshIntervalChoice, setRefreshIntervalChoice] = useState("0");
  const [customRefreshSeconds, setCustomRefreshSeconds] = useState("");
  const [isCollapsed, setIsCollapsed] = useState(isMobileViewport);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropTargetLayerId, setDropTargetLayerId] = useState<string | null>(
    null,
  );
  // Ending a rename (commit or cancel) clears the editing state, which
  // unmounts the focused input. React then delivers that input's onBlur (the
  // browser's native blur on the removed element) to commitRename from the
  // pre-update closure, which would re-commit the edit. This ref, read
  // synchronously by commitRename, suppresses that stray blur commit. It is
  // reset in beginRename so a flag left set by a cancel whose blur never fired
  // cannot leak into the next rename session.
  const suppressBlurCommitRef = useRef(false);
  const refreshingLayerIdsRef = useRef(new Set<string>());
  const refreshTimersRef = useRef(new Map<string, LayerRefreshTimer>());
  const refreshStatusTimersRef = useRef(new Map<string, number>());
  const visibleLayers = [...layers].reverse();
  const refreshSettingsLayer = refreshSettingsLayerId
    ? (layers.find((layer) => layer.id === refreshSettingsLayerId) ?? null)
    : null;
  const refreshSettingsConfig = refreshSettingsLayer
    ? getLayerRefreshConfig(refreshSettingsLayer)
    : null;
  const refreshSettingsIntervalMs = refreshSettingsConfig
    ? refreshSettingsConfig.enabled
      ? refreshSettingsConfig.intervalMs
      : 0
    : null;
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
  const customRefreshIntervalMs = parseCustomRefreshIntervalMs(
    customRefreshSeconds,
  );

  const resetDragState = () => {
    setDraggedLayerId(null);
    setDropTargetLayerId(null);
  };

  const beginRename = (layer: GeoLibreLayer) => {
    // Clear any flag left set by a prior cancel/commit whose blur never fired,
    // so it cannot swallow the first commit of this rename session.
    suppressBlurCommitRef.current = false;
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const commitRename = () => {
    if (suppressBlurCommitRef.current || !editingLayerId) {
      suppressBlurCommitRef.current = false;
      return;
    }
    // Suppress the onBlur that fires when clearing editing state unmounts the
    // input, so the edit is not committed a second time from the stale closure.
    suppressBlurCommitRef.current = true;
    const trimmed = editingName.trim();
    const current = layers.find((l) => l.id === editingLayerId);
    if (trimmed && current && trimmed !== current.name) {
      updateLayer(editingLayerId, { name: trimmed });
    }
    setEditingLayerId(null);
    setEditingName("");
  };

  const cancelRename = () => {
    suppressBlurCommitRef.current = true;
    setEditingLayerId(null);
    setEditingName("");
  };

  const clearRefreshStatusTimer = useCallback((layerId: string) => {
    const timer = refreshStatusTimersRef.current.get(layerId);
    if (!timer) return;
    window.clearTimeout(timer);
    refreshStatusTimersRef.current.delete(layerId);
  }, []);

  const scheduleStatusClear = useCallback(
    (layerId: string) => {
      clearRefreshStatusTimer(layerId);
      const timer = window.setTimeout(() => {
        refreshStatusTimersRef.current.delete(layerId);
        setRefreshStatuses((current) => {
          // Keep in-flight statuses; only fade finished success/error notes.
          if (!current[layerId] || current[layerId].type === "refreshing") {
            return current;
          }
          const next = { ...current };
          delete next[layerId];
          return next;
        });
      }, REFRESH_STATUS_DURATION_MS);
      refreshStatusTimersRef.current.set(layerId, timer);
    },
    [clearRefreshStatusTimer],
  );

  const handleRefreshLayer = useCallback(
    async (layer: GeoLibreLayer, automatic = false) => {
      if (refreshingLayerIdsRef.current.has(layer.id)) return;

      refreshingLayerIdsRef.current.add(layer.id);
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "refreshing",
          message: automatic ? "Auto refreshing..." : "Refreshing...",
        },
      }));

      try {
        const { geojson, featureCount } = await refreshGeoJsonLayer(layer);
        const latest = useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;

        updateLayer(layer.id, {
          geojson,
          metadata: {
            ...latest.metadata,
            featureCount,
          },
        });

        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: {
            type: "success",
            message: `Refreshed ${featureCount.toLocaleString()} features.`,
          },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not refresh this layer.";
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: {
            type: "error",
            message,
          },
        }));
        scheduleStatusClear(layer.id);
      } finally {
        refreshingLayerIdsRef.current.delete(layer.id);
      }
    },
    [clearRefreshStatusTimer, scheduleStatusClear, updateLayer],
  );

  // Read through a ref inside interval callbacks so long-lived timers never
  // capture a stale handleRefreshLayer closure.
  const handleRefreshLayerRef = useRef(handleRefreshLayer);
  useEffect(() => {
    handleRefreshLayerRef.current = handleRefreshLayer;
  }, [handleRefreshLayer]);

  useEffect(() => {
    if (
      refreshSettingsLayerId &&
      !layers.some((layer) => layer.id === refreshSettingsLayerId)
    ) {
      setRefreshSettingsLayerId(null);
    }

    if (
      editingLayerId &&
      !layers.some((layer) => layer.id === editingLayerId)
    ) {
      setEditingLayerId(null);
      setEditingName("");
    }

    const layerIds = new Set(layers.map((layer) => layer.id));
    for (const id of refreshStatusTimersRef.current.keys()) {
      if (!layerIds.has(id)) clearRefreshStatusTimer(id);
    }
    setRefreshStatuses((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of Object.keys(next)) {
        if (!layerIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [clearRefreshStatusTimer, editingLayerId, layers, refreshSettingsLayerId]);

  useEffect(() => {
    if (refreshSettingsIntervalMs === null) {
      setRefreshIntervalChoice("0");
      setCustomRefreshSeconds("");
      return;
    }

    setRefreshIntervalChoice(
      refreshIntervalOptionValue(refreshSettingsIntervalMs),
    );
    setCustomRefreshSeconds(
      refreshIntervalOptionValue(refreshSettingsIntervalMs) ===
        CUSTOM_REFRESH_INTERVAL_VALUE
        ? customRefreshIntervalSeconds(refreshSettingsIntervalMs)
        : "",
    );
  }, [refreshSettingsLayerId, refreshSettingsIntervalMs]);

  useEffect(() => {
    const activeLayerIds = new Set<string>();

    for (const layer of layers) {
      const config = getLayerRefreshConfig(layer);
      if (!config.enabled || !isRefreshableLayer(layer)) continue;

      activeLayerIds.add(layer.id);
      const existing = refreshTimersRef.current.get(layer.id);
      if (existing?.intervalMs === config.intervalMs) continue;

      if (existing) window.clearInterval(existing.timer);
      const timer = window.setInterval(() => {
        const latest = useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;

        const latestConfig = getLayerRefreshConfig(latest);
        if (!latestConfig.enabled || !isRefreshableLayer(latest)) return;
        void handleRefreshLayerRef.current(latest, true);
      }, config.intervalMs);

      refreshTimersRef.current.set(layer.id, {
        intervalMs: config.intervalMs,
        timer,
      });
    }

    for (const [id, entry] of refreshTimersRef.current) {
      if (activeLayerIds.has(id)) continue;
      window.clearInterval(entry.timer);
      refreshTimersRef.current.delete(id);
    }
  }, [layers]);

  useEffect(() => {
    return () => {
      for (const entry of refreshTimersRef.current.values()) {
        window.clearInterval(entry.timer);
      }
      refreshTimersRef.current.clear();
      for (const timer of refreshStatusTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      refreshStatusTimersRef.current.clear();
    };
  }, []);

  const setRefreshInterval = useCallback(
    (layer: GeoLibreLayer, intervalMs: number) => {
      // Read the latest layer from the store so a concurrent refresh's
      // metadata (e.g. featureCount) is not overwritten by a stale snapshot.
      const latest =
        useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === layer.id) ?? layer;
      updateLayer(
        layer.id,
        setLayerRefreshConfig(latest, {
          enabled: intervalMs > 0,
          intervalMs,
        }),
      );
    },
    [updateLayer],
  );

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
    <aside className="relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-b bg-card md:max-h-none md:w-[var(--layer-panel-width)] md:border-b-0 md:border-r">
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
              isDuckDBQueryLayer(layer) ||
              (layer.type === "wms" &&
                typeof layer.source.layers === "string" &&
                Boolean(layer.source.layers.trim()) &&
                Boolean(
                  (typeof layer.source.url === "string" &&
                    layer.source.url.trim()) ||
                    layer.sourcePath,
                )) ||
              layer.type === "vector-tiles" ||
              (layer.type === "mbtiles" &&
                layer.metadata.tileType === "vector") ||
              hasNativeIdentifyLayers(layer);
            const identifyActive = identifyLayerId === layer.id;
            const canEditGeometry = canEditLayerGeometry(layer);
            const geometryEditActive = geometryEditLayerId === layer.id;
            const geometryEditElsewhere =
              geometryEditLayerId !== null && !geometryEditActive;
            const canMaterializeDuckDB =
              isDuckDBQueryLayer(layer) &&
              typeof layer.metadata.query === "string";
            const canRefresh = isRefreshableLayer(layer);
            const refreshConfig = getLayerRefreshConfig(layer);
            const refreshStatus = refreshStatuses[layer.id];
            const isRefreshing = refreshStatus?.type === "refreshing";
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
                    onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                    onDragStart={(e) => handleLayerDragStart(e, layer.id)}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    title={layer.visible ? "Hide layer" : "Show layer"}
                    aria-label={layer.visible ? "Hide layer" : "Show layer"}
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
                  {editingLayerId === layer.id ? (
                    <input
                      autoFocus
                      type="text"
                      className="flex-1 min-w-0 rounded border border-input bg-background px-1 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
                      value={editingName}
                      aria-label={`Rename ${layer.name}`}
                      onChange={(e) => setEditingName(e.target.value)}
                      onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="flex-1 truncate text-sm font-medium"
                      title="Double-click to rename"
                      onDoubleClick={(e: ReactMouseEvent) => {
                        e.stopPropagation();
                        beginRename(layer);
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {layerTypeLabel(layer)}
                  </span>
                </div>
                {isPlaceholderLayer(layer) && (
                  <p className="mt-1 text-[10px] text-amber-600">
                    {placeholderMessage(layer)}
                  </p>
                )}
                {refreshStatus && (
                  <p
                    className={`mt-1 text-[10px] ${
                      refreshStatus.type === "error"
                        ? "text-destructive"
                        : refreshStatus.type === "success"
                          ? "text-emerald-600"
                          : "text-muted-foreground"
                    }`}
                  >
                    {refreshStatus.message}
                  </p>
                )}
                {geometryEditActive && (
                  <div className="mt-1 flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-1">
                    <PencilRuler className="h-3 w-3 text-primary" />
                    <span className="flex-1 text-[10px] font-medium text-primary">
                      Editing geometry
                    </span>
                    <Button
                      variant="default"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      title="Save geometry edits"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleGeometryEdit(layer.id);
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px]"
                      title="Discard geometry edits"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelGeometryEdit();
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
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
                    onValueChange={([v]: number[]) =>
                      setLayerOpacity(layer.id, v ?? layer.opacity)
                    }
                    onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                  />
                </div>
                <div className="mt-2 flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Move up"
                    aria-label="Move up"
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
                    aria-label="Move down"
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
                    aria-label="Zoom to layer"
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
                        ? "border border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 hover:text-primary-foreground"
                        : ""
                    }`}
                    title={
                      canIdentify
                        ? identifyActive
                          ? "Deactivate identify"
                          : "Identify features"
                        : "Identify is only available for vector and WMS layers"
                    }
                    aria-label={
                      canIdentify
                        ? identifyActive
                          ? "Deactivate identify"
                          : "Identify features"
                        : "Identify is only available for vector and WMS layers"
                    }
                    disabled={!canIdentify || geometryEditActive}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canIdentify) return;
                      selectLayer(layer.id);
                      setIdentifyLayer(identifyActive ? null : layer.id);
                    }}
                  >
                    <MousePointerClick className="h-3.5 w-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-7 w-7 ${
                          refreshConfig.enabled
                            ? "border border-primary text-primary"
                            : ""
                        }`}
                        title="Layer actions"
                        aria-label="Layer actions"
                        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                    >
                      {/* Rename is always available — name is a display-only
                          label, so no per-layer-type guard is needed here.
                          preventDefault keeps the menu's default close from
                          racing autoFocus on the rename input. */}
                      <DropdownMenuItem
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          beginRename(layer);
                        }}
                      >
                        <Pencil className="mr-2 h-3.5 w-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {canMaterializeDuckDB && (
                        <>
                          <DropdownMenuItem
                            onSelect={(e: Event) => {
                              e.preventDefault();
                              onMaterializeDuckDBLayer(layer);
                            }}
                          >
                            <Table2 className="mr-2 h-3.5 w-3.5" />
                            Materialize to editable layer
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      {(canEditGeometry || geometryEditActive) && (
                        <DropdownMenuItem
                          disabled={geometryEditElsewhere}
                          onSelect={(e: Event) => {
                            e.preventDefault();
                            selectLayer(layer.id);
                            if (identifyActive) setIdentifyLayer(null);
                            onToggleGeometryEdit(layer.id);
                          }}
                        >
                          <PencilRuler className="mr-2 h-3.5 w-3.5" />
                          {geometryEditActive
                            ? "Finish editing geometry"
                            : "Edit geometry"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={!canRefresh || isRefreshing}
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          void handleRefreshLayer(layer);
                        }}
                      >
                        <RefreshCw
                          className={`mr-2 h-3.5 w-3.5 ${
                            isRefreshing ? "animate-spin" : ""
                          }`}
                        />
                        Refresh
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!canRefresh}
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          setRefreshSettingsLayerId(layer.id);
                        }}
                      >
                        <Timer className="mr-2 h-3.5 w-3.5" />
                        {refreshConfig.enabled
                          ? "Auto refresh on"
                          : "Auto refresh"}
                      </DropdownMenuItem>
                      {!canRefresh && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem disabled>
                            WFS and GeoJSON URLs only
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Metadata"
                    aria-label="Metadata"
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
                    aria-label="Remove layer"
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
                onValueChange={([v]: number[]) => setBasemapOpacity(v ?? basemapOpacity)}
                onClick={(e: ReactMouseEvent) => e.stopPropagation()}
              />
            </div>
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {/* TODO(v0.3): Add native PMTiles, COG, and FlatGeobuf layer types */}
        Advanced formats: see docs/roadmap.md
      </p>
      <Dialog
        open={!!refreshSettingsLayerId}
        onOpenChange={(open: boolean) => {
          if (!open) setRefreshSettingsLayerId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {refreshSettingsLayer?.name ?? "Layer"} Auto Refresh
            </DialogTitle>
            <DialogDescription>
              Reload this layer from its source on a fixed interval.
            </DialogDescription>
          </DialogHeader>
          {refreshSettingsLayer && (
            <div className="space-y-3">
              <Label htmlFor="layer-refresh-interval">Interval</Label>
              <Select
                id="layer-refresh-interval"
                value={refreshIntervalChoice}
                onChange={(event) => {
                  const value = event.target.value;
                  setRefreshIntervalChoice(value);
                  if (value === CUSTOM_REFRESH_INTERVAL_VALUE) {
                    const current = getLayerRefreshConfig(refreshSettingsLayer);
                    setCustomRefreshSeconds(
                      customRefreshIntervalSeconds(current.intervalMs),
                    );
                    return;
                  }
                  setCustomRefreshSeconds("");
                  setRefreshInterval(refreshSettingsLayer, Number(value));
                }}
              >
                {REFRESH_INTERVAL_OPTIONS.map((option) => (
                  <option key={option.intervalMs} value={option.intervalMs}>
                    {option.label}
                  </option>
                ))}
                <option value={CUSTOM_REFRESH_INTERVAL_VALUE}>Custom</option>
              </Select>
              {refreshIntervalChoice === CUSTOM_REFRESH_INTERVAL_VALUE && (
                <div className="space-y-2">
                  <Label htmlFor="layer-refresh-custom-seconds">
                    Custom interval (seconds)
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="layer-refresh-custom-seconds"
                      type="number"
                      min="1"
                      step="1"
                      value={customRefreshSeconds}
                      onChange={(event) =>
                        setCustomRefreshSeconds(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          !refreshSettingsLayer ||
                          !customRefreshIntervalMs
                        ) {
                          return;
                        }
                        setRefreshInterval(
                          refreshSettingsLayer,
                          customRefreshIntervalMs,
                        );
                      }}
                    />
                    <Button
                      type="button"
                      disabled={!customRefreshIntervalMs}
                      onClick={() => {
                        if (!customRefreshIntervalMs) return;
                        setRefreshInterval(
                          refreshSettingsLayer,
                          customRefreshIntervalMs,
                        );
                      }}
                    >
                      Apply
                    </Button>
                  </div>
                  {!customRefreshIntervalMs && customRefreshSeconds.trim() && (
                    <p className="text-xs text-destructive">
                      Enter a positive number of seconds.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRefreshSettingsLayerId(null)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!metadataLayer}
        onOpenChange={(open: boolean) => {
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
        onOpenChange={(open: boolean) => {
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
