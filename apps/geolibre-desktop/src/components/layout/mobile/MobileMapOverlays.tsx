import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { useState, type RefObject } from "react";
import { useFieldCrosshairStore } from "../../../lib/field-crosshair";
import { useScreenWakeLock } from "../../../lib/wake-lock";
import { FieldCrosshairOverlay } from "./FieldCrosshairOverlay";
import { MobileGpsHud } from "./MobileGpsHud";
import { TouchSelectionActionBar } from "./TouchSelectionActionBar";

export interface MobileMapOverlaysProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Touch-mode on-map floating overlays (feature selection action bar, live GPS
 * HUD pill, and field crosshair digitizing reticle). Owns the single shared
 * Screen Wake Lock controller so the HUD toggle governs both GPS tracking and
 * crosshair capture.
 */
export function MobileMapOverlays({ mapControllerRef }: MobileMapOverlaysProps) {
  const hasGps = useAppStore((s) => Boolean(s.gpsStatus));
  const crosshairActive = useFieldCrosshairStore((s) => s.active);
  const [keepAwake, setKeepAwake] = useState(true);
  const wakeLock = useScreenWakeLock(keepAwake && (hasGps || crosshairActive));

  const handleToggleKeepAwake = () => {
    // If keep-awake is enabled but the OS rejected or dropped the lock, a tap
    // retries acquisition without flipping the stored preference off.
    if (keepAwake && !wakeLock.active) {
      wakeLock.retry();
      return;
    }
    setKeepAwake((v) => !v);
  };

  return (
    <>
      <TouchSelectionActionBar />
      <MobileGpsHud
        crosshairActive={crosshairActive}
        wakeLockActive={wakeLock.active}
        wakeLockSupported={wakeLock.supported}
        onToggleKeepAwake={handleToggleKeepAwake}
      />
      <FieldCrosshairOverlay mapControllerRef={mapControllerRef} />
    </>
  );
}
