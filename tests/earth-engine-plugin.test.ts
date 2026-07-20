import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  closeEarthEnginePanel,
  EARTH_ENGINE_RUNTIME_ID,
  isEarthEnginePanelVisible,
  openEarthEnginePanel,
  subscribeEarthEnginePanel,
  toggleEarthEnginePanel,
} from "../packages/plugins/src/plugins/maplibre-earth-engine";

describe("Earth Engine panel descriptor", () => {
  it("uses hosted lifecycle and a typed hide command without a native control", () => {
    const invocations: Array<{ command: string; input: unknown }> = [];
    let reportState: ((state: unknown) => void) | undefined;
    const app = {
      map: {
        invoke: (command: string, input: unknown) => {
          invocations.push({ command, input });
          if (command === "hosted-plugin.activate") {
            reportState = (input as { onStateChange?: (state: unknown) => void }).onStateChange;
          }
          return true;
        },
      },
    } as unknown as GeoLibreAppAPI;

    const unsubscribe = subscribeEarthEnginePanel(() => {});
    try {
      openEarthEnginePanel(app);
      reportState?.({ visible: true });
      assert.equal(isEarthEnginePanelVisible(), true);

      toggleEarthEnginePanel(app);
      assert.equal(isEarthEnginePanelVisible(), false);
      closeEarthEnginePanel(app);

      assert.deepEqual(
        invocations.map(({ command }) => command),
        ["hosted-plugin.activate", "earth-engine.hide", "hosted-plugin.deactivate"],
      );
      assert.equal(
        (invocations[0].input as { pluginId: string }).pluginId,
        EARTH_ENGINE_RUNTIME_ID,
      );
    } finally {
      unsubscribe();
      closeEarthEnginePanel(app);
    }
  });
});
