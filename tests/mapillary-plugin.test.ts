import assert from "node:assert/strict";
import test from "node:test";
import {
  MAPILLARY_PLUGIN_ID,
  maplibreMapillaryPlugin,
  setMapillaryLabels,
} from "../packages/plugins/src/plugins/maplibre-mapillary";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

test("Mapillary descriptor sends runtime, floating-panel, and store bridges through MapEngine", () => {
  const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
  const app = {
    registerFloatingPanel: () => () => undefined,
    openFloatingPanel: () => true,
    registerExternalNativeLayer: () => undefined,
    unregisterExternalNativeLayer: () => undefined,
    map: {
      invoke: (command: string, input: Record<string, unknown>) => {
        calls.push({ command, input });
        return command !== "hosted-plugin.deactivate";
      },
    },
  } as unknown as GeoLibreAppAPI;

  assert.equal(maplibreMapillaryPlugin.activate(app), true);
  const activation = calls[0];
  assert.equal(activation.command, "hosted-plugin.activate");
  assert.equal(activation.input.pluginId, MAPILLARY_PLUGIN_ID);
  assert.equal(
    typeof (activation.input.floatingPanelHost as { register?: unknown }).register,
    "function",
  );
  assert.equal(
    typeof (activation.input.externalLayerHost as { register?: unknown }).register,
    "function",
  );

  setMapillaryLabels({ title: "Street imagery" });
  assert.equal(calls[1].command, "hosted-plugin.apply-state");
  assert.equal(maplibreMapillaryPlugin.setMapControlPosition?.(app, "bottom-right"), true);
  assert.equal(calls[2].command, "hosted-plugin.set-position");
  maplibreMapillaryPlugin.deactivate(app);
  assert.equal(calls[3].command, "hosted-plugin.deactivate");
});
