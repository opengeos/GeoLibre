// The standalone Legend GUI control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { LegendGuiControl, LegendGuiControlOptions } from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { getComponentsConstructors, type LegendGuiControlConstructor } from "./constructors";
import {
  type ComponentLegendGuiEntryState,
  type ComponentLegendGuiState,
  type ComponentLegendItem,
  type RestorableLegendGuiControl,
  restoreGuiControlState,
  selectedIndex,
} from "./gui-state";
import { constrainGuiPanelToViewport } from "./shared";

const legendControlPosition: GeoLibreMapControlPosition = "top-left";

const LEGEND_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-legend-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  // Omit maxHeight so the control auto-fits the available viewport height
  // (maplibre-gl-components >= 0.20.6); see COLORBAR_OPTIONS in ./colorbar.ts.
  panelWidth: 320,
  position: legendControlPosition,
} satisfies LegendGuiControlOptions;

export let legendControl: LegendGuiControl | null = null;
let legendControlMounted = false;
export let legendPanelVisible = false;
const legendPanelListeners = new Set<() => void>();

export async function restoreLegendPanel(
  app: GeoLibreAppAPI,
  state: ComponentLegendGuiState,
): Promise<void> {
  const restored = await openStandaloneLegendControl(app);
  if (!restored) return;
  setTimeout(() => {
    if (!legendControl) return;
    const control = legendControl as RestorableLegendGuiControl;
    restoreGuiControlState(control, state);
    if (state.collapsed) control.collapse();
    else control.expand();
    if (state.visible) control.show();
    else control.hide();
    setLegendPanelVisible(state.visible);
  }, 0);
}

export function openLegendPanel(app: GeoLibreAppAPI): void {
  void openStandaloneLegendControl(app);
}

/**
 * Opens the Legend control (creating and mounting it if needed) and fills the
 * currently-selected legend entry with the given title and items, replacing
 * whatever it held (the default placeholder entry on first open). Used to
 * populate a legend from a paletted raster's color table.
 *
 * @param app - The live app API used to mount the control.
 * @param options.title - Legend title (typically the raster layer name).
 * @param options.items - Legend items (color swatch + label) to show.
 * @param options.legendPosition - Map corner for the rendered on-map legend.
 *   Defaults to the control's current position (or bottom-left). The editor
 *   panel itself always docks top-left, so pass a right/other corner to keep
 *   the on-map legend from overlapping it.
 * @param options.signal - Abort signal checked just before the mutation. If the
 *   caller supersedes this call (e.g. the user switches layers) the shared
 *   Legend control is left untouched, not populated with stale data.
 * @returns Whether the control was opened and populated.
 */
export async function openLegendPanelWithItems(
  app: GeoLibreAppAPI,
  options: {
    title: string;
    items: ComponentLegendItem[];
    legendPosition?: GeoLibreMapControlPosition;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const opened = await openStandaloneLegendControl(app);
  if (!opened) return false;
  // openStandaloneLegendControl shows/expands on a 0ms timer; defer past it so
  // the state we set is not clobbered by that deferred show, and so getState()
  // reflects the freshly-created control.
  return await new Promise<boolean>((resolve) => {
    setTimeout(() => {
      if (!legendControl) {
        resolve(false);
        return;
      }
      // A superseded call (the caller aborted after switching away) must not
      // populate the shared control with the previous layer's data. Checked
      // here, inside the deferred timer, because that is the first point after
      // the caller could have aborted.
      if (options.signal?.aborted) {
        resolve(false);
        return;
      }
      // Guard the whole mutation: if the vendor control throws in getState /
      // setState / expand / show, resolve(false) instead of leaving the promise
      // (and the caller's "pending" UI) hanging forever.
      try {
        const control = legendControl as RestorableLegendGuiControl;
        const current = legendControl.getState() as unknown as ComponentLegendGuiState;
        const entry: ComponentLegendGuiEntryState = {
          title: options.title,
          items: options.items,
          legendPosition: options.legendPosition ?? current.legendPosition ?? "bottom-left",
        };
        // Mirror the replacement onto both the top-level fields and the selected
        // slot of the `legends` array so the control's single- and multi-legend
        // views stay consistent (matches how project restore round-trips state).
        // `selectedIndex` clamps a stale index into range so the written-back
        // `selectedLegendIndex` can never point past the array it indexes.
        const baseLegends =
          Array.isArray(current.legends) && current.legends.length > 0 ? current.legends : [entry];
        const index = Math.max(0, selectedIndex(current.selectedLegendIndex, baseLegends.length));
        const legends = baseLegends.map((existing, i) => (i === index ? entry : existing));
        restoreGuiControlState(control, {
          ...current,
          title: entry.title,
          items: entry.items,
          legendPosition: entry.legendPosition,
          hasLegend: true,
          selectedLegendIndex: index,
          legends,
        });
        control.expand();
        control.show();
        setLegendPanelVisible(true);
        // The control was already expanded by openStandaloneLegendControl, so
        // the expand() above is a no-op and its "expand" handler (which fits the
        // panel to the viewport) never re-fires for this now-taller, populated
        // panel. Run the constraint directly so a many-class legend doesn't
        // overflow under the status bar.
        constrainGuiPanelToViewport(".geolibre-legend-control .legend-gui-panel");
        resolve(true);
      } catch {
        resolve(false);
      }
    }, 0);
  });
}

export function closeLegendPanel(app: GeoLibreAppAPI): void {
  teardownLegendControl(app);
}

export function isLegendPanelVisible(): boolean {
  return legendPanelVisible;
}

export function subscribeLegendPanel(listener: () => void): () => void {
  legendPanelListeners.add(listener);
  return () => legendPanelListeners.delete(listener);
}

async function openStandaloneLegendControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { LegendGuiControl: LegendGuiControlClass } = await getComponentsConstructors();

  legendControl ??= createLegendControl(LegendGuiControlClass);

  if (!legendControlMounted) {
    const added = app.addMapControl(legendControl, legendControlPosition);
    if (!added) {
      legendControl = null;
      return false;
    }
    legendControlMounted = true;
  }

  setTimeout(() => {
    legendControl?.show();
    legendControl?.expand();
    setLegendPanelVisible(true);
  }, 0);
  return true;
}

function createLegendControl(LegendGuiControlClass: LegendGuiControlConstructor): LegendGuiControl {
  const control = new LegendGuiControlClass(LEGEND_OPTIONS);
  control.on("expand", () => {
    constrainGuiPanelToViewport(".geolibre-legend-control .legend-gui-panel");
    setLegendPanelVisible(true);
  });
  return control;
}

export function teardownLegendControl(app: GeoLibreAppAPI): void {
  if (legendControl && legendControlMounted) {
    app.removeMapControl(legendControl);
  }
  legendControl = null;
  legendControlMounted = false;
  setLegendPanelVisible(false);
}

function setLegendPanelVisible(visible: boolean): void {
  if (legendPanelVisible === visible) return;
  legendPanelVisible = visible;
  for (const listener of legendPanelListeners) {
    listener();
  }
}
