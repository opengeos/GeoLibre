import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { GpsTrackSegments } from "../lib/gps-tracking";
import {
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
): { scheduleCheckpoint: (segments: GpsTrackSegments) => void } {
  const wakeLockRef = useRef<GpsWakeLockController | null>(null);
  const saverRef = useRef<ThrottledCheckpointSaver | null>(null);
  const warnedQuotaRef = useRef(false);
  const restoredOnceRef = useRef(false);

  const getSaver = useCallback((): ThrottledCheckpointSaver => {
    if (!saverRef.current) {
      saverRef.current = createThrottledCheckpointSaver({
        onSaveResult: (ok) => {
          if (!ok && !warnedQuotaRef.current) {
            warnedQuotaRef.current = true;
            notify.warning(
              "GPS track checkpoint could not be saved to browser storage. Export your track to avoid losing fixes.",
              { dedupeKey: "gps-checkpoint-quota" },
            );
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
      if (fixesRef.current.some((seg) => seg.length > 0)) {
        saver.flush(fixesRef.current);
      }
    }
    const flushNow = () => {
      if (fixesRef.current.some((seg) => seg.length > 0)) {
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
      void controller.stop();
    };
  }, [recording, fixesRef, getSaver]);

  const scheduleCheckpoint = useCallback(
    (segments: GpsTrackSegments) => {
      getSaver().schedule(segments);
    },
    [getSaver],
  );

  return { scheduleCheckpoint };
}
