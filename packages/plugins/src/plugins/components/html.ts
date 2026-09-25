// The standalone HTML GUI control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { HtmlGuiControl, HtmlGuiControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type HtmlGuiControlConstructor } from "./constructors";
import {
  type ComponentHtmlGuiState,
  type RestorableHtmlGuiControl,
  restoreGuiControlState,
} from "./gui-state";
import { constrainGuiPanelToViewport } from "./shared";

const htmlControlPosition: GeoLibreMapControlPosition = "top-left";

const HTML_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-html-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  // Omit maxHeight so the control auto-fits the available viewport height
  // (HtmlGuiControl gained this in maplibre-gl-components >= 0.22.8); see
  // COLORBAR_OPTIONS in ./colorbar.ts for the full rationale.
  panelWidth: 340,
  position: htmlControlPosition,
} satisfies HtmlGuiControlOptions;

export let htmlControl: HtmlGuiControl | null = null;
let htmlControlMounted = false;
export let htmlPanelVisible = false;
const htmlPanelListeners = new Set<() => void>();

export async function restoreHtmlPanel(
  app: GeoLibreAppAPI,
  state: ComponentHtmlGuiState,
): Promise<void> {
  const restored = await openStandaloneHtmlControl(app);
  if (!restored) return;
  setTimeout(() => {
    if (!htmlControl) return;
    const control = htmlControl as RestorableHtmlGuiControl;
    restoreGuiControlState(control, state);
    if (state.collapsed) control.collapse();
    else control.expand();
    if (state.visible) control.show();
    else control.hide();
    setHtmlPanelVisible(state.visible);
  }, 0);
}

export function openHtmlPanel(app: GeoLibreAppAPI): void {
  void openStandaloneHtmlControl(app);
}

export function closeHtmlPanel(app: GeoLibreAppAPI): void {
  teardownHtmlControl(app);
}

export function isHtmlPanelVisible(): boolean {
  return htmlPanelVisible;
}

export function subscribeHtmlPanel(listener: () => void): () => void {
  htmlPanelListeners.add(listener);
  return () => htmlPanelListeners.delete(listener);
}

async function openStandaloneHtmlControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { HtmlGuiControl: HtmlGuiControlClass } = await getComponentsConstructors();

  htmlControl ??= createHtmlControl(HtmlGuiControlClass);

  if (!htmlControlMounted) {
    const added = app.addMapControl(htmlControl, htmlControlPosition);
    if (!added) {
      htmlControl = null;
      return false;
    }
    htmlControlMounted = true;
  }

  setTimeout(() => {
    htmlControl?.show();
    htmlControl?.expand();
    setHtmlPanelVisible(true);
  }, 0);
  return true;
}

function createHtmlControl(HtmlGuiControlClass: HtmlGuiControlConstructor): HtmlGuiControl {
  const control = new HtmlGuiControlClass(HTML_OPTIONS);
  control.on("expand", () => {
    constrainGuiPanelToViewport(".geolibre-html-control .html-gui-panel");
    setHtmlPanelVisible(true);
  });
  return control;
}

export function teardownHtmlControl(app: GeoLibreAppAPI): void {
  if (htmlControl && htmlControlMounted) {
    app.removeMapControl(htmlControl);
  }
  htmlControl = null;
  htmlControlMounted = false;
  setHtmlPanelVisible(false);
}

function setHtmlPanelVisible(visible: boolean): void {
  if (htmlPanelVisible === visible) return;
  htmlPanelVisible = visible;
  for (const listener of htmlPanelListeners) {
    listener();
  }
}
