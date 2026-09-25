import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  BLANK_BASEMAP,
  DEFAULT_BASEMAP,
  getPlanetaryBasemapById,
  getPlanetaryBasemapByStyleUrl,
  PLANET_SWITCHER_OPTIONS,
  useAppStore,
  layerGroupDepth,
  layerGroupMoveability,
  layerGroupSortability,
  layerPanelGroupHeaders,
} from "@geolibre/core";
import type { EllipsoidId, GeoLibreLayer, LayerGroup } from "@geolibre/core";
import { getTemporalLayersVersion, subscribeTemporalLayers } from "@geolibre/plugins";
import type { MapEngine } from "@geolibre/map";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { usePluginRegistry } from "../../hooks/usePlugins";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { isMobile } from "../../lib/is-mobile";
import { masHidesDataSource } from "../../lib/mas-build";
import { activeInterfaceProfile, isDataSourceVisible } from "../../lib/ui-profile";
import { Button, ScrollArea, Separator } from "@geolibre/ui";
import { Layers, PanelLeftOpen } from "lucide-react";
import { PasteStyleDialog } from "./PasteStyleDialog";
import { participantCanEditLayer } from "../../lib/collab-protocol";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { BasemapPickerDialog } from "./BasemapPickerDialog";
import { LayerPanelPlaceSearch } from "./LayerPanelPlaceSearch";
import { useMapCapabilities } from "../../hooks/useMapCapabilities";
import { ADD_DATA_DIALOG_SOURCES, BACKGROUND_SELECTION_ID } from "./layer-panel/layer-panel-utils";
import { BackgroundAppearanceDialog, BackgroundLayerRow } from "./layer-panel/BackgroundLayerRow";
import { BindTimeSliderDialog } from "./layer-panel/BindTimeSliderDialog";
import type { LayerActionsMenuShared } from "./layer-panel/LayerActionsMenu";
import { LayerGroupHeader } from "./layer-panel/LayerGroupHeader";
import { LayerMetadataDialog, useLayerMetadataDialog } from "./layer-panel/LayerMetadataDialog";
import { LayerPanelHeader } from "./layer-panel/LayerPanelHeader";
import { LayerRow } from "./layer-panel/LayerRow";
import {
  RefreshSettingsDialog,
  useRefreshSettingsDialog,
} from "./layer-panel/RefreshSettingsDialog";
import { RemoveLayerDialog } from "./layer-panel/RemoveLayerDialog";
import { useLayerActions } from "./layer-panel/useLayerActions";
import { useLayerDragAndDrop } from "./layer-panel/useLayerDragAndDrop";
import { useLayerRefresh } from "./layer-panel/useLayerRefresh";
import { useLayerRename } from "./layer-panel/useLayerRename";
import { useLayerSelection } from "./layer-panel/useLayerSelection";
import { useTimeSliderBinding } from "./layer-panel/useTimeSliderBinding";

interface LayerPanelProps {
  themeMode: ThemeMode;
  mapControllerRef: RefObject<MapEngine | null>;
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

export function LayerPanel({
  themeMode,
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
  const arcgisPrimary = useAppStore((s) => s.primaryRenderer === "arcgis");
  const addDataGroupSources = useMemo(
    () =>
      ADD_DATA_DIALOG_SOURCES.filter(
        (entry) =>
          isDataSourceVisible(uiProfile, entry.id) &&
          (!["pmtiles", "raster", "zarr"].includes(entry.id) || arcgisPrimary) &&
          !(entry.id === "postgres" && mobile) &&
          !masHidesDataSource(entry.id),
      ),
    [uiProfile, mobile, arcgisPrimary],
  );
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  // The 3D globe draws a subset of the layer kinds MapLibre does, so rows it
  // cannot render are flagged while it owns the primary map area (#2217).
  const cesiumPrimary = useAppStore((s) => s.primaryRenderer === "cesium");
  // Likewise the Mapbox engine only compiles native Mapbox sources, so a layer
  // it rejects (a MapLibre custom protocol, deck.gl, COG, ...) is flagged here
  // rather than only reported by the map's error banner once it is visible.
  const mapboxPrimary = useAppStore((s) => s.primaryRenderer === "mapbox");
  // The subset panel draws its extract box on the map surface, so it needs an
  // engine the user can draw on — not merely "not the globe".
  const capabilities = useMapCapabilities(mapControllerRef);
  const setLayerGroupVisibility = useAppStore((s) => s.setLayerGroupVisibility);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const selectedFeatureCount = useAppStore((s) => s.selectedFeatureIds.length);
  // Select by Location needs a second layer to compare against (see EditMenu).
  const hasTwoSelectableLayers = useAppStore(
    (s) => s.layers.filter((layer) => (layer.geojson?.features?.length ?? 0) > 0).length >= 2,
  );
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const setBasemapVisible = useAppStore((s) => s.setBasemapVisible);
  const applyPlanetaryBasemap = useAppStore((s) => s.applyPlanetaryBasemap);
  const restoreEarthBasemap = useAppStore((s) => s.restoreEarthBasemap);
  const basemapStyleUrl = useAppStore((s) =>
    s.primaryRenderer === "mapbox"
      ? (s.preferences.map.mapboxStyleUrl ?? s.basemapStyleUrl)
      : s.basemapStyleUrl,
  );
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
  const copiedLayerStyle = useAppStore((s) => s.copiedLayerStyle);
  const updateLayer = useAppStore((s) => s.updateLayer);
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

  const [basemapPickerOpen, setBasemapPickerOpen] = useState(false);
  const [backgroundAppearanceOpen, setBackgroundAppearanceOpen] = useState(false);
  const metadata = useLayerMetadataDialog();
  const [layerPendingRemoval, setLayerPendingRemoval] = useState<GeoLibreLayer | null>(null);
  // The layer a pasted style is destined for, or null when the box is closed. Keyed by id
  // rather than a boolean so text pasted for one layer can never land on another.
  const [pasteStyleLayerId, setPasteStyleLayerId] = useState<string | null>(null);
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
  const visibleLayers = useMemo(() => [...layers].reverse(), [layers]);
  const selection = useLayerSelection({ layers, visibleLayers, selectedLayerId, selectLayer });
  const drag = useLayerDragAndDrop({
    layers,
    visibleLayers,
    selectedLayerIds: selection.selectedLayerIds,
    selectedMoveIds: selection.selectedMoveIds,
    selectOnlyLayer: selection.selectOnlyLayer,
  });
  const rename = useLayerRename(layers, layerGroups);
  const refresh = useLayerRefresh({ layers, isCollapsed });
  const actions = useLayerActions({
    mapControllerRef,
    canEditLayer,
    setRefreshStatuses: refresh.setRefreshStatuses,
    clearRefreshStatusTimer: refresh.clearRefreshStatusTimer,
    scheduleStatusClear: refresh.scheduleStatusClear,
    isPluginActive,
    togglePlugin,
  });
  const binding = useTimeSliderBinding({ layers, mapControllerRef });
  const refreshSettings = useRefreshSettingsDialog(layers);
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
  const groupSortability = useMemo(
    () => layerGroupSortability(layers, layerGroups, i18n.language),
    [layers, layerGroups, i18n.language],
  );

  const backgroundSelected = selectedLayerId === BACKGROUND_SELECTION_ID;
  const blankBackgroundActive = basemapStyleUrl === BLANK_BASEMAP;
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

  const renderGroupHeader = (group: LayerGroup) => {
    if (hasCollapsedAncestor(group)) return null;
    return (
      <LayerGroupHeader
        group={group}
        depth={groupDepth(group)}
        isDropTarget={drag.dropTargetGroupId === group.id}
        moveability={groupMoveability.get(group.id)}
        sortability={groupSortability.get(group.id)}
        moveTargets={groupMoveTargets(group)}
        addDataGroupSources={addDataGroupSources}
        rename={rename}
        onDragOver={drag.handleGroupHeaderDragOver}
        onDrop={drag.handleGroupHeaderDrop}
      />
    );
  };

  // What every row's actions menu shares; the per-row flags are derived in the row.
  const menu: LayerActionsMenuShared = {
    mapControllerRef,
    collaboration,
    collaborationApi,
    layers,
    layerGroups,
    selectedLayerId,
    selectedFeatureCount,
    hasTwoSelectableLayers,
    copiedLayerStyle,
    canDrawOnMap: capabilities.onMapDrawing,
    selectedMoveIds: selection.selectedMoveIds,
    actions,
    handleRefreshLayer: refresh.handleRefreshLayer,
    toggleWatchLayer: refresh.toggleWatchLayer,
    openBindTimeSliderDialog: binding.openBindTimeSliderDialog,
    beginRename: rename.beginRename,
    setRefreshSettingsLayerId: refreshSettings.setRefreshSettingsLayerId,
    setPasteStyleLayerId,
    onToggleGeometryEdit,
    onMaterializeDuckDBLayer,
    onOpenRasterStylePanel,
    onOpenStylePanel,
    onOpenRasterSubset,
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
    // The two named rows do not have to match the child count: the header takes
    // the `auto` row, the layer list takes `minmax(0, 1fr)`, and the separator
    // and place search below it fall into implicit auto rows (the dialogs and
    // menus after them render through Radix portals, so they take no row at
    // all). Only the list sits in the flexible row, which is what makes it the
    // part that shrinks and scrolls once the panel reaches its max height — so
    // a new direct child added here must not displace the ScrollArea from the
    // second in-flow position.
    <aside
      aria-label={t("sharedRail.layers")}
      className="relative grid max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 grid-rows-[auto_minmax(0,1fr)] border-b bg-card max-md:absolute max-md:inset-x-0 max-md:top-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--layer-panel-width)] md:border-b-0 md:border-e"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("layers.resizePanel")}
        className="absolute -end-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-e border-transparent hover:border-primary md:block"
        onPointerDown={onResizeStart}
      />
      <LayerPanelHeader
        mapControllerRef={mapControllerRef}
        selectedPlanet={selectedPlanet}
        togglePlanet={togglePlanet}
        isPluginActive={isPluginActive}
        togglePlugin={togglePlugin}
        onCreateGroup={rename.handleCreateGroup}
        allLayersVisible={allLayersVisible}
        onToggleAllLayers={toggleAllLayers}
        geometryEditLayerId={geometryEditLayerId}
        identifyLayerId={identifyLayerId}
        onCollapse={() => setIsCollapsed(true)}
      />
      <ScrollArea
        className="min-h-0 [&_[data-radix-scroll-area-viewport]]:touch-pan-y [&_[data-radix-scroll-area-viewport]]:overscroll-contain [&_[data-radix-scroll-area-viewport]>div]:block! [&_[data-radix-scroll-area-viewport]>div]:w-full! [&_[data-radix-scroll-area-viewport]>div]:min-w-0!"
        // Radix measures scroll content with an injected display:table
        // wrapper. Opt this viewport into block sizing so long layer names
        // cannot establish a wider min-content table. The panel's minmax(0, 1fr)
        // content row constrains overflowing cards without making short lists fill
        // the mobile panel's maximum height. `-webkit-overflow-scrolling` is not
        // set here: Radix already injects it for every viewport, and it is a
        // legacy iOS property that does nothing on the Android WebView this fix
        // targets.
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
            return (
              <Fragment key={layer.id}>
                {groupHeaders.aboveLayer.get(layer.id)?.map((header) => (
                  <Fragment key={header.id}>{renderGroupHeader(header)}</Fragment>
                ))}
                {!groupCollapsed && !groupAncestorCollapsed && (
                  <LayerRow
                    layer={layer}
                    displayIndex={displayIndex}
                    group={group}
                    groupById={groupById}
                    groupDepth={groupDepth}
                    selected={selection.selectedLayerIds.has(layer.id)}
                    dragged={drag.draggedLayerId === layer.id}
                    dropTarget={drag.dropTargetLayerId === layer.id}
                    draggedDisplayIndex={drag.draggedDisplayIndex}
                    onDragStart={drag.handleLayerDragStart}
                    onDragOver={drag.handleLayerDragOver}
                    onDrop={drag.handleLayerDrop}
                    onDragEnd={drag.resetDragState}
                    onSelect={selection.handleLayerSelection}
                    selectOnlyLayer={selection.selectOnlyLayer}
                    editing={rename.editingLayerId === layer.id}
                    editingName={rename.editingName}
                    setEditingName={rename.setEditingName}
                    commitRename={rename.commitRename}
                    cancelRename={rename.cancelRename}
                    transientRefreshStatus={refresh.refreshStatuses[layer.id]}
                    identifyLayerId={identifyLayerId}
                    geometryEditLayerId={geometryEditLayerId}
                    onToggleGeometryEdit={onToggleGeometryEdit}
                    onCancelGeometryEdit={onCancelGeometryEdit}
                    cesiumPrimary={cesiumPrimary}
                    mapboxPrimary={mapboxPrimary}
                    arcgisPrimary={arcgisPrimary}
                    deckOverlay={capabilities.deckOverlay}
                    canEditLayer={canEditLayer}
                    onOpenMetadata={metadata.setMetadataLayer}
                    onRequestRemove={setLayerPendingRemoval}
                    menu={menu}
                  />
                )}
              </Fragment>
            );
          })}
          {/* Headers placed below the last layer row: the panel has no layer
              left to anchor them above. */}
          {groupHeaders.bottom.map((group) => (
            <Fragment key={group.id}>{renderGroupHeader(group)}</Fragment>
          ))}
          <BackgroundLayerRow
            selected={backgroundSelected}
            basemapVisible={basemapVisible}
            blankBackgroundActive={blankBackgroundActive}
            onOpenBasemapPicker={() => setBasemapPickerOpen(true)}
            onOpenAppearance={() => setBackgroundAppearanceOpen(true)}
          />
        </div>
      </ScrollArea>
      <Separator />
      <LayerPanelPlaceSearch mapControllerRef={mapControllerRef} />
      <BasemapPickerDialog open={basemapPickerOpen} onOpenChange={setBasemapPickerOpen} />
      <BackgroundAppearanceDialog
        open={backgroundAppearanceOpen}
        onOpenChange={setBackgroundAppearanceOpen}
        themeMode={themeMode}
      />
      <BindTimeSliderDialog binding={binding} />
      <RefreshSettingsDialog
        settings={refreshSettings}
        setRefreshInterval={refresh.setRefreshInterval}
        setRefreshFailurePolicy={refresh.setRefreshFailurePolicy}
      />
      <LayerMetadataDialog metadata={metadata} />
      <RemoveLayerDialog layer={layerPendingRemoval} onClose={() => setLayerPendingRemoval(null)} />
      <PasteStyleDialog
        open={pasteStyleLayerId !== null}
        onOpenChange={(open) => {
          if (!open) setPasteStyleLayerId(null);
        }}
        onApply={(imported) => {
          if (!pasteStyleLayerId) return;
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === pasteStyleLayerId);
          // Removed while the box was open — the dialog closes rather than styling a layer that is
          // no longer there.
          if (!latest) return;
          updateLayer(pasteStyleLayerId, { style: imported.apply(latest.style) });
          actions.noteImportedStyle(pasteStyleLayerId, imported.warnings);
        }}
      />
    </aside>
  );
}
