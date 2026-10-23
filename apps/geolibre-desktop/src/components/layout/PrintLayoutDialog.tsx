import { useEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, useLayersWhen } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Separator,
} from "@geolibre/ui";
import type { LayoutOptions } from "../../lib/print-layout";
import { substituteAtlasTokens } from "../../lib/print-atlas";
import { useMapCapabilities } from "../../hooks/useMapCapabilities";
import {
  CONTROLS_MAX_WIDTH,
  CONTROLS_MIN_WIDTH,
  createPrintLayoutState,
  printLayoutReducer,
} from "./print-layout/state";
import { useDialogResize } from "./print-layout/useDialogResize";
import { useLegendModel } from "./print-layout/useLegendModel";
import { useMapCapture } from "./print-layout/useMapCapture";
import { useLayoutOptions } from "./print-layout/useLayoutOptions";
import { useAtlasSeries } from "./print-layout/useAtlasSeries";
import { useDataBlocks } from "./print-layout/useDataBlocks";
import {
  useAtlasAutoDrive,
  useAtlasCapture,
  useLayerSelectionDefaults,
} from "./print-layout/useAtlasDrive";
import { useScaleControl } from "./print-layout/useScaleControl";
import { useExtentDrawing } from "./print-layout/useExtentDrawing";
import { usePreviewCanvas } from "./print-layout/usePreviewCanvas";
import { useExportActions } from "./print-layout/useExportActions";
import { TitleEditor } from "./print-layout/TitleEditor";
import { PageEditor } from "./print-layout/PageEditor";
import { MapFrameEditor } from "./print-layout/MapFrameEditor";
import { MapScaleEditor } from "./print-layout/MapScaleEditor";
import { PrintExtentEditor } from "./print-layout/PrintExtentEditor";
import { AtlasEditor } from "./print-layout/AtlasEditor";
import { ElementToggles } from "./print-layout/ElementToggles";
import { CustomLegendEditor } from "./print-layout/CustomLegendEditor";
import { ColorbarEditor } from "./print-layout/ColorbarEditor";
import { DataTableEditor } from "./print-layout/DataTableEditor";
import { DataChartEditor } from "./print-layout/DataChartEditor";
import { FooterEditor } from "./print-layout/FooterEditor";
import { PageBorderEditor } from "./print-layout/PageBorderEditor";
import { InfoBlockEditor } from "./print-layout/InfoBlockEditor";
import { LegendEditor } from "./print-layout/LegendEditor";
import { PreviewPane } from "./print-layout/PreviewPane";
import { ExportActions } from "./print-layout/ExportActions";

interface PrintLayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapEngine | null>;
}

/**
 * Print Layout composer dialog: captures the current map view and composes it
 * with a title, legend, scale bar, north arrow, and footer onto a chosen paper
 * or screen size, then exports the result to PNG, PDF, or SVG.
 *
 * The composer's state lives in one reducer (`print-layout/state.ts`); each
 * page element has its own editor under `print-layout/`, and the map-side
 * work (capture, atlas drive, scale, extent drawing, export) lives in hooks
 * there too. This component wires them together.
 */
export function PrintLayoutDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: PrintLayoutDialogProps) {
  const { t } = useTranslation();
  // Layers are only read while the dialog is open; it stays mounted closed (to
  // keep the layout being composed) without re-rendering on layer edits.
  const layers = useLayersWhen(open);
  const projectName = useAppStore((s) => s.projectName);
  const legendConfig = useAppStore((s) => s.legend);
  const setLegendConfig = useAppStore((s) => s.setLegend);
  // Follow the map's scale-bar unit preference so the printed bar matches the
  // on-screen one (metric / imperial / nautical).
  const scaleUnit = useAppStore((s) => s.preferences.map.scaleUnit);
  // The project's zoom limits. An engine without a MapLibre map exposes none of
  // its own, but `applyMapPreferences` feeds it these (clamped to [0, 24], the
  // range every engine accepts), so they are what its camera can reach.
  const prefMinZoom = useAppStore((s) => s.preferences.map.minZoom);
  const prefMaxZoom = useAppStore((s) => s.preferences.map.maxZoom);
  const setPrintLayout = useAppStore((s) => s.setPrintLayout);
  // The composer's settings belong to the project, so the controls start from
  // what it was saved with. Read once per mount: the dialog is remounted on
  // every project load (see the `key` at its render site), which is what makes
  // an opened project's layout reach these controls instead of the previous
  // project's (GeoLibre discussion #1992).
  const [state, dispatch] = useReducer(printLayoutReducer, undefined, () =>
    createPrintLayoutState(useAppStore.getState().printLayout),
  );
  const { layout, captured, mapFit, atlasBusy, exporting } = state;
  const { captureMode, extentBbox } = layout;

  // Atlas / map series: one page per coverage-layer feature (GH #1291).
  const renderer = useAppStore((s) => s.primaryRenderer);
  // Atlas drives the live camera of a flat map (print-atlas-camera): a Style
  // Spec map's own (a MapLibre or Mapbox globe included), or the engine's on
  // a flat ArcGIS view; the ArcGIS SceneView and the Cesium globe have none.
  const mapCapabilities = useMapCapabilities(mapControllerRef);
  const projection = useAppStore((s) => s.preferences.map.projection);
  const atlasRendererSupported =
    mapCapabilities.flatProjection && (mapCapabilities.styleSpec || projection !== "globe");
  const atlasEnabled = layout.atlasEnabled && atlasRendererSupported;
  // Mirror of atlasActive (derived further down) for the dialog-open effect,
  // which is declared before those derivations exist.
  const atlasActiveRef = useRef(false);

  const { dialogRef, resizeCleanupRef, startDialogResize, startSplitterResize } = useDialogResize(
    dispatch,
    state.controlsWidth,
  );
  const { legend, editorRows, markerIcons, entryIdsInOrder, moveEntry } = useLegendModel(
    layers,
    legendConfig,
    setLegendConfig,
    t,
  );
  const capture = useMapCapture({
    open,
    mapControllerRef,
    captureMode,
    extentBbox,
    dispatch,
    atlasActiveRef,
    resizeCleanupRef,
    t,
  });
  const { recapture, showEnginePreview } = capture;

  // Push composer edits into the project so Save writes them and reopening the
  // project restores them. `layout` is the project's `PrintLayoutConfig` as-is,
  // and `setPrintLayout` ignores a config equal to the one already stored, so
  // this effect's first run (which replays exactly what the controls were
  // seeded with) does not mark the project dirty.
  useEffect(() => {
    setPrintLayout(layout);
  }, [layout, setPrintLayout]);

  const { options, isMmPage, currentRatio } = useLayoutOptions({
    layout,
    projectName,
    scaleUnit,
    legend,
    legendConfig,
    markerIcons,
    captured,
    mapFit,
    t,
  });

  // ---- Atlas (map series) derivations (GH #1291) ----
  const atlas = useAtlasSeries({
    open,
    layers,
    layout,
    atlasEnabled,
    atlasIndex: state.atlasIndex,
    mapControllerRef,
  });
  const { atlasActive, atlasTokenCtx, clampedAtlasIndex } = atlas;
  atlasActiveRef.current = atlasActive;

  // ---- Data blocks: attribute table + chart on the page (GH #1324) ----
  const blocks = useDataBlocks({
    layout,
    atlas,
    atlasEnabled,
    atlasViewBounds: state.atlasViewBounds,
    t,
  });
  const { displayDataBlocks } = blocks;

  // Options with this page's atlas tokens resolved, fed to the preview, the
  // clipboard copy, and the single-page exports; the inputs keep the raw
  // template so the tokens stay editable.
  const displayOptions = useMemo<LayoutOptions>(() => {
    const withBlocks = { ...options, ...displayDataBlocks };
    return atlasTokenCtx
      ? {
          ...withBlocks,
          title: substituteAtlasTokens(options.title, atlasTokenCtx),
          subtitle: substituteAtlasTokens(options.subtitle, atlasTokenCtx),
          footerText: substituteAtlasTokens(options.footerText, atlasTokenCtx),
        }
      : withBlocks;
  }, [options, displayDataBlocks, atlasTokenCtx]);

  const { captureAtlasPage, goToAtlasPage, goToAtlasPageRef } = useAtlasCapture({
    mapControllerRef,
    layout,
    atlas,
    atlasBusy,
    options,
    showEnginePreview,
    wasOpenRef: capture.wasOpenRef,
    dispatch,
    t,
  });
  useLayerSelectionDefaults({
    open,
    layout,
    atlasEnabled,
    atlasLayers: atlas.atlasLayers,
    dispatch,
  });
  useAtlasAutoDrive({
    open,
    layout,
    atlasEnabled,
    atlas,
    atlasIndex: state.atlasIndex,
    isMmPage,
    goToAtlasPageRef,
    dispatch,
  });

  // A drawn extent fixes the ground area, so zooming would not reach the
  // requested denominator (it changes the crop size inversely); only allow
  // manual scale entry in viewport mode.
  const scaleEditable = Boolean(captured) && captureMode !== "extent";
  const { applyScale, scaleFocusedRef } = useScaleControl({
    mapControllerRef,
    captureMode,
    currentRatio,
    prefMinZoom,
    prefMaxZoom,
    recapture,
    idleRecaptureRef: capture.idleRecaptureRef,
    idleFallbackRef: capture.idleFallbackRef,
    dispatch,
    t,
  });
  const { handleDrawExtent, handleClearExtent, setMode } = useExtentDrawing({
    mapControllerRef,
    options,
    onOpenChange,
    recapture,
    captureMode,
    extentBbox,
    showEnginePreview,
    enginePreviewRef: capture.enginePreviewRef,
    drawingRef: capture.drawingRef,
    drawAbortRef: capture.drawAbortRef,
    dispatch,
  });
  const { previewRef, previewBoxRef } = usePreviewCanvas(open, displayOptions);
  const actions = useExportActions({
    layout,
    projectName,
    captured,
    exporting,
    atlasBusy,
    options,
    displayOptions,
    atlas,
    blocks,
    captureAtlasPage,
    copiedTimeoutRef: capture.copiedTimeoutRef,
    onOpenChange,
    dispatch,
    t,
  });

  const { dialogSize, controlsWidth } = state;
  const editorProps = { layout, dispatch };
  return (
    <Dialog open={open} onOpenChange={actions.handleDialogOpenChange}>
      <DialogContent
        ref={dialogRef}
        className="max-w-5xl"
        style={
          dialogSize
            ? {
                width: dialogSize.width,
                height: dialogSize.height,
                maxWidth: "none",
              }
            : undefined
        }
        bodyClassName={
          dialogSize ? "flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-6" : undefined
        }
        resizeHandle={
          <div
            role="separator"
            aria-label={t("printLayout.resizeDialog")}
            onPointerDown={startDialogResize}
            className="absolute bottom-0 right-0 z-10 hidden h-5 w-5 cursor-nwse-resize touch-none select-none text-muted-foreground hover:text-foreground md:block"
            title={t("printLayout.resizeDialog")}
          >
            <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden="true">
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
          <DialogTitle>{t("printLayout.title")}</DialogTitle>
          <DialogDescription>{t("printLayout.description")}</DialogDescription>
        </DialogHeader>

        <div
          className={`grid min-h-0 grid-cols-1 gap-6 md:gap-2 md:[grid-template-columns:var(--pl-cols)] ${
            dialogSize ? "flex-1" : ""
          }`}
          style={
            {
              "--pl-cols": `${controlsWidth}px 10px minmax(0,1fr)`,
            } as React.CSSProperties
          }
        >
          {/* Controls */}
          <div
            className={`min-w-0 space-y-4 overflow-y-auto pe-1 ${
              dialogSize ? "h-full" : "max-h-[60vh]"
            }`}
          >
            <TitleEditor {...editorProps} projectName={projectName} />

            <Separator />

            <PageEditor {...editorProps} />
            <MapFrameEditor {...editorProps} mapBackgroundDraft={state.mapBackgroundDraft} />
            {isMmPage && (
              <MapScaleEditor
                dispatch={dispatch}
                scaleDraft={state.scaleDraft}
                scaleNotice={state.scaleNotice}
                scaleEditable={scaleEditable}
                currentRatio={currentRatio}
                scaleFocusedRef={scaleFocusedRef}
                applyScale={applyScale}
              />
            )}
            <PrintExtentEditor
              captureMode={captureMode}
              extentBbox={extentBbox}
              drawingExtent={state.drawingExtent}
              renderer={renderer}
              onDrawExtent={handleDrawExtent}
              onClearExtent={handleClearExtent}
              onSetMode={setMode}
            />

            <Separator />

            <AtlasEditor
              {...editorProps}
              atlas={atlas}
              atlasEnabled={atlasEnabled}
              atlasRendererSupported={atlasRendererSupported}
              atlasBusy={atlasBusy}
              atlasScaleNotice={state.atlasScaleNotice}
              isMmPage={isMmPage}
            />

            <Separator />

            <ElementToggles {...editorProps} />
            {layout.showCustomLegend && (
              <CustomLegendEditor
                {...editorProps}
                legendDict={state.legendDict}
                legendDictError={state.legendDictError}
              />
            )}
            {layout.showColorbar && <ColorbarEditor {...editorProps} />}
            {layout.showDataTable && (
              <DataTableEditor
                {...editorProps}
                atlasLayers={atlas.atlasLayers}
                blocks={blocks}
                atlasEnabled={atlasEnabled}
              />
            )}
            {layout.showDataChart && (
              <DataChartEditor {...editorProps} atlasLayers={atlas.atlasLayers} blocks={blocks} />
            )}
            {layout.showFooter && <FooterEditor {...editorProps} />}
            {layout.showPageBorder && <PageBorderEditor {...editorProps} />}
            {layout.showInfoBlock && <InfoBlockEditor {...editorProps} />}
            {layout.showLegend && (
              <LegendEditor
                legendConfig={legendConfig}
                setLegendConfig={setLegendConfig}
                editorRows={editorRows}
                entryIdsInOrder={entryIdsInOrder}
                markerIcons={markerIcons}
                moveEntry={moveEntry}
              />
            )}
          </div>

          {/* Splitter between the controls and the preview */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("printLayout.resizeControls")}
            aria-valuenow={Math.round(controlsWidth)}
            aria-valuemin={CONTROLS_MIN_WIDTH}
            aria-valuemax={CONTROLS_MAX_WIDTH}
            tabIndex={0}
            className="group relative hidden cursor-col-resize touch-none select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
            onPointerDown={startSplitterResize}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 32 : 8;
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                dispatch({ type: "nudgeControlsWidth", delta: -step });
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                dispatch({ type: "nudgeControlsWidth", delta: step });
              }
            }}
          >
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary" />
          </div>

          <PreviewPane
            atlas={atlas}
            atlasBusy={atlasBusy}
            sized={dialogSize !== null}
            error={state.error}
            previewRef={previewRef}
            previewBoxRef={previewBoxRef}
            onRecapture={() => {
              if (atlasActive) void goToAtlasPage(clampedAtlasIndex);
              else recapture();
            }}
            onGoToAtlasPage={goToAtlasPage}
          />
        </div>

        <ExportActions
          ui={state}
          hasCapture={Boolean(captured)}
          atlasEnabled={atlasEnabled}
          atlas={atlas}
          actions={actions}
        />
      </DialogContent>
    </Dialog>
  );
}
