// The standalone Spinning Globe control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { SpinGlobeControl, SpinGlobeControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type SpinGlobeControlConstructor } from "./constructors";

const spinGlobeControlPosition: GeoLibreMapControlPosition = "top-right";

const SPIN_GLOBE_OPTIONS = {
  // Start expanded so opening the panel from the Controls menu immediately
  // reveals the speed slider and spin toggle rather than a collapsed icon.
  collapsed: false,
  pauseOnInteraction: true,
  speed: 10,
} satisfies SpinGlobeControlOptions;

let spinGlobeControl: SpinGlobeControl | null = null;
let spinGlobeControlMounted = false;
let spinGlobePanelVisible = false;
const spinGlobePanelListeners = new Set<() => void>();

// Standalone Spinning Globe control, toggled from the Controls menu. It mirrors
// the spinGlobe sub-control of the Components plugin's ControlGrid, but lives on
// its own so it can be opened independently from the Controls menu.
export function openSpinGlobePanel(app: GeoLibreAppAPI): void {
  void openStandaloneSpinGlobeControl(app);
}

export function closeSpinGlobePanel(app: GeoLibreAppAPI): void {
  teardownSpinGlobeControl(app);
}

export function isSpinGlobePanelVisible(): boolean {
  return spinGlobePanelVisible;
}

export function subscribeSpinGlobePanel(listener: () => void): () => void {
  spinGlobePanelListeners.add(listener);
  return () => spinGlobePanelListeners.delete(listener);
}

async function openStandaloneSpinGlobeControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { SpinGlobeControl: SpinGlobeControlClass } = await getComponentsConstructors();

  spinGlobeControl ??= createSpinGlobeControl(SpinGlobeControlClass);

  if (!spinGlobeControlMounted) {
    const added = app.addMapControl(spinGlobeControl, spinGlobeControlPosition);
    if (!added) {
      spinGlobeControl = null;
      return false;
    }
    spinGlobeControlMounted = true;
  }

  setTimeout(() => {
    // Bail if a teardown ran between mounting and this deferred tick, so a
    // quick open→close can't flip the menu checkmark back on after the control
    // was removed (matches the guard in openStandaloneMinimapControl).
    if (!spinGlobeControl) return;
    // Expand the settings panel so the speed slider and spin toggle are visible
    // immediately, mirroring how the other Controls-menu panels open expanded.
    spinGlobeControl.expand();
    setSpinGlobePanelVisible(true);
  }, 0);
  return true;
}

function createSpinGlobeControl(
  SpinGlobeControlClass: SpinGlobeControlConstructor,
): SpinGlobeControl {
  return new SpinGlobeControlClass(SPIN_GLOBE_OPTIONS);
}

export function teardownSpinGlobeControl(app: GeoLibreAppAPI): void {
  if (spinGlobeControl && spinGlobeControlMounted) {
    // Stop the rotation before removing so a torn-down control can't keep
    // drifting the map center via a still-running animation frame.
    spinGlobeControl.stopSpin();
    app.removeMapControl(spinGlobeControl);
  }
  spinGlobeControl = null;
  spinGlobeControlMounted = false;
  setSpinGlobePanelVisible(false);
}

function setSpinGlobePanelVisible(visible: boolean): void {
  if (spinGlobePanelVisible === visible) return;
  spinGlobePanelVisible = visible;
  for (const listener of spinGlobePanelListeners) {
    listener();
  }
}
