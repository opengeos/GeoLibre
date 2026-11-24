import { act, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderHook } from "@testing-library/react";
import { DEFAULT_EFFECTS_SETTINGS } from "../packages/plugins/src/effects-settings";

const { usePluginRegistry, getPluginManager, createAppAPI } =
  await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { BUILT_IN_PLUGINS } = await import("../packages/plugins/src/builtin-plugins");

it("previews pending effects immediately and preserves the latest appearance through loading and commit", async () => {
  const id = "maplibre-atmosphere-effects";
  const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === id);
  assert.ok(descriptor);
  const manager = getPluginManager();
  const app = createAppAPI({ current: null });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  manager.unregister(id, app);
  manager.registerLazy({
    ...descriptor,
    load: async () => {
      await gate;
      return descriptor.load();
    },
  });
  const original = { ...DEFAULT_EFFECTS_SETTINGS, spaceColor: "#112233" };
  const state = {
    manifestUrls: [],
    activePluginIds: [],
    mapControlPositions: {},
    settings: { [id]: original },
  };
  useAppStore.getState().setProjectPlugins(state, false);
  manager.restoreProjectState(state, app);
  const hook = renderHook(() => usePluginRegistry());
  try {
    assert.equal(hook.result.current.getEffectsSettings().spaceColor, "#112233");
    act(() => hook.result.current.previewEffectsSettings({ haloColor: "#ff0000" }));
    assert.equal(hook.result.current.getEffectsSettings().haloColor, "#ff0000");
    assert.equal(hook.result.current.getEffectsSettings().spaceColor, "#112233");
    act(() => hook.result.current.commitEffectsSettings());
    assert.equal(
      (useAppStore.getState().projectPlugins?.settings[id] as typeof original).haloColor,
      "#ff0000",
    );
    await act(async () => {
      release();
      await manager.preparePlugin(id, app);
    });
    const native = await descriptor.load();
    assert.equal((native.getProjectState?.() as typeof original).haloColor, "#ff0000");
    act(() => {
      hook.result.current.previewEffectsSettings(DEFAULT_EFFECTS_SETTINGS);
      hook.result.current.commitEffectsSettings();
    });
    assert.equal(manager.getProjectState().settings[id], undefined);
    assert.equal(useAppStore.getState().projectPlugins?.settings[id], undefined);
  } finally {
    release();
    hook.unmount();
    manager.unregister(id, app);
    manager.registerLazy(descriptor);
  }
});
