import { useEffect, useRef, type MutableRefObject } from "react";
import type { GpsTrackSegments } from "../lib/gps-tracking";
import { createGpsWakeLockController, saveGpsTrackCheckpoint } from "../lib/gps-wake-lock";

/**
 * Keep the device screen awake while actively recording a GPS track and
 * checkpoint fixes whenever the page is hidden or unloaded so mobile OS
 * background suspension does not lose an in-progress survey track.
 */
export function useGpsBackgroundRecording(
  recording: "off" | "recording" | "paused",
  fixesRef: MutableRefObject<GpsTrackSegments>,
  onRestoredCount: (count: number) => void,
): void {
  const wakeLockRef = useRef(createGpsWakeLockController());
  const restoredOnceRef = useRef(false);

  useEffect(() => {
    if (restoredOnceRef.current) return;
    restoredOnceRef.current = true;
    const restoredCount = fixesRef.current.reduce((n, seg) => n + seg.length, 0);
    if (restoredCount > 0) onRestoredCount(restoredCount);
  }, [fixesRef, onRestoredCount]);

  useEffect(() => {
    const controller = wakeLockRef.current;
    if (recording === "recording") {
      void controller.start();
    } else {
      void controller.stop();
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        saveGpsTrackCheckpoint(fixesRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void controller.stop();
    };
  }, [recording, fixesRef]);
}
