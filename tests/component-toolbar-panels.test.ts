import { act, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderHook } from "@testing-library/react";

const { useToolbarPanels } = await import("../apps/geolibre-desktop/src/hooks/useToolbarPanels");
const { getPluginManager, createAppAPI } =
  await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { BUILT_IN_PLUGINS } = await import("../packages/plugins/src/builtin-plugins");
const { maplibreSunPlugin, closeSunPanel, isSunPanelVisible, subscribeSunPanel } =
  await import("../packages/plugins/src/plugins/maplibre-sun");

it("applies two queued panel toggles to live visibility after the first import resolves", async () => {
  const app = createAppAPI({ current: null });
  const manager = getPluginManager();
  const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === "geolibre-sun");
  assert.ok(descriptor);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  manager.unregister("geolibre-sun", app);
  manager.registerLazy({
    ...descriptor,
    peek: () => undefined,
    load: async () => {
      await pending;
      return maplibreSunPlugin;
    },
  });
  const transitions: boolean[] = [];
  const unsubscribe = subscribeSunPanel(() => transitions.push(isSunPanelVisible()));
  const hook = renderHook(() => useToolbarPanels(app));
  try {
    act(() => {
      hook.result.current.sun.toggle();
      hook.result.current.sun.toggle();
    });
    assert.equal(isSunPanelVisible(), false);
    await act(async () => {
      release();
      await manager.preparePlugin("geolibre-sun", app);
    });
    await waitFor(() => assert.deepEqual(transitions, [true, false]));
    assert.equal(hook.result.current.sun.visible, false);
  } finally {
    hook.unmount();
    unsubscribe();
    closeSunPanel(app);
    manager.unregister("geolibre-sun", app);
    manager.registerLazy(descriptor);
  }
});

for (const outcome of ["superseded", "failed"] as const) {
  it(`${outcome === "superseded" ? "does not diagnose an obsolete" : "diagnoses a failed"} toolbar panel request`, async () => {
    const id = "geolibre-sun";
    const app = createAppAPI({ current: null });
    const manager = getPluginManager();
    const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === id);
    assert.ok(descriptor);
    const { clearDiagnostics, getDiagnosticsSnapshot } =
      await import("../apps/geolibre-desktop/src/lib/diagnostics");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.unregister(id, app);
    manager.registerLazy({
      ...descriptor,
      peek: () => undefined,
      load: async () => {
        await pending;
        if (outcome === "failed") throw new Error("sun panel import failed");
        return maplibreSunPlugin;
      },
    });
    clearDiagnostics();
    const hook = renderHook(() => useToolbarPanels(app));
    try {
      act(() => hook.result.current.sun.toggle());
      if (outcome === "superseded") manager.restoreProjectState(null, app, { mapReplaced: true });
      await act(async () => {
        release();
        await new Promise((resolve) => setImmediate(resolve));
      });
      const failures = getDiagnosticsSnapshot().records.filter(
        (record) => record.source === `plugin:${id}` && record.message.includes("update-panel"),
      );
      if (outcome === "superseded") {
        assert.equal(isSunPanelVisible(), false);
        assert.deepEqual(failures, []);
      } else {
        assert.ok(failures.some(({ message }) => message.includes("sun panel import failed")));
      }
    } finally {
      release();
      hook.unmount();
      closeSunPanel(app);
      manager.unregister(id, app);
      manager.registerLazy(descriptor);
    }
  });
}
