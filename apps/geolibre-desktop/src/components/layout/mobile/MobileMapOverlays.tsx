import { useAppStore } from "@geolibre/core";
import { useState } from "react";
import { useFieldCrosshairStore } from "../../../lib/field-crosshair";
import { useScreenWakeLock } from "../../../lib/wake-lock";
import { FieldCrosshairOverlay } from "./FieldCrosshairOverlay";
import { MobileGpsHud } from "./MobileGpsHud";
import { TouchSelectionActionBar } from "./TouchSelectionActionBar";

/**
 * Touch-mode on-map floating overlays (feature selection action bar, live GPS
 * HUD pill, and field crosshair digitizing reticle). Owns the single shared
 * Screen Wake Lock controller so the HUD toggle governs both GPS tracking and
 * crosshair capture.
 */
export function MobileMapOverlays() {
  const gpsStatus = useAppStore((s) => s.gpsStatus);
  const crosshairActive = useFieldCrosshairStore((s) => s.active);
  const [keepAwake, setKeepAwake] = useState(true);
  const wakeLock = useScreenWakeLock(keepAwake && (Boolean(gpsStatus) || crosshairActive));

  return (
    <>
      <TouchSelectionActionBar />
      <MobileGpsHud
        keepAwake={keepAwake}
        wakeLockSupported={wakeLock.supported}
        onToggleKeepAwake={() => setKeepAwake((v) => !v)}
      />
      <FieldCrosshairOverlay />
    </>
  );
}
