import { DECK_VIZ_PLUGIN_ID } from "../plugin-ids";
export { DECK_VIZ_PLUGIN_ID } from "../plugin-ids";
import { builtInPluginProperties } from "../builtin-plugin-metadata";
import type { GeoLibrePlugin } from "../types";
import { activateDeckViz, deactivateDeckViz } from "./deckgl-viz/overlay";

/**
 * Renders user-built deck.gl visualizations (created through the Add Data →
 * "Deck.gl Layer" dialog) on a shared deck.gl overlay. The dialog writes
 * `deckgl-viz` layers into the store; this plugin owns the overlay that draws
 * them and keeps it in sync with the store.
 *
 * Like the other `activeByDefault` overlay plugins, its initial activation is
 * driven idempotently from the desktop shell via `restoreDeckViz`, because the
 * plugin manager marks default plugins active without calling activate().
 */
export const maplibreDeckGlVizPlugin: GeoLibrePlugin = {
  ...builtInPluginProperties("maplibre-deckgl-viz"),

  // The overlay binds to `app.getMap()`, `app.getMapboxMap()` or
  // `app.getArcgisView()`, so it stays active across renderer swaps (the
  // plugin manager deactivates plugins that omit the new engine).

  activate: (app) => {
    void activateDeckViz(app);
  },
  deactivate: (app) => {
    deactivateDeckViz(app);
  },
};
