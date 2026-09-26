import { type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  IDENTIFY_ALL_LAYERS_ID,
  effectiveLayerRenderState,
  identifyAllIncludes,
  hasActiveLayerFilter,
  isCesiumOnlyLayer,
  isDuckDBQueryLayer,
  pluginOwnsPaint,
  rendererAppliesOpacity,
  resolveLayerCapabilities,
  supportsBridgedOpacity,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";
import {
  isArcgisSupportedLayer,
  isCesiumSupportedLayerType,
  isMapboxSupportedLayer,
  isPlaceholderLayer,
  placeholderMessage,
} from "@geolibre/map";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Filter,
  GripVertical,
  Info,
  Lock,
  MoreHorizontal,
  MousePointerClick,
  Palette,
  PencilRuler,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { layerFilteredHintKey } from "../../../lib/layer-filter-hint";
import { getLayerRefreshConfig } from "../../../lib/layer-refresh";
import { LayerSwatchIcon } from "../LayerSwatchIcon";
import {
  hasNativeIdentifyLayers,
  layerTypeLabel,
  relativeSyncTime,
  type LayerRefreshStatus,
} from "./layer-panel-utils";
import { LayerActionsMenuItems, type LayerActionsMenuShared } from "./LayerActionsMenu";
import { LayerOpacitySlider } from "./LayerOpacitySlider";

interface LayerRowProps {
  layer: GeoLibreLayer;
  /** The row's index in panel (top-to-bottom) order. */
  displayIndex: number;
  /** The group the layer belongs to, if any. */
  group: LayerGroup | undefined;
  /** Every group by id, for folding ancestor visibility into the row. */
  groupById: Map<string, LayerGroup>;
  groupDepth: (group: LayerGroup) => number;
  /** Whether the row is part of the panel's multi-selection. */
  selected: boolean;
  /** Whether this row is the one being dragged. */
  dragged: boolean;
  /** Whether a dragged row is hovering this one. */
  dropTarget: boolean;
  /** Panel index of the dragged row, or -1 when nothing is dragged. */
  draggedDisplayIndex: number;
  onDragStart: (event: ReactDragEvent<HTMLElement>, layerId: string) => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>, layerId: string) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>, layerId: string, displayIndex: number) => void;
  onDragEnd: () => void;
  onSelect: (event: ReactMouseEvent<HTMLDivElement>, layerId: string) => void;
  selectOnlyLayer: (layerId: string) => void;
  /** Whether this row's name is open for inline rename. */
  editing: boolean;
  editingName: string;
  setEditingName: (name: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  /** A transient status note (refresh, export, …) for this layer, if any. */
  transientRefreshStatus: LayerRefreshStatus | undefined;
  identifyLayerId: string | null;
  geometryEditLayerId: string | null;
  onToggleGeometryEdit: (layerId: string) => void;
  onCancelGeometryEdit: () => void;
  cesiumPrimary: boolean;
  mapboxPrimary: boolean;
  arcgisPrimary: boolean;
  /** Whether the ArcGIS engine can host deck.gl overlays. */
  deckOverlay: boolean;
  canEditLayer: (layerId: string) => boolean;
  onOpenMetadata: (layer: GeoLibreLayer) => void;
  onRequestRemove: (layer: GeoLibreLayer) => void;
  /** Panel-wide state and handlers for the row's actions menu. */
  menu: LayerActionsMenuShared;
}

/** One layer card in the layer list: visibility, name, badges, opacity and actions. */
export function LayerRow({
  layer,
  displayIndex,
  group,
  groupById,
  groupDepth,
  selected,
  dragged,
  dropTarget,
  draggedDisplayIndex,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onSelect,
  selectOnlyLayer,
  editing,
  editingName,
  setEditingName,
  commitRename,
  cancelRename,
  transientRefreshStatus,
  identifyLayerId,
  geometryEditLayerId,
  onToggleGeometryEdit,
  onCancelGeometryEdit,
  cesiumPrimary,
  mapboxPrimary,
  arcgisPrimary,
  deckOverlay,
  canEditLayer,
  onOpenMetadata,
  onRequestRemove,
  menu,
}: LayerRowProps) {
  const { i18n, t } = useTranslation();
  const setLayerVisibility = useAppStore((s) => s.setLayerVisibility);
  const setLayerOpacity = useAppStore((s) => s.setLayerOpacity);
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const reorderLayer = useAppStore((s) => s.reorderLayer);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const setIdentifyLayer = useAppStore((s) => s.setIdentifyLayer);
  const { collaboration, mapControllerRef, beginRename, onOpenStylePanel } = menu;
  // When an ancestor group is hidden, a layer whose own visibility
  // toggle is still on is not rendered — a surprising state. Grey its
  // name and eye out as a cue that the group-level setting is what's
  // hiding it (issue #430). If the layer's own toggle is also off,
  // the EyeOff icon already explains it, so skip the group cue then.
  // Folded through effectiveLayerRenderState rather than read off the
  // immediate parent, so a hidden grandparent gets the cue too. Given
  // the memoized `groupById` rather than the array, so folding every
  // row does not rebuild that map once per layer.
  const layerRendered = effectiveLayerRenderState(layer, groupById).visible;
  const groupHidden = layer.visible && !layerRendered;
  const visibilityToggleLabel = groupHidden
    ? `${t("layers.hiddenByGroup")} — ${t("layers.hideLayer")}`
    : layer.visible
      ? t("layers.hideLayer")
      : t("layers.showLayer");
  // Explicit per-layer capabilities (issue #1674) overlaid on the
  // defaults inferred from the layer's source kind. Each flag gates
  // only the actions it names: `query` the read/inspect paths,
  // `create`/`update`/`delete` the feature writes, `export` the
  // paths that copy the layer's data out.
  const layerCaps = resolveLayerCapabilities(layer);
  const canIdentify =
    layerCaps.query &&
    (layer.type === "geojson" ||
      isDuckDBQueryLayer(layer) ||
      (layer.type === "wms" &&
        typeof layer.source.layers === "string" &&
        Boolean(layer.source.layers.trim()) &&
        Boolean(
          (typeof layer.source.url === "string" && layer.source.url.trim()) || layer.sourcePath,
        )) ||
      layer.type === "vector-tiles" ||
      (layer.type === "mbtiles" && layer.metadata.tileType === "vector") ||
      // COG layers identify pixel values via the raster control's pixel
      // inspector (see useRasterIdentify), not the vector feature query.
      layer.type === "cog" ||
      hasNativeIdentifyLayers(layer));
  const identifyActive = identifyLayerId === layer.id;
  // A gesture that takes over map clicks has to turn Identify off, or
  // its toolbar button stays lit over a handler that no longer
  // answers. All-layer Identify counts the same as this layer's own, unless a
  // script or project limited it to a list that leaves this layer out.
  const identifyLayerIds = useAppStore((s) => s.identifyLayerIds);
  const identifyOwnsClicks =
    identifyActive ||
    (identifyLayerId === IDENTIFY_ALL_LAYERS_ID && identifyAllIncludes(layer.id, identifyLayerIds));
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
    : // A layer whose `query` capability is denied is not the same as
      // one whose type has no identify route, and saying "only
      // available for vector, WMS, and COG layers" on a vector layer
      // reads as a bug.
      layerCaps.query
      ? t("layers.identifyUnavailable")
      : t("layers.identifyCapabilityDisabled");
  const geometryEditActive = geometryEditLayerId === layer.id;
  const geometryEditElsewhere = geometryEditLayerId !== null && !geometryEditActive;
  const isLayerLocked =
    collaboration.isActive && (collaboration.lockedLayerIds ?? []).includes(layer.id);
  // Whether collaboration lets this session touch the layer at all —
  // rename, remove, move between groups. Deliberately *not* anded
  // with `layerCaps.update`: that flag governs the layer's features
  // and attributes, so a read-only reference layer can still be
  // renamed or taken off the map.
  const layerEditable = canEditLayer(layer.id);
  const refreshConfig = getLayerRefreshConfig(layer);
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
  return (
    <div
      data-layer-card=""
      data-testid="layer-row"
      data-layer-name={layer.name}
      className={`relative min-w-0 max-w-full rounded-md border p-2 transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/20"
      } ${dragged ? "opacity-50" : ""} ${
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
      onDragOver={(e) => onDragOver(e, layer.id)}
      onDrop={(e) => onDrop(e, layer.id, displayIndex)}
      onDragEnd={onDragEnd}
      aria-pressed={selected}
      onClick={(e) => onSelect(e, layer.id)}
      onKeyDown={(e) => {
        // Only act on the card itself: preventDefault here would
        // otherwise cancel the Enter activation of the action
        // buttons nested inside it.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectOnlyLayer(layer.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      {dropTarget && draggedDisplayIndex > displayIndex && (
        <div className="pointer-events-none absolute -top-1 left-2 right-2 h-1 rounded-full bg-primary shadow-[0_0_0_2px_hsl(var(--background))]" />
      )}
      {dropTarget && draggedDisplayIndex >= 0 && draggedDisplayIndex < displayIndex && (
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
          onDragStart={(e) => onDragStart(e, layer.id)}
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
            <Eye className={`h-3.5 w-3.5 ${groupHidden ? "text-muted-foreground" : ""}`} />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
        <LayerSwatchIcon layer={layer} />
        {editing ? (
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
        {/* A layer filter hides features, so say so on the row:
            without this a filtered layer reads as missing data. */}
        {hasActiveLayerFilter(layer) && (
          <span title={t(layerFilteredHintKey(layer))}>
            <Filter
              className="h-3 w-3 shrink-0 text-primary"
              aria-label={t(layerFilteredHintKey(layer))}
            />
          </span>
        )}
        {/* The 3D globe renders a subset of the layer kinds the
            2D map does (#2217). An unsupported layer stays in the
            project and comes back when MapLibre does, so flag the
            row rather than leaving the layer silently absent. */}
        {cesiumPrimary && !isCesiumSupportedLayerType(layer) && (
          <span
            title={t("renderer.layerUnsupported")}
            className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase text-muted-foreground"
          >
            {t("mapGrid.only2d")}
          </span>
        )}
        {/* The mirror image: a Cesium Ion asset (issue #2290) has
            no 2D rendering, so flag it while MapLibre is primary. */}
        {!cesiumPrimary && isCesiumOnlyLayer(layer) && (
          <span
            title={t("renderer.layerCesiumOnly")}
            className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase text-muted-foreground"
          >
            {t("mapGrid.only3d")}
          </span>
        )}
        {mapboxPrimary && !isCesiumOnlyLayer(layer) && !isMapboxSupportedLayer(layer) && (
          <span
            title={t("renderer.layerMapboxUnsupported")}
            className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase text-muted-foreground"
          >
            {t("mapGrid.noMapbox")}
          </span>
        )}
        {arcgisPrimary &&
          !isCesiumOnlyLayer(layer) &&
          !isArcgisSupportedLayer(layer, deckOverlay) && (
            <span
              title={t("renderer.layerArcgisUnsupported")}
              className="shrink-0 rounded-sm bg-muted px-1 text-[10px] uppercase text-muted-foreground"
            >
              {t("mapGrid.noArcgis")}
            </span>
          )}
        <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
          {layerTypeLabel(layer, t)}
        </span>
      </div>
      {/* Placeholder detection checks MapLibre source ids, which the
          globe's own layers never create. Suppress it only for the
          kinds Cesium actually draws — a kind it cannot draw (e.g.
          duckdb-query) keeps its message while the globe is primary. */}
      {(!cesiumPrimary || !isCesiumSupportedLayerType(layer)) &&
        (!arcgisPrimary || !isArcgisSupportedLayer(layer, deckOverlay)) &&
        isPlaceholderLayer(layer) && (
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
          it — otherwise it would move with no effect (#1445) — or
          when the primary renderer draws the layer itself. */}
      {(!pluginOwnsPaint(layer) ||
        supportsBridgedOpacity(layer.id) ||
        rendererAppliesOpacity(layer, primaryRenderer)) && (
        <LayerOpacitySlider
          label={t("layers.opacity")}
          ariaLabel={t("layers.opacityFor", { name: layer.name })}
          value={layer.opacity}
          onChange={(v) => setLayerOpacity(layer.id, v)}
        />
      )}
      <div className="mt-2 flex flex-wrap gap-1">
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
        {onOpenStylePanel && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("layers.openStylePanel")}
            aria-label={t("layers.openStylePanel")}
            onClick={(e) => {
              e.stopPropagation();
              selectLayer(layer.id);
              onOpenStylePanel();
            }}
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
        )}
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
          <DropdownMenuContent align="end" onClick={(e: ReactMouseEvent) => e.stopPropagation()}>
            <LayerActionsMenuItems
              shared={menu}
              layer={layer}
              layerCaps={layerCaps}
              layerRendered={layerRendered}
              identifyOwnsClicks={identifyOwnsClicks}
              geometryEditActive={geometryEditActive}
              geometryEditElsewhere={geometryEditElsewhere}
              isLayerLocked={isLayerLocked}
              layerEditable={layerEditable}
              refreshConfig={refreshConfig}
              isRefreshing={isRefreshing}
            />
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
            onOpenMetadata(layer);
          }}
        >
          <Info className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive disabled:opacity-40"
          title={!layerEditable ? t("collaborate.layerLockedHint") : t("layers.removeLayer")}
          aria-label={t("layers.removeLayer")}
          disabled={!layerEditable}
          onClick={(e) => {
            e.stopPropagation();
            if (!layerEditable) return;
            onRequestRemove(layer);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
