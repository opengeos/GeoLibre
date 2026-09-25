import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  activeLayerFilterExpression,
  canSaveLayerToLibrary,
  clearQuickFilterValues,
  copyableLayerStyleKind,
  hasActiveLayerFilter,
  hasActiveQuickFilter,
  isDuckDBQueryLayer,
  isStyleLibraryTargetLayer,
  resolveLayerCapabilities,
  useAppStore,
} from "@geolibre/core";
import type {
  CollaborationState,
  CopiedLayerStyle,
  GeoLibreLayer,
  LayerGroup,
} from "@geolibre/core";
import {
  canEditLayerGeometry,
  getLayerTimeBinding,
  getTemporalLayerAdapter,
  isArcGISWritableLayer,
  isEmbeddableLocalVectorLayer,
  isTileVectorLayer,
  RASTER_SOURCE_KIND,
  SKETCHES_SOURCE_KIND,
} from "@geolibre/plugins";
import { startFeatureSelection, type MapEngine } from "@geolibre/map";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@geolibre/ui";
import {
  CalendarClock,
  CircleDashed,
  ClipboardPaste,
  ClipboardType,
  Copy,
  Database,
  Download,
  FilePlus2,
  Filter,
  FilterX,
  Folder,
  FolderMinus,
  FolderPlus,
  LassoSelect,
  Library,
  Locate,
  Lock,
  MousePointerClick,
  Palette,
  Pencil,
  PencilRuler,
  Pentagon,
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
  Unlock,
  Upload,
  X,
} from "lucide-react";
import { canOpenLayerAttributeTable } from "../../../lib/attribute-table-source";
import type { CollaborationApi } from "../../../hooks/useCollaboration";
import {
  clearFeatureSelection,
  exportSelectionAsLayer,
  invertLayerSelection,
  zoomToSelection,
} from "../../../lib/selection-actions";
import {
  getLayerRefreshConfig,
  isRefreshableLayer,
  supportsAutoRefresh,
} from "../../../lib/layer-refresh";
import { getLayerWatchConfig, isLocalFileLayer } from "../../../lib/local-file-watch";
import { canRestoreLibraryLayer } from "../../../lib/restore-library-layer";
import { getSqlQueryLayerConfig, isSqlQueryLayer } from "../../../lib/sql-query-layer";
import { requestSqlWorkspaceQuery } from "../../../lib/sql-workspace-prefill";
import { canExportRasterLayer } from "../../../lib/raster-export";
import { canExtractRasterSubset } from "../../../lib/raster-subset-export";
import { layerSupportsPolylineExport } from "../../../lib/vector-export";
import { isTauri } from "../../../lib/is-tauri";
import { canWriteEditsToSource, isPostgisEditableLayer } from "./layer-panel-utils";
import type { LayerActions } from "./useLayerActions";
import type { LayerRefresh } from "./useLayerRefresh";
import type { TimeSliderBinding } from "./useTimeSliderBinding";

/**
 * What every row's actions menu shares: the panel-wide state the menu items
 * read and the handlers they call. Built once per panel render.
 */
export interface LayerActionsMenuShared {
  mapControllerRef: RefObject<MapEngine | null>;
  collaboration: CollaborationState;
  collaborationApi?: CollaborationApi;
  layers: GeoLibreLayer[];
  layerGroups: LayerGroup[];
  selectedLayerId: string | null;
  selectedFeatureCount: number;
  /** Select by Location needs a second layer to compare against. */
  hasTwoSelectableLayers: boolean;
  copiedLayerStyle: CopiedLayerStyle | null;
  /** Whether the map engine lets the user draw an extract box on it. */
  canDrawOnMap: boolean;
  /** The ids a move of `layerId` carries: the selection, or just that layer. */
  selectedMoveIds: (layerId: string) => string[];
  actions: LayerActions;
  handleRefreshLayer: LayerRefresh["handleRefreshLayer"];
  toggleWatchLayer: LayerRefresh["toggleWatchLayer"];
  openBindTimeSliderDialog: TimeSliderBinding["openBindTimeSliderDialog"];
  beginRename: (layer: GeoLibreLayer) => void;
  setRefreshSettingsLayerId: (layerId: string) => void;
  setPasteStyleLayerId: (layerId: string) => void;
  onToggleGeometryEdit: (layerId: string) => void;
  onMaterializeDuckDBLayer: (layer: GeoLibreLayer) => void;
  onOpenRasterStylePanel: () => void;
  onOpenStylePanel?: () => void;
  onOpenRasterSubset: (layer: GeoLibreLayer) => void;
}

interface LayerActionsMenuItemsProps {
  shared: LayerActionsMenuShared;
  layer: GeoLibreLayer;
  /** The layer's resolved capabilities (explicit flags over inferred defaults). */
  layerCaps: ReturnType<typeof resolveLayerCapabilities>;
  /** Whether the layer is drawn once its groups' visibility is folded in. */
  layerRendered: boolean;
  /** Whether Identify (this layer's or all-layer) currently owns map clicks. */
  identifyOwnsClicks: boolean;
  geometryEditActive: boolean;
  geometryEditElsewhere: boolean;
  isLayerLocked: boolean;
  /** Whether collaboration lets this session change the layer. */
  layerEditable: boolean;
  refreshConfig: ReturnType<typeof getLayerRefreshConfig>;
  isRefreshing: boolean;
}

/**
 * The items of a layer row's actions ("...") menu. Rendered inside the row's
 * DropdownMenuContent, so it mounts only while that menu is open.
 */
export function LayerActionsMenuItems({
  shared,
  layer,
  layerCaps,
  layerRendered,
  identifyOwnsClicks,
  geometryEditActive,
  geometryEditElsewhere,
  isLayerLocked,
  layerEditable,
  refreshConfig,
  isRefreshing,
}: LayerActionsMenuItemsProps) {
  const { t } = useTranslation();
  const {
    mapControllerRef,
    collaboration,
    collaborationApi,
    layers,
    layerGroups,
    selectedLayerId,
    selectedFeatureCount,
    hasTwoSelectableLayers,
    copiedLayerStyle,
    canDrawOnMap,
    selectedMoveIds,
    actions,
    handleRefreshLayer,
    toggleWatchLayer,
    openBindTimeSliderDialog,
    beginRename,
    setRefreshSettingsLayerId,
    setPasteStyleLayerId,
    onToggleGeometryEdit,
    onMaterializeDuckDBLayer,
    onOpenRasterStylePanel,
    onOpenStylePanel,
    onOpenRasterSubset,
  } = shared;
  const {
    quickBufferPresets,
    formatQuickDistance,
    runLayerQuickTool,
    exportSketchesAsLayer,
    handleCopyStyle,
    handlePasteStyle,
    handleSaveToLibrary,
    handleExportLayer,
    handleExportStyle,
    handleExportGeoLibreStyle,
    handleExportSldStyle,
    handleExportQmlStyle,
    handleImportStyle,
    handleSaveEditsToSource,
    handleBindTemporalLayer,
    handleUnbindTimeSlider,
    handleExportRasterLayer,
  } = actions;
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const moveLayersToGroup = useAppStore((s) => s.moveLayersToGroup);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  const setSelectByExpressionOpen = useAppStore((s) => s.setSelectByExpressionOpen);
  const setSelectByLocationOpen = useAppStore((s) => s.setSelectByLocationOpen);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const setRasterAttributeTableOpen = useAppStore((s) => s.setRasterAttributeTableOpen);
  const setLoadEditorFeaturesOpen = useAppStore((s) => s.setLoadEditorFeaturesOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const canEditGeometry = canEditLayerGeometry(layer) && layerCaps.update;
  // A vector layer whose in-view features can be loaded into the
  // GeoEditor (a copy, not in-place): geojson and vector tile layers
  // (vector-tiles, and PMTiles/MBTiles carrying vector tiles),
  // excluding the editor's own Sketches layer. Tile layers are
  // included here (unlike Edit geometry) because loading grabs a copy
  // of what is rendered rather than editing the source in place;
  // raster PMTiles/MBTiles have no vector features so are excluded.
  // Gated on `export`, not `create`/`update`: the action copies this
  // layer's features into the editor's own layer, so it is the same
  // kind of copy-out as Export selection and Save to Layer Library.
  // `create` would be wrong twice over — the features are created in
  // the editor's layer, not this one, and `inferLayerCapabilities`
  // infers `create: false` for every tile layer in the list below,
  // which would remove the action from all of them by default.
  const canLoadIntoEditor =
    layerCaps.export &&
    layer.metadata.sourceKind !== SKETCHES_SOURCE_KIND &&
    layer.metadata.tileType !== "raster" &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "pmtiles" ||
      layer.type === "mbtiles");
  const canMaterializeDuckDB =
    isDuckDBQueryLayer(layer) && typeof layer.metadata.query === "string";
  const canOpenAttributeTable = canOpenLayerAttributeTable(layer);
  // The interactive selection dialogs (#1314) resolve selection ids
  // against in-store features, like the highlight overlay does, and
  // inspecting which features match is a read of the layer's data.
  const canSelectFeatures = layerCaps.query && (layer.geojson?.features?.length ?? 0) > 0;
  // Selection actions act on the live selection, which always
  // belongs to the active layer.
  const holdsSelection =
    canSelectFeatures && layer.id === selectedLayerId && selectedFeatureCount > 0;
  // Exporting the selection copies the selected features into a new
  // layer they can be shared or published from, so it follows
  // `export` rather than the read-only selection actions beside it.
  const canExportSelection = holdsSelection && layerCaps.export;
  // Export writes the layer's GeoJSON features to disk; only
  // geojson-backed vector layers carry those features.
  const canExportLayer = layerCaps.export && layer.type === "geojson";
  const canExportPolyline = canExportLayer && layerSupportsPolylineExport(layer);
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
  const canSaveToLibrary =
    layerCaps.export &&
    canSaveLayerToLibrary(layer, {
      canRestoreControlPainted: canRestoreLibraryLayer,
      hasMaterializableFeatures: isEmbeddableLocalVectorLayer,
    });
  // Copy/paste symbology (issue #1339). Vector-styled layers and
  // deck.gl rasters each copy their own style family; a paste only
  // lands when the clipboard entry shares the target's family.
  const copyStyleKind = copyableLayerStyleKind(layer);
  const canPasteStyle = copiedLayerStyle?.kind === copyStyleKind;
  // Write-back commits edits to the layer's local source file in place
  // (desktop only, supported formats); Export writes a new file. A
  // save can insert, update or delete rows, so any one of those three
  // capabilities is enough to offer it — the sidecar refuses the
  // individual statements the layer does not allow.
  const canWriteBack =
    canWriteEditsToSource(layer) && (layerCaps.update || layerCaps.create || layerCaps.delete);
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
  const canExportRaster = layerCaps.export && canExportRasterLayer(layer);
  // COG/WMS/XYZ layers can also export a bounding-box subset (a clip)
  // via the in-browser geolibre-wasm extractors, drawn on the map.
  // Gated on the engine's own drawing capability: the panel needs a
  // surface the user can drag an extract box on.
  const canExtractSubset = layerCaps.export && canDrawOnMap && canExtractRasterSubset(layer);
  // Rasters added through the floating Add Raster Layer panel are
  // styled there; offer a shortcut to reopen that panel since it is
  // dismissed (and its on-map icon removed) when closed.
  const canEditRasterStyle = layer.metadata.sourceKind === RASTER_SOURCE_KIND;
  const canRefresh = isRefreshableLayer(layer);
  // Iceberg layers refresh only on demand: scanning a table that
  // large on a timer is never what the user meant, so the interval
  // settings are unavailable even though Refresh is not.
  const canAutoRefresh = canRefresh && supportsAutoRefresh(layer);
  // Emptying Quick Filter answers narrows a view; discarding the
  // authored expression changes the project. A read-only
  // collaborator may do the first but not the second, so the row's
  // clear action offers whichever half they are allowed.
  const clearsExpression = layerEditable && activeLayerFilterExpression(layer) !== null;
  const clearableQuickFilters = hasActiveQuickFilter(layer);
  // Live SQL query layers (issue #1295) refresh by re-running their
  // stored DuckDB statement and offer a shortcut to edit it.
  const isSqlLayer = isSqlQueryLayer(layer);
  // Local-file vector layers (desktop only) can be reloaded from disk
  // and watched for changes instead of the URL-based refresh above.
  const canWatchLocalFile = isTauri() && isLocalFileLayer(layer);
  const watchConfig = getLayerWatchConfig(layer);
  const moveIds = selectedMoveIds(layer.id);
  return (
    <>
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
      {/* Clearing drops the persistent expression filter
          outright, but keeps the Quick Filter controls the
          author configured and only empties what they were
          answered with, so the next question does not start
          from scratch. */}
      {hasActiveLayerFilter(layer) && (
        <DropdownMenuItem
          disabled={!clearsExpression && !clearableQuickFilters}
          onSelect={() => {
            if (!clearsExpression && !clearableQuickFilters) return;
            const quickFilters = clearQuickFilterValues(layer.quickFilters);
            updateLayer(layer.id, {
              ...(clearsExpression ? { filterExpression: undefined } : {}),
              quickFilters: quickFilters.length > 0 ? quickFilters : undefined,
            });
          }}
        >
          {clearsExpression ? (
            <FilterX className="me-2 h-3.5 w-3.5" />
          ) : (
            <Filter className="me-2 h-3.5 w-3.5" />
          )}
          {t(clearsExpression ? "quickFilters.clearAllWithExpression" : "quickFilters.clearAll")}
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
            {moveIds.length > 1 ? t("layers.moveSelectedToGroup") : t("layers.moveToGroup")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {layerGroups.map((g) => (
              <DropdownMenuItem
                key={g.id}
                disabled={moveIds.every(
                  (id) => layers.find((item) => item.id === id)?.groupId === g.id,
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
      {layer.metadata.sourceKind === SKETCHES_SOURCE_KIND && (
        <>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={
                !Array.isArray(layer.geojson?.features) || layer.geojson.features.length === 0
              }
            >
              <FilePlus2 className="h-3.5 w-3.5" />
              {t("layers.exportSketchesAsLayer")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => exportSketchesAsLayer(layer)}>
                {t("layers.exportSketchesKeep")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!layerEditable}
                onSelect={() => exportSketchesAsLayer(layer, true)}
              >
                {t("layers.exportSketchesClear")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
        </>
      )}
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
            if (identifyOwnsClicks) setIdentifyLayer(null);
            onToggleGeometryEdit(layer.id);
          }}
        >
          <PencilRuler className="me-2 h-3.5 w-3.5" />
          {geometryEditActive ? t("layers.finishEditingGeometry") : t("layers.editGeometry")}
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MousePointerClick className="h-3.5 w-3.5" />
              {t("layers.selectFeaturesMenu")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {(
                [
                  ["single", MousePointerClick, "layers.selectFeaturesSingle"],
                  ["rectangle", SquareDashed, "layers.selectFeaturesRectangle"],
                  ["polygon", Pentagon, "layers.selectFeaturesPolygon"],
                  ["freehand", LassoSelect, "layers.selectFeaturesFreehand"],
                  ["radius", CircleDashed, "layers.selectFeaturesRadius"],
                ] as const
              ).map(([shape, Icon, label]) => (
                <DropdownMenuItem
                  key={shape}
                  // Drawing on the map only makes sense
                  // against features the user can see, and
                  // a click gesture on a hidden layer would
                  // match nothing at all.
                  disabled={!layerRendered}
                  onSelect={() => {
                    if (identifyOwnsClicks) setIdentifyLayer(null);
                    startFeatureSelection({
                      layerId: layer.id,
                      shape,
                    });
                  }}
                >
                  <Icon className="me-2 h-3.5 w-3.5" />
                  {t(label)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!holdsSelection} onSelect={clearFeatureSelection}>
                <X className="me-2 h-3.5 w-3.5" />
                {t("toolbar.item.clearSelection")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="max-w-64 whitespace-normal text-xs font-normal text-muted-foreground">
                {t("layers.selectFeaturesModifiers")}
              </DropdownMenuLabel>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* Not selectLayer() + open: that would clear the
          live selection the dialogs' add/remove/intersect
          modes combine with, so the target travels via the
          open setter instead. */}
          <DropdownMenuItem onSelect={() => setSelectByExpressionOpen(true, layer.id)}>
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
          <DropdownMenuItem onSelect={() => zoomToSelection(mapControllerRef.current)}>
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
          {canExportSelection && (
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
          )}
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
              CSV
            </DropdownMenuItem>
            {canExportPolyline && (
              <>
                <DropdownMenuItem
                  onSelect={() => {
                    void handleExportLayer(layer, "polyline", 5);
                  }}
                >
                  {t("layers.exportPolyline", { precision: 5 })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void handleExportLayer(layer, "polyline", 6);
                  }}
                >
                  {t("layers.exportPolyline", { precision: 6 })}
                </DropdownMenuItem>
              </>
            )}
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
              <DropdownMenuItem
                onSelect={() => {
                  setPasteStyleLayerId(layer.id);
                }}
              >
                <ClipboardType className="me-2 h-3.5 w-3.5" />
                {t("layers.importStyleFromText")}
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
          disabled={geometryEditActive || !layerEditable}
          onSelect={() => {
            void handleSaveEditsToSource(layer);
          }}
        >
          <Save className="me-2 h-3.5 w-3.5" />
          {isArcGISWritableLayer(layer)
            ? t("layers.saveEditsToArcgis")
            : isPostgisEditableLayer(layer)
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
            <RefreshCw className={`me-2 h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
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
            <RefreshCw className={`me-2 h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            {t("layers.refresh")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canAutoRefresh}
            onSelect={() => {
              setRefreshSettingsLayerId(layer.id);
            }}
          >
            <Timer className="me-2 h-3.5 w-3.5" />
            {refreshConfig.enabled ? t("layers.autoRefreshOn") : t("layers.autoRefresh")}
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
              <DropdownMenuItem disabled>{t("layers.refreshWfsGeojsonOnly")}</DropdownMenuItem>
            </>
          )}
        </>
      )}
    </>
  );
}
