import { act, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { MapEngine } from "@geolibre/map";
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
} from "../apps/geolibre-desktop/src/lib/diagnostics";

const { usePluginStateRestore } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/usePluginStateRestore");
const { getPluginManager, createAppAPI } =
  await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { BUILT_IN_PLUGINS } = await import("../packages/plugins/src/builtin-plugins");
const { rendererCapabilities } = await import("@geolibre/map");

for (const outcome of ["superseded", "failed"] as const) {
  it(`${outcome === "superseded" ? "does not diagnose an obsolete" : "diagnoses a failed"} asynchronous effects restore`, async () => {
    const id = "maplibre-atmosphere-effects";
    const manager = getPluginManager();
    const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === id);
    assert.ok(descriptor);
    const engine = {
      kind: "maplibre",
      capabilities: rendererCapabilities("maplibre"),
      getMap: () => null,
    } as unknown as MapEngine;
    const mapControllerRef = { current: engine };
    const app = createAppAPI(mapControllerRef);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.unregister(id, app);
    manager.registerLazy({
      ...descriptor,
      load: async () => {
        await gate;
        if (outcome === "failed") throw new Error("effects import failed");
        return descriptor.load();
      },
    });
    clearDiagnostics();
    const enforceViewerPlugins = () => {};
    const hook = renderHook(() =>
      usePluginStateRestore({
        mapControllerRef,
        externalPluginsReady: true,
        enforceViewerPlugins,
        mapReadyGeneration: 1,
        projectGeneration: useAppStore.getState().projectGeneration,
        projectUrlSettled: true,
      }),
    );
    try {
      const initial = manager.pendingActivation(id);
      if (outcome === "superseded") manager.restoreProjectState(null, app, { mapReplaced: true });
      const replacement = manager.pendingActivation(id);
      await act(async () => {
        release();
        await Promise.allSettled([initial, replacement]);
        await new Promise((resolve) => setImmediate(resolve));
      });
      const errors = getDiagnosticsSnapshot().records.filter(
        (record) =>
          record.source === `plugin:${id}` && record.message.includes("failed to restore"),
      );
      if (outcome === "superseded")
        assert.deepEqual(
          errors.map(({ message }) => message),
          [],
        );
      else assert.ok(errors.some(({ message }) => message.includes("effects import failed")));
    } finally {
      release();
      hook.unmount();
      manager.unregister(id, app);
      manager.registerLazy(descriptor);
    }
  });
}
