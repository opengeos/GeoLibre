import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore } from "../packages/core/src";
import {
  closePlanetaryComputerPanel,
  openPlanetaryComputerPanel,
  PLANETARY_COMPUTER_RUNTIME_ID,
  restorePlanetaryComputerLayers,
} from "../packages/plugins/src/plugins/maplibre-planetary-computer";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("Planetary Computer panel descriptor", () => {
  it("uses only the hosted MapEngine lifecycle for open, restore, and close", () => {
    const invocations: Array<{ command: string; input: unknown }> = [];
    const layerId = "planetary-computer-descriptor-test";
    const app = {
      map: {
        invoke: (command: string, input: unknown) => {
          invocations.push({ command, input });
          return true;
        },
      },
    } as unknown as GeoLibreAppAPI;

    useAppStore.getState().addLayer({
      id: layerId,
      name: "Planetary Computer test layer",
      type: "raster",
      source: { type: "raster" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {
        externalNativeLayer: true,
        sourceKind: "planetary-computer-raster",
      },
    });

    try {
      openPlanetaryComputerPanel(app);
      restorePlanetaryComputerLayers(app);
      closePlanetaryComputerPanel(app);

      assert.deepEqual(invocations, [
        {
          command: "hosted-plugin.activate",
          input: {
            pluginId: PLANETARY_COMPUTER_RUNTIME_ID,
            state: { openPanel: true },
          },
        },
        {
          command: "hosted-plugin.activate",
          input: {
            pluginId: PLANETARY_COMPUTER_RUNTIME_ID,
            state: { restoreLayers: true },
          },
        },
        {
          command: "hosted-plugin.deactivate",
          input: { pluginId: PLANETARY_COMPUTER_RUNTIME_ID },
        },
      ]);
    } finally {
      useAppStore.getState().removeLayer(layerId);
    }
  });
});
