import { act, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { render } from "@testing-library/react";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const { SunPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/DeferredPluginPanels");
const { loadBuiltInPluginModule } = await import("../packages/plugins/src/builtin-plugins");

it("opens the deferred Sun UI with provider state and unmounts it on close", async () => {
  const app = { getMap: () => null } as unknown as GeoLibreAppAPI;
  const view = render(createElement(SunPanel));
  assert.equal(screen.queryByRole("dialog"), null);
  const module = await loadBuiltInPluginModule("sun");
  try {
    await act(async () => {
      module.setSunSettings({ speed: 72 });
      module.openSunPanel(app);
    });
    await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Sun" })));
    assert.equal(module.getSunSettingsSnapshot().speed, 72);
    act(() => module.closeSunPanel(app));
    await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
    assert.equal(module.getSunSettingsSnapshot().speed, 72);
  } finally {
    view.unmount();
    module.closeSunPanel(app);
    module.maplibreSunPlugin.applyProjectState?.(app, undefined);
  }
});
