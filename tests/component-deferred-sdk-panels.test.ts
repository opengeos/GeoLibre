import { act, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { render } from "@testing-library/react";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const { SunPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/DeferredPluginPanels");

it("observes the existing public Sun helper even when the SDK imports its implementation directly", async () => {
  const app = { getMap: () => null } as unknown as GeoLibreAppAPI;
  const view = render(createElement(SunPanel));
  const native = await import("../packages/plugins/src/plugins/maplibre-sun");
  try {
    await act(async () => native.openSunPanel(app));
    await waitFor(() => assert.ok(screen.getByRole("dialog", { name: "Sun" })));
    act(() => native.closeSunPanel(app));
    assert.equal(screen.queryByRole("dialog"), null);
  } finally {
    view.unmount();
    native.closeSunPanel(app);
  }
});
