import { useCallback, useEffect, useRef, type Dispatch } from "react";
import type { TFunction } from "i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { scaleZoomTarget } from "../../../lib/print-layout";
import type { PrintExtent } from "../../../lib/print-extent";
import { clamp } from "../../../lib/clamp";
import type { PrintLayoutAction } from "./state";

interface UseScaleControlArgs {
  mapControllerRef: React.RefObject<MapEngine | null>;
  captureMode: PrintLayoutConfig["captureMode"];
  currentRatio: number;
  prefMinZoom: number;
  prefMaxZoom: number;
  recapture: (clipOverride?: PrintExtent | null) => Promise<void>;
  idleRecaptureRef: React.RefObject<(() => void) | null>;
  idleFallbackRef: React.RefObject<number | null>;
  dispatch: Dispatch<PrintLayoutAction>;
  t: TFunction;
}

/**
 * The manual 1:N scale control: keeps the input in step with the captured
 * view's scale, and drives the live map to a typed or preset scale.
 *
 * @returns `applyScale` and the ref marking the scale input as focused (so
 *   the two-way sync does not overwrite what the user is typing).
 */
export function useScaleControl({
  mapControllerRef,
  captureMode,
  currentRatio,
  prefMinZoom,
  prefMaxZoom,
  recapture,
  idleRecaptureRef,
  idleFallbackRef,
  dispatch,
  t,
}: UseScaleControlArgs) {
  // True while the scale input has focus, so two-way sync does not overwrite
  // what the user is typing.
  const scaleFocusedRef = useRef(false);

  // Two-way scale sync: reflect the captured view's scale into the input unless
  // the user is actively editing it.
  useEffect(() => {
    if (!scaleFocusedRef.current) {
      dispatch({
        type: "setUi",
        patch: { scaleDraft: currentRatio > 0 ? String(Math.round(currentRatio)) : "" },
      });
    }
  }, [currentRatio, dispatch]);

  // Drive the live map to a target 1:N scale, then recapture. The reported
  // scale is linear in metres-per-pixel, which halves per zoom level, so the
  // zoom delta is log2(currentScale / targetScale).
  // A drawn extent fixes the ground area, so zooming would not reach the
  // requested denominator (it changes the crop size inversely); only allow
  // manual scale entry in viewport mode.
  const applyScale = useCallback(
    (targetRatio: number) => {
      const setScaleNotice = (notice: string | null) =>
        dispatch({ type: "setUi", patch: { scaleNotice: notice } });
      const engine = mapControllerRef.current;
      const map = engine?.getMap();
      if (engine && !map && captureMode !== "extent") {
        // `applyMapPreferences` feeds a non-MapLibre engine the project's zoom
        // limits (clamped to [0, 24], the range every engine accepts), so those
        // are what this camera can reach.
        const target = scaleZoomTarget(
          engine.readView().zoom,
          currentRatio,
          targetRatio,
          clamp(prefMinZoom, 0, 24),
          clamp(prefMaxZoom, 0, 24),
        );
        if (!target) return;
        // A scale the camera cannot reach is applied partially, so say so rather
        // than letting the value snap back unexplained — the same contract the
        // MapLibre branch below has had since GH #743.
        setScaleNotice(target.clamped ? t("printLayout.errors.scaleOutOfRange") : null);
        // Already there (or clamped to where it is): recapture without moving,
        // so the reported scale still refreshes.
        if (!target.unchanged) engine.flyTo({ zoom: target.zoom, duration: 0 });
        void recapture(null);
        return;
      }
      if (captureMode === "extent" || !map) return;
      // The map's own zoom limits (not a fixed 0–24), so the out-of-range notice
      // reflects what this map can actually reach.
      const target = scaleZoomTarget(
        map.getZoom(),
        currentRatio,
        targetRatio,
        map.getMinZoom(),
        map.getMaxZoom(),
      );
      if (!target) return;
      // The requested scale needs a zoom past the map's limits, so it can only be
      // applied partially: surface that instead of letting the value snap back
      // with no explanation (GH #743). A reachable scale clears the notice.
      setScaleNotice(target.clamped ? t("printLayout.errors.scaleOutOfRange") : null);
      // Drop a still-pending idle handler / fallback timer from a prior applyScale
      // before registering new ones, so two quick scale changes don't both fire.
      if (idleRecaptureRef.current) {
        map.off("idle", idleRecaptureRef.current);
        idleRecaptureRef.current = null;
      }
      if (idleFallbackRef.current !== null) {
        window.clearTimeout(idleFallbackRef.current);
        idleFallbackRef.current = null;
      }
      // No effective zoom change (already at target, or clamped): MapLibre won't
      // emit an "idle", so recapture directly rather than registering a handler
      // that would never fire and could later fire on an unrelated render.
      if (target.unchanged) {
        recapture(null);
        return;
      }
      map.setZoom(target.zoom);
      // Recapture once the map is idle, so tiles for the new zoom have finished
      // loading and the snapshot is not blurry/blank mid-fetch. applyScale only
      // runs in viewport mode, so pin the recapture to a null clip. Use map.on
      // with manual self-removal (not map.once) so cancelling via map.off never
      // depends on MapLibre's internal once-wrapper. The ref lets a capture that
      // happens first (e.g. the user draws an extent while tiles load) cancel it.
      const handler = () => {
        map.off("idle", handler);
        idleRecaptureRef.current = null;
        if (idleFallbackRef.current !== null) {
          window.clearTimeout(idleFallbackRef.current);
          idleFallbackRef.current = null;
        }
        recapture(null);
      };
      idleRecaptureRef.current = handler;
      map.on("idle", handler);
      // Fallback: if "idle" is delayed or never arrives (some browsers throttle
      // the occluded map canvas behind this dialog, so the zoom never settles and
      // the scale would appear to silently do nothing), force the recapture after
      // a short grace period. GH #743.
      idleFallbackRef.current = window.setTimeout(() => {
        idleFallbackRef.current = null;
        if (idleRecaptureRef.current) {
          map.off("idle", idleRecaptureRef.current);
          idleRecaptureRef.current = null;
          recapture(null);
        }
      }, 1500);
    },
    [
      mapControllerRef,
      captureMode,
      currentRatio,
      prefMaxZoom,
      prefMinZoom,
      recapture,
      t,
      dispatch,
      idleRecaptureRef,
      idleFallbackRef,
    ],
  );

  return { applyScale, scaleFocusedRef };
}
