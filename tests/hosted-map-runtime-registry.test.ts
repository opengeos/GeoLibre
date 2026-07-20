import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMapLibreHostedRuntimeRegistry } from "../packages/map/src/maplibre-runtime/registry";
import { restoreHostedControlPanel } from "../packages/map/src/maplibre-runtime/types";
import { createHostedMapPlugin } from "../packages/plugins/src/hosted-map-plugin";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import type { MapEngineClient } from "../packages/map/src/engine/types";

describe("MapLibre hosted runtime registry", () => {
  it("honors project restore collapse instead of scheduling an auto-expand", () => {
    const calls: string[] = [];
    const control = {
      collapse: () => calls.push("collapse"),
      expand: () => calls.push("expand"),
    };
    restoreHostedControlPanel(control, true);
    assert.deepEqual(calls, ["collapse"]);
  });

  it("loads a runtime only on activation and retains it for lifecycle commands", async () => {
    const calls: string[] = [];
    let loads = 0;
    const registry = createMapLibreHostedRuntimeRegistry({} as MapEngineClient, {
      control: async () => {
        loads += 1;
        return {
          activate: (_context, input) => {
            calls.push(`activate:${input.position}`);
            return true;
          },
          setPosition: (_context, position) => {
            calls.push(`position:${position}`);
            return true;
          },
          deactivate: () => calls.push("deactivate"),
        };
      },
    });

    assert.equal(loads, 0);
    assert.equal(await registry.activate("control", { position: "bottom-left" }), true);
    assert.equal(loads, 1);
    assert.equal(registry.setPosition("control", "top-right"), true);
    registry.deactivate("control");
    assert.deepEqual(calls, ["activate:bottom-left", "position:top-right", "deactivate"]);
  });

  it("surfaces a dynamic-import failure to PluginManager activation rollback", async () => {
    const registry = createMapLibreHostedRuntimeRegistry({} as MapEngineClient, {
      unavailable: async () => Promise.reject(new Error("chunk unavailable")),
    });
    await assert.rejects(() => registry.activate("unavailable", {}), /chunk unavailable/);
  });
});

describe("hosted map plugin descriptor", () => {
  it("sends lifecycle and position commands only through MapEngineClient", () => {
    const calls: Array<{ command: string; input: unknown }> = [];
    const app = {
      map: {
        invoke: (command: string, input: unknown) => {
          calls.push({ command, input });
          return command === "hosted-plugin.activate" || command === "hosted-plugin.set-position";
        },
      } as unknown as MapEngineClient,
    } as GeoLibreAppAPI;
    const plugin = createHostedMapPlugin({
      id: "control",
      name: "Control",
      version: "1.0.0",
      initialPosition: "top-left",
    });

    assert.equal(plugin.activate(app, { collapsed: true }), true);
    assert.equal(plugin.setMapControlPosition?.(app, "bottom-right"), true);
    plugin.deactivate(app);
    assert.deepEqual(calls, [
      {
        command: "hosted-plugin.activate",
        input: { pluginId: "control", position: "top-left", collapsed: true },
      },
      {
        command: "hosted-plugin.set-position",
        input: { pluginId: "control", position: "bottom-right" },
      },
      { command: "hosted-plugin.deactivate", input: { pluginId: "control" } },
    ]);
  });
});
