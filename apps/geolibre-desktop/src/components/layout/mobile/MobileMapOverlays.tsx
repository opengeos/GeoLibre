import { FieldCrosshairOverlay } from "./FieldCrosshairOverlay";
import { MobileGpsHud } from "./MobileGpsHud";
import { TouchSelectionActionBar } from "./TouchSelectionActionBar";

/**
 * Touch-mode on-map floating overlays (feature selection action bar, live GPS
 * HUD pill, and field crosshair digitizing reticle).
 */
export function MobileMapOverlays() {
  return (
    <>
      <TouchSelectionActionBar />
      <MobileGpsHud />
      <FieldCrosshairOverlay />
    </>
  );
}
