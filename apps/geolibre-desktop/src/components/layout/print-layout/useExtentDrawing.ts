import { useCallback, type Dispatch } from "react";
import type { PrintLayoutConfig } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { resolvePageSize, type LayoutOptions } from "../../../lib/print-layout";
import {
  clearPrintExtent,
  drawEnginePrintExtent,
  drawPrintExtent,
  showPrintExtent,
  type PrintExtent,
} from "../../../lib/print-extent";
import type { PrintLayoutAction } from "./state";

interface UseExtentDrawingArgs {
  mapControllerRef: React.RefObject<MapEngine | null>;
  options: LayoutOptions;
  onOpenChange: (open: boolean) => void;
  recapture: (clipOverride?: PrintExtent | null) => Promise<void>;
  captureMode: PrintLayoutConfig["captureMode"];
  extentBbox: PrintExtent | null;
  showEnginePreview: (extent: PrintExtent | null) => void;
  enginePreviewRef: React.RefObject<(() => void) | null>;
  drawingRef: React.RefObject<boolean>;
  drawAbortRef: React.RefObject<AbortController | null>;
  dispatch: Dispatch<PrintLayoutAction>;
}

/**
 * The custom print extent (GH #523): draw it on the live map, clear it, and
 * switch the capture between it and the viewport.
 *
 * @returns The draw / clear / capture-mode handlers.
 */
export function useExtentDrawing({
  mapControllerRef,
  options,
  onOpenChange,
  recapture,
  captureMode,
  extentBbox,
  showEnginePreview,
  enginePreviewRef,
  drawingRef,
  drawAbortRef,
  dispatch,
}: UseExtentDrawingArgs) {
  // Hide the dialog so the map is interactive, let the user drag an extent box,
  // then reopen with the new extent active.
  const handleDrawExtent = useCallback(async () => {
    const engine = mapControllerRef.current;
    if (!engine) return;
    const map = engine.getMap();
    const page = resolvePageSize(options);
    const aspect = page.width / page.height;
    const controller = new AbortController();
    drawAbortRef.current = controller;
    drawingRef.current = true;
    dispatch({ type: "setUi", patch: { drawingExtent: true } });
    onOpenChange(false);
    try {
      let extent: PrintExtent | null = null;
      if (map) {
        extent = await drawPrintExtent(map, { aspect, signal: controller.signal });
      } else {
        // Take the prior globe box down first so the drag is not painted over
        // it (drawPrintExtent replaces the MapLibre box's data the same way).
        showEnginePreview(null);
        const drawn = await drawEnginePrintExtent(engine, controller.signal);
        if (drawn && controller.signal.aborted) drawn.dispose();
        else if (drawn) {
          extent = drawn.extent;
          enginePreviewRef.current = drawn.dispose;
        }
      }
      // Aborted means the dialog unmounted mid-draw: do not touch state.
      if (controller.signal.aborted) return;
      if (extent) {
        dispatch({ type: "extentDrawn", extent });
        recapture(extent);
      } else if (extentBbox) {
        // Cancelled drag: drop the half-drawn preview back to the prior extent.
        if (map) showPrintExtent(map, extentBbox);
        else showEnginePreview(extentBbox);
      } else {
        if (map) clearPrintExtent(map);
      }
    } finally {
      if (drawAbortRef.current === controller) drawAbortRef.current = null;
      if (!controller.signal.aborted) {
        drawingRef.current = false;
        dispatch({ type: "setUi", patch: { drawingExtent: false } });
        onOpenChange(true);
      }
    }
  }, [
    mapControllerRef,
    options,
    onOpenChange,
    recapture,
    extentBbox,
    showEnginePreview,
    enginePreviewRef,
    drawingRef,
    drawAbortRef,
    dispatch,
  ]);

  const handleClearExtent = useCallback(() => {
    const map = mapControllerRef.current?.getMap();
    if (map) clearPrintExtent(map);
    showEnginePreview(null);
    dispatch({ type: "extentCleared" });
    recapture(null);
  }, [mapControllerRef, recapture, showEnginePreview, dispatch]);

  const setMode = useCallback(
    (mode: "viewport" | "extent") => {
      if (mode === captureMode) return;
      dispatch({ type: "setCaptureMode", mode });
      recapture(mode === "extent" ? extentBbox : null);
    },
    [recapture, extentBbox, captureMode, dispatch],
  );

  return { handleDrawExtent, handleClearExtent, setMode };
}
