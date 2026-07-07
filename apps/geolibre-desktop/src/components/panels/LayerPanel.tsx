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
import type { TFunction } from "i18next";
import { isDuckDBQueryLayer, useAppStore } from "@geolibre/core";
import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildTimeBinding,
  canEditLayerGeometry,
  detectTimeProperties,
  getLayerTimeBinding,
  RASTER_SOURCE_KIND,
  reloadVectorControlLayer,
  SKETCHES_SOURCE_KIND,
  TIME_SLIDER_PLUGIN_ID,
  type TimePropertyCandidate,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import {
  applyMapboxStyleImport,
  applySldImport,
  buildMapboxStyle,
  buildSld,
  isPlaceholderLayer,
  mapboxStyleToJson,
  parseMapboxStyle,
  parseSld,
  placeholderMessage,
} from "@geolibre/map";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { activeInterfaceProfile } from "../../lib/ui-profile";
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
  CalendarClock,
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
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilRuler,
  RefreshCw,
  Save,
  SquarePen,
  Table2,
  TableProperties,
  Timer,
  Trash2,
  Upload,
  ZoomIn,
} from "lucide-react";
import { clamp } from "../../lib/clamp";
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
import {
  openLocalDataFileWithFallback,
  saveTextFileWithFallback,
} from "../../lib/tauri-io";
import {
  readPostgisTable,
  writePostgisTable,
  writeVectorToSource,
} from "@geolibre/processing";
import {
  postgisBaselineKeys,
  postgisFeatureKeys,
  resolvePostgisConnection,
  unregisterPostgisConnection,
} from "../../lib/postgis-connections";
import { isTauri } from "../../lib/is-tauri";
import { BasemapPickerDialog } from "./BasemapPickerDialog";
import { LayerPanelPlaceSearch } from "./LayerPanelPlaceSearch";

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
  /** Open the floating Add Raster Layer panel for advanced raster styling. */
  onOpenRasterStylePanel: () => void;
  /**
   * When this flips to `true` the panel collapses to its thin rail (it is not
   * unmounted). Used to clear room for a story map presentation; the user can
   * still expand it again, and the prior state is restored when it flips off.
   */
  autoCollapse?: boolean;
  /**
   * Controlled collapse state for the shared left-sidebar (`replace-layers`)
   * mode. When defined, the panel's own collapse state is ignored and the parent
   * fully owns expand/collapse (the buttons call {@link onCollapsedChange} and
   * `autoCollapse` no longer applies). Mirrors StylePanel. Leave undefined for
   * the standalone panel.
   */
  collapsed?: boolean;
  /** Notify the parent of a collapse/expand request in controlled mode. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * In the shared left-sidebar mode, suppress the panel's own collapsed rail:
   * when collapsed the panel renders nothing because a single shared rail (owned
   * by the host) lists the Layers entry instead of two adjacent rails.
   */
  hideOwnRail?: boolean;
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

function layerTypeLabel(
  layer: GeoLibreLayer,
  t: TFunction,
): string {
  if (layer.metadata?.sourceKind === "maplibre-basemap-control") {
    return t("layers.typeBasemap");
  }
  if (layer.type === "geojson" || layer.type === "vector-tiles") {
    return "vector";
  }
  return layer.type;
}

function sourceUrlsFromLayer(layer: GeoLibreLayer): string[] {
  if (layer.type !== "video" || !Array.isArray(layer.source.urls)) {
    return [];
  }
  return layer.source.urls.filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

// Source formats whose in-place write-back the sidecar supports today. Kept in
// sync with the backend gate in `app/vector.py` (_WRITABLE_EXTENSIONS).
const WRITEBACK_EXTENSIONS = ["gpkg", "geojson", "json"];

/**
 * Whether the layer is an editable PostGIS table with a usable primary key
 * (loaded via Add Data > PostgreSQL in editable mode). The sidecar diffs the
 * features against the source table by that key on save.
 */
function isPostgisEditableLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.metadata.sourceKind === "postgis-table" &&
    typeof layer.metadata.postgisTable === "string" &&
    typeof layer.metadata.postgisPrimaryKey === "string"
  );
}

/**
 * Whether the layer's edits can be committed back to its source: a
 * desktop-only, geojson-backed layer loaded either from a local file in a
 * supported format or from a PostGIS table with a primary key. The sidecar
 * needs real filesystem/database access, so this is false on the web build.
 */
function canWriteEditsToSource(layer: GeoLibreLayer): boolean {
  if (!isTauri() || layer.type !== "geojson") return false;
  if (isPostgisEditableLayer(layer)) return true;
  const path =
    typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? WRITEBACK_EXTENSIONS.includes(ext) : false;
}

function layerMetadataPayload(layer: GeoLibreLayer): Record<string, unknown> {
  const videoSourceUrls = sourceUrlsFromLayer(layer);
  return {
    ...layer.metadata,
    layerName: layer.name,
    layerType: layer.type,
    ...(videoSourceUrls.length > 0
      ? {
          sourceUrl: videoSourceUrls[0],
          ...(videoSourceUrls[1]
            ? { fallbackSourceUrl: videoSourceUrls[1] }
            : {}),
        }
      : {}),
    sourcePath: layer.sourcePath,
  };
}

interface LayerOpacitySliderProps {
  label: string;
  ariaLabel: string;
  value: number;
  onChange: (value: number) => void;
}

// Opacity control for the layer panel cards: a compact slider paired with a
// value readout that, on double-click, swaps to an inline numeric input so the
// user can type an exact value instead of dragging to it. This mirrors the
// Style panel's RasterStyleSlider (#832) to keep interaction parity between the
// two panels (#838). Enter/blur commits the clamped value, Escape cancels.
function LayerOpacitySlider({
  label,
  ariaLabel,
  value,
  onChange,
}: LayerOpacitySliderProps) {
  const { t } = useTranslation();
  const min = 0;
  const max = 1;
  const step = 0.05;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Guard so each edit session commits (or cancels) at most once: Enter and
  // Escape both tear down the input, and React still fires onBlur on the
  // unmounting element. Without this, blur would re-commit after Enter or
  // commit a cancelled draft after Escape.
  const handledRef = useRef(false);

  const commit = (raw: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const parsed = Number(raw);
    // Treat an empty/whitespace entry like Escape: cancel rather than commit 0
    // (Number("") === 0 would otherwise silently reset the slider to its min).
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Number(clamp(parsed, min, max).toFixed(2)));
    }
    setEditing(false);
  };

  const cancel = () => {
    handledRef.current = true;
    setEditing(false);
  };

  const startEditing = () => {
    // The slider stays mounted while editing, so a second double-click on its
    // track must not re-enter and clobber the in-progress draft (the value
    // button is unmounted while editing, so it cannot re-trigger this).
    if (editing) return;
    handledRef.current = false;
    setDraft(value.toFixed(2));
    setEditing(true);
  };

  return (
    <div className="mt-2 flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <Slider
        aria-label={ariaLabel}
        className="flex-1"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]: number[]) => onChange(v ?? value)}
        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
        onDoubleClick={(e: ReactMouseEvent) => {
          e.stopPropagation();
          startEditing();
        }}
      />
      {editing ? (
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          autoFocus
          aria-label={t("layers.opacityValueInputAria", { label: ariaLabel })}
          className="h-6 w-12 px-1 py-0 text-right font-mono text-[10px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="w-9 shrink-0 cursor-text text-right font-mono text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
          title={t("layers.opacityExactHint")}
          aria-label={t("layers.opacityValueEditAria", { label: ariaLabel })}
          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
          onDoubleClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            startEditing();
          }}
        >
          {value.toFixed(2)}
        </button>
      )}
    </div>
  );
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
  onOpenRasterStylePanel,
  autoCollapse = false,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  hideOwnRail = false,
}: LayerPanelProps) {
  const { t } = useTranslation();
  const isBeginnerProfile = useDesktopSettingsStore(
    (s) => activeInterfaceProfile(s.desktopSettings.uiProfile) === "beginner",
  );
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
  const setLoadEditorFeaturesOpen = useAppStore(
    (s) => s.setLoadEditorFeaturesOpen,
  );
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [basemapPickerOpen, setBasemapPickerOpen] = useState(false);
  // Transient note shown when the user double-clicks the Background name (the
  // rename gesture on every other layer). The background name is fixed, so
  // instead of staying silent we surface a short-lived message explaining why
  // (#838). The timer ref clears it after the standard status duration.
  const [backgroundNameNotice, setBackgroundNameNotice] = useState(false);
  const backgroundNoticeTimerRef = useRef<number | null>(null);
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
  // Time Slider binding dialog: the target layer, the detected timestamp
  // columns, the chosen property, and the window width. `candidates` is null
  // while the layer's features are still being inspected.
  const [bindTimeSliderLayerId, setBindTimeSliderLayerId] = useState<
    string | null
  >(null);
  const [bindCandidates, setBindCandidates] = useState<
    TimePropertyCandidate[] | null
  >(null);
  const [bindProperty, setBindProperty] = useState("");
  const [bindWindowMode, setBindWindowMode] = useState<
    "step" | "wide" | "wider"
  >("step");
  // Feature collection resolved when the bind dialog opens, reused on confirm so
  // a large layer is scanned only once.
  const [bindLayerGeojson, setBindLayerGeojson] =
    useState<FeatureCollection | null>(null);
  // Shown in the dialog when binding fails (e.g. the chosen property has no
  // parseable timestamps) instead of closing the dialog with no feedback.
  const [bindError, setBindError] = useState<string | null>(null);
  // Monotonic token for the active bind request. Each open/close bumps it, so a
  // stale async scan or confirm (even for the same layer reopened) is dropped
  // when it no longer matches the latest token.
  const bindRequestRef = useRef(0);
  const { isActive: isPluginActive, toggle: togglePlugin } =
    usePluginRegistry();
  const [internalCollapsed, setInternalCollapsed] = useState(getIsMobileViewport);
  // In the shared left-sidebar mode the parent owns collapse (controlled);
  // otherwise the panel manages it locally. `setIsCollapsed` routes to whichever
  // owner applies so every existing call site keeps working.
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;
  const setIsCollapsed = useCallback(
    (value: boolean) => {
      if (isControlled) onCollapsedChange?.(value);
      else setInternalCollapsed(value);
    },
    [isControlled, onCollapsedChange],
  );
  // Collapse to the rail when `autoCollapse` flips on (a story map starts
  // presenting), and restore the prior expand/collapse state when it flips back
  // off. Both act only on the transition so the user can still toggle the panel
  // manually while `autoCollapse` stays on. `internalCollapsed` is in the deps
  // only to keep the captured value fresh; the guards make pure collapse changes
  // a no-op while `autoCollapse` is stable. Mirrors StylePanel's behavior. The
  // ref starts as null (not `autoCollapse`) so a mount with `autoCollapse`
  // already true reads as a null→true transition and still collapses. Skipped in
  // controlled mode, where the parent (shared rail) owns collapse.
  const prevAutoCollapse = useRef<boolean | null>(null);
  const collapsedBeforeAuto = useRef(internalCollapsed);
  useEffect(() => {
    if (isControlled) return;
    const wasAuto = prevAutoCollapse.current;
    prevAutoCollapse.current = autoCollapse;
    if (autoCollapse && !wasAuto) {
      collapsedBeforeAuto.current = internalCollapsed;
      setInternalCollapsed(true);
    } else if (!autoCollapse && wasAuto) {
      setInternalCollapsed(collapsedBeforeAuto.current);
    }
  }, [autoCollapse, internalCollapsed, isControlled]);
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
  const bindTimeSliderLayer = bindTimeSliderLayerId
    ? (layers.find((layer) => layer.id === bindTimeSliderLayerId) ?? null)
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

  const showBackgroundNameNotice = useCallback(() => {
    if (backgroundNoticeTimerRef.current !== null) {
      window.clearTimeout(backgroundNoticeTimerRef.current);
    }
    setBackgroundNameNotice(true);
    backgroundNoticeTimerRef.current = window.setTimeout(() => {
      backgroundNoticeTimerRef.current = null;
      setBackgroundNameNotice(false);
    }, REFRESH_STATUS_DURATION_MS);
  }, []);

  useEffect(
    () => () => {
      if (backgroundNoticeTimerRef.current !== null) {
        window.clearTimeout(backgroundNoticeTimerRef.current);
      }
    },
    [],
  );

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

  // Export a vector layer's symbology as a self-contained Mapbox GL / MapLibre
  // style document, so the cartography can be reused in another map or handed to
  // a teammate instead of being locked inside the .geolibre.json project.
  const handleExportStyle = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (!geojson) {
          // Mirror handleExportLayer: a source-backed (Add Vector Layer) layer
          // whose features are not readable yet is usually a not-yet-ready map
          // source, so surface that rather than exporting a style with no data.
          const message =
            geojsonVectorSourceId(layer) !== null
              ? t("layers.exportStyleDataNotReady")
              : t("layers.exportStyleNeedsFeatures");
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const result = buildMapboxStyle(layer, geojson);
        const savedPath = await saveTextFileWithFallback(
          mapboxStyleToJson(result),
          {
            defaultName: `${sanitizeExportFileName(layer.name)}.style.json`,
            filters: [
              { name: "Mapbox GL style", extensions: ["json"] },
            ],
            browserTypes: [
              {
                description: "Mapbox GL style",
                accept: { "application/json": [".json"] },
              },
            ],
            mimeType: "application/json",
          },
        );
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              result.warnings.length > 0
                ? {
                    type: "warning",
                    message: `${t("layers.exportStyleSuccess")} ${result.warnings.join(" ")}`,
                  }
                : {
                    type: "success",
                    message: t("layers.exportStyleSuccess"),
                  },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t("layers.exportStyleError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, t],
  );

  // Export a vector layer's symbology as an OGC SLD document, the interchange
  // format QGIS, GeoServer, MapServer, and ArcGIS speak, so GeoLibre cartography
  // can be handed off to a desktop-GIS or WMS workflow.
  const handleExportSldStyle = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        // Unlike the Mapbox export, SLD carries no data, so a layer whose
        // features are not readable can still export (geometry detection just
        // falls back to a symbolizer superset); pass whatever we resolved.
        const result = buildSld(layer, geojson ?? null);
        const savedPath = await saveTextFileWithFallback(result.sld, {
          defaultName: `${sanitizeExportFileName(layer.name)}.sld`,
          filters: [{ name: "OGC SLD", extensions: ["sld", "xml"] }],
          browserTypes: [
            {
              description: "OGC SLD",
              accept: { "application/xml": [".sld", ".xml"] },
            },
          ],
          mimeType: "application/xml",
        });
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              result.warnings.length > 0
                ? {
                    type: "warning",
                    message: `${t("layers.exportStyleSuccess")} ${result.warnings.join(" ")}`,
                  }
                : {
                    type: "success",
                    message: t("layers.exportStyleSuccess"),
                  },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("layers.exportStyleError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, t],
  );

  // Import a symbology file (Mapbox GL / MapLibre style JSON or an OGC SLD) and
  // apply it to a vector layer, so cartography authored elsewhere (QGIS,
  // GeoServer, another map, or a style exported from GeoLibre) can be brought
  // back in instead of being rebuilt by hand. The format is detected from the
  // file content (XML vs JSON). Anything the style could not represent is
  // surfaced as a warning rather than dropped silently.
  const handleImportStyle = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const picked = await openLocalDataFileWithFallback({
          filters: [
            { name: "Style (Mapbox GL / SLD)", extensions: ["json", "sld", "xml"] },
          ],
          accept: ".json,.sld,.xml,application/json,application/xml,text/xml",
          readText: true,
        });
        // A null result means the user dismissed the file dialog; no note. Guard
        // on `picked` itself (not `picked.text`) so an empty/whitespace file is
        // still parsed and surfaces an "invalid" error rather than a silent
        // no-op that looks like a cancel.
        if (!picked || picked.text === undefined) return;

        // Detect the format from the content: a leading `<` is XML (SLD),
        // everything else is parsed as a Mapbox GL style JSON. This is more
        // reliable than the file extension (a `.xml` can hold either).
        const trimmed = picked.text.trimStart();
        const isSld = trimmed.startsWith("<");

        let result:
          | ReturnType<typeof parseMapboxStyle>
          | ReturnType<typeof parseSld>;
        let matched: number;
        let applyImport: (base: GeoLibreLayer["style"]) => GeoLibreLayer["style"];

        if (isSld) {
          const sldResult = parseSld(picked.text);
          result = sldResult;
          matched = sldResult.matchedRuleCount;
          applyImport = (base) => applySldImport(base, sldResult);
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(picked.text);
          } catch {
            setRefreshStatuses((current) => ({
              ...current,
              [layer.id]: {
                type: "error",
                message: t("layers.importStyleInvalid"),
              },
            }));
            scheduleStatusClear(layer.id);
            return;
          }
          const mapboxResult = parseMapboxStyle(parsed);
          result = mapboxResult;
          matched = mapboxResult.matchedLayerCount;
          applyImport = (base) => applyMapboxStyleImport(base, mapboxResult);
        }

        if (matched === 0) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "error",
              message: result.warnings[0] ?? t("layers.importStyleNoMatch"),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        // The file picker await can block while the user edits the Style panel,
        // so merge onto the current store style (not the pre-await snapshot) to
        // avoid clobbering a concurrent edit, matching handleRefreshLayer.
        const latest = useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;
        updateLayer(layer.id, {
          style: applyImport(latest.style),
        });
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]:
            result.warnings.length > 0
              ? {
                  type: "warning",
                  message: `${t("layers.importStyleSuccess")} ${result.warnings.join(" ")}`,
                }
              : { type: "success", message: t("layers.importStyleSuccess") },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("layers.importStyleError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, scheduleStatusClear, t, updateLayer],
  );

  // Commit the layer's current (edited) features back to the source they were
  // loaded from, via the sidecar: either overwriting the local file in place,
  // or diffing against the PostGIS table by primary key. Unlike Export, there
  // is no save dialog: write-back targets the known source.
  const handleSaveEditsToSource = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      const isPostgis = isPostgisEditableLayer(layer);
      const path =
        typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
      if (!isPostgis && !path) return;
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (!geojson || geojson.features.length === 0) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "error",
              message: t("layers.saveEditsNoFeatures"),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        let message: string;
        if (isPostgis) {
          const connection = resolvePostgisConnection(layer);
          if (!connection) {
            setRefreshStatuses((current) => ({
              ...current,
              [layer.id]: {
                type: "error",
                message: t("layers.saveEditsPostgisNoConnection"),
              },
            }));
            scheduleStatusClear(layer.id);
            return;
          }
          const schema =
            typeof layer.metadata.postgisSchema === "string"
              ? layer.metadata.postgisSchema
              : "public";
          const table = layer.metadata.postgisTable as string;
          const result = await writePostgisTable({
            connection,
            schema_name: schema,
            table,
            geojson,
            // Scope deletions to the rows this session actually read so a
            // save cannot sweep away rows inserted concurrently elsewhere.
            // The baseline lives on the layer metadata, so it survives a
            // project reload.
            baseline_keys: postgisBaselineKeys(layer),
          });
          // Re-read the table so inserted features pick up their database-
          // assigned primary keys; without this a second save would insert
          // them again as duplicates.
          let fresh;
          try {
            fresh = await readPostgisTable({
              connection,
              schema_name: schema,
              table,
            });
          } catch {
            // The write committed; only the refresh failed. Reporting this as
            // a plain failure would invite a retry that re-inserts the still
            // key-less new features, so surface a distinct warning instead.
            setRefreshStatuses((current) => ({
              ...current,
              [layer.id]: {
                type: "error",
                message: t("layers.saveEditsPostgisRefreshWarning"),
              },
            }));
            scheduleStatusClear(layer.id);
            return;
          }
          // Merge into the store's current metadata, not the click-time
          // closure: the write/re-read round trip is slow enough for other
          // updates (auto-refresh, time-slider binding) to land in between.
          const currentMetadata =
            useAppStore.getState().layers.find((l) => l.id === layer.id)
              ?.metadata ?? layer.metadata;
          updateLayer(layer.id, {
            geojson: fresh.geojson,
            metadata: {
              ...currentMetadata,
              featureCount: fresh.feature_count,
              postgisBaselineKeys: postgisFeatureKeys(fresh.geojson),
            },
          });
          message = t("layers.saveEditsPostgisSuccess", {
            table: `${schema}.${table}`,
            inserted: result.inserted,
            updated: result.updated,
            deleted: result.deleted,
          });
          // The sidecar reports editor-added fields it could not persist
          // (no matching table column); surface that so the drop is not
          // silent behind a plain success toast.
          if (result.skipped_fields?.length) {
            message = `${message} ${t("layers.saveEditsPostgisSkippedFields", {
              fields: result.skipped_fields.join(", "),
            })}`;
          }
        } else {
          const result = await writeVectorToSource({ path, geojson });
          message = t("layers.saveEditsSuccess", {
            count: result.feature_count,
          });
        }
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "success", message },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t("layers.saveEditsError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [
      clearRefreshStatusTimer,
      mapControllerRef,
      scheduleStatusClear,
      t,
      updateLayer,
    ],
  );

  // Close the bind dialog and invalidate any in-flight scan/confirm so a late
  // async result cannot reopen it, write stale candidates, or bind after cancel.
  const closeBindTimeSliderDialog = useCallback(() => {
    bindRequestRef.current += 1;
    setBindTimeSliderLayerId(null);
  }, []);

  // Open the bind dialog: inspect the layer's features for timestamp columns and
  // preselect the best-covered one. `candidates` stays null until detection
  // finishes so the dialog can show a "scanning" state for large layers.
  const openBindTimeSliderDialog = useCallback(
    async (layer: GeoLibreLayer) => {
      // Tag this request with a fresh token so a stale async scan (open ->
      // close/reopen, even for the same layer) cannot populate this dialog.
      const token = (bindRequestRef.current += 1);
      setBindTimeSliderLayerId(layer.id);
      setBindCandidates(null);
      setBindProperty("");
      setBindWindowMode("step");
      setBindLayerGeojson(null);
      setBindError(null);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        if (bindRequestRef.current !== token) return;
        const candidates = detectTimeProperties(geojson ?? undefined);
        setBindLayerGeojson(geojson ?? null);
        setBindCandidates(candidates);
        if (candidates.length > 0) setBindProperty(candidates[0].property);
      } catch {
        if (bindRequestRef.current !== token) return;
        setBindCandidates([]);
      }
    },
    [mapControllerRef],
  );

  // Commit a binding: persist it on the layer metadata and activate the Time
  // Slider so it adopts the binding and drives the filter. Styling/opacity are
  // untouched; only the visible feature set narrows as the timeline moves.
  const confirmBindTimeSlider = useCallback(async () => {
    const layer = bindTimeSliderLayer;
    if (!layer || !bindProperty) return;
    const token = bindRequestRef.current;
    // Reuse the feature collection resolved when the dialog opened so large
    // layers are not scanned twice.
    const geojson =
      bindLayerGeojson ??
      (await resolveLayerGeojson(
        layer,
        mapControllerRef.current?.getMap() ?? undefined,
      ));
    // If the dialog was cancelled (or reopened for another layer) while the
    // fallback scan was in flight, abandon this commit.
    if (bindRequestRef.current !== token) return;
    const binding = buildTimeBinding(geojson ?? undefined, bindProperty);
    if (!binding) {
      // Keep the dialog open and explain why, rather than closing silently.
      setBindError(t("layers.bindNoTimestamps"));
      return;
    }
    const timeWindow =
      bindWindowMode === "wider"
        ? { unit: binding.granularity, before: 3, after: 3 }
        : bindWindowMode === "wide"
          ? { unit: binding.granularity, before: 1, after: 1 }
          : { unit: binding.granularity, before: 0, after: 1 };
    updateLayer(layer.id, {
      metadata: { ...layer.metadata, timeBinding: { ...binding, window: timeWindow } },
      timeFilter: undefined,
    });
    if (!isPluginActive(TIME_SLIDER_PLUGIN_ID)) {
      togglePlugin(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
    }
    closeBindTimeSliderDialog();
  }, [
    bindTimeSliderLayer,
    bindLayerGeojson,
    bindProperty,
    bindWindowMode,
    mapControllerRef,
    updateLayer,
    isPluginActive,
    togglePlugin,
    closeBindTimeSliderDialog,
    t,
  ]);

  // Remove a layer's binding and clear its transient time filter so it shows
  // every feature again. The Time Slider stays active for any other bindings.
  const handleUnbindTimeSlider = useCallback(
    (layer: GeoLibreLayer) => {
      const { timeBinding: _removed, ...metadata } = layer.metadata as Record<
        string,
        unknown
      >;
      updateLayer(layer.id, { metadata, timeFilter: undefined });
    },
    [updateLayer],
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
      bindTimeSliderLayerId &&
      !layers.some((layer) => layer.id === bindTimeSliderLayerId)
    ) {
      bindRequestRef.current += 1;
      setBindTimeSliderLayerId(null);
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
  }, [
    bindTimeSliderLayerId,
    clearRefreshStatusTimer,
    editingLayerId,
    layers,
    refreshSettingsLayerId,
  ]);

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
              {/* Action items below omit preventDefault so Radix dismisses the
                  menu on select; only the rename item above keeps it, so the
                  menu's close does not race its input autofocus. */}
              <DropdownMenuItem
                disabled={!canReorderGroup}
                onSelect={() => {
                  reorderLayerGroup(group.id, "up");
                }}
              >
                <ChevronUp className="mr-2 h-3.5 w-3.5" />
                {t("layers.moveGroupUp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canReorderGroup}
                onSelect={() => {
                  reorderLayerGroup(group.id, "down");
                }}
              >
                <ChevronDown className="mr-2 h-3.5 w-3.5" />
                {t("layers.moveGroupDown")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  removeLayerGroup(group.id);
                }}
              >
                <FolderMinus className="mr-2 h-3.5 w-3.5" />
                {t("layers.ungroupKeepLayers")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => {
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
          <LayerOpacitySlider
            label={t("layers.groupOpacity")}
            ariaLabel={t("layers.groupOpacityAria", { name: group.name })}
            value={group.opacity}
            onChange={(v) => setLayerGroupOpacity(group.id, v)}
          />
        )}
      </div>
    );
  };

  if (isCollapsed) {
    // In the shared left-sidebar mode the host renders a single rail listing
    // Layers alongside the plugin panel, so the panel shows nothing of its own
    // when collapsed (avoids two adjacent rails).
    if (hideOwnRail) return null;
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
              {isBeginnerProfile
                ? t("layers.emptyBeginner")
                : t("layers.empty")}
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
            // When the parent group is hidden, a layer whose own visibility
            // toggle is still on is not rendered — a surprising state. Grey its
            // name out as a cue that the group-level setting is what's hiding
            // it (issue #430). If the layer's own toggle is also off, the
            // EyeOff icon already explains it, so skip the group cue then.
            const groupHidden = group ? !group.visible && layer.visible : false;
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
              // COG layers identify pixel values via the raster control's pixel
              // inspector (see useRasterIdentify), not the vector feature query.
              layer.type === "cog" ||
              hasNativeIdentifyLayers(layer);
            const identifyActive = identifyLayerId === layer.id;
            // COGs inspect raw pixel/band values rather than vector features, so
            // the icon's tooltip reflects that distinct action.
            const isPixelIdentify = layer.type === "cog";
            // Shared by the button's title and aria-label so they can't diverge.
            const identifyLabel = canIdentify
              ? identifyActive
                ? isPixelIdentify
                  ? t("layers.identifyStopInspectPixels")
                  : t("layers.identifyDeactivate")
                : isPixelIdentify
                  ? t("layers.identifyInspectPixels")
                  : t("layers.identifyFeatures")
              : t("layers.identifyUnavailable");
            const canEditGeometry = canEditLayerGeometry(layer);
            // A vector layer whose in-view features can be loaded into the
            // GeoEditor (a copy, not in-place): geojson and vector tile layers
            // (vector-tiles, and PMTiles/MBTiles carrying vector tiles),
            // excluding the editor's own Sketches layer. Tile layers are
            // included here (unlike Edit geometry) because loading grabs a copy
            // of what is rendered rather than editing the source in place;
            // raster PMTiles/MBTiles have no vector features so are excluded.
            const canLoadIntoEditor =
              layer.metadata.sourceKind !== SKETCHES_SOURCE_KIND &&
              layer.metadata.tileType !== "raster" &&
              (layer.type === "geojson" ||
                layer.type === "vector-tiles" ||
                layer.type === "pmtiles" ||
                layer.type === "mbtiles");
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
            // Importing a style (Mapbox GL or SLD) only writes the layer's
            // vector symbology, so it applies to any vector-styled layer (local
            // GeoJSON and vector tiles), not just the export-capable GeoJSON
            // layers.
            const canImportStyle =
              layer.type === "geojson" || layer.type === "vector-tiles";
            // Write-back commits edits to the layer's local source file in place
            // (desktop only, supported formats); Export writes a new file.
            const canWriteBack = canWriteEditsToSource(layer);
            // Vector layers with a date/timestamp property can be driven by the
            // Time Slider; the binding (if any) lives on the layer metadata.
            const canBindTimeSlider = layer.type === "geojson";
            const timeBinding = getLayerTimeBinding(layer);
            // Raster/COG layers backed by a downloadable file (a retained
            // local-bytes blob URL or a source URL) export to GeoTIFF.
            const canExportRaster = canExportRasterLayer(layer);
            // Rasters added through the floating Add Raster Layer panel are
            // styled there; offer a shortcut to reopen that panel since it is
            // dismissed (and its on-map icon removed) when closed.
            const canEditRasterStyle =
              layer.metadata.sourceKind === RASTER_SOURCE_KIND;
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
                      className={`flex-1 truncate text-sm font-medium ${
                        groupHidden ? "text-muted-foreground" : ""
                      }`}
                      title={
                        groupHidden
                          ? `${t("layers.hiddenByGroup")} — ${t("layers.doubleClickToRename")}`
                          : t("layers.doubleClickToRename")
                      }
                      onDoubleClick={(e: ReactMouseEvent) => {
                        e.stopPropagation();
                        beginRename(layer);
                      }}
                    >
                      {layer.name}
                    </span>
                  )}
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {layerTypeLabel(layer, t)}
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
                <LayerOpacitySlider
                  label={t("layers.opacity")}
                  ariaLabel={t("layers.opacityFor", { name: layer.name })}
                  value={layer.opacity}
                  onChange={(v) => setLayerOpacity(layer.id, v)}
                />
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
                    title={identifyLabel}
                    aria-label={identifyLabel}
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
                      {/* The Rename item above keeps preventDefault so the
                          menu's close does not race its input autofocus. Every
                          action item below has no such focus target, so each
                          lets Radix dismiss the menu on select rather than
                          leaving it pinned open. */}
                      <DropdownMenuItem
                        onSelect={() => {
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
                                onSelect={() => {
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
                          onSelect={() => {
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
                            onSelect={() => {
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
                          onSelect={() => {
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
                      {canLoadIntoEditor && (
                        <DropdownMenuItem
                          onSelect={() => {
                            selectLayer(layer.id);
                            setLoadEditorFeaturesOpen(true, layer.id);
                          }}
                        >
                          <SquarePen className="mr-2 h-3.5 w-3.5" />
                          {t("loadEditorFeatures.menuItem")}
                        </DropdownMenuItem>
                      )}
                      {canOpenAttributeTable && (
                        <DropdownMenuItem
                          onSelect={() => {
                            selectLayer(layer.id);
                            setAttributeTableOpen(true);
                          }}
                        >
                          <TableProperties className="mr-2 h-3.5 w-3.5" />
                          Open attribute table
                        </DropdownMenuItem>
                      )}
                      {canBindTimeSlider && (
                        <DropdownMenuItem
                          onSelect={() => {
                            if (timeBinding) {
                              handleUnbindTimeSlider(layer);
                            } else {
                              void openBindTimeSliderDialog(layer);
                            }
                          }}
                        >
                          <CalendarClock className="mr-2 h-3.5 w-3.5" />
                          {timeBinding
                            ? t("layers.unbindFromTimeSlider")
                            : t("layers.bindToTimeSlider")}
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
                              onSelect={() => {
                                void handleExportLayer(layer, "geojson");
                              }}
                            >
                              GeoJSON
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleExportLayer(layer, "geoparquet");
                              }}
                            >
                              GeoParquet
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleExportLayer(layer, "geopackage");
                              }}
                            >
                              GeoPackage
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleExportLayer(layer, "shapefile");
                              }}
                            >
                              Shapefile (zipped)
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleExportLayer(layer, "csv");
                              }}
                            >
                              CSV (attributes only)
                            </DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      {/* Symbology import/export live in their own Styles menu,
                          separate from the feature-data Export menu above. */}
                      {(canExportLayer || canImportStyle) && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Palette className="h-3.5 w-3.5" />
                            {t("layers.stylesMenu")}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {canExportLayer && (
                              <>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    void handleExportStyle(layer);
                                  }}
                                >
                                  <Download className="mr-2 h-3.5 w-3.5" />
                                  {t("layers.exportMapboxStyle")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    void handleExportSldStyle(layer);
                                  }}
                                >
                                  <Download className="mr-2 h-3.5 w-3.5" />
                                  {t("layers.exportSldStyle")}
                                </DropdownMenuItem>
                              </>
                            )}
                            {canExportLayer && canImportStyle && (
                              <DropdownMenuSeparator />
                            )}
                            {canImportStyle && (
                              <DropdownMenuItem
                                onSelect={() => {
                                  void handleImportStyle(layer);
                                }}
                              >
                                <Upload className="mr-2 h-3.5 w-3.5" />
                                {t("layers.importStyle")}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      )}
                      {canWriteBack && (
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleSaveEditsToSource(layer);
                          }}
                        >
                          <Save className="mr-2 h-3.5 w-3.5" />
                          {isPostgisEditableLayer(layer)
                            ? t("layers.saveEditsToPostgis")
                            : t("layers.saveEditsToSource")}
                        </DropdownMenuItem>
                      )}
                      {canEditRasterStyle && (
                        <DropdownMenuItem
                          onSelect={() => {
                            selectLayer(layer.id);
                            onOpenRasterStylePanel();
                          }}
                        >
                          <Palette className="mr-2 h-3.5 w-3.5" />
                          {t("layers.openRasterStylePanel")}
                        </DropdownMenuItem>
                      )}
                      {canExportRaster && (
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Download className="h-3.5 w-3.5" />
                            Export
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            <DropdownMenuItem
                              onSelect={() => {
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
                        onSelect={() => {
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
                        onSelect={() => {
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
            title={t("layers.doubleClickToChangeBasemap")}
            onClick={() => selectLayer(BACKGROUND_SELECTION_ID)}
            onDoubleClick={() => setBasemapPickerOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") selectLayer(BACKGROUND_SELECTION_ID);
              // Keyboard equivalent of the double-click: Space opens the basemap
              // picker (preventDefault stops the panel from scrolling).
              if (e.key === " ") {
                e.preventDefault();
                setBasemapPickerOpen(true);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div className="flex items-center gap-1">
              <span
                title={t("layers.backgroundCannotReorder")}
                className="rounded p-0.5 text-muted-foreground/50"
              >
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted"
                title={
                  basemapVisible
                    ? t("layers.hideBackground")
                    : t("layers.showBackground")
                }
                aria-label={
                  basemapVisible
                    ? t("layers.hideBackground")
                    : t("layers.showBackground")
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
              <span
                className="flex-1 truncate text-sm font-medium"
                title={t("layers.backgroundNameFixed")}
                onDoubleClick={(e: ReactMouseEvent) => {
                  // The card's own onDoubleClick opens the basemap picker; on
                  // the name we instead explain that the name is fixed, since
                  // that is where users attempt the rename gesture (#838).
                  e.stopPropagation();
                  showBackgroundNameNotice();
                }}
              >
                {t("layers.background")}
              </span>
              <span className="text-[10px] uppercase text-muted-foreground">
                {t("layers.typeBasemap")}
              </span>
            </div>
            {backgroundNameNotice && (
              <p className="mt-1 text-[10px] text-amber-600">
                {t("layers.backgroundNameFixed")}
              </p>
            )}
            <LayerOpacitySlider
              label={t("layers.opacity")}
              ariaLabel={t("layers.basemapOpacity")}
              value={basemapOpacity}
              onChange={setBasemapOpacity}
            />
          </div>
        </div>
      </ScrollArea>
      <Separator />
      <LayerPanelPlaceSearch mapControllerRef={mapControllerRef} />
      <BasemapPickerDialog
        open={basemapPickerOpen}
        onOpenChange={setBasemapPickerOpen}
      />
      <Dialog
        open={!!bindTimeSliderLayerId}
        onOpenChange={(open: boolean) => {
          if (!open) closeBindTimeSliderDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("layers.bindToTimeSlider")}</DialogTitle>
            <DialogDescription>
              {t("layers.bindDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          {bindCandidates === null ? (
            <p className="text-sm text-muted-foreground">
              {t("layers.bindScanning")}
            </p>
          ) : bindCandidates.length === 0 ? (
            <p className="text-sm text-destructive">
              {t("layers.bindNoProperty")}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="time-slider-property">
                  {t("layers.bindProperty")}
                </Label>
                <Select
                  id="time-slider-property"
                  value={bindProperty}
                  onChange={(event) => {
                    setBindProperty(event.target.value);
                    setBindError(null);
                  }}
                >
                  {bindCandidates.map((candidate) => (
                    <option key={candidate.property} value={candidate.property}>
                      {candidate.property}
                      {candidate.coverage < 1
                        ? ` (${Math.round(candidate.coverage * 100)}%)`
                        : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="time-slider-window">
                  {t("layers.bindWindow")}
                </Label>
                <Select
                  id="time-slider-window"
                  value={bindWindowMode}
                  onChange={(event) =>
                    setBindWindowMode(
                      event.target.value as "step" | "wide" | "wider",
                    )
                  }
                >
                  <option value="step">{t("layers.bindWindowStep")}</option>
                  <option value="wide">{t("layers.bindWindowWide")}</option>
                  <option value="wider">{t("layers.bindWindowWider")}</option>
                </Select>
              </div>
              {bindError && (
                <p className="text-sm text-destructive">{bindError}</p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={closeBindTimeSliderDialog}
            >
              {t("layers.bindCancel")}
            </Button>
            <Button
              type="button"
              disabled={!bindProperty}
              onClick={() => void confirmBindTimeSlider()}
            >
              {t("layers.bindConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
                JSON.stringify(layerMetadataPayload(metadataLayer), null, 2)}
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
                // Drop the removed layer's PostGIS session state (connection
                // string, baseline keys) so credentials don't outlive it.
                unregisterPostgisConnection(layerPendingRemoval.id);
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
