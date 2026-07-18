import type { GeoLibrePlugin } from "../types";
import { activateDeckViz, deactivateDeckViz } from "./deckgl-viz/overlay";

export const DECK_VIZ_PLUGIN_ID = "maplibre-deckgl-viz";

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
  id: DECK_VIZ_PLUGIN_ID,
  name: "Deck.gl Layer",
  version: "0.1.0",
  activeByDefault: true,
  activate: (app) => {
    void activateDeckViz(app);
  },
  deactivate: (app) => {
    deactivateDeckViz(app);
  },
};
