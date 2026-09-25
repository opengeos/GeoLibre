// The standalone Minimap control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { MinimapControl, MinimapControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type MinimapControlConstructor } from "./constructors";

const minimapControlPosition: GeoLibreMapControlPosition = "bottom-left";

const MINIMAP_OPTIONS = {
  className: "geolibre-minimap-control",
  collapsed: false,
  height: 180,
  interactive: true,
  position: minimapControlPosition,
  width: 250,
  zoomOffset: -4,
} satisfies Omit<MinimapControlOptions, "style">;

let minimapControl: MinimapControl | null = null;
let minimapControlMounted = false;
let minimapBasemapUnsubscribe: (() => void) | null = null;
let minimapPanelVisible = false;
const minimapPanelListeners = new Set<() => void>();

// Standalone Minimap control, toggled from the Controls menu.
export function openMinimapPanel(app: GeoLibreAppAPI): void {
  void openStandaloneMinimapControl(app);
}

export function closeMinimapPanel(app: GeoLibreAppAPI): void {
  teardownMinimapControl(app);
}

export function isMinimapPanelVisible(): boolean {
  return minimapPanelVisible;
}

export function subscribeMinimapPanel(listener: () => void): () => void {
  minimapPanelListeners.add(listener);
  return () => minimapPanelListeners.delete(listener);
}

async function openStandaloneMinimapControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { MinimapControl: MinimapControlClass } = await getComponentsConstructors();

  minimapControl ??= createMinimapControl(MinimapControlClass, app.getActiveBasemap());

  if (!minimapControlMounted) {
    const added = app.addMapControl(minimapControl, minimapControlPosition);
    if (!added) {
      minimapControl = null;
      return false;
    }
    minimapControlMounted = true;
    // MinimapControl has no setStyle method and is reused across reopens, so
    // recreate it whenever the active basemap changes to avoid showing a stale
    // style for the rest of the session.
    minimapBasemapUnsubscribe ??= app.onBasemapChange(() => {
      void refreshMinimapBasemap(app);
    });
  }

  setTimeout(() => {
    if (!minimapControl) return;
    minimapControl.show();
    minimapControl.expand();
    setMinimapPanelVisible(true);
  }, 0);
  return true;
}

// Swap the mounted minimap for a fresh instance built with the current
// basemap. MinimapControl bakes the style in at construction and exposes no
// style setter, so a rebuild is the only way to follow a basemap change.
async function refreshMinimapBasemap(app: GeoLibreAppAPI): Promise<void> {
  if (!minimapControl || !minimapControlMounted) return;
  const controlAtStart = minimapControl;
  const { MinimapControl: MinimapControlClass } = await getComponentsConstructors();
  // Bail out if a concurrent refresh already rebuilt the control or a teardown
  // ran while awaiting; otherwise rapid basemap switches could double-remove
  // the just-added control and leave two minimap instances on the map.
  if (!minimapControl || !minimapControlMounted || minimapControl !== controlAtStart) {
    return;
  }

  // Preserve the user's panel state across the rebuild: a basemap change must
  // not re-open a minimap the user had collapsed to its on-map icon.
  const wasCollapsed = minimapControl.getState().collapsed;

  app.removeMapControl(minimapControl);
  minimapControl = createMinimapControl(MinimapControlClass, app.getActiveBasemap());
  const added = app.addMapControl(minimapControl, minimapControlPosition);
  if (!added) {
    // Also drop the basemap subscription: minimapControlMounted is now false,
    // so without nulling the unsubscribe the `??=` in openStandaloneMinimapControl
    // would never re-subscribe on a later reopen, silently disabling refresh.
    minimapBasemapUnsubscribe?.();
    minimapBasemapUnsubscribe = null;
    minimapControl = null;
    minimapControlMounted = false;
    setMinimapPanelVisible(false);
    return;
  }

  setTimeout(() => {
    if (!minimapControl) return;
    minimapControl.show();
    if (!wasCollapsed) minimapControl.expand();
  }, 0);
}

function createMinimapControl(
  MinimapControlClass: MinimapControlConstructor,
  basemapStyleUrl: string,
): MinimapControl {
  const control = new MinimapControlClass({
    ...MINIMAP_OPTIONS,
    style: basemapStyleUrl,
  });
  return control;
}

export function teardownMinimapControl(app: GeoLibreAppAPI): void {
  minimapBasemapUnsubscribe?.();
  minimapBasemapUnsubscribe = null;
  if (minimapControl && minimapControlMounted) {
    app.removeMapControl(minimapControl);
  }
  minimapControl = null;
  minimapControlMounted = false;
  setMinimapPanelVisible(false);
}

function setMinimapPanelVisible(visible: boolean): void {
  if (minimapPanelVisible === visible) return;
  minimapPanelVisible = visible;
  for (const listener of minimapPanelListeners) {
    listener();
  }
}
