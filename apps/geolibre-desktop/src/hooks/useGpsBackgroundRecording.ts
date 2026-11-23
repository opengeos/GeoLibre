import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import i18next from "i18next";
import type { GpsTrackSegments } from "../lib/gps-tracking";
import {
  clearGpsTrackCheckpoint,
  createGpsWakeLockController,
  createThrottledCheckpointSaver,
  type GpsWakeLockController,
  type ThrottledCheckpointSaver,
} from "../lib/gps-wake-lock";
import { notify } from "../lib/notify";

/**
 * Keep the device screen awake while actively recording a GPS track, throttle
 * per-fix track checkpoint writes, and flush immediately on `visibilitychange`,
 * `pagehide`, or recording stop so mobile OS suspension does not lose fixes.
 */
export function useGpsBackgroundRecording(
  recording: "off" | "recording" | "paused",
  fixesRef: MutableRefObject<GpsTrackSegments>,
  onRestoredCount: (count: number) => void,
): {
  scheduleCheckpoint: (segments: GpsTrackSegments) => void;
  flushCheckpoint: (segments: GpsTrackSegments) => void;
  clearCheckpoint: () => void;
  reconcileAfterExport: (unchangedSinceExport: boolean) => void;
} {
  const wakeLockRef = useRef<GpsWakeLockController | null>(null);
  const saverRef = useRef<ThrottledCheckpointSaver | null>(null);
  const warnedQuotaRef = useRef(false);
  const restoredOnceRef = useRef(false);
  const checkpointClearedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const getSaver = useCallback((): ThrottledCheckpointSaver => {
    if (!saverRef.current) {
      saverRef.current = createThrottledCheckpointSaver({
        onSaveResult: (ok) => {
          if (!ok && !warnedQuotaRef.current) {
            warnedQuotaRef.current = true;
            notify.warning(i18next.t("gps.checkpointQuotaWarning"), {
              dedupeKey: "gps-checkpoint-quota",
            });
          } else if (ok) {
            warnedQuotaRef.current = false;
          }
        },
      });
    }
    return saverRef.current;
  }, []);

  useEffect(() => {
    if (restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    const restoredCount = fixesRef.current.reduce((n, seg) => n + seg.length, 0);
    if (restoredCount > 0) onRestoredCount(restoredCount);
  }, [fixesRef, onRestoredCount]);

  useEffect(() => {
    if (!wakeLockRef.current) {
      wakeLockRef.current = createGpsWakeLockController();
    }
    const controller = wakeLockRef.current;
    const saver = getSaver();
    if (recording === "recording") {
      void controller.start();
    } else {
      void controller.stop();
      if (!checkpointClearedRef.current && fixesRef.current.some((seg) => seg.length > 0)) {
        saver.flush(fixesRef.current);
      }
    }
    const flushNow = () => {
      if (!checkpointClearedRef.current && fixesRef.current.some((seg) => seg.length > 0)) {
        saver.flush(fixesRef.current);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushNow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushNow);
      flushNow();
      // Cancel any pending trailing timer even when the track is now empty so
      // an earlier queued write cannot fire after unmount or discard.
      saver.reset();
      void controller.stop();
    };
  }, [recording, fixesRef, getSaver]);

  const scheduleCheckpoint = useCallback(
    (segments: GpsTrackSegments) => {
      checkpointClearedRef.current = false;
      getSaver().schedule(segments);
    },
    [getSaver],
  );

  const flushCheckpoint = useCallback(
    (segments: GpsTrackSegments) => {
      checkpointClearedRef.current = false;
      getSaver().flush(segments);
    },
    [getSaver],
  );

  const clearCheckpoint = useCallback(() => {
    checkpointClearedRef.current = true;
    getSaver().reset();
    clearGpsTrackCheckpoint();
  }, [getSaver]);

  // `lineSegments()` only exports segments with >= 2 points; keep or flush the
  // checkpoint if any singleton segment was omitted or new fixes arrived during
  // the async save dialog. Skip once unmounted so a stale save completion can
  // never clear or overwrite a newer dialog instance's shared checkpoint.
  const reconcileAfterExport = useCallback(
    (unchangedSinceExport: boolean) => {
      if (!mountedRef.current) return;
      const segments = fixesRef.current;
      const hasUnexportedFixes = segments.some((seg) => seg.length === 1);
      if (unchangedSinceExport && !hasUnexportedFixes) {
        clearCheckpoint();
      } else if (segments.some((seg) => seg.length > 0)) {
        flushCheckpoint(segments);
      }
    },
    [fixesRef, clearCheckpoint, flushCheckpoint],
  );

  return { scheduleCheckpoint, flushCheckpoint, clearCheckpoint, reconcileAfterExport };
}
