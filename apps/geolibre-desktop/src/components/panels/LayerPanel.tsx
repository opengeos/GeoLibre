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
  useSyncExternalStore,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ParseKeys, TFunction } from "i18next";
import {
  NETCDF_IMAGE_SOURCE_KIND,
  DEFAULT_BASEMAP,
  effectiveLayerRenderState,
  getPlanetaryBasemapById,
  getPlanetaryBasemapByStyleUrl,
  isDuckDBQueryLayer,
  PLANET_SWITCHER_OPTIONS,
  isStyleLibraryTargetLayer,
  canSaveLayerToLibrary,
  captureLayerLibraryEntry,
  createLayerLibraryEntryId,
  copyableLayerStyleKind,
  pluginOwnsPaint,
  supportsBridgedOpacity,
  useAppStore,
  excludeHiddenFieldsFromGeojson,
  layerGroupDepth,
  layerGroupMoveability,
  layerPanelGroupHeaders,
} from "@geolibre/core";
import type { EllipsoidId, GeoLibreLayer, LayerGroup } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildTimeBindingFromRecords,
  canEditLayerGeometry,
  detectTimePropertiesFromRecords,
  formatTimeExtentInput,
  getTemporalLayerAdapter,
  getTemporalLayersVersion,
  getLayerTimeBinding,
  isTileVectorLayer,
  isTimeSliderIdle,
  subscribeTemporalLayers,
  parseTimeValue,
  sampleTileFeatureRecords,
  BASEMAP_CONTROL_PLUGIN_ID,
  GEO_EDITOR_PLUGIN_ID,
  isEmbeddableLocalVectorLayer,
  materializeEmbeddableVectorLayers,
  RASTER_SOURCE_KIND,
  reloadVectorControlLayer,
  replayVectorControlLayerById,
  SKETCHES_SOURCE_KIND,
  TIME_SLIDER_PLUGIN_ID,
  type TimePropertyCandidate,
  type TimePropertyRecord,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import {
  applyMapboxStyleImport,
  applyQmlImport,
  applySldImport,
  buildMapboxStyle,
  buildGeoLibreQueryStyle,
  buildQml,
  buildSld,
  isPlaceholderLayer,
  mapboxStyleToJson,
  geoLibreStyleSourceName,
  parseMapboxStyle,
  parseQml,
  parseSld,
  placeholderMessage,
} from "@geolibre/map";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import {
  activateTimeSliderForBinding,
  bindTemporalLayer,
  createAppAPI,
  usePluginRegistry,
} from "../../hooks/usePlugins";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import {
  clearFeatureSelection,
  exportSelectionAsLayer,
  invertLayerSelection,
  zoomToSelection,
} from "../../lib/selection-actions";
import { isMobile } from "../../lib/is-mobile";
import { masHidesDataSource } from "../../lib/mas-build";
import {
  DATA_SOURCE_CATALOG,
  type DataSourceCatalogEntry,
  activeInterfaceProfile,
  isDataSourceVisible,
} from "../../lib/ui-profile";
import type { AddDataKind } from "../layout/add-data/types";
import { KIND_I18N_KEY } from "../layout/add-data/constants";
import { openAddData } from "../layout/add-data/open-add-data";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  cn,
} from "@geolibre/ui";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardPaste,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Info,
  Layers,
  Library,
  Locate,
  Lock,
  Map as MapIcon,
  MoreHorizontal,
  MousePointerClick,
  Orbit,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PencilRuler,
  PenTool,
  RefreshCw,
  Save,
  Shuffle,
  Sparkles,
  SquareDashed,
  SquareFunction,
  SquarePen,
  Table2,
  TableProperties,
  Timer,
  Trash2,
  Unlock,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import { clamp } from "../../lib/clamp";
import {
  getLayerRefreshConfig,
  isRefreshableLayer,
  isVectorControlRefreshLayer,
  MIN_REFRESH_INTERVAL_MS,
  refreshGeoJsonLayer,
  setLayerConnectionResult,
  setLayerRefreshConfig,
  supportsRefreshFailurePolicy,
} from "../../lib/layer-refresh";
import {
  getLayerWatchConfig,
  isLocalFileLayer,
  reloadLocalFileLayer,
  setLayerWatchConfig,
} from "../../lib/local-file-watch";
import { canRestoreLibraryLayer } from "../../lib/restore-library-layer";
import {
  getSqlQueryLayerConfig,
  isSqlQueryLayer,
  refreshSqlQueryLayer,
} from "../../lib/sql-query-layer";
import {
  bufferPresetsFor,
  formatBufferDistance,
  runQuickAnalysis,
  type QuickBufferPreset,
} from "../../lib/quick-analysis";
import { requestSqlWorkspaceQuery } from "../../lib/sql-workspace-prefill";
import { canExportRasterLayer, exportRasterLayer, rasterExportUrl } from "../../lib/raster-export";
import { readRasterInfo, type RasterInfo } from "../../lib/raster-info";
import { canExtractRasterSubset } from "../../lib/raster-subset-export";
import {
  exportVectorLayer,
  geojsonVectorSourceId,
  kmlExportErrorMessage,
  resolveLayerGeojson,
  sanitizeExportFileName,
  shapefileFieldWarnings,
  type VectorExportFormat,
} from "../../lib/vector-export";
import { openLocalDataFileWithFallback, saveTextFileWithFallback } from "../../lib/tauri-io";
import { isQmlStyleXml } from "../../lib/style-format";
import { readPostgisTable, writePostgisTable, writeVectorToSource } from "@geolibre/processing";
import {
  postgisBaselineKeys,
  postgisFeatureKeys,
  resolvePostgisConnection,
  unregisterPostgisConnection,
} from "../../lib/postgis-connections";
import { IS_MAS_BUILD } from "../../lib/build-flags";
import { isTauri } from "../../lib/is-tauri";
import { getNetcdfLayerState } from "../../lib/netcdf-image-symbology";
import { participantCanEditLayer } from "../../lib/collab-protocol";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { BasemapPickerDialog } from "./BasemapPickerDialog";
import { LayerPanelPlaceSearch } from "./LayerPanelPlaceSearch";
import { LayerSwatchIcon } from "./LayerSwatchIcon";

interface LayerPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  collaborationApi?: CollaborationApi;
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
   * Select the target layer and expand the built-in Style panel. Left undefined
   * when that panel is hidden (Settings → "Show Style panel"), which also hides
   * the menu item — the panel is not mounted then, so the request would be
   * dropped rather than queued.
   */
  onOpenStylePanel?: () => void;
  /**
   * Open the floating Extract Subset panel for a COG/WMS/XYZ layer, letting the
   * user draw a bounding box and export a clipped GeoTIFF.
   */
  onOpenRasterSubset: (layer: GeoLibreLayer) => void;
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

const REFRESH_INTERVAL_OPTIONS: ReadonlyArray<{
  labelKey: ParseKeys;
  intervalMs: number;
}> = [
  { labelKey: "layers.refreshIntervals.off", intervalMs: 0 },
  { labelKey: "layers.refreshIntervals.s15", intervalMs: 15_000 },
  { labelKey: "layers.refreshIntervals.s30", intervalMs: 30_000 },
  { labelKey: "layers.refreshIntervals.m1", intervalMs: 60_000 },
  { labelKey: "layers.refreshIntervals.m5", intervalMs: 5 * 60_000 },
  { labelKey: "layers.refreshIntervals.m15", intervalMs: 15 * 60_000 },
];
const CUSTOM_REFRESH_INTERVAL_VALUE = "custom";
const REFRESH_STATUS_DURATION_MS = 4_000;
/** How often the durable "Last synced …" labels are recomputed. */
const SYNC_CLOCK_TICK_MS = 60_000;

/**
 * The Add Data sources a group's "Add data to group" submenu can offer, in Add
 * Data menu order. `openAddData` scopes the layers a source creates to a group,
 * so only the sources the Add Data *dialog* owns qualify — `KIND_I18N_KEY` is
 * keyed by `AddDataKind`, so membership in it is that test. The rest of the
 * catalog (vector/raster file pickers, STAC, PMTiles, …) never routes through
 * the dialog and so has no group-scoped open.
 */
const ADD_DATA_DIALOG_SOURCES = DATA_SOURCE_CATALOG.filter(
  (entry): entry is DataSourceCatalogEntry & { id: AddDataKind } => entry.id in KIND_I18N_KEY,
);

/** Menu labels for the planet switcher, keyed by celestial body. */
const PLANET_SWITCHER_LABEL_KEYS: Record<EllipsoidId, ParseKeys> = {
  earth: "planetSwitcher.earth",
  mercury: "planetSwitcher.mercury",
  venus: "planetSwitcher.venus",
  moon: "planetSwitcher.moon",
  mars: "planetSwitcher.mars",
  io: "planetSwitcher.io",
  europa: "planetSwitcher.europa",
  ganymede: "planetSwitcher.ganymede",
  callisto: "planetSwitcher.callisto",
  titan: "planetSwitcher.titan",
  pluto: "planetSwitcher.pluto",
  charon: "planetSwitcher.charon",
};

type LayerRefreshStatus = {
  type: "refreshing" | "success" | "error" | "warning";
  message: string;
};

type LayerRefreshTimer = {
  intervalMs: number;
  timer: number;
};

function layerTypeLabel(layer: GeoLibreLayer, t: TFunction): string {
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
    (value): value is string => typeof value === "string" && value.trim().length > 0,
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
  // Both write-back paths (PostGIS tables and local files) run through the
  // Python sidecar, which the Mac App Store build compiles out, so edits are
  // export-only there, as on the web build.
  if (IS_MAS_BUILD) return false;
  if (isPostgisEditableLayer(layer)) return true;
  const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? WRITEBACK_EXTENSIONS.includes(ext) : false;
}

/**
 * Async state of the GeoTIFF header read that backs the raster section of the
 * metadata dialog. `layerId` scopes the state to the layer it was read for:
 * the dialog re-renders for a newly opened layer before the effect below can
 * restart the read, so without it the previous layer's header would show for a
 * frame under the new layer's name.
 */
type RasterInfoState = { layerId: string } & (
  | { status: "loading" }
  | { status: "ready"; info: RasterInfo }
  | { status: "error" }
);

/**
 * Whether a layer's metadata can be enriched with GeoTIFF header facts: a
 * raster layer whose bytes are reachable as a single file (a remote COG or a
 * retained local-bytes blob). Tile-template rasters have no such file.
 *
 * @param layer - The layer whose metadata dialog is open.
 * @returns A fetchable GeoTIFF URL, or null.
 */
function rasterInfoUrl(layer: GeoLibreLayer): string | null {
  if (layer.type !== "cog" && layer.type !== "raster") return null;
  return rasterExportUrl(layer);
}

/**
 * Builds the JSON payload shown in the layer metadata dialog. Raster header
 * facts (CRS, pixel size, storage) lead when they have been read, since the
 * store metadata below them only knows the WGS84 bounds and band count.
 *
 * @param layer - The layer whose metadata is shown.
 * @param rasterInfo - GeoTIFF header facts, when read for this layer.
 * @returns The payload to serialize into the dialog.
 */
function layerMetadataPayload(
  layer: GeoLibreLayer,
  rasterInfo?: RasterInfo | null,
): Record<string, unknown> {
  const videoSourceUrls = sourceUrlsFromLayer(layer);
  return {
    ...(rasterInfo ? { raster: rasterInfo } : {}),
    ...layer.metadata,
    layerName: layer.name,
    layerType: layer.type,
    ...(videoSourceUrls.length > 0
      ? {
          sourceUrl: videoSourceUrls[0],
          ...(videoSourceUrls[1] ? { fallbackSourceUrl: videoSourceUrls[1] } : {}),
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
function LayerOpacitySlider({ label, ariaLabel, value, onChange }: LayerOpacitySliderProps) {
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
          className="h-6 w-12 px-1 py-0 text-end font-mono text-[10px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
          className="w-9 shrink-0 cursor-text text-end font-mono text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
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
  if (REFRESH_INTERVAL_OPTIONS.some((option) => option.intervalMs === intervalMs)) {
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

function relativeSyncTime(iso: string, locale: string): string {
  const elapsedSeconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (!Number.isFinite(elapsedSeconds)) return iso;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const minutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function hasNativeIdentifyLayers(layer: GeoLibreLayer): boolean {
  if (layer.metadata.identifiable === false) return false;

  // A NetCDF grid baked to pixels has no queryable features and no native layer
  // registered by a plugin, but its values are held in memory and read directly
  // by useNetcdfIdentify. Named here rather than given a synthetic
  // `nativeLayerIds`, which would make layer-sync treat it as plugin-owned and
  // stop drawing it. Gated on the grids actually being retained — a project
  // reload drops them — since offering Identify that answers nothing is worse
  // than not offering it. Deliberately the layer state rather than
  // `getNetcdfImageSource`, which is null for an RGB composite: that has no
  // colormap to re-apply but does have three channels a click can read.
  if (layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) {
    return getNetcdfLayerState(layer.id) !== null;
  }

  return Array.isArray(layer.metadata.nativeLayerIds) && layer.metadata.nativeLayerIds.length > 0;
}

export function LayerPanel({
  mapControllerRef,
  collaborationApi,
  onResizeStart,
  geometryEditLayerId,
  onToggleGeometryEdit,
  onCancelGeometryEdit,
  onMaterializeDuckDBLayer,
  onOpenRasterStylePanel,
  onOpenStylePanel,
  onOpenRasterSubset,
  autoCollapse = false,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  hideOwnRail = false,
}: LayerPanelProps) {
  const { i18n, t } = useTranslation();
  const isBeginnerProfile = useDesktopSettingsStore(
    (s) => activeInterfaceProfile(s.desktopSettings.uiProfile) === "beginner",
  );
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  // Same visibility rules the Add Data menu applies (profile, Mac App Store,
  // and the mobile-only postgres rule); the user agent is stable for the
  // session, so evaluate it once.
  const mobile = useMemo(() => isMobile(), []);
  const addDataGroupSources = useMemo(
    () =>
      ADD_DATA_DIALOG_SOURCES.filter(
        (entry) =>
          isDataSourceVisible(uiProfile, entry.id) &&
          !(entry.id === "postgres" && mobile) &&
          !masHidesDataSource(entry.id),
      ),
    [uiProfile, mobile],
  );
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const removeLayerGroup = useAppStore((s) => s.removeLayerGroup);
  const renameLayerGroup = useAppStore((s) => s.renameLayerGroup);
  const setLayerGroupVisibility = useAppStore((s) => s.setLayerGroupVisibility);
  const setLayerGroupOpacity = useAppStore((s) => s.setLayerGroupOpacity);
  const toggleLayerGroupCollapsed = useAppStore((s) => s.toggleLayerGroupCollapsed);
  const moveLayersToGroup = useAppStore((s) => s.moveLayersToGroup);
  const moveLayerGroupToGroup = useAppStore((s) => s.moveLayerGroupToGroup);
  const reorderLayerGroup = useAppStore((s) => s.reorderLayerGroup);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const selectedFeatureCount = useAppStore((s) => s.selectedFeatureIds.length);
  // Select by Location needs a second layer to compare against (see EditMenu).
  const hasTwoSelectableLayers = useAppStore(
    (s) => s.layers.filter((layer) => (layer.geojson?.features?.length ?? 0) > 0).length >= 2,
  );
  const setSelectByExpressionOpen = useAppStore((s) => s.setSelectByExpressionOpen);
  const setSelectByLocationOpen = useAppStore((s) => s.setSelectByLocationOpen);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const setBasemapVisible = useAppStore((s) => s.setBasemapVisible);
  const setBasemapOpacity = useAppStore((s) => s.setBasemapOpacity);
  const applyPlanetaryBasemap = useAppStore((s) => s.applyPlanetaryBasemap);
  const restoreEarthBasemap = useAppStore((s) => s.restoreEarthBasemap);
  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  // The body the switcher reflects, derived from the active *basemap* — not the
  // ellipsoid, which Settings lets diverge from the basemap (e.g. Mars scale
  // under an Earth style). Any planetary basemap resolves to its body: the
  // Moon/Mars mosaics (from this switcher or the full picker) and Earth's own
  // imagery. A normal Earth basemap (e.g. Liberty) resolves to nothing, so
  // nothing is selected until a planetary basemap is applied.
  const selectedPlanet = getPlanetaryBasemapByStyleUrl(basemapStyleUrl)?.ellipsoidId;
  // The Earth basemap to fall back to when a planet is deselected — the last one
  // active while no planet was selected (e.g. Liberty). Tracked in a ref so it
  // survives the planet round-trip. Starts undefined (not seeded from the mount
  // value, which could be a planetary basemap if the panel mounted while off
  // Earth) and is only ever set to a genuine Earth basemap by the guard below,
  // so a deselect never restores a planetary sentinel.
  const previousEarthBasemap = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedPlanet) previousEarthBasemap.current = basemapStyleUrl;
  }, [selectedPlanet, basemapStyleUrl]);
  const setLayerVisibility = useAppStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const reorderLayer = useAppStore((s) => s.reorderLayer);
  const moveLayer = useAppStore((s) => s.moveLayer);
  const moveLayersRelative = useAppStore((s) => s.moveLayersRelative);
  const removeLayer = useAppStore((s) => s.removeLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const copyLayerStyle = useAppStore((s) => s.copyLayerStyle);
  const pasteLayerStyle = useAppStore((s) => s.pasteLayerStyle);
  const copiedLayerStyle = useAppStore((s) => s.copiedLayerStyle);
  const saveLayerLibraryEntry = useAppStore((s) => s.saveLayerLibraryEntry);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const setRasterAttributeTableOpen = useAppStore((s) => s.setRasterAttributeTableOpen);
  const setLoadEditorFeaturesOpen = useAppStore((s) => s.setLoadEditorFeaturesOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const collaboration = useAppStore((s) => s.collaboration);
  const selfParticipant = useMemo(() => {
    if (!collaboration.isActive || !collaboration.clientId) return null;
    return collaboration.participants.find((p) => p.clientId === collaboration.clientId) ?? null;
  }, [collaboration.isActive, collaboration.clientId, collaboration.participants]);

  const canEditLayer = useCallback(
    (layerId: string): boolean => {
      if (!collaboration.isActive) return true;
      if (collaborationApi?.canEditLayer) return collaborationApi.canEditLayer(layerId);
      if (!selfParticipant) {
        if (collaboration.role === "host") return true;
        return (
          collaboration.mode === "co-edit" &&
          !(collaboration.lockedLayerIds ?? []).includes(layerId)
        );
      }
      return participantCanEditLayer(
        selfParticipant,
        collaboration.mode,
        layerId,
        collaboration.lockedLayerIds ?? [],
      );
    },
    [
      collaboration.isActive,
      collaboration.role,
      collaboration.mode,
      collaboration.lockedLayerIds,
      selfParticipant,
      collaborationApi,
    ],
  );

  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [basemapPickerOpen, setBasemapPickerOpen] = useState(false);
  const [metadataLayer, setMetadataLayer] = useState<GeoLibreLayer | null>(null);
  const [metadataCopied, setMetadataCopied] = useState(false);
  // GeoTIFF header facts (CRS, pixel size, storage) for the raster whose
  // metadata dialog is open. The store layer does not carry them, so they are
  // read from the file on open (#1420): "loading" while the header is being
  // fetched, "error" when it cannot be read.
  const [rasterInfoState, setRasterInfoState] = useState<RasterInfoState | null>(null);
  // Explicit metadata dialog size once the user drags the corner grip (null =
  // the default responsive size). Kept across open/close so a size chosen for
  // one layer still applies to the next. `metadataDialogRef` reads the live
  // element size at the start of a drag; `metadataResizeCleanupRef` tears down
  // the listeners on unmount.
  const metadataDialogRef = useRef<HTMLDivElement>(null);
  const [metadataDialogSize, setMetadataDialogSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const metadataResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => metadataResizeCleanupRef.current?.(), []);
  const [layerPendingRemoval, setLayerPendingRemoval] = useState<GeoLibreLayer | null>(null);
  const [refreshSettingsLayerId, setRefreshSettingsLayerId] = useState<string | null>(null);
  const [refreshStatuses, setRefreshStatuses] = useState<Record<string, LayerRefreshStatus>>({});
  // "Last synced <relative time>" is derived from the clock, not from store
  // state, so without a tick the label would keep reading "a few seconds ago"
  // until an unrelated re-render happened to recompute it. Tick once a minute
  // while the panel is open and at least one layer carries a sync timestamp.
  const [, setSyncClockTick] = useState(0);
  const [refreshIntervalChoice, setRefreshIntervalChoice] = useState("0");
  const [customRefreshSeconds, setCustomRefreshSeconds] = useState("");
  // Time Slider binding dialog: the target layer, the detected timestamp
  // columns, the chosen property, and the window width. `candidates` is null
  // while the layer's features are still being inspected.
  const [bindTimeSliderLayerId, setBindTimeSliderLayerId] = useState<string | null>(null);
  const [bindCandidates, setBindCandidates] = useState<TimePropertyCandidate[] | null>(null);
  const [bindProperty, setBindProperty] = useState("");
  const [bindWindowMode, setBindWindowMode] = useState<"step" | "wide" | "wider" | "cumulative">(
    "step",
  );
  // Feature properties resolved when the bind dialog opens, reused on confirm so
  // a large layer is scanned only once. A GeoJSON layer contributes every
  // feature; a tile layer contributes the features of its loaded tiles.
  const [bindRecords, setBindRecords] = useState<TimePropertyRecord[] | null>(null);
  // True when the target layer draws from vector tiles, so the scanned extent
  // covers only the loaded tiles and the dialog offers it for editing.
  const [bindIsTileLayer, setBindIsTileLayer] = useState(false);
  // The editable extent, as the text shown in the inputs (a year, or an ISO
  // date). Empty until a property is chosen and its extent is prefilled.
  const [bindRangeStart, setBindRangeStart] = useState("");
  const [bindRangeEnd, setBindRangeEnd] = useState("");
  // Shown in the dialog when binding fails (e.g. the chosen property has no
  // parseable timestamps) instead of closing the dialog with no feedback.
  const [bindError, setBindError] = useState<string | null>(null);
  // Monotonic token for the active bind request. Each open/close bumps it, so a
  // stale async scan or confirm (even for the same layer reopened) is dropped
  // when it no longer matches the latest token.
  const bindRequestRef = useRef(0);
  // A layer becomes temporal when its renderer finishes resolving a time axis
  // (a Zarr cube loads its `time` coordinate asynchronously), which happens
  // outside the store, so the menu subscribes to the adapter registry to offer
  // "Bind to Time Slider" as soon as one appears.
  useSyncExternalStore(subscribeTemporalLayers, getTemporalLayersVersion, getTemporalLayersVersion);
  const { isActive: isPluginActive, toggle: togglePlugin } = usePluginRegistry();
  const [internalCollapsed, setInternalCollapsed] = useState(getIsMobileViewport);
  // In the shared left-sidebar mode the parent owns collapse (controlled);
  // otherwise the panel manages it locally. `setIsCollapsed` routes to whichever
  // owner applies so every existing call site keeps working.
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;
  const hasSyncTimestamps = layers.some((layer) => Boolean(layer.connection?.lastSyncedAt));
  useEffect(() => {
    if (isCollapsed || !hasSyncTimestamps) return;
    const timer = window.setInterval(
      () => setSyncClockTick((tick) => tick + 1),
      SYNC_CLOCK_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [isCollapsed, hasSyncTimestamps]);
  // Quick analysis (#1523): run an existing vector tool over a whole layer from
  // its actions menu, with defaults filled in. No new algorithms — each entry
  // dispatches the same tool the Processing dialog would, so the run shows up in
  // the Processing History panel and can be re-run or copied as Python there.
  const quickScaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  const quickBufferPresets = useMemo(() => bufferPresetsFor(quickScaleUnit), [quickScaleUnit]);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);

  const formatQuickDistance = useCallback(
    (preset: QuickBufferPreset) => formatBufferDistance(preset, i18n.language, t),
    [i18n.language, t],
  );

  const runLayerQuickTool = useCallback(
    (layer: GeoLibreLayer, toolId: string, parameters: Record<string, unknown>, name: string) => {
      void runQuickAnalysis({
        toolId,
        parameters: { layer: layer.id, ...parameters },
        resultName: name,
        mapControllerRef,
      });
    },
    [mapControllerRef],
  );

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
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(
    () => new Set(selectedLayerId ? [selectedLayerId] : []),
  );
  const selectionAnchorRef = useRef<string | null>(selectedLayerId);
  const [dropTargetLayerId, setDropTargetLayerId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
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
  // Layer ids with a Save to My Data in flight, so a repeat click during the
  // vector-control materialize cannot create a duplicate library entry.
  const savingToLibraryIdsRef = useRef(new Set<string>());
  const refreshTimersRef = useRef(new Map<string, LayerRefreshTimer>());
  const refreshStatusTimersRef = useRef(new Map<string, number>());
  // Active filesystem watchers for "watch local file" layers, keyed by layer id.
  // `path` lets us restart the watch if a layer's source path ever changes;
  // `unwatch` tears it down (and doubles as a cancel flag while `watch()` is
  // still resolving — see the watch-lifecycle effect below).
  const watchUnsubsRef = useRef(new Map<string, { path: string; unwatch: () => void }>());
  const visibleLayers = useMemo(() => [...layers].reverse(), [layers]);
  useEffect(() => {
    const existingIds = new Set(layers.map((layer) => layer.id));
    setSelectedLayerIds((current) => {
      const next = new Set([...current].filter((id) => existingIds.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
    if (selectionAnchorRef.current && !existingIds.has(selectionAnchorRef.current)) {
      selectionAnchorRef.current = null;
    }
  }, [layers]);
  useEffect(() => {
    if (!selectedLayerId) return;
    setSelectedLayerIds((current) =>
      current.has(selectedLayerId) ? current : new Set([selectedLayerId]),
    );
    selectionAnchorRef.current = selectedLayerId;
  }, [selectedLayerId]);
  // Group lookup + the top-most member of each group in display order. Members
  // are kept contiguous in `layers`, so the first occurrence walking the
  // reversed list is where the group's header is drawn inline. Memoized so they
  // are not rebuilt on renders caused by unrelated state (hover, slider drag).
  const groupById = useMemo(
    () => new Map(layerGroups.map((g) => [g.id, g] as const)),
    [layerGroups],
  );
  const groupDepth = useCallback(
    (group: LayerGroup) => layerGroupDepth(group, groupById),
    [groupById],
  );
  const hasCollapsedAncestor = useCallback(
    (group: LayerGroup) => {
      let parentId = group.parentId;
      const visited = new Set([group.id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = groupById.get(parentId);
        if (!parent) return false;
        if (parent.collapsed) return true;
        parentId = parent.parentId;
      }
      return false;
    },
    [groupById],
  );
  const groupMoveTargets = useCallback(
    (group: LayerGroup) =>
      layerGroups.filter((candidate) => {
        if (candidate.id === group.id) return false;
        let parentId: string | undefined = candidate.parentId;
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
          if (parentId === group.id) return false;
          visited.add(parentId);
          parentId = groupById.get(parentId)?.parentId;
        }
        return true;
      }),
    [groupById, layerGroups],
  );
  // Every group header — the group a row belongs to, the organizers above it
  // whose layers all live in child groups, and the folders holding no layer at
  // all — comes from one core walk, anchored to the layer row it is drawn
  // above. Deriving them together is what keeps a nested folder below the
  // parent it sits in, and lets an empty folder keep its spot relative to its
  // siblings when one of them gains a layer (GeoLibre#1739).
  const groupHeaders = useMemo(
    () => layerPanelGroupHeaders(layers, layerGroups),
    [layers, layerGroups],
  );
  const groupMoveability = useMemo(
    () => layerGroupMoveability(layers, layerGroups),
    [layers, layerGroups],
  );
  // Resize the metadata dialog from its bottom-end grip. The dialog is centred
  // via a -50% transform, so each edge moves by half the size change; growing
  // by 2x the pointer delta keeps the grip under the cursor. In an RTL layout
  // the grip renders on the physical left, so the horizontal delta is inverted
  // (the same idiom as the Basemap Extract panel's grip).
  const startMetadataResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const el = metadataDialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const isRtl = document.documentElement.dir === "rtl";
    const startX = event.clientX;
    const startY = event.clientY;
    const startW = rect.width;
    const startH = rect.height;
    let next = { width: startW, height: startH };
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = isRtl ? "nesw-resize" : "nwse-resize";
    document.body.style.userSelect = "none";

    const onMove = (e: PointerEvent) => {
      const deltaX = (e.clientX - startX) * (isRtl ? -1 : 1);
      next = {
        width: Math.max(320, Math.min(window.innerWidth - 16, startW + deltaX * 2)),
        height: Math.max(240, Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2)),
      };
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setMetadataDialogSize(next);
      });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      metadataResizeCleanupRef.current = null;
    };
    const onUp = () => {
      cleanup();
      setMetadataDialogSize(next);
    };
    metadataResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  // The header read scoped to the layer whose metadata dialog is open. A state
  // left over from a previously inspected layer is ignored rather than shown
  // under the new layer's name.
  const metadataRasterInfo =
    rasterInfoState && rasterInfoState.layerId === metadataLayer?.id ? rasterInfoState : null;
  const metadataJson = metadataLayer
    ? JSON.stringify(
        layerMetadataPayload(
          metadataLayer,
          metadataRasterInfo?.status === "ready" ? metadataRasterInfo.info : null,
        ),
        null,
        2,
      )
    : "";
  const copyMetadata = useCallback(() => {
    if (!metadataJson) return;
    void navigator.clipboard
      ?.writeText(metadataJson)
      .then(() => setMetadataCopied(true))
      .catch(() => setMetadataCopied(false));
  }, [metadataJson]);
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
    basemapVisible &&
    layers.every((layer) => layer.visible) &&
    layerGroups.every((group) => group.visible);
  const toggleAllLayers = () => {
    const nextVisible = !allLayersVisible;
    for (const layer of layers) {
      setLayerVisibility(layer.id, nextVisible);
    }
    for (const group of layerGroups) {
      setLayerGroupVisibility(group.id, nextVisible);
    }
    setBasemapVisible(nextVisible);
  };
  const draggedDisplayIndex = draggedLayerId
    ? visibleLayers.findIndex((layer) => layer.id === draggedLayerId)
    : -1;
  const customRefreshIntervalMs = parseCustomRefreshIntervalMs(customRefreshSeconds);

  const resetDragState = () => {
    setDraggedLayerId(null);
    setDropTargetLayerId(null);
    setDropTargetGroupId(null);
  };

  const selectedMoveIds = (layerId: string) =>
    selectedLayerIds.has(layerId) && selectedLayerIds.size > 1
      ? layers.filter((layer) => selectedLayerIds.has(layer.id)).map((layer) => layer.id)
      : [layerId];

  const handleLayerSelection = (event: ReactMouseEvent<HTMLDivElement>, layerId: string) => {
    if (event.shiftKey && selectionAnchorRef.current) {
      const anchorIndex = visibleLayers.findIndex(
        (layer) => layer.id === selectionAnchorRef.current,
      );
      const layerIndex = visibleLayers.findIndex((layer) => layer.id === layerId);
      if (anchorIndex >= 0 && layerIndex >= 0) {
        const start = Math.min(anchorIndex, layerIndex);
        const end = Math.max(anchorIndex, layerIndex);
        setSelectedLayerIds(new Set(visibleLayers.slice(start, end + 1).map((layer) => layer.id)));
      }
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedLayerIds);
      if (next.has(layerId) && next.size > 1) next.delete(layerId);
      else next.add(layerId);
      setSelectedLayerIds(next);
      selectionAnchorRef.current = layerId;
      selectLayer(next.has(layerId) ? layerId : [...next][0]);
      return;
    } else {
      setSelectedLayerIds(new Set([layerId]));
      selectionAnchorRef.current = layerId;
    }
    selectLayer(layerId);
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
    const group = useAppStore.getState().layerGroups.find((g) => g.id === id);
    if (group) beginGroupRename(group);
  };

  // Toggle a celestial body in the switcher (like Google Earth's planet
  // dropdown). Selecting a body applies its basemap and syncs the ellipsoid;
  // deselecting the active body returns to Earth and restores the basemap that
  // was showing before (e.g. Liberty).
  const togglePlanet = (body: EllipsoidId, selected: boolean) => {
    if (!selected) {
      restoreEarthBasemap(previousEarthBasemap.current ?? DEFAULT_BASEMAP);
      return;
    }
    const option = PLANET_SWITCHER_OPTIONS.find((o) => o.ellipsoidId === body);
    const basemap = option && getPlanetaryBasemapById(option.basemapId);
    if (basemap) applyPlanetaryBasemap(basemap);
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

  const handleCopyStyle = useCallback(
    (layer: GeoLibreLayer) => {
      // Only confirm when a style was actually captured; the action no-ops on a
      // non-copyable layer.
      if (!copyLayerStyle(layer.id)) return;
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "success",
          message: t("layers.styleCopied", { name: layer.name }),
        },
      }));
      scheduleStatusClear(layer.id);
    },
    [copyLayerStyle, clearRefreshStatusTimer, scheduleStatusClear, t],
  );

  const handlePasteStyle = useCallback(
    (layer: GeoLibreLayer) => {
      // Read the source name before pasting; the message names the layer the
      // clipboard style came from.
      const sourceName = useAppStore.getState().copiedLayerStyle?.sourceName ?? "";
      // Only confirm when the style was actually applied; the action no-ops on
      // an empty clipboard or a family mismatch.
      if (!pasteLayerStyle(layer.id)) return;
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "success",
          message: t("layers.stylePasted", { name: sourceName }),
        },
      }));
      scheduleStatusClear(layer.id);
    },
    [pasteLayerStyle, clearRefreshStatusTimer, scheduleStatusClear, t],
  );

  /**
   * Save a fully configured layer to the app-level Layer Library (issue #1520)
   * so it can be re-added to any later project from the Browser panel's My Data
   * section. Reuses the per-layer status row for feedback, like the style
   * copy/paste actions above.
   *
   * An Add Vector Layer layer holds its features in the control, not the store,
   * so its current data is read from there first — the same materialization the
   * project Embed/Share flow uses — instead of relying on the store's
   * attribute-table copy, which a tiles-mode layer does not have.
   */
  const handleSaveToLibrary = useCallback(
    async (layer: GeoLibreLayer) => {
      // Guard re-entrancy across the materialize await below: a second invocation
      // for the same layer before the first resolves would save two entries under
      // two freshly generated ids (mirrors handleRefreshLayer's
      // refreshingLayerIdsRef).
      if (savingToLibraryIdsRef.current.has(layer.id)) return;
      savingToLibraryIdsRef.current.add(layer.id);
      try {
        const features = isEmbeddableLocalVectorLayer(layer)
          ? (await materializeEmbeddableVectorLayers([layer])).get(layer.id)
          : undefined;
        // The materialize await can outlive a concurrent style/opacity/join edit,
        // so capture from the current layer rather than the closure's snapshot
        // (mirrors handleImportStyle / handleSaveEditsToSource).
        const latest = useAppStore.getState().layers.find((l) => l.id === layer.id) ?? layer;
        const result = captureLayerLibraryEntry(latest, {
          id: createLayerLibraryEntryId(),
          addedAt: new Date().toISOString(),
          ...(features ? { features } : {}),
        });
        clearRefreshStatusTimer(layer.id);
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: result.ok
            ? {
                type: "success",
                message: t("layers.savedToLibrary", { name: layer.name }),
              }
            : {
                type: "error",
                message:
                  result.reason === "features-too-large"
                    ? t("layers.saveToLibraryTooLarge")
                    : result.reason === "config-too-large"
                      ? t("layers.saveToLibraryConfigTooLarge")
                      : t("layers.saveToLibraryNoSource"),
              },
        }));
        scheduleStatusClear(layer.id);
        if (result.ok) saveLayerLibraryEntry(result.entry);
      } finally {
        savingToLibraryIdsRef.current.delete(layer.id);
      }
    },
    [saveLayerLibraryEntry, clearRefreshStatusTimer, scheduleStatusClear, t],
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
          message: automatic ? t("layers.refreshingAuto") : t("layers.refreshing"),
        },
      }));

      try {
        if (isSqlQueryLayer(layer)) {
          // SQL query layers refresh by re-executing their stored DuckDB
          // statement against the current layers (the query layer itself is
          // excluded so it cannot shadow a source table name).
          const { geojson, featureCount } = await refreshSqlQueryLayer(
            layer,
            useAppStore.getState().layers,
          );
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (!latest) return;

          updateLayer(layer.id, {
            geojson,
            ...setLayerConnectionResult(latest, {
              syncedAt: new Date().toISOString(),
              error: null,
            }),
            metadata: {
              ...latest.metadata,
              featureCount,
            },
          });

          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.refreshedCount", {
                count: featureCount.toLocaleString(),
              }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        if (isLocalFileLayer(layer)) {
          // Local-file vector layers re-read their features from disk (the same
          // conversion the import ran) rather than fetching a URL.
          const { geojson, featureCount } = await reloadLocalFileLayer(layer);
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (!latest) return;

          updateLayer(layer.id, {
            geojson,
            ...setLayerConnectionResult(latest, {
              syncedAt: new Date().toISOString(),
              error: null,
            }),
            metadata: {
              ...latest.metadata,
              featureCount,
            },
          });

          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.refreshedCount", {
                count: featureCount.toLocaleString(),
              }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        if (isVectorControlRefreshLayer(layer)) {
          // A layer whose restore failed stays in the project but never made it
          // into the control, so reloadLayer cannot find it. Replaying it is
          // what brings such a layer back once the source is reachable again,
          // which is why refresh (manual and automatic) tries that second.
          const info =
            (await reloadVectorControlLayer(layer.id)) ??
            (await replayVectorControlLayerById(layer.id));
          if (!info) {
            // The control is unavailable (panel never opened, or torn down
            // and not yet replayed) or the replay above did not succeed.
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
            throw new Error(t("layers.refreshVectorControlError"));
          }
          // reloadLayer fires `layerupdated`, which drives
          // syncVectorLayersToStore to persist the refreshed featureCount (and
          // bounds) into the store. We intentionally don't call updateLayer
          // here: the metadata write is handled by that event, and a second
          // write would risk clobbering the synced values. `info` feeds only
          // the toast below.
          const featureCount = typeof info.featureCount === "number" ? info.featureCount : null;
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (latest) {
            updateLayer(
              layer.id,
              setLayerConnectionResult(latest, {
                syncedAt: new Date().toISOString(),
                error: null,
              }),
            );
          }
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message:
                featureCount === null
                  ? t("layers.refreshed")
                  : t("layers.refreshedCount", {
                      count: featureCount.toLocaleString(),
                    }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const {
          geojson,
          featureCount,
          metadata: refreshedMetadata,
        } = await refreshGeoJsonLayer(layer);
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;

        updateLayer(layer.id, {
          geojson,
          ...setLayerConnectionResult(latest, {
            syncedAt: new Date().toISOString(),
            error: null,
          }),
          metadata: {
            ...latest.metadata,
            featureCount,
            // Source kinds whose refresh recomputes more than the count (an OGC
            // API - Features layer's numberMatched/truncated) patch it here.
            ...refreshedMetadata,
          },
        });

        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: {
            type: "success",
            message: t("layers.refreshedCount", {
              count: featureCount.toLocaleString(),
            }),
          },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.refreshError");
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        if (latest) {
          updateLayer(layer.id, {
            ...setLayerConnectionResult(latest, { error: message }),
            ...(latest.connection?.onFailure === "clear" && latest.geojson
              ? { geojson: { type: "FeatureCollection" as const, features: [] } }
              : {}),
          });
        }
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
    [clearRefreshStatusTimer, scheduleStatusClear, t, updateLayer],
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
              ? t("layers.exportStyleDataNotReady")
              : t("layers.exportNeedsFeatures");
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const egressGeojson = layer.fieldVisibility
          ? excludeHiddenFieldsFromGeojson(geojson, layer.fieldVisibility)
          : geojson;
        const savedPath = await exportVectorLayer(
          egressGeojson,
          format,
          sanitizeExportFileName(layer.name),
          layer.name,
        );
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          // Surface Shapefile field-name limitations so renamed/merged
          // attributes do not come as a surprise to QGIS/ArcGIS users.
          const warnings = format === "shapefile" ? shapefileFieldWarnings(geojson) : [];
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              warnings.length > 0
                ? {
                    type: "warning",
                    message: t("layers.exportedWithWarnings", {
                      warnings: warnings.join(" "),
                    }),
                  }
                : { type: "success", message: t("layers.exported") },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message =
          kmlExportErrorMessage(error, t) ??
          (error instanceof Error ? error.message : t("layers.exportLayerError"));
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, t],
  );

  // Shared symbology-export flow: resolve the layer's features, build the style
  // text via `build`, save it, and set the success/warning/error status. Each
  // format (Mapbox GL / SLD / QML) supplies only its builder and file metadata,
  // so the three export handlers stay in sync as more formats are added. A
  // builder returns `{ error }` to abort with a message (e.g. the Mapbox
  // exporter needs embedded features), or `{ text, warnings }` to save.
  const exportLayerStyle = useCallback(
    async (
      layer: GeoLibreLayer,
      build: (
        geojson: FeatureCollection | null,
      ) => { text: string; warnings: string[] } | { error: string },
      fileMeta: {
        defaultName: string;
        filters: { name: string; extensions: string[] }[];
        browserTypes: {
          description: string;
          accept: Record<string, string[]>;
        }[];
        mimeType: string;
      },
    ) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const geojson = await resolveLayerGeojson(
          layer,
          mapControllerRef.current?.getMap() ?? undefined,
        );
        const built = build(geojson ?? null);
        if ("error" in built) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: { type: "error", message: built.error },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const savedPath = await saveTextFileWithFallback(built.text, fileMeta);
        // A null path means the user cancelled the save dialog, so no note.
        if (savedPath !== null) {
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]:
              built.warnings.length > 0
                ? {
                    type: "warning",
                    message: `${t("layers.exportStyleSuccess")} ${built.warnings.join(" ")}`,
                  }
                : { type: "success", message: t("layers.exportStyleSuccess") },
          }));
          scheduleStatusClear(layer.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.exportStyleError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, t],
  );

  // Export a vector layer's symbology as a self-contained Mapbox GL / MapLibre
  // style document, so the cartography can be reused in another map or handed to
  // a teammate instead of being locked inside the .geolibre.json project.
  const handleExportStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          if (!geojson) {
            // A source-backed (Add Vector Layer) layer whose features are not
            // readable yet is usually a not-yet-ready map source; the Mapbox
            // export embeds the data, so it cannot proceed without it.
            return {
              error:
                geojsonVectorSourceId(layer) !== null
                  ? t("layers.exportStyleDataNotReady")
                  : t("layers.exportStyleNeedsFeatures"),
            };
          }
          const result = buildMapboxStyle(layer, geojson);
          return { text: mapboxStyleToJson(result), warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.style.json`,
          filters: [{ name: "Mapbox GL style", extensions: ["json"] }],
          browserTypes: [
            {
              description: "Mapbox GL style",
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      ),
    [exportLayerStyle, t],
  );

  // Export the compact style consumed by `?data=…&style=…`. Its render-layer
  // source is the original data filename stem, which also lets one style file
  // target individual GeoJSON members of a ZIP archive.
  const handleExportGeoLibreStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          if (!geojson) {
            return {
              error:
                geojsonVectorSourceId(layer) !== null
                  ? t("layers.exportStyleDataNotReady")
                  : t("layers.exportStyleNeedsFeatures"),
            };
          }
          const result = buildGeoLibreQueryStyle(layer, geojson);
          return { text: mapboxStyleToJson(result), warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(geoLibreStyleSourceName(layer))}.geolibre.style.json`,
          filters: [{ name: "GeoLibre URL style", extensions: ["json"] }],
          browserTypes: [
            {
              description: "GeoLibre URL style",
              accept: { "application/json": [".json"] },
            },
          ],
          mimeType: "application/json",
        },
      ),
    [exportLayerStyle, t],
  );

  // Export a vector layer's symbology as an OGC SLD document, the interchange
  // format QGIS, GeoServer, MapServer, and ArcGIS speak. Unlike the Mapbox
  // export, SLD carries no data, so a layer whose features are not readable can
  // still export (geometry detection falls back to a symbolizer superset).
  const handleExportSldStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          const result = buildSld(layer, geojson);
          return { text: result.sld, warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.sld`,
          filters: [{ name: "OGC SLD", extensions: ["sld", "xml"] }],
          browserTypes: [
            {
              description: "OGC SLD",
              accept: { "application/xml": [".sld", ".xml"] },
            },
          ],
          mimeType: "application/xml",
        },
      ),
    [exportLayerStyle],
  );

  // Export a vector layer's symbology as a QGIS QML style, the native style
  // format QGIS users have on disk, so GeoLibre cartography can be opened in
  // QGIS without rebuilding it by hand.
  const handleExportQmlStyle = useCallback(
    (layer: GeoLibreLayer) =>
      exportLayerStyle(
        layer,
        (geojson) => {
          const result = buildQml(layer, geojson);
          return { text: result.qml, warnings: result.warnings };
        },
        {
          defaultName: `${sanitizeExportFileName(layer.name)}.qml`,
          filters: [{ name: "QGIS QML", extensions: ["qml"] }],
          browserTypes: [
            {
              description: "QGIS QML",
              accept: { "application/xml": [".qml"] },
            },
          ],
          mimeType: "application/xml",
        },
      ),
    [exportLayerStyle],
  );

  // Import a symbology file (including GeoLibre URL and Mapbox/MapLibre style
  // JSON, or an OGC SLD/QGIS QML) and
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
            {
              name: "Style (GeoLibre URL / Mapbox GL / SLD / QML)",
              extensions: ["json", "sld", "qml", "xml"],
            },
          ],
          // Android filters document pickers by MIME type, but SLD and QML do
          // not have consistently reported MIME types. Leave the native picker
          // broad there, then validate the selected file by content below.
          androidFilters: [],
          accept: ".json,.sld,.qml,.xml,application/json,application/xml,text/xml",
          readText: true,
        });
        // A null result means the user dismissed the file dialog; no note. Guard
        // on `picked` itself (not `picked.text`) so an empty/whitespace file is
        // still parsed and surfaces an "invalid" error rather than a silent
        // no-op that looks like a cancel.
        if (!picked || picked.text === undefined) return;

        // Detect the format from the content, which is more reliable than the
        // file extension (a `.xml` can hold either XML dialect): a QGIS QML has
        // a `<qgis>`/`renderer-v2` root, an SLD a `StyledLayerDescriptor` root,
        // and everything else (including a `.geolibre.style.json` export) is
        // parsed as Mapbox GL style JSON. Its source binding is intentionally
        // irrelevant here: importing applies symbology to the selected layer.
        const trimmed = picked.text.trimStart();
        const isXml = trimmed.startsWith("<");
        const isQml = isXml && isQmlStyleXml(picked.text);
        const isSld = isXml && !isQml;

        let result:
          | ReturnType<typeof parseMapboxStyle>
          | ReturnType<typeof parseSld>
          | ReturnType<typeof parseQml>;
        let matched: number;
        let applyImport: (base: GeoLibreLayer["style"]) => GeoLibreLayer["style"];

        if (isQml) {
          const qmlResult = parseQml(picked.text);
          result = qmlResult;
          matched = qmlResult.matchedRuleCount;
          applyImport = (base) => applyQmlImport(base, qmlResult);
        } else if (isSld) {
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
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
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
        const message = error instanceof Error ? error.message : t("layers.importStyleError");
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
      const path = typeof layer.sourcePath === "string" ? layer.sourcePath.trim() : "";
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
              excluded_fields: layer.fieldVisibility
                ? Object.keys(layer.fieldVisibility).filter(
                    (k) => layer.fieldVisibility![k] === "excluded",
                  )
                : undefined,
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
            useAppStore.getState().layers.find((l) => l.id === layer.id)?.metadata ??
            layer.metadata;
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
        const message = error instanceof Error ? error.message : t("layers.saveEditsError");
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: { type: "error", message },
        }));
        scheduleStatusClear(layer.id);
      }
    },
    [clearRefreshStatusTimer, mapControllerRef, scheduleStatusClear, t, updateLayer],
  );

  // Close the bind dialog and invalidate any in-flight scan/confirm so a late
  // async result cannot reopen it, write stale candidates, or bind after cancel.
  const closeBindTimeSliderDialog = useCallback(() => {
    bindRequestRef.current += 1;
    setBindTimeSliderLayerId(null);
  }, []);

  // Fill the extent inputs from a property's scanned range. The upper bound is
  // rounded up so a partial trailing day/year is not cut off the timeline.
  const prefillBindRange = useCallback((records: TimePropertyRecord[], property: string) => {
    const provisional = buildTimeBindingFromRecords(records, property);
    setBindRangeStart(
      provisional ? formatTimeExtentInput(provisional.min, provisional.valueKind) : "",
    );
    setBindRangeEnd(
      provisional ? formatTimeExtentInput(provisional.max, provisional.valueKind, true) : "",
    );
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
      setBindRecords(null);
      setBindRangeStart("");
      setBindRangeEnd("");
      setBindError(null);
      const isTileLayer = isTileVectorLayer(layer);
      setBindIsTileLayer(isTileLayer);
      try {
        const map = mapControllerRef.current?.getMap() ?? undefined;
        // A tile layer has no feature collection to scan — read the features of
        // its currently loaded tiles instead. That sample is enough to find the
        // timestamp column and how it stores its values; the extent it yields
        // covers only those tiles, so the dialog prefills it as an editable
        // range rather than treating it as the data's true span.
        const records: TimePropertyRecord[] = isTileLayer
          ? sampleTileFeatureRecords(map, layer)
          : ((await resolveLayerGeojson(layer, map))?.features ?? []).map(
              (feature) => feature?.properties,
            );
        if (bindRequestRef.current !== token) return;
        const candidates = detectTimePropertiesFromRecords(records);
        setBindRecords(records);
        setBindCandidates(candidates);
        if (candidates.length > 0) {
          setBindProperty(candidates[0].property);
          if (isTileLayer) prefillBindRange(records, candidates[0].property);
        }
      } catch {
        if (bindRequestRef.current !== token) return;
        setBindRecords([]);
        setBindCandidates([]);
      }
    },
    [mapControllerRef, prefillBindRange],
  );

  // Commit a binding: persist it on the layer metadata and activate the Time
  // Slider so it adopts the binding and drives the filter. Styling/opacity are
  // untouched; only the visible feature set narrows as the timeline moves.
  const confirmBindTimeSlider = useCallback(() => {
    const layer = bindTimeSliderLayer;
    // The records resolved when the dialog opened are reused here, so a large
    // layer is scanned only once.
    if (!layer || !bindProperty || !bindRecords) return;
    // Only a tile layer offers an editable extent: its scan saw just the loaded
    // tiles. A GeoJSON layer's scanned extent is exact and is used as-is.
    let extent: { min: number; max: number } | undefined;
    if (bindIsTileLayer) {
      const min = parseTimeValue(bindRangeStart);
      const max = parseTimeValue(bindRangeEnd);
      if (min === null || max === null) {
        setBindError(t("layers.bindRangeInvalid"));
        return;
      }
      extent = { min, max };
    }
    const binding = buildTimeBindingFromRecords(bindRecords, bindProperty, {
      extent,
    });
    if (!binding) {
      // Keep the dialog open and explain why, rather than closing silently.
      setBindError(t("layers.bindNoTimestamps"));
      return;
    }
    // A cumulative binding still steps one granularity unit at a time; what
    // changes is that the lower bound stays anchored at the start of the data.
    const timeWindow =
      bindWindowMode === "wider"
        ? { unit: binding.granularity, before: 3, after: 3 }
        : bindWindowMode === "wide"
          ? { unit: binding.granularity, before: 1, after: 1 }
          : { unit: binding.granularity, before: 0, after: 1 };
    // Re-read the layer before merging: the dialog stays open across an async
    // scan, so an auto-refresh or a concurrent edit can have replaced the
    // metadata since the last render, and spreading the render-time copy would
    // write those changes back out.
    const current = useAppStore.getState().layers.find((entry) => entry.id === layer.id);
    if (!current) return;
    updateLayer(layer.id, {
      metadata: {
        ...current.metadata,
        timeBinding: {
          ...binding,
          window: timeWindow,
          cumulative: bindWindowMode === "cumulative",
        },
      },
      timeFilter: undefined,
    });
    activateTimeSliderForBinding(mapControllerRef);
    closeBindTimeSliderDialog();
  }, [
    bindTimeSliderLayer,
    bindIsTileLayer,
    bindProperty,
    bindRangeEnd,
    bindRangeStart,
    bindRecords,
    bindWindowMode,
    mapControllerRef,
    updateLayer,
    closeBindTimeSliderDialog,
    t,
  ]);
  // Bind a layer whose time is an internal dimension (a Zarr data cube's `time`
  // axis, or a plugin's own custom layer). There is nothing to ask the user:
  // the adapter already knows the axis, so the binding is written and the dock
  // opens in one step rather than through the property-picking dialog.
  const handleBindTemporalLayer = useCallback(
    (layer: GeoLibreLayer) => {
      const adapter = getTemporalLayerAdapter(layer.id);
      if (!adapter) return;
      if (bindTemporalLayer(layer.id, adapter, mapControllerRef)) return;
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: { type: "error", message: t("layers.bindNoTimeDimension") },
      }));
      scheduleStatusClear(layer.id);
    },
    [mapControllerRef, scheduleStatusClear, t],
  );

  // Remove a layer's binding and clear its transient time filter so it shows
  // every feature again. The Time Slider stays active for any other bindings.
  const handleUnbindTimeSlider = useCallback(
    (layer: GeoLibreLayer) => {
      const { timeBinding: _removed, ...metadata } = layer.metadata as Record<string, unknown>;
      updateLayer(layer.id, { metadata, timeFilter: undefined });
      // Switch the plugin off once it has nothing left to drive, so the dock
      // does not linger over a map it no longer affects and the Plugins menu
      // stops showing it as active. The store write above is synchronous, so
      // the layer just unbound is already excluded. Any remaining binding, dock
      // source, or timespan overlay keeps it on.
      if (isPluginActive(TIME_SLIDER_PLUGIN_ID) && isTimeSliderIdle()) {
        togglePlugin(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
      }
    },
    [updateLayer, isPluginActive, togglePlugin, mapControllerRef],
  );

  const handleExportRasterLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      clearRefreshStatusTimer(layer.id);
      try {
        const savedPath = await exportRasterLayer(layer, sanitizeExportFileName(layer.name));
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
        const message = error instanceof Error ? error.message : t("layers.exportRasterError");
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
    if (refreshSettingsLayerId && !layers.some((layer) => layer.id === refreshSettingsLayerId)) {
      setRefreshSettingsLayerId(null);
    }

    if (bindTimeSliderLayerId && !layers.some((layer) => layer.id === bindTimeSliderLayerId)) {
      bindRequestRef.current += 1;
      setBindTimeSliderLayerId(null);
    }

    if (editingLayerId && !layers.some((layer) => layer.id === editingLayerId)) {
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

    setRefreshIntervalChoice(refreshIntervalOptionValue(refreshSettingsIntervalMs));
    setCustomRefreshSeconds(
      refreshIntervalOptionValue(refreshSettingsIntervalMs) === CUSTOM_REFRESH_INTERVAL_VALUE
        ? customRefreshIntervalSeconds(refreshSettingsIntervalMs)
        : "",
    );
  }, [refreshSettingsLayerId, refreshSettingsIntervalMs]);

  // Read the GeoTIFF header behind an open raster metadata dialog so it can
  // report the native CRS and pixel size the store layer never captured
  // (#1420). Only the header is fetched, and the result is dropped when the
  // dialog closes or moves to another layer while the read is in flight.
  useEffect(() => {
    const url = metadataLayer ? rasterInfoUrl(metadataLayer) : null;
    if (!metadataLayer || !url) {
      setRasterInfoState(null);
      return;
    }

    const layerId = metadataLayer.id;
    let cancelled = false;
    setRasterInfoState({ layerId, status: "loading" });
    void readRasterInfo(url)
      .then((info) => {
        if (!cancelled) setRasterInfoState({ layerId, status: "ready", info });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.warn("[GeoLibre] Failed to read raster metadata", error);
        setRasterInfoState({ layerId, status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [metadataLayer]);

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
        if (document.hidden) return;
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
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

  // Timers pause while the tab is hidden. On return, immediately catch up any
  // connection whose last successful sync is older than its configured cadence.
  useEffect(() => {
    const catchUp = () => {
      if (document.hidden) return;
      const now = Date.now();
      for (const layer of useAppStore.getState().layers) {
        const config = getLayerRefreshConfig(layer);
        if (!config.enabled || !isRefreshableLayer(layer)) continue;
        const lastSynced = layer.connection?.lastSyncedAt
          ? new Date(layer.connection.lastSyncedAt).getTime()
          : 0;
        if (!Number.isFinite(lastSynced) || now - lastSynced >= config.intervalMs) {
          void handleRefreshLayerRef.current(layer, true);
        }
      }
    };
    document.addEventListener("visibilitychange", catchUp);
    catchUp();
    return () => document.removeEventListener("visibilitychange", catchUp);
  }, [projectGeneration]);

  // Watch-mode lifecycle: for each local-file layer with watch enabled, register
  // a debounced filesystem watcher that reloads the layer when the file changes.
  // Only runs on the desktop host (the browser cannot watch a local path).
  useEffect(() => {
    if (!isTauri()) return;
    const activeLayerIds = new Set<string>();

    for (const layer of layers) {
      if (!isLocalFileLayer(layer) || !getLayerWatchConfig(layer).enabled) {
        continue;
      }
      const path = layer.sourcePath;
      if (typeof path !== "string" || !path) continue;

      activeLayerIds.add(layer.id);
      const existing = watchUnsubsRef.current.get(layer.id);
      // Already watching this exact path (or a start is in flight for it).
      if (existing?.path === path) continue;
      if (existing) existing.unwatch();

      // `watch()` resolves asynchronously; the effect may re-run or unmount
      // before it does. Record a placeholder whose `unwatch` flips `cancelled`
      // so a watcher that lands after teardown is torn down immediately, and so
      // a concurrent effect run sees the path as already handled.
      let cancelled = false;
      watchUnsubsRef.current.set(layer.id, {
        path,
        unwatch: () => {
          cancelled = true;
        },
      });

      // The stock fs-plugin `watch()` is subject to the fs runtime scope, so it
      // only covers paths granted this session via a picker/drag-drop (persisted
      // by tauri-plugin-persisted-scope) — the common case for a file the user
      // just added. Unlike "Reload from disk" (which falls back to the
      // scope-bypassing `read_local_file` command), watching a project-reopened
      // path that was never picked on this install can be scope-denied; that
      // surfaces as the `watchError` status below rather than silently doing
      // nothing. A scope-bypassing Rust watcher would be the follow-up if that
      // case proves common.
      void import("@tauri-apps/plugin-fs")
        .then(({ watch }) =>
          watch(
            path,
            () => {
              const latest = useAppStore
                .getState()
                .layers.find((candidate) => candidate.id === layer.id);
              if (!latest || !getLayerWatchConfig(latest).enabled) return;
              void handleRefreshLayerRef.current(latest, true);
            },
            // Debounce a burst of write events (a rewrite is rarely one event)
            // into a single reload.
            { delayMs: 400 },
          ),
        )
        .then((unwatch) => {
          if (cancelled) {
            unwatch();
            return;
          }
          watchUnsubsRef.current.set(layer.id, { path, unwatch });
        })
        .catch((error) => {
          // Only act if this attempt is still the live one. If it was cancelled
          // (watch toggled off, or off-then-on so a newer attempt now owns this
          // layer id), deleting the map entry would drop the newer attempt's
          // watcher and show a spurious error while watching is actually active.
          if (cancelled) return;
          watchUnsubsRef.current.delete(layer.id);
          console.warn(`[GeoLibre] Could not watch "${path}" for changes.`, error);
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "error",
              message: t("layers.watchError"),
            },
          }));
          scheduleStatusClear(layer.id);
        });
    }

    for (const [id, entry] of watchUnsubsRef.current) {
      if (activeLayerIds.has(id)) continue;
      entry.unwatch();
      watchUnsubsRef.current.delete(id);
    }
  }, [layers, scheduleStatusClear, t]);

  useEffect(() => {
    const watchers = watchUnsubsRef.current;
    return () => {
      for (const entry of watchers.values()) {
        entry.unwatch();
      }
      watchers.clear();
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
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
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

  const setRefreshFailurePolicy = useCallback(
    (layer: GeoLibreLayer, onFailure: "keep-last" | "clear") => {
      const latest =
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
      const config = getLayerRefreshConfig(latest);
      updateLayer(layer.id, {
        ...setLayerRefreshConfig(latest, config),
        connection: {
          layerId: layer.id,
          interval: config.enabled ? config.intervalMs / 1000 : null,
          lastSyncedAt: latest.connection?.lastSyncedAt ?? null,
          lastError: latest.connection?.lastError ?? null,
          onFailure,
        },
      });
    },
    [updateLayer],
  );

  const toggleWatchLayer = useCallback(
    (layer: GeoLibreLayer, enabled: boolean) => {
      // Read the latest layer so a concurrent reload's metadata is not
      // overwritten by a stale snapshot (mirrors setRefreshInterval).
      const latest =
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
      updateLayer(layer.id, setLayerWatchConfig(latest, enabled));
    },
    [updateLayer],
  );

  const handleLayerDragStart = (event: ReactDragEvent<HTMLElement>, layerId: string) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", layerId);
    if (!selectedLayerIds.has(layerId)) {
      setSelectedLayerIds(new Set([layerId]));
      selectionAnchorRef.current = layerId;
      selectLayer(layerId);
    }
    setDraggedLayerId(layerId);
  };

  const handleLayerDragOver = (event: ReactDragEvent<HTMLDivElement>, layerId: string) => {
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
      const moveIds = selectedMoveIds(draggedLayerId);
      if (moveIds.length > 1) {
        moveLayersRelative(
          moveIds,
          layerId,
          draggedDisplayIndex > displayIndex ? "above" : "below",
        );
      } else {
        // Same group (or both top-level): a plain reorder keeps contiguity.
        moveLayer(draggedLayerId, layers.length - 1 - displayIndex);
      }
    } else {
      // Crossing a group boundary: adopt the target's group and land next to it.
      moveLayersToGroup(selectedMoveIds(draggedLayerId), targetGroupId, layerId);
    }
    resetDragState();
  };

  const handleGroupHeaderDragOver = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!draggedLayerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetGroupId(groupId);
    setDropTargetLayerId(null);
  };

  const handleGroupHeaderDrop = (event: ReactDragEvent<HTMLDivElement>, groupId: string) => {
    if (!draggedLayerId) {
      resetDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveLayersToGroup(selectedMoveIds(draggedLayerId), groupId);
    resetDragState();
  };

  const renderGroupHeader = (group: LayerGroup) => {
    if (hasCollapsedAncestor(group)) return null;
    const isDropTarget = dropTargetGroupId === group.id;
    const moveability = groupMoveability.get(group.id);
    const moveTargets = groupMoveTargets(group);
    return (
      <div
        data-group-header=""
        data-testid="layer-group-header"
        data-group-name={group.name}
        className={`w-full min-w-0 max-w-full rounded-md border p-2 transition-colors ${
          isDropTarget
            ? "border-primary bg-primary/10"
            : "border-border bg-muted/30 hover:border-muted-foreground/40"
        }`}
        style={{
          marginInlineStart: `${groupDepth(group)}rem`,
          width: `calc(100% - ${groupDepth(group)}rem)`,
        }}
        onDragOver={(e) => handleGroupHeaderDragOver(e, group.id)}
        onDrop={(e) => handleGroupHeaderDrop(e, group.id)}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            title={group.collapsed ? t("layers.expandGroup") : t("layers.collapseGroup")}
            aria-label={group.collapsed ? t("layers.expandGroup") : t("layers.collapseGroup")}
            aria-expanded={!group.collapsed}
            onClick={(e) => {
              e.stopPropagation();
              toggleLayerGroupCollapsed(group.id);
            }}
          >
            {group.collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-muted"
            title={group.visible ? t("layers.hideGroup") : t("layers.showGroup")}
            aria-label={group.visible ? t("layers.hideGroup") : t("layers.showGroup")}
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
              className="min-w-0 flex-1 truncate text-sm font-semibold"
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
            <DropdownMenuContent align="end" onClick={(e: ReactMouseEvent) => e.stopPropagation()}>
              <DropdownMenuItem
                onSelect={(e: Event) => {
                  e.preventDefault();
                  beginGroupRename(group);
                }}
              >
                <Pencil className="me-2 h-3.5 w-3.5" />
                {t("layers.renameGroup")}
              </DropdownMenuItem>
              {addDataGroupSources.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderPlus className="h-3.5 w-3.5" />
                    {t("layers.addDataToGroup")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {addDataGroupSources.map((entry) => (
                      <DropdownMenuItem
                        key={entry.id}
                        onSelect={() => openAddData(entry.id, { groupId: group.id })}
                      >
                        {t(entry.labelKey)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {moveTargets.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Folder className="h-3.5 w-3.5" />
                    {t("layers.moveToGroup")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {moveTargets.map((target) => (
                      <DropdownMenuItem
                        key={target.id}
                        disabled={group.parentId === target.id}
                        onSelect={() => moveLayerGroupToGroup(group.id, target.id)}
                      >
                        {target.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {group.parentId && (
                <DropdownMenuItem onSelect={() => moveLayerGroupToGroup(group.id, null)}>
                  <FolderMinus className="me-2 h-3.5 w-3.5" />
                  {t("layers.removeFromGroup")}
                </DropdownMenuItem>
              )}
              {/* Action items below omit preventDefault so Radix dismisses the
                  menu on select; only the rename item above keeps it, so the
                  menu's close does not race its input autofocus. */}
              <DropdownMenuItem
                disabled={!moveability?.up}
                onSelect={() => {
                  reorderLayerGroup(group.id, "up");
                }}
              >
                <ChevronUp className="me-2 h-3.5 w-3.5" />
                {t("layers.moveGroupUp")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!moveability?.down}
                onSelect={() => {
                  reorderLayerGroup(group.id, "down");
                }}
              >
                <ChevronDown className="me-2 h-3.5 w-3.5" />
                {t("layers.moveGroupDown")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  removeLayerGroup(group.id);
                }}
              >
                <FolderMinus className="me-2 h-3.5 w-3.5" />
                {t("layers.ungroupKeepLayers")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onSelect={() => {
                  removeLayerGroup(group.id, { removeChildren: true });
                }}
              >
                <Trash2 className="me-2 h-3.5 w-3.5" />
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
        aria-label={t("layers.panelCollapsedLabel")}
        className="flex h-11 w-full shrink-0 items-center gap-2 border-b bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-b-0 md:border-e md:py-2"
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t("layers.expand")}
          aria-label={t("layers.expand")}
          onClick={() => setIsCollapsed(false)}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
          <Layers className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
            {t("sharedRail.layers")}
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t("sharedRail.layers")}
      className="relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-b bg-card max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--layer-panel-width)] md:border-b-0 md:border-e"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("layers.resizePanel")}
        className="absolute -end-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-e border-transparent hover:border-primary md:block"
        onPointerDown={onResizeStart}
      />
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-sm font-semibold">{t("sharedRail.layers")}</span>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("planetSwitcher.label")}
                aria-label={t("planetSwitcher.label")}
              >
                <Orbit
                  className={cn(
                    "h-4 w-4",
                    selectedPlanet && selectedPlanet !== "earth" && "text-primary",
                  )}
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{t("planetSwitcher.label")}</DropdownMenuLabel>
              {PLANET_SWITCHER_OPTIONS.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.ellipsoidId}
                  checked={selectedPlanet === option.ellipsoidId}
                  onCheckedChange={(checked) => togglePlanet(option.ellipsoidId, checked)}
                >
                  {t(PLANET_SWITCHER_LABEL_KEYS[option.ellipsoidId])}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("layers.basemaps")}
            aria-label={t("layers.basemaps")}
            aria-pressed={isPluginActive(BASEMAP_CONTROL_PLUGIN_ID)}
            onClick={() => togglePlugin(BASEMAP_CONTROL_PLUGIN_ID, createAppAPI(mapControllerRef))}
          >
            <MapIcon
              className={cn("h-4 w-4", isPluginActive(BASEMAP_CONTROL_PLUGIN_ID) && "text-primary")}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("layers.geoEditor")}
            aria-label={t("layers.geoEditor")}
            aria-pressed={isPluginActive(GEO_EDITOR_PLUGIN_ID)}
            onClick={() => togglePlugin(GEO_EDITOR_PLUGIN_ID, createAppAPI(mapControllerRef))}
          >
            <PenTool
              className={cn("h-4 w-4", isPluginActive(GEO_EDITOR_PLUGIN_ID) && "text-primary")}
            />
          </Button>
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
            title={allLayersVisible ? t("layers.hideAllLayers") : t("layers.showAllLayers")}
            aria-label={allLayersVisible ? t("layers.hideAllLayers") : t("layers.showAllLayers")}
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
            title={t("layers.collapse")}
            aria-label={t("layers.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ScrollArea
        className="flex-1 [&_[data-radix-scroll-area-viewport]>div]:block! [&_[data-radix-scroll-area-viewport]>div]:w-full! [&_[data-radix-scroll-area-viewport]>div]:min-w-0!"
        // Radix measures scroll content with an injected display:table
        // wrapper. Opt this viewport into block sizing so long layer names
        // cannot establish a wider min-content table.
      >
        <div className="w-full min-w-0 space-y-1 p-2">
          {layers.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              {isBeginnerProfile ? t("layers.emptyBeginner") : t("layers.empty")}
            </p>
          )}
          {visibleLayers.map((layer, displayIndex) => {
            const group = layer.groupId ? groupById.get(layer.groupId) : undefined;
            const groupCollapsed = group?.collapsed ?? false;
            const groupAncestorCollapsed = group ? hasCollapsedAncestor(group) : false;
            // When an ancestor group is hidden, a layer whose own visibility
            // toggle is still on is not rendered — a surprising state. Grey its
            // name and eye out as a cue that the group-level setting is what's
            // hiding it (issue #430). If the layer's own toggle is also off,
            // the EyeOff icon already explains it, so skip the group cue then.
            // Folded through effectiveLayerRenderState rather than read off the
            // immediate parent, so a hidden grandparent gets the cue too. Given
            // the memoized `groupById` rather than the array, so folding every
            // row does not rebuild that map once per layer.
            const groupHidden =
              layer.visible && !effectiveLayerRenderState(layer, groupById).visible;
            const visibilityToggleLabel = groupHidden
              ? `${t("layers.hiddenByGroup")} — ${t("layers.hideLayer")}`
              : layer.visible
                ? t("layers.hideLayer")
                : t("layers.showLayer");
            const canIdentify =
              layer.type === "geojson" ||
              isDuckDBQueryLayer(layer) ||
              (layer.type === "wms" &&
                typeof layer.source.layers === "string" &&
                Boolean(layer.source.layers.trim()) &&
                Boolean(
                  (typeof layer.source.url === "string" && layer.source.url.trim()) ||
                  layer.sourcePath,
                )) ||
              layer.type === "vector-tiles" ||
              (layer.type === "mbtiles" && layer.metadata.tileType === "vector") ||
              // COG layers identify pixel values via the raster control's pixel
              // inspector (see useRasterIdentify), not the vector feature query.
              layer.type === "cog" ||
              hasNativeIdentifyLayers(layer);
            const identifyActive = identifyLayerId === layer.id;
            // COGs inspect raw pixel/band values rather than vector features, so
            // the icon's tooltip reflects that distinct action. Time Slider COG
            // and mosaic sources read the same way, at the current timeline
            // date, and mark themselves with `pixelIdentify`.
            const isPixelIdentify = layer.type === "cog" || layer.metadata.pixelIdentify === true;
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
            const geometryEditElsewhere = geometryEditLayerId !== null && !geometryEditActive;
            const canMaterializeDuckDB =
              isDuckDBQueryLayer(layer) && typeof layer.metadata.query === "string";
            // The attribute table reads features from geojson layers (including
            // Add Vector Layer geojson-mode) and DuckDB query layers.
            const canOpenAttributeTable = layer.type === "geojson" || isDuckDBQueryLayer(layer);
            // The interactive selection dialogs (#1314) resolve selection ids
            // against in-store features, like the highlight overlay does.
            const canSelectFeatures = (layer.geojson?.features?.length ?? 0) > 0;
            // Selection actions act on the live selection, which always
            // belongs to the active layer.
            const holdsSelection =
              canSelectFeatures && layer.id === selectedLayerId && selectedFeatureCount > 0;
            // Export writes the layer's GeoJSON features to disk; only
            // geojson-backed vector layers carry those features.
            const canExportLayer = layer.type === "geojson";
            // Importing a style (Mapbox GL or SLD) only writes the layer's
            // vector symbology, so it applies to any vector-styled layer (local
            // GeoJSON and vector tiles), not just the export-capable GeoJSON
            // layers. Shares the Style Manager's gate so the two can't drift.
            const canImportStyle = isStyleLibraryTargetLayer(layer.type);
            // Saving the whole layer (source + style + labels + filters + joins)
            // to the Layer Library needs something re-addable to point at AND a
            // way to render it again (issue #1520), so a layer with no source and
            // no features is excluded — and so is a control-painted layer whose
            // kind has no restore route, which would otherwise re-add blank.
            // `hasMaterializableFeatures` is the same predicate the save handler
            // uses to read features out of the vector control, so the menu never
            // hides a layer the capture path could in fact embed (a tiles-mode
            // Add Vector Layer layer has no `layer.geojson` to look at).
            const canSaveToLibrary = canSaveLayerToLibrary(layer, {
              canRestoreControlPainted: canRestoreLibraryLayer,
              hasMaterializableFeatures: isEmbeddableLocalVectorLayer,
            });
            // Copy/paste symbology (issue #1339). Vector-styled layers and
            // deck.gl rasters each copy their own style family; a paste only
            // lands when the clipboard entry shares the target's family.
            const copyStyleKind = copyableLayerStyleKind(layer);
            const canPasteStyle = copiedLayerStyle?.kind === copyStyleKind;
            // Write-back commits edits to the layer's local source file in place
            // (desktop only, supported formats); Export writes a new file.
            const canWriteBack = canWriteEditsToSource(layer);
            // Vector layers with a date/timestamp property can be driven by the
            // Time Slider; the binding (if any) lives on the layer metadata.
            // Tile-backed vector layers qualify too: the window is a MapLibre
            // filter evaluated per feature as each tile decodes, so it needs no
            // local copy of the data (see the bind dialog for how the timeline's
            // extent is established without one).
            // A layer whose time is an internal dimension (a Zarr data cube)
            // binds through its registered temporal adapter instead, with no
            // property to pick: see handleBindTemporalLayer.
            const temporalAdapter = getTemporalLayerAdapter(layer.id);
            const canBindTimeSlider =
              layer.type === "geojson" || isTileVectorLayer(layer) || Boolean(temporalAdapter);
            const timeBinding = getLayerTimeBinding(layer);
            // Raster/COG layers backed by a downloadable file (a retained
            // local-bytes blob URL or a source URL) export to GeoTIFF.
            const canExportRaster = canExportRasterLayer(layer);
            // COG/WMS/XYZ layers can also export a bounding-box subset (a clip)
            // via the in-browser geolibre-wasm extractors, drawn on the map.
            const canExtractSubset = canExtractRasterSubset(layer);
            // Rasters added through the floating Add Raster Layer panel are
            // styled there; offer a shortcut to reopen that panel since it is
            // dismissed (and its on-map icon removed) when closed.
            const canEditRasterStyle = layer.metadata.sourceKind === RASTER_SOURCE_KIND;
            const canRefresh = isRefreshableLayer(layer);
            const isLayerLocked =
              collaboration.isActive && (collaboration.lockedLayerIds ?? []).includes(layer.id);
            const layerEditable = canEditLayer(layer.id);
            const refreshConfig = getLayerRefreshConfig(layer);
            // Live SQL query layers (issue #1295) refresh by re-running their
            // stored DuckDB statement and offer a shortcut to edit it.
            const isSqlLayer = isSqlQueryLayer(layer);
            // Local-file vector layers (desktop only) can be reloaded from disk
            // and watched for changes instead of the URL-based refresh above.
            const canWatchLocalFile = isTauri() && isLocalFileLayer(layer);
            const watchConfig = getLayerWatchConfig(layer);
            const transientRefreshStatus = refreshStatuses[layer.id];
            const refreshStatus: LayerRefreshStatus | undefined =
              transientRefreshStatus ??
              (layer.connection?.lastError
                ? {
                    type: "error",
                    message: t("layers.syncErrorStatus", {
                      message: layer.connection.lastError,
                    }),
                  }
                : layer.connection?.lastSyncedAt
                  ? {
                      type: "success",
                      message: t("layers.lastSynced", {
                        time: relativeSyncTime(layer.connection.lastSyncedAt, i18n.language),
                      }),
                    }
                  : undefined);
            const isRefreshing = refreshStatus?.type === "refreshing";
            const moveIds = selectedMoveIds(layer.id);
            return (
              <Fragment key={layer.id}>
                {groupHeaders.aboveLayer.get(layer.id)?.map((header) => (
                  <Fragment key={header.id}>{renderGroupHeader(header)}</Fragment>
                ))}
                {!groupCollapsed && !groupAncestorCollapsed && (
                  <div
                    data-layer-card=""
                    data-testid="layer-row"
                    data-layer-name={layer.name}
                    className={`relative min-w-0 max-w-full rounded-md border p-2 transition-colors ${
                      selectedLayerIds.has(layer.id)
                        ? "border-primary bg-primary/5"
                        : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
                    } ${draggedLayerId === layer.id ? "opacity-50" : ""} ${
                      // Nested rows get a calculated inline width below so
                      // their indentation cannot overflow the panel.
                      group ? "" : "w-full"
                    }`}
                    style={
                      group
                        ? {
                            marginInlineStart: `${groupDepth(group) + 1}rem`,
                            width: `calc(100% - ${groupDepth(group) + 1}rem)`,
                          }
                        : undefined
                    }
                    onDragOver={(e) => handleLayerDragOver(e, layer.id)}
                    onDrop={(e) => handleLayerDrop(e, layer.id, displayIndex)}
                    onDragEnd={resetDragState}
                    aria-pressed={selectedLayerIds.has(layer.id)}
                    onClick={(e) => handleLayerSelection(e, layer.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedLayerIds(new Set([layer.id]));
                        selectionAnchorRef.current = layer.id;
                        selectLayer(layer.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    {dropTargetLayerId === layer.id && draggedDisplayIndex > displayIndex && (
                      <div className="pointer-events-none absolute -top-1 left-2 right-2 h-1 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" />
                    )}
                    {dropTargetLayerId === layer.id &&
                      draggedDisplayIndex >= 0 &&
                      draggedDisplayIndex < displayIndex && (
                        <div className="pointer-events-none absolute -bottom-1 left-2 right-2 h-1 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" />
                      )}
                    <div className="flex min-w-0 items-center gap-1">
                      <span
                        role="button"
                        tabIndex={0}
                        draggable
                        title={t("layers.dragToReorder")}
                        aria-label={t("layers.dragNamedToReorder", {
                          name: layer.name,
                        })}
                        className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                        onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                        onDragStart={(e) => handleLayerDragStart(e, layer.id)}
                      >
                        <GripVertical className="h-3.5 w-3.5" />
                      </span>
                      <button
                        type="button"
                        className="rounded p-0.5 hover:bg-muted"
                        // The eye stays the layer's *own* switch even while a
                        // group hides it — showing EyeOff here would offer a
                        // "Show layer" that turns the layer's own toggle off,
                        // so revealing it later would take two clicks. The
                        // muted icon plus the tooltip say why it is not drawn.
                        // Same string for the tooltip and the accessible name,
                        // so the group-hidden context reaches a screen reader
                        // and not only a sighted hover.
                        title={visibilityToggleLabel}
                        aria-label={visibilityToggleLabel}
                        onClick={(e) => {
                          e.stopPropagation();
                          setLayerVisibility(layer.id, !layer.visible);
                        }}
                      >
                        {layer.visible ? (
                          <Eye
                            className={`h-3.5 w-3.5 ${groupHidden ? "text-muted-foreground" : ""}`}
                          />
                        ) : (
                          <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                      <LayerSwatchIcon layer={layer} />
                      {editingLayerId === layer.id ? (
                        <input
                          autoFocus
                          type="text"
                          className="flex-1 min-w-0 rounded border border-input bg-background px-1 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
                          value={editingName}
                          aria-label={t("layers.renameNamed", {
                            name: layer.name,
                          })}
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
                          className={`min-w-0 flex-1 truncate text-sm font-medium ${
                            groupHidden ? "text-muted-foreground" : ""
                          }`}
                          title={
                            isLayerLocked
                              ? t("collaborate.layerLockedHint")
                              : groupHidden
                                ? `${t("layers.hiddenByGroup")} — ${t("layers.doubleClickToRename")}`
                                : t("layers.doubleClickToRename")
                          }
                          onDoubleClick={(e: ReactMouseEvent) => {
                            e.stopPropagation();
                            if (layerEditable) beginRename(layer);
                          }}
                        >
                          {layer.name}
                        </span>
                      )}
                      {isLayerLocked && (
                        <span title={t("collaborate.layerLockedHint")}>
                          <Lock
                            className="h-3 w-3 shrink-0 text-amber-500"
                            aria-label={t("collaborate.layerLockedHint")}
                          />
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                        {layerTypeLabel(layer, t)}
                      </span>
                    </div>
                    {isPlaceholderLayer(layer) && (
                      <p className="mt-1 text-[10px] text-amber-600">{placeholderMessage(layer)}</p>
                    )}
                    {refreshStatus && (
                      <p
                        title={layer.connection?.lastError ?? layer.connection?.lastSyncedAt ?? ""}
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
                          {t("layers.editingGeometry")}
                        </span>
                        <Button
                          variant="default"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          title={t("layers.saveGeometryEdits")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleGeometryEdit(layer.id);
                          }}
                        >
                          {t("common.save")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          title={t("layers.discardGeometryEdits")}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancelGeometryEdit();
                          }}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    )}
                    {/* A plugin-painted layer (a MapLibre custom WebGL layer)
                        has no paint property for opacity to land on, so the
                        slider is only shown when the plugin bridged a setter for
                        it — otherwise it would move with no effect (#1445). */}
                    {(!pluginOwnsPaint(layer) || supportsBridgedOpacity(layer.id)) && (
                      <LayerOpacitySlider
                        label={t("layers.opacity")}
                        ariaLabel={t("layers.opacityFor", { name: layer.name })}
                        value={layer.opacity}
                        onChange={(v) => setLayerOpacity(layer.id, v)}
                      />
                    )}
                    <div className="mt-2 flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title={t("layers.moveUp")}
                        aria-label={t("layers.moveUp")}
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
                        title={t("layers.moveDown")}
                        aria-label={t("layers.moveDown")}
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
                        title={t("layers.zoomToLayer")}
                        aria-label={t("layers.zoomToLayer")}
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
                              refreshConfig.enabled ? "border border-primary text-primary" : ""
                            }`}
                            title={t("layers.layerActions")}
                            aria-label={t("layers.layerActions")}
                            onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onClick={(e: ReactMouseEvent) => e.stopPropagation()}
                        >
                          {collaboration.isActive && collaboration.role === "host" && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => {
                                  const currentLocks = collaboration.lockedLayerIds ?? [];
                                  const nextLocks = currentLocks.includes(layer.id)
                                    ? currentLocks.filter((id) => id !== layer.id)
                                    : [...currentLocks, layer.id];
                                  collaborationApi?.setLayerLocks(nextLocks);
                                }}
                              >
                                {isLayerLocked ? (
                                  <>
                                    <Unlock className="me-2 h-3.5 w-3.5 text-amber-500" />
                                    {t("collaborate.unlockLayer")}
                                  </>
                                ) : (
                                  <>
                                    <Lock className="me-2 h-3.5 w-3.5" />
                                    {t("collaborate.lockLayer")}
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          {/* Rename is available when layer is editable.
                          preventDefault keeps the menu's default close from
                          racing autoFocus on the rename input. */}
                          <DropdownMenuItem
                            disabled={!layerEditable}
                            onSelect={(e: Event) => {
                              e.preventDefault();
                              if (!layerEditable) return;
                              beginRename(layer);
                            }}
                          >
                            <Pencil className="me-2 h-3.5 w-3.5" />
                            {t("layers.rename")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {/* The Rename item above keeps preventDefault so the
                          menu's close does not race its input autofocus. Every
                          action item below has no such focus target, so each
                          lets Radix dismiss the menu on select rather than
                          leaving it pinned open. */}
                          {onOpenStylePanel && (
                            <DropdownMenuItem
                              onSelect={() => {
                                selectLayer(layer.id);
                                onOpenStylePanel();
                              }}
                            >
                              <Palette className="me-2 h-3.5 w-3.5" />
                              {t("layers.openStylePanel")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onSelect={() => {
                              addLayerGroup(undefined, moveIds);
                            }}
                          >
                            <FolderPlus className="me-2 h-3.5 w-3.5" />
                            {moveIds.length > 1
                              ? t("layers.newGroupFromSelectedLayers")
                              : t("layers.newGroupFromLayer")}
                          </DropdownMenuItem>
                          {layerGroups.length > 0 && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Folder className="h-3.5 w-3.5" />
                                {moveIds.length > 1
                                  ? t("layers.moveSelectedToGroup")
                                  : t("layers.moveToGroup")}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {layerGroups.map((g) => (
                                  <DropdownMenuItem
                                    key={g.id}
                                    disabled={moveIds.every(
                                      (id) =>
                                        layers.find((item) => item.id === id)?.groupId === g.id,
                                    )}
                                    onSelect={() => {
                                      moveLayersToGroup(moveIds, g.id);
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
                                moveLayersToGroup(moveIds, null);
                              }}
                            >
                              <FolderMinus className="me-2 h-3.5 w-3.5" />
                              {t("layers.removeFromGroup")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {canMaterializeDuckDB && (
                            <>
                              <DropdownMenuItem
                                disabled={!layerEditable}
                                onSelect={() => {
                                  if (!layerEditable) return;
                                  onMaterializeDuckDBLayer(layer);
                                }}
                              >
                                <Table2 className="me-2 h-3.5 w-3.5" />
                                {t("layers.materializeToEditable")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          {(canEditGeometry || geometryEditActive) && (
                            <DropdownMenuItem
                              disabled={geometryEditElsewhere || !layerEditable}
                              onSelect={() => {
                                if (!layerEditable) return;
                                selectLayer(layer.id);
                                if (identifyActive) setIdentifyLayer(null);
                                onToggleGeometryEdit(layer.id);
                              }}
                            >
                              <PencilRuler className="me-2 h-3.5 w-3.5" />
                              {geometryEditActive
                                ? t("layers.finishEditingGeometry")
                                : t("layers.editGeometry")}
                            </DropdownMenuItem>
                          )}
                          {canLoadIntoEditor && (
                            <DropdownMenuItem
                              disabled={!layerEditable}
                              onSelect={() => {
                                if (!layerEditable) return;
                                selectLayer(layer.id);
                                setLoadEditorFeaturesOpen(true, layer.id);
                              }}
                            >
                              <SquarePen className="me-2 h-3.5 w-3.5" />
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
                              <TableProperties className="me-2 h-3.5 w-3.5" />
                              {t("layers.openAttributeTable")}
                            </DropdownMenuItem>
                          )}
                          {canSelectFeatures && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Sparkles className="h-3.5 w-3.5" />
                                {t("quickAnalysis.menu")}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {quickBufferPresets.map((preset) => (
                                  <DropdownMenuItem
                                    key={`${preset.distance}-${preset.units}`}
                                    onSelect={() =>
                                      runLayerQuickTool(
                                        layer,
                                        "buffer",
                                        {
                                          distance: preset.distance,
                                          units: preset.units,
                                        },
                                        t("quickAnalysis.bufferOfLayerName", {
                                          name: layer.name,
                                          distance: formatQuickDistance(preset),
                                        }),
                                      )
                                    }
                                  >
                                    {t("quickAnalysis.bufferFeatures", {
                                      distance: formatQuickDistance(preset),
                                    })}
                                  </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() =>
                                    runLayerQuickTool(
                                      layer,
                                      "centroids",
                                      {},
                                      t("quickAnalysis.centroidsLayerName", {
                                        name: layer.name,
                                      }),
                                    )
                                  }
                                >
                                  {t("quickAnalysis.centroids")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    runLayerQuickTool(
                                      layer,
                                      "convex-hull",
                                      {},
                                      t("quickAnalysis.convexHullLayerName", {
                                        name: layer.name,
                                      }),
                                    )
                                  }
                                >
                                  {t("quickAnalysis.convexHull")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() =>
                                    runLayerQuickTool(
                                      layer,
                                      "bounding-box",
                                      {},
                                      t("quickAnalysis.boundingBoxLayerName", {
                                        name: layer.name,
                                      }),
                                    )
                                  }
                                >
                                  {t("quickAnalysis.boundingBox")}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => {
                                    selectLayer(layer.id);
                                    setVectorToolOpen("buffer");
                                  }}
                                >
                                  {t("quickAnalysis.openInProcessing")}
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {canSelectFeatures && (
                            <>
                              {/* Not selectLayer() + open: that would clear the
                              live selection the dialogs' add/remove/intersect
                              modes combine with, so the target travels via the
                              open setter instead. */}
                              <DropdownMenuItem
                                onSelect={() => setSelectByExpressionOpen(true, layer.id)}
                              >
                                <SquareFunction className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.selectByExpressionEllipsis")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!hasTwoSelectableLayers}
                                onSelect={() => setSelectByLocationOpen(true, layer.id)}
                              >
                                <Locate className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.selectByLocationEllipsis")}
                              </DropdownMenuItem>
                            </>
                          )}
                          {holdsSelection && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => zoomToSelection(mapControllerRef.current)}
                              >
                                <SquareDashed className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.zoomToSelection")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={invertLayerSelection}>
                                <Shuffle className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.invertSelection")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={clearFeatureSelection}>
                                <X className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.clearSelection")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() =>
                                  exportSelectionAsLayer(
                                    t("selection.exportedLayerName", {
                                      name: layer.name,
                                    }),
                                  )
                                }
                              >
                                <FilePlus2 className="me-2 h-3.5 w-3.5" />
                                {t("toolbar.item.exportSelection")}
                              </DropdownMenuItem>
                            </>
                          )}
                          {canBindTimeSlider && (
                            <DropdownMenuItem
                              onSelect={() => {
                                if (timeBinding) {
                                  handleUnbindTimeSlider(layer);
                                } else if (temporalAdapter) {
                                  handleBindTemporalLayer(layer);
                                } else {
                                  void openBindTimeSliderDialog(layer);
                                }
                              }}
                            >
                              <CalendarClock className="me-2 h-3.5 w-3.5" />
                              {timeBinding
                                ? t("layers.unbindFromTimeSlider")
                                : temporalAdapter
                                  ? t("layers.bindTimeDimensionToTimeSlider")
                                  : t("layers.bindToTimeSlider")}
                            </DropdownMenuItem>
                          )}
                          {canExportLayer && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Download className="h-3.5 w-3.5" />
                                {t("layers.export")}
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
                                    void handleExportLayer(layer, "kml");
                                  }}
                                >
                                  KML
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onSelect={() => {
                                    void handleExportLayer(layer, "kmz");
                                  }}
                                >
                                  KMZ
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
                                        void handleExportGeoLibreStyle(layer);
                                      }}
                                    >
                                      <Download className="me-2 h-3.5 w-3.5" />
                                      {t("layers.exportGeoLibreStyle")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        void handleExportStyle(layer);
                                      }}
                                    >
                                      <Download className="me-2 h-3.5 w-3.5" />
                                      {t("layers.exportMapboxStyle")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        void handleExportSldStyle(layer);
                                      }}
                                    >
                                      <Download className="me-2 h-3.5 w-3.5" />
                                      {t("layers.exportSldStyle")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        void handleExportQmlStyle(layer);
                                      }}
                                    >
                                      <Download className="me-2 h-3.5 w-3.5" />
                                      {t("layers.exportQmlStyle")}
                                    </DropdownMenuItem>
                                  </>
                                )}
                                {canExportLayer && canImportStyle && <DropdownMenuSeparator />}
                                {canImportStyle && (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      void handleImportStyle(layer);
                                    }}
                                  >
                                    <Upload className="me-2 h-3.5 w-3.5" />
                                    {t("layers.importStyle")}
                                  </DropdownMenuItem>
                                )}
                                {canImportStyle && (
                                  <>
                                    <DropdownMenuSeparator />
                                    {/* The Style Manager reads the selected layer,
                                    so select this one before opening it. */}
                                    <DropdownMenuItem
                                      onSelect={() => {
                                        selectLayer(layer.id);
                                        setStyleManagerOpen(true);
                                      }}
                                    >
                                      <Palette className="me-2 h-3.5 w-3.5" />
                                      {t("layers.openStyleManager")}
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {/* Save the whole configured layer to the Layer
                          Library (issue #1520): its source spec plus style,
                          labels, filters, and joins, re-addable from the Browser
                          panel's My Data section in any later project. */}
                          {canSaveToLibrary && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => {
                                  void handleSaveToLibrary(layer);
                                }}
                              >
                                <Library className="me-2 h-3.5 w-3.5" />
                                {t("layers.saveToLibrary")}
                              </DropdownMenuItem>
                            </>
                          )}
                          {/* Copy/paste symbology between layers (issue #1339),
                          for vector-styled layers and deck.gl rasters. Paste is
                          disabled until a same-family style is on the clipboard;
                          its tooltip explains the enabled and both disabled
                          cases. Separated from the neighbouring action groups to
                          match the rest of the menu. */}
                          {copyStyleKind && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => {
                                  handleCopyStyle(layer);
                                }}
                              >
                                <Copy className="me-2 h-3.5 w-3.5" />
                                {t("layers.copyStyle")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!canPasteStyle}
                                title={
                                  canPasteStyle && copiedLayerStyle
                                    ? t("layers.pasteStyleFrom", {
                                        name: copiedLayerStyle.sourceName,
                                      })
                                    : copiedLayerStyle
                                      ? t("layers.pasteStyleMismatch")
                                      : t("layers.pasteStyleEmpty")
                                }
                                onSelect={() => {
                                  handlePasteStyle(layer);
                                }}
                              >
                                <ClipboardPaste className="me-2 h-3.5 w-3.5" />
                                {t("layers.pasteStyle")}
                              </DropdownMenuItem>
                            </>
                          )}
                          {canWriteBack && (
                            <DropdownMenuItem
                              onSelect={() => {
                                void handleSaveEditsToSource(layer);
                              }}
                            >
                              <Save className="me-2 h-3.5 w-3.5" />
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
                              <Palette className="me-2 h-3.5 w-3.5" />
                              {t("layers.openRasterStylePanel")}
                            </DropdownMenuItem>
                          )}
                          {canExportRaster && (
                            <DropdownMenuItem
                              onSelect={() => {
                                selectLayer(layer.id);
                                setRasterAttributeTableOpen(true);
                              }}
                            >
                              <TableProperties className="me-2 h-3.5 w-3.5" />
                              {t("layers.openRasterAttributeTable")}
                            </DropdownMenuItem>
                          )}
                          {(canExportRaster || canExtractSubset) && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger>
                                <Download className="h-3.5 w-3.5" />
                                {t("layers.export")}
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {canExportRaster && (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      void handleExportRasterLayer(layer);
                                    }}
                                  >
                                    {t("layers.exportGeoTiff")}
                                  </DropdownMenuItem>
                                )}
                                {canExtractSubset && (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      selectLayer(layer.id);
                                      onOpenRasterSubset(layer);
                                    }}
                                  >
                                    {t("layers.extractSubset")}
                                  </DropdownMenuItem>
                                )}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          {canWatchLocalFile ? (
                            <>
                              <DropdownMenuItem
                                disabled={isRefreshing}
                                onSelect={() => {
                                  void handleRefreshLayer(layer);
                                }}
                              >
                                <RefreshCw
                                  className={`me-2 h-3.5 w-3.5 ${
                                    isRefreshing ? "animate-spin" : ""
                                  }`}
                                />
                                {t("layers.reloadFromDisk")}
                              </DropdownMenuItem>
                              <DropdownMenuCheckboxItem
                                checked={watchConfig.enabled}
                                // Keep the menu open on toggle so the checked state
                                // is visible before dismissing.
                                onSelect={(e) => e.preventDefault()}
                                onCheckedChange={(checked) => {
                                  toggleWatchLayer(layer, checked === true);
                                }}
                              >
                                {t("layers.watchFile")}
                              </DropdownMenuCheckboxItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem
                                disabled={!canRefresh || isRefreshing}
                                onSelect={() => {
                                  void handleRefreshLayer(layer);
                                }}
                              >
                                <RefreshCw
                                  className={`me-2 h-3.5 w-3.5 ${
                                    isRefreshing ? "animate-spin" : ""
                                  }`}
                                />
                                {t("layers.refresh")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!canRefresh}
                                onSelect={() => {
                                  setRefreshSettingsLayerId(layer.id);
                                }}
                              >
                                <Timer className="me-2 h-3.5 w-3.5" />
                                {refreshConfig.enabled
                                  ? t("layers.autoRefreshOn")
                                  : t("layers.autoRefresh")}
                              </DropdownMenuItem>
                              {isSqlLayer && (
                                <DropdownMenuItem
                                  onSelect={() => {
                                    const config = getSqlQueryLayerConfig(layer);
                                    if (!config) return;
                                    // Park the query first so the panel finds it
                                    // whether it mounts now or is already open.
                                    requestSqlWorkspaceQuery(config.sql);
                                    setSqlWorkspaceOpen(true);
                                  }}
                                >
                                  <Database className="me-2 h-3.5 w-3.5" />
                                  {t("layers.editSqlQuery")}
                                </DropdownMenuItem>
                              )}
                              {!canRefresh && (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem disabled>
                                    {t("layers.refreshWfsGeojsonOnly")}
                                  </DropdownMenuItem>
                                </>
                              )}
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title={t("layers.metadata")}
                        aria-label={t("layers.metadata")}
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
                        className="h-7 w-7 text-destructive disabled:opacity-40"
                        title={
                          !layerEditable
                            ? t("collaborate.layerLockedHint")
                            : t("layers.removeLayer")
                        }
                        aria-label={t("layers.removeLayer")}
                        disabled={!layerEditable}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!layerEditable) return;
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
          {/* Headers placed below the last layer row: the panel has no layer
              left to anchor them above. */}
          {groupHeaders.bottom.map((group) => (
            <Fragment key={group.id}>{renderGroupHeader(group)}</Fragment>
          ))}
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
                title={basemapVisible ? t("layers.hideBackground") : t("layers.showBackground")}
                aria-label={
                  basemapVisible ? t("layers.hideBackground") : t("layers.showBackground")
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
              <span className="flex-1 truncate text-sm font-medium">{t("layers.background")}</span>
              <span className="text-[10px] uppercase text-muted-foreground">
                {t("layers.typeBasemap")}
              </span>
            </div>
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
      <BasemapPickerDialog open={basemapPickerOpen} onOpenChange={setBasemapPickerOpen} />
      <Dialog
        open={!!bindTimeSliderLayerId}
        onOpenChange={(open: boolean) => {
          if (!open) closeBindTimeSliderDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("layers.bindToTimeSlider")}</DialogTitle>
            <DialogDescription>{t("layers.bindDialogDescription")}</DialogDescription>
          </DialogHeader>
          {bindCandidates === null ? (
            <p className="text-sm text-muted-foreground">{t("layers.bindScanning")}</p>
          ) : bindCandidates.length === 0 ? (
            // A tile layer with nothing loaded has no sample to detect from,
            // which is a different problem from a layer whose columns are not
            // time-like — and one the user can fix by zooming to the layer.
            <p className="text-sm text-destructive">
              {bindIsTileLayer && (bindRecords?.length ?? 0) === 0
                ? t("layers.bindTileNoFeatures")
                : t("layers.bindNoProperty")}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="time-slider-property">{t("layers.bindProperty")}</Label>
                <Select
                  id="time-slider-property"
                  value={bindProperty}
                  onChange={(event) => {
                    setBindProperty(event.target.value);
                    setBindError(null);
                    if (bindIsTileLayer && bindRecords) {
                      prefillBindRange(bindRecords, event.target.value);
                    }
                  }}
                >
                  {bindCandidates.map((candidate) => (
                    <option key={candidate.property} value={candidate.property}>
                      {candidate.property}
                      {candidate.coverage < 1 ? ` (${Math.round(candidate.coverage * 100)}%)` : ""}
                    </option>
                  ))}
                </Select>
              </div>
              {bindIsTileLayer && (
                <div className="space-y-2">
                  <Label htmlFor="time-slider-range-start">{t("layers.bindRange")}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="time-slider-range-start"
                      value={bindRangeStart}
                      onChange={(event) => {
                        setBindRangeStart(event.target.value);
                        setBindError(null);
                      }}
                    />
                    <span className="text-sm text-muted-foreground">–</span>
                    <Input
                      id="time-slider-range-end"
                      // The visible label names the start input, so the end
                      // input would otherwise be announced with no name.
                      aria-label={t("layers.bindRangeEnd")}
                      value={bindRangeEnd}
                      onChange={(event) => {
                        setBindRangeEnd(event.target.value);
                        setBindError(null);
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{t("layers.bindRangeHint")}</p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="time-slider-window">{t("layers.bindWindow")}</Label>
                <Select
                  id="time-slider-window"
                  value={bindWindowMode}
                  onChange={(event) =>
                    setBindWindowMode(
                      event.target.value as "step" | "wide" | "wider" | "cumulative",
                    )
                  }
                >
                  <option value="step">{t("layers.bindWindowStep")}</option>
                  <option value="wide">{t("layers.bindWindowWide")}</option>
                  <option value="wider">{t("layers.bindWindowWider")}</option>
                  <option value="cumulative">{t("layers.bindWindowCumulative")}</option>
                </Select>
              </div>
              {bindError && <p className="text-sm text-destructive">{bindError}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={closeBindTimeSliderDialog}>
              {t("layers.bindCancel")}
            </Button>
            <Button type="button" disabled={!bindProperty} onClick={confirmBindTimeSlider}>
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
              {t("layers.autoRefreshDialogTitle", {
                name: refreshSettingsLayer?.name ?? t("layers.layerFallback"),
              })}
            </DialogTitle>
            <DialogDescription>{t("layers.autoRefreshDialogDescription")}</DialogDescription>
          </DialogHeader>
          {refreshSettingsLayer && (
            <div className="space-y-3">
              <Label htmlFor="layer-refresh-interval">{t("layers.interval")}</Label>
              <Select
                id="layer-refresh-interval"
                value={refreshIntervalChoice}
                onChange={(event) => {
                  const value = event.target.value;
                  setRefreshIntervalChoice(value);
                  if (value === CUSTOM_REFRESH_INTERVAL_VALUE) {
                    const current = getLayerRefreshConfig(refreshSettingsLayer);
                    setCustomRefreshSeconds(customRefreshIntervalSeconds(current.intervalMs));
                    return;
                  }
                  setCustomRefreshSeconds("");
                  setRefreshInterval(refreshSettingsLayer, Number(value));
                }}
              >
                {REFRESH_INTERVAL_OPTIONS.map((option) => (
                  <option key={option.intervalMs} value={option.intervalMs}>
                    {t(option.labelKey)}
                  </option>
                ))}
                <option value={CUSTOM_REFRESH_INTERVAL_VALUE}>{t("layers.custom")}</option>
              </Select>
              {refreshIntervalChoice === CUSTOM_REFRESH_INTERVAL_VALUE && (
                <div className="space-y-2">
                  <Label htmlFor="layer-refresh-custom-seconds">
                    {t("layers.customIntervalSeconds")}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="layer-refresh-custom-seconds"
                      type="number"
                      min="1"
                      step="1"
                      value={customRefreshSeconds}
                      onChange={(event) => setCustomRefreshSeconds(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          !refreshSettingsLayer ||
                          !customRefreshIntervalMs
                        ) {
                          return;
                        }
                        setRefreshInterval(refreshSettingsLayer, customRefreshIntervalMs);
                      }}
                    />
                    <Button
                      type="button"
                      disabled={!customRefreshIntervalMs}
                      onClick={() => {
                        if (!customRefreshIntervalMs) return;
                        setRefreshInterval(refreshSettingsLayer, customRefreshIntervalMs);
                      }}
                    >
                      {t("layers.apply")}
                    </Button>
                  </div>
                  {!customRefreshIntervalMs && customRefreshSeconds.trim() && (
                    <p className="text-xs text-destructive">{t("layers.enterPositiveSeconds")}</p>
                  )}
                </div>
              )}
              {/* Vector-control layers keep their features in the external
                  control, so "clear the layer" cannot be honored for them and
                  the whole policy picker is hidden rather than offering a
                  setting that silently does nothing. */}
              {supportsRefreshFailurePolicy(refreshSettingsLayer) && (
                <>
                  <Label htmlFor="layer-refresh-failure-policy">
                    {t("layers.refreshFailurePolicy")}
                  </Label>
                  <Select
                    id="layer-refresh-failure-policy"
                    value={refreshSettingsLayer.connection?.onFailure ?? "keep-last"}
                    onChange={(event) =>
                      setRefreshFailurePolicy(
                        refreshSettingsLayer,
                        event.target.value === "clear" ? "clear" : "keep-last",
                      )
                    }
                  >
                    <option value="keep-last">{t("layers.refreshFailureKeepLast")}</option>
                    <option value="clear">{t("layers.refreshFailureClear")}</option>
                  </Select>
                </>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="button" variant="ghost" onClick={() => setRefreshSettingsLayerId(null)}>
              {t("common.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!metadataLayer}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setMetadataLayer(null);
            setMetadataCopied(false);
          }
        }}
      >
        <DialogContent
          ref={metadataDialogRef}
          style={
            metadataDialogSize
              ? {
                  width: metadataDialogSize.width,
                  height: metadataDialogSize.height,
                  // Only the width cap is lifted (to the viewport, not to
                  // `none`): a size chosen on a wide window must not leave the
                  // dialog clipped once the window narrows. The height keeps
                  // DialogContent's own viewport cap.
                  maxWidth: "calc(100vw - 1rem)",
                }
              : undefined
          }
          bodyClassName="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6"
          resizeHandle={
            <div
              role="separator"
              aria-label={t("layers.resizeMetadataDialog")}
              title={t("layers.resizeMetadataDialog")}
              onPointerDown={startMetadataResize}
              className="absolute bottom-0 end-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block rtl:cursor-nesw-resize"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-full w-full rtl:scale-x-[-1]"
                aria-hidden="true"
              >
                <path
                  d="M11 15L15 11M6 15L15 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          }
        >
          <DialogHeader>
            <DialogTitle>
              {t("layers.metadataDialogTitle", { name: metadataLayer?.name })}
            </DialogTitle>
            <DialogDescription>{t("layers.metadataDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={copyMetadata}>
              <Copy className="h-4 w-4" />
              {metadataCopied ? t("attributeStats.copiedToClipboard") : t("attributeStats.copy")}
            </Button>
          </div>
          {metadataRasterInfo && metadataRasterInfo.status !== "ready" && (
            <p className="text-xs text-muted-foreground">
              {metadataRasterInfo.status === "loading"
                ? t("layers.metadataRasterLoading")
                : t("layers.metadataRasterError")}
            </p>
          )}
          {/* A definite initial height lets Radix measure overflow on first
              layout; max-height alone left its viewport unconstrained until
              the resize handle caused a second measurement. */}
          <ScrollArea
            type="auto"
            className={cn("min-h-0", metadataDialogSize ? "flex-1" : "h-80 shrink-0")}
          >
            <pre className="whitespace-pre-wrap break-all text-xs">{metadataJson}</pre>
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
            <DialogTitle>{t("layers.removeLayerConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("layers.removeLayerConfirmBody", {
                name: layerPendingRemoval?.name ?? t("layers.thisLayerFallback"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setLayerPendingRemoval(null)}>
              {t("common.cancel")}
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
              {t("common.remove")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
