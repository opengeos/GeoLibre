import { VantorControl } from "./vantor/control";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

export const VANTOR_PLUGIN_ID = "maplibre-gl-vantor";

let control: VantorControl | null = null;
let position: GeoLibreMapControlPosition = "top-left";
let themeObserver: MutationObserver | null = null;

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
    collapsed: false,
    panelWidth: 380,
    theme: hostTheme(),
    // Use the host renderer so imagery becomes a persistent, native layer in
    // GeoLibre's Layers panel and can use any renderer the host exposes.
    cogAdder: addCogLayer ? (name, url, options) => addCogLayer(name, url, options) : undefined,
    rasterLoader: getMaplibreGlRaster ? () => getMaplibreGlRaster() : undefined,
  });
}

export const maplibreVantorPlugin: GeoLibrePlugin = {
  id: VANTOR_PLUGIN_ID,
  name: "Vantor Open Data",
  version: "0.2.1",
  activate: (app: GeoLibreAppAPI) => {
    control ??= createControl(app);
    const added = app.addMapControl(control, position);
    if (!added) {
      control = null;
      return false;
    }

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
    if (!control) return;
    app.removeMapControl(control);
    control = null;
  },
  getMapControlPosition: () => position,
  setMapControlPosition: (app: GeoLibreAppAPI, nextPosition: GeoLibreMapControlPosition) => {
    position = nextPosition;
    if (!control) return;
    app.removeMapControl(control);
    const added = app.addMapControl(control, position);
    if (!added) {
      control = null;
      return false;
    }
  },
};
