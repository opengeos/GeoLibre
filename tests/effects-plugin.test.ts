import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EFFECTS_SETTINGS,
  EFFECTS_PLUGIN_ID,
  maplibreEffectsPlugin,
  setEffectsSettings,
} from "../packages/plugins/src/plugins/maplibre-effects";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("Atmospheric Effects descriptor", () => {
  it("activates, updates, and tears down only through the hosted MapEngine lifecycle", () => {
    const invocations: Array<{ command: string; input: unknown }> = [];
    const app = {
      map: {
        invoke: (command: string, input: unknown) => {
          invocations.push({ command, input });
          return true;
        },
      },
    } as unknown as GeoLibreAppAPI;

    maplibreEffectsPlugin.activate(app);
    setEffectsSettings({ haloOpacity: 0.25 });
    maplibreEffectsPlugin.deactivate(app);
    setEffectsSettings(DEFAULT_EFFECTS_SETTINGS);

    assert.deepEqual(invocations, [
      {
        command: "hosted-plugin.activate",
        input: { pluginId: EFFECTS_PLUGIN_ID, state: DEFAULT_EFFECTS_SETTINGS },
      },
      {
        command: "hosted-plugin.apply-state",
        input: {
          pluginId: EFFECTS_PLUGIN_ID,
          state: { ...DEFAULT_EFFECTS_SETTINGS, haloOpacity: 0.25 },
        },
      },
      {
        command: "hosted-plugin.deactivate",
        input: { pluginId: EFFECTS_PLUGIN_ID },
      },
    ]);
  });
});
