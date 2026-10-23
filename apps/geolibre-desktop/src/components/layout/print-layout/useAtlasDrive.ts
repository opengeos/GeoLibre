import { useCallback, useEffect, useRef, type Dispatch } from "react";
import type { TFunction } from "i18next";
import type { GeoLibreLayer, PrintLayoutConfig } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { GRATICULE_LABEL_LAYER_ID } from "@geolibre/plugins";
import {
  computeScaleRatio,
  mapBodyAspectRatio,
  type LayoutOptions,
} from "../../../lib/print-layout";
import { setPrintExtentVisible, type PrintExtent } from "../../../lib/print-extent";
import {
  captureEngineMapImage,
  captureMapImage,
  type CapturedMap,
} from "../../../lib/print-layout-export";
import {
  atlasViewportFrame,
  expandBounds,
  geometryBounds,
  substituteAtlasTokens,
  type AtlasBounds,
  type AtlasPage,
  type AtlasTokenContext,
} from "../../../lib/print-atlas";
import { atlasCamera } from "../../../lib/print-atlas-camera";
import type { PrintLayoutAction } from "./state";
import type { AtlasSeries } from "./useAtlasSeries";

interface UseAtlasCaptureArgs {
  mapControllerRef: React.RefObject<MapEngine | null>;
  layout: PrintLayoutConfig;
  atlas: AtlasSeries;
  atlasBusy: boolean;
  options: LayoutOptions;
  showEnginePreview: (extent: PrintExtent | null) => void;
  wasOpenRef: React.RefObject<boolean>;
  dispatch: Dispatch<PrintLayoutAction>;
  t: TFunction;
}

/**
 * Drive the live map to atlas pages and capture them (GH #1291).
 *
 * @returns `captureAtlasPage` (drive + capture one page, used by the export),
 *   `goToAtlasPage` (step the preview to a page), and a ref to the latest
 *   `goToAtlasPage` for the debounced auto-drive.
 */
export function useAtlasCapture({
  mapControllerRef,
  layout,
  atlas,
  atlasBusy,
  options,
  showEnginePreview,
  wasOpenRef,
  dispatch,
  t,
}: UseAtlasCaptureArgs) {
  const { extentBbox, atlasExtentMode, atlasScale, atlasMaskEnabled } = layout;
  const { atlasFitMarginPct, atlasPageCount, atlasLayer, atlasPages } = atlas;

  // Drive the live map to one atlas page's extent and capture it. Margin mode
  // grows the feature's box before fitting; fixed-scale mode fits first, then
  // corrects the zoom by the log2 ratio difference (like applyScale) and
  // recaptures. Returns the capture plus the print frame's final visible
  // bounds, so data blocks exclude the part of the live map that cover-crop
  // removes from the page.
  const captureAtlasPage = useCallback(
    async (
      page: AtlasPage,
    ): Promise<{
      cap: CapturedMap;
      viewBounds: AtlasBounds;
      mapFit: "cover" | "contain";
    }> => {
      // Atlas drives the live camera, on any flat map: the Style Spec map's
      // own camera, or the engine's (see print-atlas-camera).
      const engine = mapControllerRef.current;
      const camera = atlasCamera(engine, GRATICULE_LABEL_LAYER_ID);
      if (!engine || !camera) throw new Error("Map is not ready");
      const ctx: AtlasTokenContext = {
        name: page.name,
        pageNumber: page.index + 1,
        total: atlasPageCount,
        properties: page.properties,
      };
      const pageOptions: LayoutOptions = {
        ...options,
        title: substituteAtlasTokens(options.title, ctx),
        subtitle: substituteAtlasTokens(options.subtitle, ctx),
        footerText: substituteAtlasTokens(options.footerText, ctx),
      };
      const { containMap, canvas, pixelRatio: cssPixelRatio } = camera;
      const viewportWidth = canvas.clientWidth || canvas.width / cssPixelRatio;
      const viewportHeight = canvas.clientHeight || canvas.height / cssPixelRatio;
      const targetAspect = containMap
        ? viewportWidth / Math.max(1, viewportHeight)
        : mapBodyAspectRatio(pageOptions);
      const viewportFrame = atlasViewportFrame(viewportWidth, viewportHeight, targetAspect);
      const coverageFeature = atlasLayer?.geojson?.features[page.sourceIndex];
      camera.showMask(atlasMaskEnabled ? coverageFeature : undefined);
      await camera.fit(expandBounds(page.bounds, atlasFitMarginPct), viewportFrame.padding);
      await camera.settle();
      // Mirror recapture: an active graticule draws coordinate labels at the
      // map edges, so fit with "contain" to keep them un-cropped on every
      // atlas page (mapFit is persistent state, so it must be set here too).
      const atlasMapFit = containMap ? "contain" : "cover";
      dispatch({ type: "setUi", patch: { mapFit: atlasMapFit } });
      // Hide the drawn print-extent box while reading the buffer, as recapture
      // does, so its outline is never baked into a page.
      const nativeMap = engine.getMap();
      const capture = async () => {
        if (!nativeMap) {
          // Another engine draws the box as its own preview; capture through
          // the engine, as recapture does there.
          showEnginePreview(null);
          try {
            return await captureEngineMapImage(engine, null, camera.decorate);
          } finally {
            // The drawn box stays on the map as a reference in either capture
            // mode, as the MapLibre branch and recapture restore it, but only
            // on this dialog's engine: a capture that outlived a close or a
            // renderer change must not draw on whatever replaced it.
            if (wasOpenRef.current && mapControllerRef.current === engine)
              showEnginePreview(extentBbox);
          }
        }
        setPrintExtentVisible(nativeMap, false);
        try {
          return captureMapImage(nativeMap, null);
        } finally {
          setPrintExtentVisible(nativeMap, true);
        }
      };
      let cap = await capture();
      const setAtlasScaleNotice = (notice: string | null) =>
        dispatch({ type: "setUi", patch: { atlasScaleNotice: notice } });
      if (atlasExtentMode === "scale") {
        const target = Number(atlasScale);
        // Measure against the page's substituted text, not the raw templates:
        // a title/footer made purely of tokens can resolve to empty for a
        // given feature, which collapses that row and changes the body height
        // the scale is computed from.
        const measure = () =>
          computeScaleRatio({
            ...pageOptions,
            metersPerPixel: cap.metersPerPixel,
            mapPixelRatio: cap.pixelRatio,
            bearingDeg: cap.bearingDeg,
            mapImage: cap.image,
            mapImageWidth: cap.width,
            mapImageHeight: cap.height,
          });
        // MapLibre lands on the scale in one correction; another engine's
        // camera can round the zoom it is given (the ArcGIS SDK does), so the
        // scale is measured again and corrected up to twice more.
        // Up to three corrections; the last pass only measures the capture
        // that ships, so the notice reflects it.
        for (let attempt = 0; attempt < 4; attempt++) {
          const ratio = measure();
          if (!(target > 0 && ratio > 0)) break;
          if (attempt > 0 && Math.abs(ratio / target - 1) < 0.005) {
            // Landed: an earlier pass's out-of-range notice no longer holds.
            setAtlasScaleNotice(null);
            break;
          }
          // Still off after every correction: the camera cannot reach the scale
          // (a zoom limit, or bounds that raise the minimum), so say so.
          if (attempt === 3) {
            setAtlasScaleNotice(t("printLayout.errors.scaleOutOfRange"));
            break;
          }
          const zoom = camera.zoom() + Math.log2(ratio / target);
          const clamped = Math.max(camera.minZoom(), Math.min(camera.maxZoom(), zoom));
          // A clamp means this page renders at the closest reachable scale,
          // not the requested one: surface that (like applyScale's notice)
          // instead of letting the substitution pass silently.
          setAtlasScaleNotice(
            Math.abs(clamped - zoom) > 1e-3 ? t("printLayout.errors.scaleOutOfRange") : null,
          );
          if (Math.abs(clamped - camera.zoom()) <= 1e-3) break;
          await camera.setZoom(clamped);
          await camera.settle();
          cap = await capture();
        }
      } else {
        setAtlasScaleNotice(null);
      }
      const frameBounds = containMap
        ? null
        : geometryBounds({
            type: "MultiPoint",
            coordinates: [
              [viewportFrame.crop.left, viewportFrame.crop.top],
              [viewportFrame.crop.right, viewportFrame.crop.top],
              [viewportFrame.crop.right, viewportFrame.crop.bottom],
              [viewportFrame.crop.left, viewportFrame.crop.bottom],
            ]
              .map(([x, y]) => camera.unproject(x, y))
              // A frame corner off the globe has no position.
              .filter((point): point is [number, number] => point !== null),
          });
      return {
        cap,
        viewBounds: frameBounds ?? camera.bounds(),
        mapFit: atlasMapFit,
      };
    },
    [
      mapControllerRef,
      extentBbox,
      showEnginePreview,
      atlasExtentMode,
      atlasFitMarginPct,
      atlasScale,
      atlasPageCount,
      atlasLayer,
      atlasMaskEnabled,
      options,
      t,
      dispatch,
      wasOpenRef,
    ],
  );

  const goToAtlasPage = useCallback(
    async (index: number) => {
      const page = atlasPages[index];
      if (!page || atlasBusy) return;
      dispatch({ type: "setUi", patch: { atlasBusy: true, error: null } });
      try {
        const { cap, viewBounds } = await captureAtlasPage(page);
        dispatch({ type: "atlasPageCaptured", captured: cap, index, bounds: viewBounds });
      } catch {
        dispatch({ type: "setUi", patch: { error: t("printLayout.errors.captureFailed") } });
      } finally {
        dispatch({ type: "setUi", patch: { atlasBusy: false } });
      }
    },
    [atlasPages, atlasBusy, captureAtlasPage, t, dispatch],
  );
  // Latest goToAtlasPage for the auto-jump effect, so the effect does not
  // re-run (and re-drive the map) every time a capture refreshes options.
  const goToAtlasPageRef = useRef(goToAtlasPage);
  goToAtlasPageRef.current = goToAtlasPage;

  return { captureAtlasPage, goToAtlasPage, goToAtlasPageRef };
}

interface UseLayerSelectionDefaultsArgs {
  open: boolean;
  layout: PrintLayoutConfig;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  /** Layers with loaded features: the ones an atlas or data block can use. */
  atlasLayers: GeoLibreLayer[];
  dispatch: Dispatch<PrintLayoutAction>;
}

/**
 * Default the atlas coverage layer and the data blocks' layers to the first
 * eligible layer when they are switched on without one selected, or when the
 * selected layer disappears (e.g. removed from the Layers panel while the
 * dialog is open) — a stale id would leave the Select valueless and the
 * series / block silently empty.
 *
 * Gated on `open`: the dialog stays mounted when closed, and since the
 * composer's settings are project state, an ungated reassignment would rewrite
 * (and dirty) the saved layout in the background when a layer is deleted from
 * the Layers panel, with the composer never opened. Reopening it re-runs these
 * and defaults then.
 */
export function useLayerSelectionDefaults({
  open,
  layout,
  atlasEnabled,
  atlasLayers,
  dispatch,
}: UseLayerSelectionDefaultsArgs) {
  const { atlasLayerId, showDataTable, tableLayerId, showDataChart, chartLayerId } = layout;
  useEffect(() => {
    if (!open || !atlasEnabled || atlasLayers.length === 0) return;
    if (!atlasLayers.some((l) => l.id === atlasLayerId)) {
      dispatch({ type: "selectAtlasLayer", layerId: atlasLayers[0].id });
    }
  }, [open, atlasEnabled, atlasLayerId, atlasLayers, dispatch]);

  // The data blocks' layers (GH #1324): the field choices belong to the old
  // layer, so selecting drops them.
  useEffect(() => {
    if (!open || !showDataTable || atlasLayers.length === 0) return;
    if (!atlasLayers.some((l) => l.id === tableLayerId)) {
      dispatch({ type: "selectTableLayer", layerId: atlasLayers[0].id });
    }
  }, [open, showDataTable, tableLayerId, atlasLayers, dispatch]);
  useEffect(() => {
    if (!open || !showDataChart || atlasLayers.length === 0) return;
    if (!atlasLayers.some((l) => l.id === chartLayerId)) {
      dispatch({ type: "selectChartLayer", layerId: atlasLayers[0].id });
    }
  }, [open, showDataChart, chartLayerId, atlasLayers, dispatch]);
}

interface UseAtlasAutoDriveArgs {
  open: boolean;
  layout: PrintLayoutConfig;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlas: AtlasSeries;
  atlasIndex: number;
  isMmPage: boolean;
  goToAtlasPageRef: React.RefObject<(index: number) => Promise<void>>;
  dispatch: Dispatch<PrintLayoutAction>;
}

/**
 * Keep the atlas preview in step with its settings: re-drive the current page
 * when the series or its capture settings change, and fall back from a fixed
 * scale to margin mode on a pixel-sized page.
 */
export function useAtlasAutoDrive({
  open,
  layout,
  atlasEnabled,
  atlas,
  atlasIndex,
  isMmPage,
  goToAtlasPageRef,
  dispatch,
}: UseAtlasAutoDriveArgs) {
  const { atlasLayerId, atlasExtentMode, atlasMarginPct, atlasScale, atlasMaskEnabled } = layout;
  const { atlasCoverage } = layout;
  const { atlasDriveKey, atlasPageCount, deferredSegmentKm } = atlas;
  // Latest page index for the auto-drive effect below, so stepping (which
  // sets the index) does not itself re-trigger a capture.
  const atlasIndexRef = useRef(atlasIndex);
  atlasIndexRef.current = atlasIndex;

  // Re-drive the preview whenever the series or its capture settings change:
  // enabling the atlas or switching layers (their handlers reset the index to
  // 0), reordering/filtering (a new atlasDriveKey), or editing the extent
  // margin/scale. Without this the derived title/name text updates
  // immediately while the captured map still shows the previously driven
  // feature. Keyed on the sourceIndex signature (not the pages array) so a
  // name-field-only change never recaptures. Debounced so free-text typing
  // does not thrash the live map; goToAtlasPage's busy guard drops re-drives
  // landing mid-capture.
  useEffect(() => {
    if (!open || !atlasEnabled || atlasPageCount === 0) return;
    const timer = window.setTimeout(() => {
      void goToAtlasPageRef.current(Math.min(atlasIndexRef.current, atlasPageCount - 1));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    goToAtlasPageRef,
    open,
    atlasEnabled,
    atlasLayerId,
    atlasDriveKey,
    atlasPageCount,
    atlasExtentMode,
    atlasMarginPct,
    atlasScale,
    atlasMaskEnabled,
    // Along-a-line coverage: a new segment length can keep the same page
    // count (sourceIndex signature unchanged) while every extent moved.
    atlasCoverage,
    deferredSegmentKm,
  ]);

  // Fixed scale is only meaningful on physical paper (like the manual scale
  // input); fall back to margin mode when the page switches to pixel sizes.
  // `open`-gated for the same reason as the layer defaults: this also runs on
  // the mount that every project load triggers, so a hand-edited file pairing
  // a pixel page with scale mode would be corrected — and the project marked
  // dirty — before the composer had ever been opened. Nothing acts on the
  // pairing until the composer is open, and opening it runs this.
  useEffect(() => {
    if (!open) return;
    if (!isMmPage && atlasExtentMode === "scale") {
      dispatch({ type: "setLayout", patch: { atlasExtentMode: "margin" } });
    }
  }, [open, isMmPage, atlasExtentMode, dispatch]);
}
