import { useCallback, useEffect, useRef, type Dispatch } from "react";
import type { TFunction } from "i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { GRATICULE_LABEL_LAYER_ID } from "@geolibre/plugins";
import {
  clearPrintExtent,
  setPrintExtentVisible,
  showPrintExtent,
  type PrintExtent,
} from "../../../lib/print-extent";
import { captureEngineMapImage } from "../../../lib/print-layout-export";
import { clearAtlasFeatureMask } from "../../../lib/print-atlas-mask";
import { engineStyleMap } from "../../../lib/engine-style-map";
import type { PrintLayoutAction } from "./state";

interface UseMapCaptureArgs {
  open: boolean;
  mapControllerRef: React.RefObject<MapEngine | null>;
  captureMode: PrintLayoutConfig["captureMode"];
  extentBbox: PrintExtent | null;
  dispatch: Dispatch<PrintLayoutAction>;
  /** Mirror of the atlas being active, derived later in the render. */
  atlasActiveRef: React.RefObject<boolean>;
  /** Teardown of an in-progress dialog/splitter resize drag. */
  resizeCleanupRef: React.RefObject<(() => void) | null>;
  t: TFunction;
}

/**
 * Snapshot the live map for the composer and own the map-side lifecycle of the
 * dialog: capture on the closed -> open transition, show / hide the drawn
 * print-extent box, and tear everything down on close and unmount.
 *
 * @returns `recapture`, the engine extent-preview helper, and the refs the
 *   other composer actions coordinate through.
 */
export function useMapCapture({
  open,
  mapControllerRef,
  captureMode,
  extentBbox,
  dispatch,
  atlasActiveRef,
  resizeCleanupRef,
  t,
}: UseMapCaptureArgs) {
  const copiedTimeoutRef = useRef<number | null>(null);
  const wasOpenRef = useRef(false);
  // Set while the dialog is hidden to let the user draw on the map, so the
  // close handler does not tear down the in-progress extent box.
  const drawingRef = useRef(false);
  // Aborts an in-progress draw when the dialog unmounts mid-drag.
  const drawAbortRef = useRef<AbortController | null>(null);
  // A pending "recapture once the map is idle" handler (from applyScale), kept
  // so any newer capture can cancel it before it overwrites a fresh result.
  const idleRecaptureRef = useRef<(() => void) | null>(null);
  // Fallback timer that forces a recapture if the map's "idle" event is delayed
  // or never fires (e.g. WebKit throttling the occluded map canvas behind the
  // dialog), so a scale change is never silently dropped (GH #743).
  const idleFallbackRef = useRef<number | null>(null);

  const captureRequest = useRef(0);
  // The globe keeps the drawn extent as a native entity (MapLibre's box lives
  // in the print-extent source/layers), so one retained disposer mirrors that
  // box's show / hide-for-capture / clear lifecycle. No-op on MapLibre.
  const enginePreviewRef = useRef<(() => void) | null>(null);
  const showEnginePreview = useCallback(
    (extent: PrintExtent | null) => {
      enginePreviewRef.current?.();
      enginePreviewRef.current = null;
      const engine = mapControllerRef.current;
      if (!extent || !engine || engine.getMap()) return;
      enginePreviewRef.current = engine.showExtent(extent);
    },
    [mapControllerRef],
  );
  const recapture = useCallback(
    async (clipOverride?: PrintExtent | null) => {
      const request = ++captureRequest.current;
      const engine = mapControllerRef.current;
      const map = engine?.getMap();
      if (!engine?.getRenderSurface()) {
        dispatch({ type: "captureFailed", error: t("printLayout.errors.mapNotReady") });
        return;
      }
      // Cancel any pending post-zoom idle capture: this fresh capture supersedes
      // it, so it must not fire later and overwrite the result (e.g. a viewport
      // recapture clobbering an extent the user drew while tiles were loading).
      if (idleRecaptureRef.current) {
        map?.off("idle", idleRecaptureRef.current);
        idleRecaptureRef.current = null;
      }
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      // An explicit override wins (used right after drawing, before state has
      // settled); otherwise clip to the stored extent only in extent mode.
      const clip =
        clipOverride !== undefined ? clipOverride : captureMode === "extent" ? extentBbox : null;
      // An active graticule draws coordinate labels at the map edges; fit the
      // captured map with "contain" so the page crop does not trim them.
      dispatch({
        type: "setUi",
        patch: { mapFit: map?.getLayer(GRATICULE_LABEL_LAYER_ID) ? "contain" : "cover" },
      });
      // Hide the extent box while reading the drawing buffer so its outline is
      // never baked into the captured image.
      if (map) setPrintExtentVisible(map, false);
      else showEnginePreview(null);
      try {
        const image = await captureEngineMapImage(engine, clip);
        if (request !== captureRequest.current) return;
        dispatch({ type: "captureSucceeded", captured: image });
      } catch {
        if (request !== captureRequest.current) return;
        dispatch({ type: "captureFailed", error: t("printLayout.errors.captureFailed") });
      } finally {
        // Only the live request restores the box: a superseded capture's
        // restore would otherwise land mid-way through the newer one and bake
        // the outline into its image.
        if (request === captureRequest.current) {
          if (map && engine.getMap() === map) setPrintExtentVisible(map, true);
          else if (!map) showEnginePreview(clipOverride !== undefined ? clipOverride : extentBbox);
        }
      }
    },
    [mapControllerRef, t, captureMode, extentBbox, showEnginePreview, dispatch],
  );

  // Capture the map only on the closed -> open transition, so a background
  // change while the dialog is open does not replace the snapshot the user is
  // composing.
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (open && !wasOpenRef.current) {
      // Clear the error, any out-of-range scale notice and the clipboard
      // "Copied" flag from a prior session: the dialog is hidden (not
      // unmounted) on close, so they would otherwise persist into the next
      // open (GH #743, GH #773).
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      dispatch({ type: "dialogOpened" });
      // Re-show a previously drawn extent box while composing.
      if (map && extentBbox) showPrintExtent(map, extentBbox);
      else if (!map && extentBbox) showEnginePreview(extentBbox);
      // With an active atlas persisting from a prior session, skip the plain
      // viewport capture: the atlas auto-drive effect recaptures the current
      // page on this same transition, and the extra capture would flash an
      // incorrect preview first.
      if (!atlasActiveRef.current) recapture();
    } else if (!open && wasOpenRef.current && !drawingRef.current) {
      captureRequest.current++;
      // Closing for good (not to draw): take the extent box off the map.
      showEnginePreview(null);
      if (map) clearPrintExtent(map);
      // The atlas mask is drawn on either 2D engine; see captureAtlasPage.
      const styleMap = engineStyleMap(mapControllerRef.current);
      if (styleMap) clearAtlasFeatureMask(styleMap);
    }
    wasOpenRef.current = open;
  }, [open, recapture, mapControllerRef, extentBbox, showEnginePreview, dispatch, atlasActiveRef]);

  // Clean up if the dialog unmounts: abort an in-progress draw (so its window
  // listeners are torn down and it does not setState on an unmounted component)
  // and take the extent box off the map.
  useEffect(
    () => () => {
      drawAbortRef.current?.abort();
      // Tear down an in-progress resize drag so its window listeners don't leak.
      resizeCleanupRef.current?.();
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = null;
      }
      enginePreviewRef.current?.();
      enginePreviewRef.current = null;
      // An atlas capture still in flight must not bring the preview back.
      wasOpenRef.current = false;
      const map = mapControllerRef.current?.getMap();
      if (map) {
        if (idleRecaptureRef.current) {
          map.off("idle", idleRecaptureRef.current);
          idleRecaptureRef.current = null;
        }
        clearPrintExtent(map);
      }
      const styleMap = engineStyleMap(mapControllerRef.current);
      if (styleMap) clearAtlasFeatureMask(styleMap);
    },
    [mapControllerRef, resizeCleanupRef],
  );

  return {
    recapture,
    showEnginePreview,
    enginePreviewRef,
    wasOpenRef,
    drawingRef,
    drawAbortRef,
    idleRecaptureRef,
    idleFallbackRef,
    copiedTimeoutRef,
  };
}
