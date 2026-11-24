import { act, fireEvent, i18n, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";

const { MapContextMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/MapContextMenu");
const { useCogoTool } = await import("../apps/geolibre-desktop/src/lib/cogo-store");

it("opens COGO from the clicked map coordinate", async () => {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const engine = {
    getRenderSurface: () => ({
      getCanvas: () => canvas,
      unproject: () => ({ lng: -83.92, lat: 35.96 }),
    }),
    getZoom: () => 12,
  };
  useAppStore.setState({ primaryRenderer: "maplibre" });
  const view = render(
    createElement(MapContextMenu, {
      mapControllerRef: { current: engine as never },
      mapReadyGeneration: 0,
    }),
  );
  try {
    fireEvent.contextMenu(canvas, { clientX: 100, clientY: 100 });
    const trigger = await screen.findByRole("menuitem", { name: i18n.t("quickAnalysis.menu") });
    await act(async () => trigger.focus());
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const menu = await screen.findByRole("menu", { name: i18n.t("quickAnalysis.menu") });
    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: i18n.t("quickAnalysis.cogoHere") }),
    );
    assert.equal(useCogoTool.getState().open, true);
    assert.deepEqual(useCogoTool.getState().seed, { lng: -83.92, lat: 35.96 });
  } finally {
    view.unmount();
    canvas.remove();
    act(() => useCogoTool.getState().closeCogo());
  }
});
