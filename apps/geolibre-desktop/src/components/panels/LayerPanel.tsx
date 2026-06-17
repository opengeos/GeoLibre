import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { isDuckDBQueryLayer, useAppStore } from "@geolibre/core";
import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";
import {
  canEditLayerGeometry,
  reloadVectorControlLayer,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import { isPlaceholderLayer, placeholderMessage } from "@geolibre/map";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  ChevronRight,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
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
  TableProperties,
  Timer,
  Trash2,
  ZoomIn,
} from "lucide-react";
import {
  getLayerRefreshConfig,
  isRefreshableLayer,
  isVectorControlRefreshLayer,
  MIN_REFRESH_INTERVAL_MS,
  refreshGeoJsonLayer,
  setLayerRefreshConfig,
} from "../../lib/layer-refresh";
import {
  canExportRasterLayer,
  exportRasterLayer,
} from "../../lib/raster-export";
import {
  exportVectorLayer,
  geojsonVectorSourceId,
  resolveLayerGeojson,
  sanitizeExportFileName,
  shapefileFieldWarnings,
  type VectorExportFormat,
} from "../../lib/vector-export";

interface LayerPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
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
  type: "refreshing" | "success" | "error" | "warning";
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

export function LayerPanel({
  mapControllerRef,
  onResizeStart,
  geometryEditLayerId,
  onToggleGeometryEdit,
  onCancelGeometryEdit,
  onMaterializeDuckDBLayer,
}: LayerPanelProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const removeLayerGroup = useAppStore((s) => s.removeLayerGroup);
  const renameLayerGroup = useAppStore((s) => s.renameLayerGroup);
  const setLayerGroupVisibility = useAppStore((s) => s.setLayerGroupVisibility);
  const setLayerGroupOpacity = useAppStore((s) => s.setLayerGroupOpacity);
  const toggleLayerGroupCollapsed = useAppStore(
    (s) => s.toggleLayerGroupCollapsed,
  );
  const moveLayerToGroup = useAppStore((s) => s.moveLayerToGroup);
  const reorderLayerGroup = useAppStore((s) => s.reorderLayerGroup);
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
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
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
  const [isCollapsed, setIsCollapsed] = useState(getIsMobileViewport);
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropTargetLayerId, setDropTargetLayerId] = useState<string | null>(
    null,
  );
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(
    null,
  );
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  // Ending a rename (commit or cancel) clears the editing state, which
  // unmounts the focused input. React then delivers that input's onBlur (the
  // browser's native blur on the removed element) to commitRename from the
  // pre-update closure, which would re-commit the edit. This ref, read
  // synchronously by commitRename, suppresses that stray blur commit. It is
  // reset in beginRename so a flag left set by a cancel whose blur never fired
  // cannot leak into the next rename session.
  const suppressBlurCommitRef = useRef(false);
  // Same stray-blur guard as suppressBlurCommitRef, for the group rename input.
  const suppressGroupBlurCommitRef = useRef(false);
  const refreshingLayerIdsRef = useRef(new Set<string>());
  const refreshTimersRef = useRef(new Map<string, LayerRefreshTimer>());
  const refreshStatusTimersRef = useRef(new Map<string, number>());
  const visibleLayers = useMemo(() => [...layers].reverse(), [layers]);
  // Group lookup + the top-most member of each group in display order. Members
  // are kept contiguous in `layers`, so the first occurrence walking the
  // reversed list is where the group's header is drawn inline. Memoized so they
  // are not rebuilt on renders caused by unrelated state (hover, slider drag).
  const groupById = useMemo(
    () => new Map(layerGroups.map((g) => [g.id, g] as const)),
    [layerGroups],
  );
  const firstMemberIdByGroup = useMemo(() => {
    const map = new Map<string, string>();
    for (const layer of visibleLayers) {
      if (layer.groupId && !map.has(layer.groupId)) {
        map.set(layer.groupId, layer.id);
      }
    }
    return map;
  }, [visibleLayers]);
  // Empty folders have no member to anchor them, so they render pinned at the
  // top of the panel where they are easy to drop layers into.
  const emptyGroups = useMemo(
    () => layerGroups.filter((g) => !firstMemberIdByGroup.has(g.id)),
    [layerGroups, firstMemberIdByGroup],
  );
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
    setDropTargetGroupId(null);
  };

  const beginGroupRename = (group: LayerGroup) => {
    // Clear any flag left set by a prior cancel/commit whose blur never fired,
    // so it cannot swallow the first commit of this rename session.
    suppressGroupBlurCommitRef.current = false;
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const commitGroupRename = () => {
    if (suppressGroupBlurCommitRef.current || !editingGroupId) {
      suppressGroupBlurCommitRef.current = false;
      return;
    }
    // Suppress the onBlur that fires when clearing editing state unmounts the
    // input, so the edit is not committed a second time from the stale closure.
    suppressGroupBlurCommitRef.current = true;
    const trimmed = editingGroupName.trim();
    const current = layerGroups.find((g) => g.id === editingGroupId);
    if (trimmed && current && trimmed !== current.name) {
      renameLayerGroup(editingGroupId, trimmed);
    }
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const cancelGroupRename = () => {
    suppressGroupBlurCommitRef.current = true;
    setEditingGroupId(null);
    setEditingGroupName("");
  };

  const handleCreateGroup = () => {
    const id = addLayerGroup();
    // Open the new (empty) folder's name for editing right away.
    const group = useAppStore
      .getState()
      .layerGroups.find((g) => g.id === id);
    if (group) beginGroupRename(group);
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
        if (isVectorControlRefreshLayer(layer)) {
          const info = await reloadVectorControlLayer(layer.id);
          if (!info) {
            // The control is unavailable (panel never opened, or torn down
            // and not yet replayed) or no longer knows this layer id.
            // Automatic ticks fire on a timer the user didn't initiate, so
            // skip silently and clear the transient note instead of surfacing
            // an error every interval until the control comes back.
            if (automatic) {
              setRefreshStatuses((current) => {
                if (!current[layer.id]) return current;
                const next = { ...current };
                delete next[layer.id];
                return next;
              });
              return;
            }
            throw new Error(
              "Could not refresh this layer. Try re-opening the Add Vector Layer panel.",
            );
          }
          // reloadLayer fires `layerupdated`, which drives
          // syncVectorLayersToStore to persist the refreshed featureCount (and
          // bounds) into the store. We intentionally don't call updateLayer
          // here: the metadata write is handled by that event, and a second
          // write would risk clobbering the synced values. `info` feeds only
          // the toast below.
          const featureCount =
            typeof info.featureCount === "number" ? info.featureCount : null;
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message:
                featureCount === null
                  ? "Refreshed."
                  : `Refreshed ${featureCount.toLocaleString()} features.`,
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
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

  const handleExportLayer = useCallback(
    async (layer: GeoLibreLayer, format: VectorExportFormat) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (!geojson) {
          // A source-backed (Add Vector Layer) layer whose features could not be
          // read is usually a not-yet-ready map source, not a layer that lacks
          // features, so the two cases get different diagnostics.
          const message =
            geojsonVectorSourceId(layer) !== null
              ? "Layer data is not ready yet. Try again in a moment."
              : "Export requires a vector layer with features.";
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const savedPath = await exportVectorLayer(
          geojson,
          format,
          sanitizeExportFileName(layer.name),
        );
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          // Surface Shapefile field-name limitations so renamed/merged
          // attributes do not come as a surprise to QGIS/ArcGIS users.
          const warnings =
            format === "shapefile" ? shapefileFieldWarnings(geojson) : [];
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              warnings.length > 0
                ? {
                    type: "warning",
                    message: `Layer exported. ${warnings.join(" ")}`,
                  }
                : { type: "success", message: "Layer exported." },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Could not export this layer.";
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear],
  );

  const handleExportRasterLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const savedPath = await exportRasterLayer(
          layer,
          sanitizeExportFileName(layer.name),
        );
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.exportRasterSuccess"),
            },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t("layers.exportRasterError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, scheduleStatusClear, t],
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
    setDropTargetGroupId(null);
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
    const dragged = layers.find((l) => l.id === draggedLayerId);
    const target = layers.find((l) => l.id === layerId);
    const draggedGroupId = dragged?.groupId ?? null;
    const targetGroupId = target?.groupId ?? null;
    if (draggedGroupId === targetGroupId) {
      // Same group (or both top-level): a plain reorder keeps contiguity.
      moveLayer(draggedLayerId, layers.length - 1 - displayIndex);
    } else {
      // Crossing a group boundary: adopt the target's group and land next to it.
      moveLayerToGroup(draggedLayerId, targetGroupId, layerId);
    }
    resetDragState();
  };

  const handleGroupHeaderDragOver = (
    event: ReactDragEvent<HTMLDivElement>,
    groupId: string,
  ) => {
    if (!draggedLayerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetGroupId(groupId);
    setDropTargetLayerId(null);
  };

  const handleGroupHeaderDrop = (
    event: ReactDragEvent<HTMLDivElement>,
    groupId: string,
  ) => {
    if (!draggedLayerId) {
      resetDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveLayerToGroup(draggedLayerId, groupId);
    resetDragState();
  };

  const renderGroupHeader = (group: LayerGroup) => {
    const isDropTarget = dropTargetGroupId === group.id;
    // Empty folders have no members in the flat `layers` array, so
    // reorderLayerGroup cannot move them; disable the reorder actions for them.
    const canReorderGroup = firstMemberIdByGroup.has(group.id);
    return (
      <div
        data-group-header=""
        data-testid="layer-group-header"
        data-group-name={group.name}
        className={`rounded-md border p-2 transition-colors ${
          isDropTarget
            ? "border-primary bg-primary/10"
            : "border-border bg-muted/30 hover:border-muted-foreground/40"
        }`}
        onDragOver={(e) => handleGroupHeaderDragOver(e, group.id)}
        onDrop={(e) => handleGroupHeaderDrop(e, group.id)}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            title={
              group.collapsed
                ? t("layers.expandGroup")
                : t("layers.collapseGroup")
            }
            aria-label={
              group.collapsed
                ? t("layers.expandGroup")
                : t("layers.collapseGroup")
            }
            aria-expanded={!group.collapsed}
            onClick={(e) => {
              e.stopPropagation();
              toggleLayerGroupCollapsed(group.id);
            }}
          >
            {group.collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-muted"
            title={group.visible ? t("layers.hideGroup") : t("layers.showGroup")}
            aria-label={
              group.visible ? t("layers.hideGroup") : t("layers.showGroup")
            }
            onClick={(e) => {
              e.stopPropagation();
              setLayerGroupVisibility(group.id, !group.visible);
            }}
          >
            {group.visible ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
          {group.collapsed ? (
            <Folder className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {editingGroupId === group.id ? (
            <input
              autoFocus
              type="text"
              className="flex-1 min-w-0 rounded border border-input bg-background px-1 py-0.5 text-sm font-semibold outline-none focus:ring-1 focus:ring-ring"
              value={editingGroupName}
              aria-label={t("layers.renameNamed", { name: group.name })}
              onChange={(e) => setEditingGroupName(e.target.value)}
              onClick={(e: ReactMouseEvent) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={commitGroupRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitGroupRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelGroupRename();
                }
              }}
            />
          ) : (
            <span
              className="flex-1 truncate text-sm font-semibold"
              title={t("layers.doubleClickToRename")}
              onDoubleClick={(e: ReactMouseEvent) => {
                e.stopPropagation();
                beginGroupRename(group);
              }}
            >
              {group.name}
            </span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("layers.groupActions")}
                aria-label={t("layers.groupActions")}
                onClick={(e: ReactMouseEvent) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onClick={(e: ReactMouseEvent) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onSelect={(e: Event) => {
                  e.preventDefault();
                  beginGroupRename(group);
                }}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                {t("layers.renameGroup")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canReorderGroup}
                onSelect={(e: Event) => {
                  e.preventDefault();
                  reorderLayerGroup(group.id, "up");
                }}
              >
                <ChevronUp className="mr-2 h-3.5 w-3.5" />
                {t("layers.moveGroupUp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canReorderGroup}
                onSelect={(e: Event) => {
                  e.preventDefault();
                  reorderLayerGroup(group.id, "down");
                }}
              >
                <ChevronDown className="mr-2 h-3.5 w-3.5" />
                {t("layers.moveGroupDown")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e: Event) => {
                  e.preventDefault();
                  removeLayerGroup(group.id);
                }}
              >
                <FolderMinus className="mr-2 h-3.5 w-3.5" />
                {t("layers.ungroupKeepLayers")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={(e: Event) => {
                  e.preventDefault();
                  removeLayerGroup(group.id, { removeChildren: true });
                }}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {t("layers.deleteGroupAndLayers")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {!group.collapsed && (
          <div className="mt-2 flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">
              {t("layers.groupOpacity")}
            </span>
            <Slider
              aria-label={t("layers.groupOpacityAria", { name: group.name })}
              className="flex-1"
              min={0}
              max={1}
              step={0.05}
              value={[group.opacity]}
              onValueChange={([v]: number[]) =>
                setLayerGroupOpacity(group.id, v ?? group.opacity)
              }
              onClick={(e: ReactMouseEvent) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    );
  };

  if (isCollapsed) {
    return (
      <aside
        aria-label="Layers (collapsed)"
        className="flex h-11 w-full shrink-0 items-center gap-2 border-b bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-b-0 md:border-r md:py-2"
      >
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
    <aside
      aria-label="Layers"
      className="relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-b bg-card max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--layer-panel-width)] md:border-b-0 md:border-r"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Layers panel"
        className="absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-r border-transparent hover:border-primary md:block"
        onPointerDown={onResizeStart}
      />
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-sm font-semibold">Layers</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("layers.newGroup")}
            aria-label={t("layers.newGroup")}
            onClick={handleCreateGroup}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
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
          {emptyGroups.map((group) => (
            <Fragment key={group.id}>{renderGroupHeader(group)}</Fragment>
          ))}
          {visibleLayers.map((layer, displayIndex) => {
            const group = layer.groupId
              ? groupById.get(layer.groupId)
              : undefined;
            const isFirstOfGroup = group
              ? firstMemberIdByGroup.get(group.id) === layer.id
              : false;
            const groupCollapsed = group?.collapsed ?? false;
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
            // The attribute table reads features from geojson layers (including
            // Add Vector Layer geojson-mode) and DuckDB query layers.
            const canOpenAttributeTable =
              layer.type === "geojson" || isDuckDBQueryLayer(layer);
            // Export writes the layer's GeoJSON features to disk; only
            // geojson-backed vector layers carry those features.
            const canExportLayer = layer.type === "geojson";
            // Raster/COG layers backed by a downloadable file (a retained
            // local-bytes blob URL or a source URL) export to GeoTIFF.
            const canExportRaster = canExportRasterLayer(layer);
            const canRefresh = isRefreshableLayer(layer);
            const refreshConfig = getLayerRefreshConfig(layer);
            const refreshStatus = refreshStatuses[layer.id];
            const isRefreshing = refreshStatus?.type === "refreshing";
            return (
              <Fragment key={layer.id}>
                {isFirstOfGroup && group && renderGroupHeader(group)}
                {!groupCollapsed && (
              <div
                data-layer-card=""
                data-testid="layer-row"
                data-layer-name={layer.name}
                className={`relative rounded-md border p-2 transition-colors ${
                  selectedLayerId === layer.id
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
                } ${draggedLayerId === layer.id ? "opacity-50" : ""} ${
                  group ? "ml-4" : ""
                }`}
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
                          : refreshStatus.type === "warning"
                            ? "text-amber-600"
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
                    aria-label={`Opacity for ${layer.name}`}
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
                      <DropdownMenuItem
                        onSelect={(e: Event) => {
                          e.preventDefault();
                          addLayerGroup(undefined, [layer.id]);
                        }}
                      >
                        <FolderPlus className="mr-2 h-3.5 w-3.5" />
                        {t("layers.newGroupFromLayer")}
                      </DropdownMenuItem>
                      {layerGroups.length > 0 && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Folder className="h-3.5 w-3.5" />
                            {t("layers.moveToGroup")}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {layerGroups.map((g) => (
                              <DropdownMenuItem
                                key={g.id}
                                disabled={layer.groupId === g.id}
                                onSelect={(e: Event) => {
                                  e.preventDefault();
                                  moveLayerToGroup(layer.id, g.id);
                                }}
                              >
                                {g.name}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      {layer.groupId && (
                        <DropdownMenuItem
                          onSelect={(e: Event) => {
                            e.preventDefault();
                            moveLayerToGroup(layer.id, null);
                          }}
                        >
                          <FolderMinus className="mr-2 h-3.5 w-3.5" />
                          {t("layers.removeFromGroup")}
                        </DropdownMenuItem>
                      )}
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
                      {canOpenAttributeTable && (
                        <DropdownMenuItem
                          onSelect={(e: Event) => {
                            e.preventDefault();
                            selectLayer(layer.id);
                            setAttributeTableOpen(true);
                          }}
                        >
                          <TableProperties className="mr-2 h-3.5 w-3.5" />
                          Open attribute table
                        </DropdownMenuItem>
                      )}
                      {canExportLayer && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Download className="h-3.5 w-3.5" />
                            Export
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportLayer(layer, "geojson");
                              }}
                            >
                              GeoJSON
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportLayer(layer, "geoparquet");
                              }}
                            >
                              GeoParquet
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportLayer(layer, "geopackage");
                              }}
                            >
                              GeoPackage
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportLayer(layer, "shapefile");
                              }}
                            >
                              Shapefile (zipped)
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportLayer(layer, "csv");
                              }}
                            >
                              CSV (attributes only)
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      {canExportRaster && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Download className="h-3.5 w-3.5" />
                            Export
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem
                              onSelect={(e: Event) => {
                                e.preventDefault();
                                void handleExportRasterLayer(layer);
                              }}
                            >
                              {t("layers.exportGeoTiff")}
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
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
                )}
              </Fragment>
            );
          })}
          <div
            data-layer-card=""
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
                aria-label="Basemap opacity"
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
