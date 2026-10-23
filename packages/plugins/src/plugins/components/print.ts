// The standalone Print panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { PrintControl, PrintControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type PrintControlConstructor } from "./constructors";
import { resolveDocumentTheme } from "./shared";

const printControlPosition: GeoLibreMapControlPosition = "top-left";

const PRINT_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-print-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 300,
  position: printControlPosition,
  showPageOptions: true,
  showSizeOptions: true,
} satisfies PrintControlOptions;

let printControl: PrintControl | null = null;
let printControlMounted = false;
let printPanelVisible = false;
const printPanelListeners = new Set<() => void>();
let printThemeObserver: MutationObserver | null = null;

// The standalone Print panel exports the map via the maplibre-gl-components
// PrintControl. It is opened on demand from the Project menu.
export function openPrintPanel(app: GeoLibreAppAPI): void {
  void openStandalonePrintControl(app);
}

// Hides the panel but leaves the control mounted on the map (mirrors
// closeSearchPlacesPanel). For full teardown — removing the control and
// stopping the theme observer — use closeMaplibreComponentControls(app) or
// deactivate the plugin.
export function closePrintPanel(): void {
  hidePrintControl();
}

export function isPrintPanelVisible(): boolean {
  return printPanelVisible;
}

export function subscribePrintPanel(listener: () => void): () => void {
  printPanelListeners.add(listener);
  return () => printPanelListeners.delete(listener);
}

async function openStandalonePrintControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { PrintControl: PrintControlClass } = await getComponentsConstructors();

  printControl ??= createPrintControl(PrintControlClass);

  if (!printControlMounted) {
    const added = app.addMapControl(printControl, printControlPosition);
    if (!added) {
      printControl = null;
      return false;
    }
    printControlMounted = true;
    startPrintThemeSync();
  }

  setTimeout(() => {
    // Guard against a teardown that nulled printControl between addMapControl
    // succeeding and this deferred callback firing, which would otherwise mark
    // the panel visible even though the control no longer exists.
    if (!printControl) return;
    printControl.show();
    printControl.expand();
    setPrintPanelVisible(true);
  }, 0);
  return true;
}

function createPrintControl(PrintControlClass: PrintControlConstructor): PrintControl {
  const control = new PrintControlClass({
    ...PRINT_OPTIONS,
    theme: resolveDocumentTheme(),
  });
  // Skip if a teardown has already replaced the module reference with a newer
  // instance, so a late `collapse` from an orphaned control is ignored.
  control.on("collapse", () => {
    if (control === printControl) hidePrintControl();
  });
  return control;
}

/**
 * Keep the PrintControl panel theme in sync with the in-app light/dark toggle
 * by observing the `class` attribute of the document element.
 */
function startPrintThemeSync(): void {
  if (
    printThemeObserver ||
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  // The observer fires on any `class` mutation of <html>, so cache the last
  // applied theme and only call setTheme when the dark/light value flips.
  let lastTheme = resolveDocumentTheme();
  printThemeObserver = new MutationObserver(() => {
    const next = resolveDocumentTheme();
    if (next === lastTheme) return;
    lastTheme = next;
    printControl?.setTheme(next);
  });
  printThemeObserver.observe(document.documentElement, {
    attributeFilter: ["class"],
  });
}

function stopPrintThemeSync(): void {
  printThemeObserver?.disconnect();
  printThemeObserver = null;
}

export function teardownPrintControl(app: GeoLibreAppAPI): void {
  stopPrintThemeSync();
  if (printControl && printControlMounted) {
    app.removeMapControl(printControl);
  }
  printControl = null;
  printControlMounted = false;
  setPrintPanelVisible(false);
}

function hidePrintControl(): void {
  printControl?.hide();
  setPrintPanelVisible(false);
}

function setPrintPanelVisible(visible: boolean): void {
  if (printPanelVisible === visible) return;
  printPanelVisible = visible;
  for (const listener of printPanelListeners) {
    listener();
  }
}
