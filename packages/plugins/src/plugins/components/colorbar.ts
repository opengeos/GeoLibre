// The standalone Colorbar GUI control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { ColorbarGuiControl, ColorbarGuiControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { type ColorbarGuiControlConstructor, getComponentsConstructors } from "./constructors";
import {
  type ComponentColorbarGuiState,
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
  control.on("expand", () => {
    constrainGuiPanelToViewport(".geolibre-colorbar-control .colorbar-gui-panel");
    setColorbarPanelVisible(true);
  });
  return control;
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
