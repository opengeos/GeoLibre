// The standalone Minimap control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { MinimapControl, MinimapControlOptions } from "maplibre-gl-components";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibreMinimapOptions,
} from "../../types";
import { getComponentsConstructors, type MinimapControlConstructor } from "./constructors";

const minimapControlPosition: GeoLibreMapControlPosition = "bottom-left";
const minimapOptionKeys = ["zoomOffset", "width", "height"] as const;

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
let minimapRequest = 0;
let minimapOptions = defaultMinimapOptions();
const minimapPanelListeners = new Set<() => void>();

// Standalone Minimap control, toggled from the Controls menu. `collapsed`
// opens (or folds) it to its on-map button (GeoLibre#3241); otherwise an open
// keeps a rebuilt overview's collapsed state and expands a new one.
export function openMinimapPanel(app: GeoLibreAppAPI, options?: GeoLibreMinimapOptions): void {
  const collapsed = options?.collapsed;
  if (collapsed !== undefined && typeof collapsed !== "boolean") {
    throw new Error("Minimap collapsed must be a boolean");
  }
  const next = { ...minimapOptions };
  for (const key of minimapOptionKeys) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (key !== "zoomOffset" && value <= 0)
    ) {
      throw new Error(
        `Minimap ${key} must be a finite ${key === "zoomOffset" ? "number" : "positive number"}`,
      );
    }
    next[key] = value;
  }
  const optionsChanged = minimapOptionKeys.some((key) => next[key] !== minimapOptions[key]);
  if (
    !optionsChanged &&
    collapsed === undefined &&
    (minimapPanelVisible || minimapControlMounted)
  ) {
    return;
  }
  minimapOptions = next;
  void openStandaloneMinimapControl(app, ++minimapRequest, optionsChanged, collapsed);
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

async function openStandaloneMinimapControl(
  app: GeoLibreAppAPI,
  request: number,
  optionsChanged: boolean,
  collapsed: boolean | undefined,
): Promise<boolean> {
  const { MinimapControl: MinimapControlClass } = await getComponentsConstructors();
  if (request !== minimapRequest) return false;

  // Reconfigure in place after loading the constructor. Keep the visibility
  // store and the user's collapsed state steady while replacing the control.
  const wasCollapsed =
    collapsed ?? (optionsChanged && minimapControl?.getState().collapsed === true);
  if (optionsChanged && minimapControl && minimapControlMounted) {
    app.removeMapControl(minimapControl);
    minimapControl = null;
    minimapControlMounted = false;
  }
  minimapControl ??= createMinimapControl(
    MinimapControlClass,
    app.getActiveBasemap(),
    wasCollapsed,
  );

  if (!minimapControlMounted) {
    const added = app.addMapControl(minimapControl, minimapControlPosition);
    if (!added) {
      removeMinimapControl(app);
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

  const control = minimapControl;
  // Apply an explicit request now, not only in the deferred callback: a
  // basemap refresh in between reads this state to rebuild the overview.
  if (collapsed === true) control.collapse();
  else if (collapsed === false) control.expand();
  setTimeout(() => {
    if (request !== minimapRequest || minimapControl !== control) return;
    control.show();
    if (wasCollapsed) control.collapse();
    else control.expand();
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
  minimapControl = createMinimapControl(MinimapControlClass, app.getActiveBasemap(), wasCollapsed);
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

  const control = minimapControl;
  setTimeout(() => {
    if (minimapControl !== control) return;
    control.show();
    if (!wasCollapsed) control.expand();
  }, 0);
}

function createMinimapControl(
  MinimapControlClass: MinimapControlConstructor,
  basemapStyleUrl: string,
  collapsed = false,
): MinimapControl {
  const control = new MinimapControlClass({
    ...MINIMAP_OPTIONS,
    ...minimapOptions,
    collapsed,
    style: basemapStyleUrl,
  });
  return control;
}

export function teardownMinimapControl(app: GeoLibreAppAPI): void {
  ++minimapRequest;
  removeMinimapControl(app);
  minimapOptions = defaultMinimapOptions();
}

function defaultMinimapOptions(): Required<
  Pick<GeoLibreMinimapOptions, (typeof minimapOptionKeys)[number]>
> {
  return {
    zoomOffset: MINIMAP_OPTIONS.zoomOffset,
    width: MINIMAP_OPTIONS.width,
    height: MINIMAP_OPTIONS.height,
  };
}

function removeMinimapControl(app: GeoLibreAppAPI): void {
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
