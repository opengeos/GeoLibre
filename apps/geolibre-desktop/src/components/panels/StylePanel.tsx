import {
  DEFAULT_LAYER_STYLE,
  isCesiumKmlLayer,
  isCzmlLayer,
  pluginOwnsPaint,
  styleValue,
  rendererAppliesOpacity,
  supportsBridgedOpacity,
  useAppStore,
  useLayer,
  useLayerSummaries,
  type LabelStyle,
} from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { SKETCHES_SOURCE_KIND, TIME_SLIDER_SOURCE_KIND } from "@geolibre/plugins";
import {
  arcgisRasterEffect,
  arcgisUnsupportedStyleSettings,
  arcgisVectorStyle,
  mapboxUnsupportedStyleSettings,
  type MapEngine,
} from "@geolibre/map";
import { useTranslation } from "react-i18next";
import { PanelRightClose, PanelRightOpen, SlidersHorizontal } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useState } from "react";
import { getAttributePropertyNames } from "../../lib/expression-inputs";
import {
  IMPORTED_STYLE_NOTE_DURATION_MS,
  type ImportedStyleNote,
} from "../../lib/style-import-note";
import { BlendModeControl } from "./style-panel/BlendModeControl";
import { STYLE_PANEL_ASIDE_CLASS } from "./style-panel/constants";
import {
  hasExternalDeckLayer,
  hasExternalNativeLayers,
  hasTextMarkerFeatures,
  isRasterPaintLayer,
  supportsExtrusionControls,
  supportsPointRendererFor,
} from "./style-panel/layer-capabilities";
import { LayerOrderControl } from "./style-panel/LayerOrderControl";
import { NoPaintControlsStylePanel } from "./style-panel/NoPaintControlsStylePanel";
import { PluginPaintedStylePanel } from "./style-panel/PluginPaintedStylePanel";
import { RasterStylePanel } from "./style-panel/RasterStylePanel";
import { createVectorRuleActions } from "./style-panel/rule-tree";
import {
  StyleExpressionBuilder,
  useExpressionBuilderInputs,
  type ExpressionBuilderTarget,
} from "./style-panel/StyleExpressionBuilder";
import { useLayerFeatureScans } from "./style-panel/useLayerFeatureScans";
import { useStylePanelCollapse } from "./style-panel/useStylePanelCollapse";
import { useStylePanelDrafts } from "./style-panel/useStylePanelDrafts";
import { VectorStylePanel } from "./style-panel/VectorStylePanel";
import { VectorSymbologySection } from "./style-panel/VectorSymbologySection";
import { ZoomRangeControls } from "./style-panel/ZoomRangeControls";

interface StylePanelProps {
  mapControllerRef: RefObject<MapEngine | null>;
  /** Bumped when the map (re)initializes; see {@link useQuickFilterProfiles}. */
  mapReadyGeneration?: number;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Incremented when another part of the UI explicitly requests this panel. */
  openRequest?: number;
  /**
   * When this flips to `true` the panel collapses to its thin rail (it is not
   * unmounted). Used to clear room when the notebook opens beside the map; the
   * user can still expand it again.
   */
  autoCollapse?: boolean;
  /**
   * Controlled collapse state for the shared right-sidebar (`replace-style`)
   * mode. When defined, the panel's own collapse state is ignored and the
   * parent fully owns expand/collapse: the collapse/expand buttons call
   * {@link onCollapsedChange} instead of toggling internal state, and
   * `autoCollapse` no longer applies. Leave undefined for the standalone panel.
   */
  collapsed?: boolean;
  /** Notify the parent of a collapse/expand request in controlled mode. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /**
   * In the shared right-sidebar mode, suppress the panel's own collapsed rail:
   * when collapsed the panel renders nothing because a single shared rail (owned
   * by the host) lists the Style entry instead of two adjacent rails.
   */
  hideOwnRail?: boolean;
}

export function StylePanel({
  mapControllerRef,
  mapReadyGeneration,
  onResizeStart,
  openRequest = 0,
  autoCollapse = false,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  hideOwnRail = false,
}: StylePanelProps) {
  const { t } = useTranslation();
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  // Only the other layers' ids and names are read (the "place below" list);
  // the selected layer itself comes from useLayer, so editing another layer's
  // style or opacity does not re-render this panel.
  const layerSummaries = useLayerSummaries();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  // The Mapbox compiler draws only part of the symbology below; see
  // `mapboxUnsupportedStyleSettings`.
  const mapboxPrimary = useAppStore((s) => s.primaryRenderer === "mapbox");
  // Likewise for ArcGIS, whose 3D SceneView (the globe, or any view with
  // terrain) draws a different subset from its flat MapView.
  const arcgisPrimary = useAppStore((s) => s.primaryRenderer === "arcgis");
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const arcgisScene = useAppStore(
    (s) => s.preferences.map.projection === "globe" || s.preferences.map.terrainEnabled,
  );
  const [pasteStyleOpen, setPasteStyleOpen] = useState(false);
  // What the last pasted style reported. The Layers panel has a per-row note for this; this
  // panel has none, and dropping the parser's warnings would make an import that could not be
  // fully represented look like a clean one.
  const [pasteStyleNotice, setPasteStyleNotice] = useState<ImportedStyleNote | null>(null);
  const { isCollapsed, setIsCollapsed } = useStylePanelCollapse({
    openRequest,
    autoCollapse,
    controlledCollapsed,
    onCollapsedChange,
  });
  // Layers whose style suggestions the user waved off this session (#1519).
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set());
  // Which expression surface the shared Expression Builder is editing; null
  // when the builder is closed. Targets carry the owning layer id so an edit
  // can never be applied to a different layer than the one it was opened for
  // (GH #1306).
  const [expressionBuilderTarget, setExpressionBuilderTarget] =
    useState<ExpressionBuilderTarget | null>(null);
  // Close both dialogs when the selected layer changes. The builder's fields, sample features and
  // target expression all belong to the previous layer; a paste box left open would submit one
  // layer's style onto another.
  useEffect(() => {
    setExpressionBuilderTarget(null);
    setPasteStyleOpen(false);
    setPasteStyleNotice(null);
  }, [selectedLayerId]);

  // Fade the header note the way the Layers panel fades its row status. Without this a stale
  // "Style imported." stays pinned under the header while the user keeps working on the same layer.
  // The cleanup covers a second import, a change of layer, and unmount.
  useEffect(() => {
    if (!pasteStyleNotice) return;
    const timer = window.setTimeout(
      () => setPasteStyleNotice(null),
      IMPORTED_STYLE_NOTE_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pasteStyleNotice]);

  const layer = useLayer(selectedLayerId);
  const drafts = useStylePanelDrafts(layer, mapControllerRef);
  const {
    isPointOnly,
    geometryFlags,
    styleSuggestions,
    diagramTruncated,
    diagramDrawnCount,
    diagramAtlasDropped,
    numericPropertyOptions,
    supportsElevation3d,
  } = useLayerFeatureScans(layer);
  const builderInputs = useExpressionBuilderInputs(layer, expressionBuilderTarget);

  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("style.resizePanel")}
      className="absolute -start-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-s border-transparent hover:border-primary md:block"
      onPointerDown={onResizeStart}
    />
  );

  if (isCollapsed) {
    // In the shared right-sidebar mode the host renders a single rail listing
    // Style alongside the plugin panel, so the panel shows nothing of its own
    // when collapsed (avoids two adjacent rails).
    if (hideOwnRail) return null;
    return (
      <aside
        aria-label={t("style.panelLabelCollapsed")}
        className="flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-s md:border-t-0 md:py-2"
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title={t("style.expand")}
          aria-label={t("style.expand")}
          onClick={() => setIsCollapsed(false)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
          <SlidersHorizontal className="h-4 w-4" />
          <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
            {t("sharedRail.style")}
          </span>
        </div>
      </aside>
    );
  }

  if (!layer) {
    return (
      <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
        {resizeHandle}
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-sm font-semibold">{t("style.heading")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={t("style.collapse")}
            aria-label={t("style.collapse")}
            onClick={() => setIsCollapsed(true)}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
        <p className="p-4 text-xs text-muted-foreground">{t("style.selectLayerHint")}</p>
      </aside>
    );
  }

  const { style } = layer;
  const isDeckRasterLayer =
    layer.metadata.sourceKind === "cog-url" ||
    layer.metadata.sourceKind === "geotiff-url" ||
    layer.metadata.sourceKind === "maplibre-gl-raster" ||
    layer.metadata.sourceKind === "stac-search-cog" ||
    // A Time Slider mosaic (and a COG on the gpu/wasm engine, which the library
    // renders through the same adapter) draws on the client-side pipeline, so
    // MapLibre's raster paint properties have no layer to land on. The mirrored
    // layer carries the flag, so this stays correct during the window where a
    // restored project has the layer but the plugin has not built its control.
    (layer.metadata.sourceKind === TIME_SLIDER_SOURCE_KIND &&
      layer.metadata.clientRenderedRaster === true);
  const isDeckVectorLayer = hasExternalDeckLayer(layer);
  const isRasterTileLayer = layer.metadata.tileType === "raster";
  const isThreeDTilesLayer = layer.type === "3d-tiles";
  // A CZML scene reuses the `3d-tiles` type so the globe owns it, but
  // `CesiumLayerSync` only toggles its visibility: no `Cesium3DTileStyle` is
  // compiled for it and no feature filter reaches its entities, so the tileset
  // symbology and quick-filter controls would be silent no-ops (#2290).
  const isNativeDocumentScene = isCzmlLayer(layer) || isCesiumKmlLayer(layer);
  const hasTilesetSymbology = isThreeDTilesLayer && !isNativeDocumentScene;
  // An external plugin's MapLibre custom (WebGL) layer draws its own pixels and
  // has no MapLibre paint properties, so every paint editor below would be inert
  // for it (#1445). The plugin declares that with `paintMode: "plugin"`; the
  // panel then offers only what actually reaches the layer.
  const isPluginPaintedLayer = pluginOwnsPaint(layer);
  // An ArcGIS vector-tile layer with its resolved style keeps the service's
  // own paint: layer sync forwards only opacity, order, zoom range, and
  // filters to its native layers, so the color editors would be inert.
  const isServiceStyledLayer = layer.type === "arcgis" && arcgisVectorStyle(layer) !== null;
  // Opacity survives the suppression when the plugin bridged a setter for it,
  // or when the primary renderer draws the layer itself (a Zarr layer on the
  // ArcGIS view or the globe); otherwise the slider would be an inert control.
  const hasBridgedOpacity =
    isPluginPaintedLayer &&
    (supportsBridgedOpacity(layer.id) || rendererAppliesOpacity(layer, primaryRenderer));
  const hasVectorPaintControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    !isDeckRasterLayer &&
    !isPluginPaintedLayer &&
    !isServiceStyledLayer &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "mbtiles" ||
      hasExternalNativeLayers(layer) ||
      hasExternalDeckLayer(layer));
  const hasExtrusionControls =
    !isThreeDTilesLayer &&
    !isRasterTileLayer &&
    !isDeckRasterLayer &&
    !isPluginPaintedLayer &&
    !isServiceStyledLayer &&
    supportsExtrusionControls(layer);
  const hasRasterPaintControls =
    !isPluginPaintedLayer &&
    (isRasterPaintLayer(layer.type) || isRasterTileLayer || isDeckRasterLayer);
  const hasTextMarkerControls = layer.type === "geojson" && hasTextMarkerFeatures(layer);
  // Quick filters compile to the per-feature MapLibre filter layer sync already
  // applies, so they are offered exactly where that filter reaches: the layer
  // types `withFeatureFilters` covers, plus any layer whose control registered
  // native MapLibre layers for `applyExternalNativeFeatureFilters` to narrow
  // (Add Vector Layer, vector PMTiles, and the plugin-painted vectors —
  // filtering is independent of who owns the paint).
  //
  // Deliberately *not* keyed off `hasVectorPaintControls`: that set excludes
  // plugin-painted layers, which do accept a filter, and includes deck.gl
  // layers, which are MapLibre custom layers and accept none — offering a
  // control there would be a control that quietly does nothing.
  const hasQuickFilterControls =
    // The deck.gl guard is outermost: a deck-rendered layer keeps its original
    // `type` (a deck GeoJSON layer is still `"geojson"`), so testing the type
    // first would let it through even though a custom layer accepts no filter.
    !hasExternalDeckLayer(layer) &&
    !isNativeDocumentScene &&
    (layer.type === "geojson" ||
      layer.type === "vector-tiles" ||
      layer.type === "mbtiles" ||
      hasExternalNativeLayers(layer));
  // isPointOnly is memoized above the early returns to keep hook order stable.
  const supportsPointRenderer = supportsPointRendererFor(layer, isPointOnly);
  // The "Sketches" layer mixes geometry types under one style, so "Circle
  // radius" only applies to its point markers and is misleading otherwise (#483).
  const isSketchLayer = layer.metadata.sourceKind === SKETCHES_SOURCE_KIND;
  const strokeWidthUnit = styleValue(style, "strokeWidthUnit");
  // The unit only affects line/polygon-outline rendering. Point layers always
  // stroke in pixels, so never present meters semantics (label/range/selector)
  // for them, even if a hand-edited project set "meters".
  const strokeWidthInMeters = strokeWidthUnit === "meters" && !supportsPointRenderer;
  const pointRenderer = styleValue(style, "pointRenderer");
  // Settings this layer turns on that the Mapbox renderer does not draw yet,
  // named at the top of the panel so they do not silently do nothing.
  const mapboxUnsupportedSettings =
    mapboxPrimary && hasVectorPaintControls ? mapboxUnsupportedStyleSettings(layer) : [];
  const arcgisUnsupportedSettings =
    arcgisPrimary && hasVectorPaintControls
      ? arcgisUnsupportedStyleSettings(layer, arcgisScene)
      : [];
  // A SceneView blends tiled rasters but ignores the colour sliders' effect.
  const arcgisRasterEffectIgnored =
    arcgisPrimary &&
    arcgisScene &&
    arcgisRasterEffect({ ...DEFAULT_LAYER_STYLE, ...style }) !== null;
  const extrusionEnabled = styleValue(style, "extrusionEnabled");
  const elevation3dEnabled = styleValue(style, "elevation3dEnabled");
  // Effective 3D Z-value mode: the saved flag can outlive the data's Z values
  // (e.g. a processing tool rewrote the geometry), in which case the renderer
  // falls back to 2D — the panel must match so a Visualization radio is
  // always selected and 2D controls stay usable.
  const elevation3dActive = elevation3dEnabled && supportsElevation3d;
  const extrusionHeightPropertyOptions = getAttributePropertyNames(layer);
  const vectorStylePropertyOptions = extrusionHeightPropertyOptions;
  const labels: LabelStyle = {
    ...DEFAULT_LAYER_STYLE.labels,
    ...styleValue(style, "labels"),
  };
  const updateLabels = (patch: Partial<LabelStyle>) =>
    setLayerStyle(layer.id, { labels: { ...labels, ...patch } });
  const { loadedVectorPropertyValues } = drafts;
  const matchingPropertyValues = (property: string): unknown[] | undefined =>
    loadedVectorPropertyValues?.layerId === layer.id
      ? loadedVectorPropertyValues.byProperty[property]
      : undefined;
  const ruleActions = createVectorRuleActions(layer, setLayerStyle);

  // Only mounted while open: the dialog memoizes validation/preview work off
  // props that this panel recreates each render, so keeping it mounted would
  // rescan the layer's features on every unrelated panel re-render.
  const expressionBuilderDialog = expressionBuilderTarget ? (
    <StyleExpressionBuilder
      layer={layer}
      expressionBuilderTarget={expressionBuilderTarget}
      setExpressionBuilderTarget={setExpressionBuilderTarget}
      builderInputs={builderInputs}
      currentRules={ruleActions.currentRules}
      updateVectorRule={ruleActions.updateVectorRule}
      draftVectorStyleExpression={drafts.draftVectorStyleExpression}
      setDraftVectorStyleExpression={drafts.setDraftVectorStyleExpression}
      setVectorStyleError={drafts.setVectorStyleError}
      labels={labels}
      updateLabels={updateLabels}
    />
  ) : null;

  const beforeIdControl = (
    <LayerOrderControl
      layer={layer}
      layerSummaries={layerSummaries}
      draftBeforeId={drafts.draftBeforeId}
      setDraftBeforeId={drafts.setDraftBeforeId}
      showBasemapStyleLayers={drafts.showBasemapStyleLayers}
      setShowBasemapStyleLayers={drafts.setShowBasemapStyleLayers}
      elevation3dActive={elevation3dActive}
      mapControllerRef={mapControllerRef}
    />
  );
  const zoomRangeControls = <ZoomRangeControls layer={layer} />;
  const blendModeControl = (
    <BlendModeControl layer={layer} isPluginPaintedLayer={isPluginPaintedLayer} />
  );

  // --- Style suggestions (#1519) -------------------------------------------
  // styleSuggestions is memoized above the early returns. Dismissal is
  // per-layer and session-scoped — this is a nudge, not project state.
  const visibleSuggestions = dismissedSuggestions.has(layer.id) ? [] : styleSuggestions;
  const vectorSymbologyControls = (
    <VectorSymbologySection
      layer={layer}
      drafts={drafts}
      vectorStylePropertyOptions={vectorStylePropertyOptions}
      matchingPropertyValues={matchingPropertyValues}
      visibleSuggestions={visibleSuggestions}
      setDismissedSuggestions={setDismissedSuggestions}
      ruleActions={ruleActions}
      setExpressionBuilderTarget={setExpressionBuilderTarget}
    />
  );

  if (isPluginPaintedLayer || isServiceStyledLayer) {
    // The plugin paints this layer itself, so the panel keeps only the controls
    // that still reach it: insert-below and the zoom range (MapLibre honors both
    // on a custom layer) plus Opacity when the registration bridged setOpacity.
    // Everything else is styled from the plugin's own panel. A service-styled
    // ArcGIS layer lands here too; its opacity is a native paint property, so
    // the slider always reaches it.
    return (
      <PluginPaintedStylePanel
        layer={layer}
        resizeHandle={resizeHandle}
        setIsCollapsed={setIsCollapsed}
        beforeIdControl={beforeIdControl}
        zoomRangeControls={zoomRangeControls}
        hasBridgedOpacity={hasBridgedOpacity}
        isServiceStyledLayer={isServiceStyledLayer}
        hasQuickFilterControls={hasQuickFilterControls}
        mapControllerRef={mapControllerRef}
        mapReadyGeneration={mapReadyGeneration}
      />
    );
  }

  if (hasRasterPaintControls) {
    return (
      <RasterStylePanel
        layer={layer}
        resizeHandle={resizeHandle}
        setIsCollapsed={setIsCollapsed}
        arcgisRasterEffectIgnored={arcgisRasterEffectIgnored}
        beforeIdControl={beforeIdControl}
        zoomRangeControls={zoomRangeControls}
        blendModeControl={blendModeControl}
        isDeckRasterLayer={isDeckRasterLayer}
        mapControllerRef={mapControllerRef}
      />
    );
  }

  if (!hasVectorPaintControls) {
    return (
      <NoPaintControlsStylePanel
        layer={layer}
        resizeHandle={resizeHandle}
        setIsCollapsed={setIsCollapsed}
        beforeIdControl={beforeIdControl}
        blendModeControl={blendModeControl}
        hasTilesetSymbology={hasTilesetSymbology}
        vectorSymbologyControls={vectorSymbologyControls}
        expressionBuilderDialog={expressionBuilderDialog}
        hasQuickFilterControls={hasQuickFilterControls}
        isNativeDocumentScene={isNativeDocumentScene}
        mapControllerRef={mapControllerRef}
        mapReadyGeneration={mapReadyGeneration}
      />
    );
  }

  return (
    <VectorStylePanel
      layer={layer}
      resizeHandle={resizeHandle}
      setIsCollapsed={setIsCollapsed}
      pasteStyleOpen={pasteStyleOpen}
      setPasteStyleOpen={setPasteStyleOpen}
      pasteStyleNotice={pasteStyleNotice}
      setPasteStyleNotice={setPasteStyleNotice}
      mapboxUnsupportedSettings={mapboxUnsupportedSettings}
      arcgisUnsupportedSettings={arcgisUnsupportedSettings}
      beforeIdControl={beforeIdControl}
      zoomRangeControls={zoomRangeControls}
      blendModeControl={blendModeControl}
      vectorSymbologyControls={vectorSymbologyControls}
      expressionBuilderDialog={expressionBuilderDialog}
      drafts={drafts}
      hasVectorPaintControls={hasVectorPaintControls}
      hasExtrusionControls={hasExtrusionControls}
      hasTextMarkerControls={hasTextMarkerControls}
      hasQuickFilterControls={hasQuickFilterControls}
      isDeckVectorLayer={isDeckVectorLayer}
      isSketchLayer={isSketchLayer}
      supportsPointRenderer={supportsPointRenderer}
      supportsElevation3d={supportsElevation3d}
      elevation3dActive={elevation3dActive}
      extrusionEnabled={extrusionEnabled}
      pointRenderer={pointRenderer}
      strokeWidthUnit={strokeWidthUnit}
      strokeWidthInMeters={strokeWidthInMeters}
      geometryFlags={geometryFlags}
      numericPropertyOptions={numericPropertyOptions}
      diagramTruncated={diagramTruncated}
      diagramDrawnCount={diagramDrawnCount}
      diagramAtlasDropped={diagramAtlasDropped}
      extrusionHeightPropertyOptions={extrusionHeightPropertyOptions}
      vectorStylePropertyOptions={vectorStylePropertyOptions}
      matchingPropertyValues={matchingPropertyValues}
      labels={labels}
      updateLabels={updateLabels}
      setExpressionBuilderTarget={setExpressionBuilderTarget}
      mapControllerRef={mapControllerRef}
      mapReadyGeneration={mapReadyGeneration}
    />
  );
}
