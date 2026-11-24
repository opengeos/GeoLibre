import { act, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { renderHook } from "@testing-library/react";

const { useStacUrlLoader } = await import("../apps/geolibre-desktop/src/hooks/useStacUrlLoader");
const { getPluginManager, createAppAPI } =
  await import("../apps/geolibre-desktop/src/hooks/usePlugins");
const { BUILT_IN_PLUGINS } = await import("../packages/plugins/src/builtin-plugins");
const { requestStacCatalogUrl, consumeStacCatalogRequest, cancelStacCatalogRequest } =
  await import("../packages/plugins/src/stac-catalog-request");

it("an obsolete deep-link activation preserves a newer queued SDK catalog request", async () => {
  const id = "geolibre-stac-catalogs";
  const manager = getPluginManager();
  const descriptor = BUILT_IN_PLUGINS.find(({ metadata }) => metadata.id === id);
  assert.ok(descriptor);
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
  window.history.replaceState(
    {},
    "",
    `/?stac=${encodeURIComponent("https://example.com/catalog-A.json")}`,
  );
  const hook = renderHook(() => useStacUrlLoader(app, false));
  try {
    await waitFor(() => assert.ok(manager.pendingActivation(id)));
    const first = manager.pendingActivation(id)!;
    act(() => manager.deactivate(id, app));
    requestStacCatalogUrl("https://example.com/catalog-B.json");
    await act(async () => {
      release();
      await first;
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(consumeStacCatalogRequest(), "https://example.com/catalog-B.json");
  } finally {
    release();
    hook.unmount();
    cancelStacCatalogRequest();
    manager.unregister(id, app);
    manager.registerLazy(descriptor);
    window.history.replaceState({}, "", "/");
  }
});
