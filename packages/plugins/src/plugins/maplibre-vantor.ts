import { VantorControl } from "./vantor/control";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { mountMapControlInPanel } from "./dockable-map-control";

export const VANTOR_PLUGIN_ID = "maplibre-gl-vantor";

let control: VantorControl | null = null;
const PANEL_ID = "vantor-panel";
let unregisterPanel: (() => void) | null = null;
let themeObserver: MutationObserver | null = null;
let unsubscribeLocale: (() => void) | null = null;

/** Follow GeoLibre's explicit theme instead of the operating-system preference. */
function hostTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
}

function createControl(app: GeoLibreAppAPI): VantorControl {
  const addCogLayer = app.addCogLayer;
  const getMaplibreGlRaster = app.getMaplibreGlRaster;
  return new VantorControl({
    collapsed: true,
    panelWidth: 380,
    theme: hostTheme(),
    // Use the host renderer so imagery becomes a persistent, native layer in
    // GeoLibre's Layers panel and can use any renderer the host exposes.
    cogAdder: addCogLayer ? (name, url, options) => addCogLayer(name, url, options) : undefined,
    rasterLoader: getMaplibreGlRaster ? () => getMaplibreGlRaster() : undefined,
    cogRenderEngineSetter: app.setCogRenderEngine,
    translate: (key, defaultValue, params) =>
      app.translate?.(key, defaultValue, params) ?? defaultValue,
  });
}

export const maplibreVantorPlugin: GeoLibrePlugin = {
  id: VANTOR_PLUGIN_ID,
  name: "Vantor Open Data",
  version: "0.2.1",
  activate: (app: GeoLibreAppAPI) => {
    control ??= createControl(app);
    const activeControl = control;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "Vantor Open Data",
        dock: "replace-style",
        defaultWidth: 380,
        render: (container) => {
          const unmount = mountMapControlInPanel(app, activeControl, container);
          if (!unmount) return;
          activeControl.expand();
          return unmount;
        },
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);

    unsubscribeLocale ??=
      app.onLocaleChange?.(() =>
        control?.setTranslator(
          (key, defaultValue, params) => app.translate?.(key, defaultValue, params) ?? defaultValue,
        ),
      ) ?? null;

    if (
      !themeObserver &&
      typeof document !== "undefined" &&
      typeof MutationObserver !== "undefined"
    ) {
      themeObserver = new MutationObserver(() => control?.setTheme(hostTheme()));
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  },
  deactivate: (app: GeoLibreAppAPI) => {
    themeObserver?.disconnect();
    themeObserver = null;
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    if (!control) return;
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    control = null;
  },
};
