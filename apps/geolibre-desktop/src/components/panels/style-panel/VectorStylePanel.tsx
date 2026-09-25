import {
  isStyleLibraryTargetLayer,
  styleValue,
  useAppStore,
  type GeoLibreLayer,
  type LabelStyle,
  type PointRenderer,
  type StrokeWidthUnit,
} from "@geolibre/core";
import { Button, Label, ScrollArea, Separator } from "@geolibre/ui";
import {
  arcgisUnsupportedStyleSettings,
  mapboxUnsupportedStyleSettings,
  type MapEngine,
} from "@geolibre/map";
import { ClipboardType, Palette, PanelRightClose } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { importedStyleNote, type ImportedStyleNote } from "../../../lib/style-import-note";
import { AttributeFormSection } from "../AttributeFormSection";
import { EditorTrackingSection } from "../EditorTrackingSection";
import { LayerJoinsSection } from "../LayerJoinsSection";
import { PasteStyleDialog } from "../PasteStyleDialog";
import { PopupSection } from "../PopupSection";
import { QuickFiltersSection } from "../QuickFiltersSection";
import { VirtualFieldsSection } from "../VirtualFieldsSection";
import { STYLE_PANEL_ASIDE_CLASS } from "./constants";
import { DiagramSection } from "./DiagramSection";
import { Elevation3dControls } from "./Elevation3dControls";
import { ExtrusionControls } from "./ExtrusionControls";
import { GeometryGeneratorSection } from "./GeometryGeneratorSection";
import { LabelsSection } from "./LabelsSection";
import {
  hasExternalDeckLayer,
  hasExternalNativeLayers,
  type GeometryFlags,
} from "./layer-capabilities";
import { ProportionalSizeSection } from "./ProportionalSizeSection";
import type { ExpressionBuilderTarget } from "./StyleExpressionBuilder";
import { FillPatternSection, LineDecorationSection, MarkerSection } from "./SymbolSections";
import type { StylePanelDrafts } from "./useStylePanelDrafts";
import { VectorPaintControls } from "./VectorPaintControls";

interface VectorStylePanelProps {
  layer: GeoLibreLayer;
  resizeHandle: ReactNode;
  setIsCollapsed: (collapsed: boolean) => void;
  pasteStyleOpen: boolean;
  setPasteStyleOpen: (open: boolean) => void;
  pasteStyleNotice: ImportedStyleNote | null;
  setPasteStyleNotice: (note: ImportedStyleNote | null) => void;
  mapboxUnsupportedSettings: ReturnType<typeof mapboxUnsupportedStyleSettings>;
  arcgisUnsupportedSettings: ReturnType<typeof arcgisUnsupportedStyleSettings>;
  beforeIdControl: ReactNode;
  zoomRangeControls: ReactNode;
  blendModeControl: ReactNode;
  vectorSymbologyControls: ReactNode;
  expressionBuilderDialog: ReactNode;
  drafts: StylePanelDrafts;
  hasVectorPaintControls: boolean;
  hasExtrusionControls: boolean;
  hasTextMarkerControls: boolean;
  hasQuickFilterControls: boolean;
  isDeckVectorLayer: boolean;
  isSketchLayer: boolean;
  supportsPointRenderer: boolean;
  supportsElevation3d: boolean;
  elevation3dActive: boolean;
  extrusionEnabled: boolean;
  pointRenderer: PointRenderer;
  strokeWidthUnit: StrokeWidthUnit;
  strokeWidthInMeters: boolean;
  geometryFlags: GeometryFlags;
  numericPropertyOptions: string[];
  diagramTruncated: boolean;
  diagramDrawnCount: number;
  diagramAtlasDropped: number;
  extrusionHeightPropertyOptions: string[];
  vectorStylePropertyOptions: string[];
  matchingPropertyValues: (property: string) => unknown[] | undefined;
  labels: LabelStyle;
  updateLabels: (patch: Partial<LabelStyle>) => void;
  setExpressionBuilderTarget: (target: ExpressionBuilderTarget | null) => void;
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration?: number;
}

/**
 * The full vector Style panel: visualization mode, symbology, the 2D / 3D
 * extrusion / 3D Z-value controls, the geometry-gated sections, labels, and
 * the attribute sections that need the layer's features in the store.
 *
 * @param props - The layer, its draft state, the shared controls and the
 *   capability flags the parent derives.
 * @returns The panel body.
 */
export function VectorStylePanel({
  layer,
  resizeHandle,
  setIsCollapsed,
  pasteStyleOpen,
  setPasteStyleOpen,
  pasteStyleNotice,
  setPasteStyleNotice,
  mapboxUnsupportedSettings,
  arcgisUnsupportedSettings,
  beforeIdControl,
  zoomRangeControls,
  blendModeControl,
  vectorSymbologyControls,
  expressionBuilderDialog,
  drafts,
  hasVectorPaintControls,
  hasExtrusionControls,
  hasTextMarkerControls,
  hasQuickFilterControls,
  isDeckVectorLayer,
  isSketchLayer,
  supportsPointRenderer,
  supportsElevation3d,
  elevation3dActive,
  extrusionEnabled,
  pointRenderer,
  strokeWidthUnit,
  strokeWidthInMeters,
  geometryFlags,
  numericPropertyOptions,
  diagramTruncated,
  diagramDrawnCount,
  diagramAtlasDropped,
  extrusionHeightPropertyOptions,
  vectorStylePropertyOptions,
  matchingPropertyValues,
  labels,
  updateLabels,
  setExpressionBuilderTarget,
  mapControllerRef,
  mapReadyGeneration,
}: VectorStylePanelProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const setStyleManagerOpen = useAppStore((s) => s.setStyleManagerOpen);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const { style } = layer;
  const {
    draftVectorStyleMode,
    draftExtrusionHeightProperty,
    setDraftExtrusionHeightProperty,
    setVectorStyleError,
    setExtrusionError,
  } = drafts;
  const defaultExtrusionHeightProperty = extrusionHeightPropertyOptions.includes(
    draftExtrusionHeightProperty,
  )
    ? draftExtrusionHeightProperty
    : (extrusionHeightPropertyOptions[0] ?? "");

  // --- Geometry-gated sections (proportional size, fill pattern, markers) ---
  // geometryFlags is memoized in the parent (useLayerFeatureScans).
  const showProportionalControls =
    hasVectorPaintControls &&
    pointRenderer !== "heatmap" &&
    // Proportional sizing drives circle-radius, marker icon-size (the
    // interpolate scales the baked sprite, see markerIconSizeValue in
    // @geolibre/map), and line-width, so it applies to any single-renderer
    // point layer (with or without a marker icon) and to layers that carry
    // lines.
    ((geometryFlags.hasPoint && pointRenderer === "single") || geometryFlags.hasLine);
  const showFillPatternControls =
    hasVectorPaintControls && !extrusionEnabled && geometryFlags.hasPolygon;
  const showMarkerControls =
    hasVectorPaintControls && supportsPointRenderer && pointRenderer === "single";
  // The symbology-pack renders (inverted mask, line decorations, geometry
  // generator) are drawn by the core GeoJSON render path
  // (applyVectorDataRenderLayers), so they don't apply to vector tiles,
  // external deck layers, or control-painted (external native) layers — hide
  // the controls there rather than offer a silent no-op.
  const supportsDerivedGeometry =
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    !hasExternalNativeLayers(layer);
  const showLineDecorationControls =
    hasVectorPaintControls &&
    !extrusionEnabled &&
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    !hasExternalNativeLayers(layer) &&
    (geometryFlags.hasLine || geometryFlags.hasPolygon);
  const showGeneratorControls =
    hasVectorPaintControls && !extrusionEnabled && supportsDerivedGeometry;
  const diagramFields = styleValue(style, "diagramFields");
  const showDiagramControls =
    hasVectorPaintControls &&
    layer.type === "geojson" &&
    !!layer.geojson &&
    !hasExternalDeckLayer(layer) &&
    (!supportsPointRenderer || pointRenderer === "single") &&
    (numericPropertyOptions.length > 0 || diagramFields.length > 0);

  const twoDimensionalControls = (
    <VectorPaintControls
      layer={layer}
      supportsPointRenderer={supportsPointRenderer}
      pointRenderer={pointRenderer}
      draftVectorStyleMode={draftVectorStyleMode}
      strokeWidthUnit={strokeWidthUnit}
      strokeWidthInMeters={strokeWidthInMeters}
      isSketchLayer={isSketchLayer}
      hasTextMarkerControls={hasTextMarkerControls}
      numericPropertyOptions={numericPropertyOptions}
    />
  );
  const extrusionControls = (
    <ExtrusionControls
      layer={layer}
      drafts={drafts}
      extrusionHeightPropertyOptions={extrusionHeightPropertyOptions}
    />
  );
  const elevation3dControls = (
    <Elevation3dControls
      layer={layer}
      strokeWidthInMeters={strokeWidthInMeters}
      geometryFlags={geometryFlags}
      isSketchLayer={isSketchLayer}
    />
  );
  const proportionalSizeControls = (
    <ProportionalSizeSection
      layer={layer}
      drafts={drafts}
      vectorStylePropertyOptions={vectorStylePropertyOptions}
      matchingPropertyValues={matchingPropertyValues}
    />
  );
  const fillPatternControls = (
    <FillPatternSection layer={layer} supportsDerivedGeometry={supportsDerivedGeometry} />
  );
  const markerControls = <MarkerSection layer={layer} />;
  const lineDecorationControls = <LineDecorationSection layer={layer} />;
  const generatorControls = (
    <GeometryGeneratorSection layer={layer} numericPropertyOptions={numericPropertyOptions} />
  );
  const diagramControls = (
    <DiagramSection
      layer={layer}
      numericPropertyOptions={numericPropertyOptions}
      diagramTruncated={diagramTruncated}
      diagramDrawnCount={diagramDrawnCount}
      diagramAtlasDropped={diagramAtlasDropped}
    />
  );
  const labelControls = (
    <LabelsSection
      layer={layer}
      labels={labels}
      updateLabels={updateLabels}
      vectorStylePropertyOptions={vectorStylePropertyOptions}
      setExpressionBuilderTarget={setExpressionBuilderTarget}
    />
  );

  return (
    <aside aria-label={t("style.panelLabel")} className={STYLE_PANEL_ASIDE_CLASS}>
      {resizeHandle}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-sm font-semibold">
          {t("style.headingWithLayer", { name: layer.name })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {/* Only the layer types the Style Manager can apply to; this vector
              panel also serves mbtiles/plugin/deck layers, where the dialog
              would open with Apply/Save disabled. */}
          {isStyleLibraryTargetLayer(layer.type) && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("style.openStyleManager")}
                aria-label={t("style.openStyleManager")}
                onClick={() => setStyleManagerOpen(true)}
              >
                <Palette className="h-4 w-4" />
              </Button>
              {/* The other door into this is the layer's actions menu, a long way from where
                  someone thinking about symbology already is. */}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title={t("layers.importStyleFromText")}
                aria-label={t("layers.importStyleFromText")}
                onClick={() => {
                  setPasteStyleNotice(null);
                  setPasteStyleOpen(true);
                }}
              >
                <ClipboardType className="h-4 w-4" />
              </Button>
            </>
          )}
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
      </div>
      {pasteStyleNotice && (
        <p
          className={`border-b px-3 py-1.5 text-xs ${
            pasteStyleNotice.type === "warning" ? "text-amber-600" : "text-emerald-600"
          }`}
          data-testid="style-paste-notice"
          role="status"
        >
          {pasteStyleNotice.message}
        </p>
      )}
      {mapboxUnsupportedSettings.length > 0 && (
        <div
          className="border-b px-3 py-1.5 text-xs text-amber-600"
          data-testid="style-mapbox-unsupported"
          role="note"
        >
          <p>{t("style.mapboxUnsupported.title")}</p>
          <ul className="list-disc ps-4">
            {mapboxUnsupportedSettings.map((setting) => (
              <li key={setting}>{t(`style.mapboxUnsupported.${setting}`)}</li>
            ))}
          </ul>
        </div>
      )}
      {arcgisUnsupportedSettings.length > 0 && (
        <div
          className="border-b px-3 py-1.5 text-xs text-amber-600"
          data-testid="style-arcgis-unsupported"
          role="note"
        >
          <p>{t("style.arcgisUnsupported.title")}</p>
          <ul className="list-disc ps-4">
            {arcgisUnsupportedSettings.map((setting) => (
              <li key={setting}>{t(`style.arcgisUnsupported.${setting}`)}</li>
            ))}
          </ul>
        </div>
      )}
      <ScrollArea className="flex-1">
        {/* Padding lives on the inner content (not the ScrollArea root) with
            extra right clearance so the overlay scrollbar never covers the
            right edge of a control (e.g. the "Transparent" label). */}
        <div className="space-y-4 p-3 pe-5">
          {beforeIdControl}
          {/* The 3D Z-value render (deck.gl) does not honor the MapLibre
              min/max zoom range, so hide the controls rather than show a
              silently-ignored setting. */}
          {!elevation3dActive && zoomRangeControls}
          {blendModeControl}
          {hasExtrusionControls && (
            <div className="space-y-2">
              <Label>{t("style.visualization")}</Label>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={!extrusionEnabled && !elevation3dActive}
                    onChange={() => {
                      setExtrusionError(null);
                      setLayerStyle(layer.id, {
                        extrusionEnabled: false,
                        elevation3dEnabled: false,
                      });
                    }}
                  />
                  {t("style.mode2d")}
                </label>
                <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                  <input
                    type="radio"
                    name={`style-mode-${layer.id}`}
                    checked={extrusionEnabled && !elevation3dActive}
                    onChange={() => {
                      setVectorStyleError(null);
                      setDraftExtrusionHeightProperty(defaultExtrusionHeightProperty);
                      setLayerStyle(layer.id, {
                        extrusionEnabled: true,
                        elevation3dEnabled: false,
                        extrusionHeightProperty: defaultExtrusionHeightProperty,
                      });
                    }}
                  />
                  {t("style.mode3dExtrusion")}
                </label>
                {supportsElevation3d && (
                  <label className="col-span-2 flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                    <input
                      type="radio"
                      name={`style-mode-${layer.id}`}
                      checked={elevation3dActive}
                      onChange={() => {
                        setExtrusionError(null);
                        setLayerStyle(layer.id, {
                          extrusionEnabled: false,
                          elevation3dEnabled: true,
                        });
                      }}
                    />
                    {t("style.elevation3d.mode")}
                  </label>
                )}
              </div>
            </div>
          )}
          {/* Data-driven coloring doesn't apply to the heatmap renderer or the
              flat-styled 3D Z-value render. */}
          {pointRenderer === "heatmap" || elevation3dActive ? null : vectorSymbologyControls}
          {elevation3dActive
            ? elevation3dControls
            : !hasExtrusionControls || !extrusionEnabled
              ? twoDimensionalControls
              : extrusionControls}
          {!elevation3dActive && (!hasExtrusionControls || !extrusionEnabled) && (
            <>
              {showProportionalControls && (
                <>
                  <Separator />
                  {proportionalSizeControls}
                </>
              )}
              {showFillPatternControls && (
                <>
                  <Separator />
                  {fillPatternControls}
                </>
              )}
              {showLineDecorationControls && (
                <>
                  <Separator />
                  {lineDecorationControls}
                </>
              )}
              {showMarkerControls && (
                <>
                  <Separator />
                  {markerControls}
                </>
              )}
              {showDiagramControls && (
                <>
                  <Separator />
                  <p className="text-sm font-semibold">{t("style.diagrams.heading")}</p>
                  {diagramControls}
                </>
              )}
              {showGeneratorControls && (
                <>
                  <Separator />
                  <p className="text-sm font-semibold">{t("style.generator.heading")}</p>
                  {generatorControls}
                </>
              )}
            </>
          )}
          {/* Attribute labels apply to vector features, not the heatmap density
              surface or the 3D extrusion / 3D Z-value renders. */}
          {!extrusionEnabled && !elevation3dActive && pointRenderer !== "heatmap" ? (
            <>
              <Separator />
              <p className="text-sm font-semibold">{t("style.labels.heading")}</p>
              {labelControls}
            </>
          ) : null}
          {/* Quick filters narrow what the layer draws, so they apply to every
              vector layer — including tile-backed ones, which profile the
              features currently loaded rather than a local copy. */}
          {hasQuickFilterControls ? (
            <>
              <Separator />
              <QuickFiltersSection
                key={`qf-${layer.id}`}
                layer={layer}
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
            </>
          ) : null}
          {/* Persistent attribute joins need the layer's features in the store
              (layer.geojson); tile/service layers without an inline attribute
              table cannot be a join target. */}
          {layer.geojson ? (
            <>
              <Separator />
              {/* Keyed by layer so the add-join draft never survives a layer
                  switch (a stale draft could reference the new target itself). */}
              <LayerJoinsSection key={layer.id} layer={layer} />
              <Separator />
              {/* Virtual fields need the layer's features in the store too
                  (the expressions evaluate against layer.geojson). Keyed for
                  the same draft-lifetime reason as the joins section. */}
              <VirtualFieldsSection key={`vf-${layer.id}`} layer={layer} />
            </>
          ) : null}
          {/* The Attribute Form designer configures how attribute values are
              edited, so it needs the layer's features in the store too. Keyed
              like Joins so an open field draft never survives a layer switch. */}
          {layer.geojson ? (
            <>
              <Separator />
              <AttributeFormSection key={`af-${layer.id}`} layer={layer} />
            </>
          ) : null}
          {/* The Popup designer reads the layer's field profile to offer the
              fields, so like the sections above it needs the features in the
              store. Keyed by layer so a half-edited expression never carries
              over to the next layer. */}
          {layer.geojson ? (
            <>
              <Separator />
              <PopupSection key={`popup-${layer.id}`} layer={layer} />
            </>
          ) : null}
          {/* Editor tracking stamps the features as they are created and edited,
              so it needs the layer's features in the store as well. Keyed like
              the sections above so a half-typed column name never carries over
              to the next layer. */}
          {layer.geojson ? (
            <>
              <Separator />
              <EditorTrackingSection key={`et-${layer.id}`} layer={layer} />
            </>
          ) : null}
        </div>
      </ScrollArea>
      <Separator />
      <p className="p-2 text-[10px] text-muted-foreground">
        {extrusionEnabled
          ? t("style.extrusion.footer")
          : elevation3dActive
            ? t("style.elevation3d.footer")
            : isDeckVectorLayer
              ? t("style.footerDeck")
              : t("style.footerMaplibre")}
      </p>
      {expressionBuilderDialog}
      <PasteStyleDialog
        open={pasteStyleOpen}
        onOpenChange={setPasteStyleOpen}
        onApply={(imported) => {
          // Merge onto the store's current style, not the one this render closed over: the box can
          // sit open while the panel's own controls edit the same layer. The layer *identity* is
          // safe to close over, because a change of selection closes the dialog above.
          const latest = useAppStore.getState().layers.find((c) => c.id === layer.id);
          // Removed while the box was open — nothing to style.
          if (!latest) return;
          updateLayer(layer.id, { style: imported.apply(latest.style) });
          setPasteStyleNotice(importedStyleNote(t, imported.warnings));
        }}
      />
    </aside>
  );
}
