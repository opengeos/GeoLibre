// The standalone Colorbar GUI control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { ColorbarGuiControl, ColorbarGuiControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { type ColorbarGuiControlConstructor, getComponentsConstructors } from "./constructors";
import {
  type ComponentColorbarGuiState,
  normalizeColorbarState,
  type RestorableColorbarGuiControl,
  restoreGuiControlState,
} from "./gui-state";
import { constrainGuiPanelToViewport } from "./shared";

const colorbarControlPosition: GeoLibreMapControlPosition = "top-left";

const COLORBAR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-colorbar-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  // Omit maxHeight so the control auto-fits the available viewport height
  // (maplibre-gl-components >= 0.20.6). A fixed cap forced an unnecessary
  // scrollbar even on tall screens, because the panel starts expanded and so
  // never fires the "expand" event that constrainGuiPanelToViewport hooks.
  panelWidth: 320,
  position: colorbarControlPosition,
} satisfies ColorbarGuiControlOptions;

export let colorbarControl: ColorbarGuiControl | null = null;
let colorbarControlMounted = false;
export let colorbarPanelVisible = false;
const colorbarPanelListeners = new Set<() => void>();

export async function restoreColorbarPanel(
  app: GeoLibreAppAPI,
  state: ComponentColorbarGuiState,
): Promise<void> {
  const restored = await openStandaloneColorbarControl(app);
  if (!restored) return;
  setTimeout(() => {
    if (!colorbarControl) return;
    const control = colorbarControl as RestorableColorbarGuiControl;
    restoreGuiControlState(control, state);
    if (state.collapsed) control.collapse();
    else control.expand();
    if (state.visible) control.show();
    else control.hide();
    setColorbarPanelVisible(state.visible);
  }, 0);
}

/** A colorbar another plugin asks the Colorbar control to show. */
export interface ColorbarRequest {
  /** A named colormap of the control, or the colors of a custom ramp (low to high). */
  colormap: string | string[];
  /** Value at the low end of the ramp. */
  vmin: number;
  /** Value at the high end of the ramp. */
  vmax: number;
  /** Caption, typically the layer or index name. */
  label: string;
  /** Units shown after the tick values. */
  units?: string;
}

/**
 * Adds a colorbar to the map through the Controls → Colorbar panel, opening
 * the panel when it is closed and keeping the colorbars already on it.
 *
 * A colorbar with the same label replaces the earlier one, so restyling a layer
 * and asking again updates its colorbar instead of stacking duplicates.
 *
 * @param app - The GeoLibre app API.
 * @param request - The ramp, its value range, and its caption.
 */
export async function showColorbar(app: GeoLibreAppAPI, request: ColorbarRequest): Promise<void> {
  const current = normalizeColorbarState(
    colorbarControl && colorbarPanelVisible ? colorbarControl.getState() : undefined,
  );
  const custom = Array.isArray(request.colormap);
  const entry = {
    mode: custom ? ("custom" as const) : ("named" as const),
    ...(custom
      ? { customColors: (request.colormap as string[]).join(", ") }
      : { colormap: request.colormap as string }),
    vmin: request.vmin,
    vmax: request.vmax,
    label: request.label,
    units: request.units ?? "",
    orientation: "horizontal" as const,
  };
  const kept = (current?.colorbars ?? []).filter((colorbar) => colorbar.label !== request.label);
  const state = normalizeColorbarState({
    ...current,
    ...entry,
    colorbars: [...kept, entry],
    selectedColorbarIndex: kept.length,
    visible: true,
    collapsed: true,
  });
  if (state) await restoreColorbarPanel(app, state);
}

export function openColorbarPanel(app: GeoLibreAppAPI): void {
  void openStandaloneColorbarControl(app);
}

export function closeColorbarPanel(app: GeoLibreAppAPI): void {
  teardownColorbarControl(app);
}

export function isColorbarPanelVisible(): boolean {
  return colorbarPanelVisible;
}

export function subscribeColorbarPanel(listener: () => void): () => void {
  colorbarPanelListeners.add(listener);
  return () => colorbarPanelListeners.delete(listener);
}

async function openStandaloneColorbarControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { ColorbarGuiControl: ColorbarGuiControlClass } = await getComponentsConstructors();

  colorbarControl ??= createColorbarControl(ColorbarGuiControlClass);

  if (!colorbarControlMounted) {
    const added = app.addMapControl(colorbarControl, colorbarControlPosition);
    if (!added) {
      colorbarControl = null;
      return false;
    }
    colorbarControlMounted = true;
  }

  setTimeout(() => {
    colorbarControl?.show();
    // expand() fires the "expand" handler, which applies the viewport
    // constraint, so no separate constrainGuiPanelToViewport call is needed.
    colorbarControl?.expand();
    setColorbarPanelVisible(true);
  }, 0);
  return true;
}

function createColorbarControl(
  ColorbarGuiControlClass: ColorbarGuiControlConstructor,
): ColorbarGuiControl {
  const control = new ColorbarGuiControlClass(COLORBAR_OPTIONS);
  themeColorbarControlOutputs(control);
  control.on("expand", () => {
    constrainGuiPanelToViewport(".geolibre-colorbar-control .colorbar-gui-panel");
    setColorbarPanelVisible(true);
  });
  return control;
}

/** Apply theme defaults only to outputs managed by this GUI, including grid children. */
export function themeColorbarControlOutputs(control: ColorbarGuiControl): void {
  // ColorbarGuiControl 0.31.1 creates and updates one output Colorbar per map
  // corner in a private sync method. Style every GUI-created output through its
  // public update API after each sync, without touching the color ramp.
  type ThemedColorbarOutput = {
    update(options: { backgroundColor: string; fontColor: string }): void;
  };
  const guiControl = control as unknown as {
    _positionControls: Map<GeoLibreMapControlPosition, ThemedColorbarOutput>;
    _syncPositionControl: (position: GeoLibreMapControlPosition) => void;
  };
  const syncPositionControl = guiControl._syncPositionControl;
  guiControl._syncPositionControl = (position) => {
    syncPositionControl.call(guiControl, position);
    guiControl._positionControls.get(position)?.update({
      backgroundColor: "var(--geolibre-bg)",
      fontColor: "var(--geolibre-fg)",
    });
  };
}

export function teardownColorbarControl(app: GeoLibreAppAPI): void {
  if (colorbarControl && colorbarControlMounted) {
    app.removeMapControl(colorbarControl);
  }
  colorbarControl = null;
  colorbarControlMounted = false;
  setColorbarPanelVisible(false);
}

function setColorbarPanelVisible(visible: boolean): void {
  if (colorbarPanelVisible === visible) return;
  colorbarPanelVisible = visible;
  for (const listener of colorbarPanelListeners) {
    listener();
  }
}
