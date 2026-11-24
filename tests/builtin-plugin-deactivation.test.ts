import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILT_IN_PLUGINS } from "../packages/plugins/src/builtin-plugins";
import { createLazyPlugin } from "../packages/plugins/src/builtin-plugin-lifecycle";
import { maplibreSunPlugin } from "../packages/plugins/src/plugins/maplibre-sun";
import { maplibreRouteAnimationPlugin } from "../packages/plugins/src/plugins/maplibre-route-animation";
import { flightSimulatorPlugin } from "../packages/plugins/src/plugins/flight-simulator";
import { maplibreComponentsPlugin } from "../packages/plugins/src/plugins/maplibre-components";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

const app = {
  getMap: () => null,
  addMapControl: () => true,
  removeMapControl: () => {},
} as unknown as GeoLibreAppAPI;

describe("pending built-in deactivation", () => {
  const cases: Array<{ plugin: GeoLibrePlugin; state: unknown }> = [
    { plugin: maplibreSunPlugin, state: { open: true, speed: 120, playing: true } },
    { plugin: maplibreRouteAnimationPlugin, state: { open: true, speedMps: 120, playing: true } },
    { plugin: flightSimulatorPlugin, state: { open: true, units: "metric", invertPitch: true } },
    {
      plugin: maplibreComponentsPlugin,
      state: { images: [{ id: "logo", url: "https://example.com/logo.png" }] },
    },
  ];
  const defaultCases = [maplibreSunPlugin, maplibreRouteAnimationPlugin, flightSimulatorPlugin].map(
    (plugin) => ({ plugin, state: { open: true } }),
  );

  for (const [index, { plugin, state }] of [...cases, ...defaultCases].entries()) {
    it(`matches ${plugin.id} teardown for fixture ${index} before its implementation resolves`, async () => {
      const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === plugin.id);
      assert.ok(descriptor);
      let finish!: (plugin: GeoLibrePlugin) => void;
      const loading = new Promise<GeoLibrePlugin>((resolve) => {
        finish = resolve;
      });
      const errors: unknown[] = [];
      const lazy = createLazyPlugin(
        { ...descriptor, load: () => loading, peek: () => undefined },
        {
          restoreGeneration: () => 0,
          isRegistered: () => true,
          changed: () => {},
          reportError: (error) => {
            errors.push(error);
          },
        },
      );
      try {
        plugin.applyProjectState?.(app, undefined);
        plugin.applyProjectState?.(app, state);
        const saved = plugin.getProjectState?.();
        assert.notEqual(saved, undefined, "the fixture must exercise persistent state");
        lazy.plugin.applyProjectState?.(app, saved);
        lazy.plugin.deactivate(app);
        plugin.deactivate(app);
        const expected = plugin.getProjectState?.();
        assert.deepEqual(lazy.plugin.getProjectState?.(), expected);
        finish(plugin);
        await lazy.prepare(app);
        assert.deepEqual(plugin.getProjectState?.(), expected);
        assert.deepEqual(errors, []);
      } finally {
        plugin.deactivate(app);
        plugin.applyProjectState?.(app, undefined);
      }
    });
  }
});
