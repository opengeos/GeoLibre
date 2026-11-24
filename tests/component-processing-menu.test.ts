import { act, fireEvent, render, screen, useAppStore, waitFor, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { NetworkToolKind } from "@geolibre/core";

const { ProcessingMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ProcessingMenu");
const noop = () => {};

/** Open the real menu with the same callback boundary as the desktop toolbar. */
function renderMenu(onOpenNetworkTool: (kind: NetworkToolKind) => void = noop) {
  render(
    createElement(ProcessingMenu, {
      chrome: {
        buttonClass: "",
        buttonSize: "sm",
        iconClassName: "",
        renderLabel: (label: string) => label,
      },
      commands: [],
      earthEnginePanel: { visible: false, toggle: noop },
      open: true,
      onOpenChange: noop,
      onOpenNetworkTool,
      onOpenPlanetaryComputer: noop,
      onOpenGeoreferencer: noop,
    }),
  );
}

/** Expand nested menu groups through their keyboard interaction. */
async function openGroup(name: string) {
  await waitFor(() =>
    assert.ok(
      document.activeElement === screen.getByRole("combobox", { name: "Search processing tools" }),
    ),
  );
  const parent = screen.getByRole("menuitem", { name: "GeoLibre toolbox" });
  await act(async () => parent.focus());
  fireEvent.keyDown(parent, { key: "ArrowRight" });
  const parentMenu = await screen.findByRole("menu", { name: "GeoLibre toolbox" });
  const child = within(parentMenu).getByRole("menuitem", { name });
  await act(async () => child.focus());
  fireEvent.keyDown(child, { key: "ArrowRight" });
  return screen.findByRole("menu", { name });
}

describe("Processing menu model and routing entries", () => {
  for (const [id, label] of [
    ["ols-regression", "Ordinary least squares (OLS)"],
    ["gwr", "Geographically weighted regression (GWR)"],
    ["dbscan", "DBSCAN clustering"],
    ["hdbscan", "HDBSCAN clustering"],
    ["kriging-diagnostics", "Kriging variogram and cross-validation"],
  ] as const) {
    it(`opens the ${id} model instead of a different statistics tool`, async () => {
      renderMenu();
      const menu = await openGroup("Spatial statistics");
      fireEvent.click(await within(menu).findByRole("menuitem", { name: label }));
      assert.equal(useAppStore.getState().ui.statisticsToolOpen, id);
    });
  }

  for (const [id, label] of [
    ["local-shortest-path", "Shortest path (local network)"],
    ["local-closest-facility", "Closest facility (local network)"],
    ["local-service-area", "Service area (local network)"],
  ] as const) {
    it(`dispatches ${id} through the toolbar routing gate`, async () => {
      const calls: NetworkToolKind[] = [];
      renderMenu((kind) => calls.push(kind));
      const menu = await openGroup("Network");
      fireEvent.click(await within(menu).findByRole("menuitem", { name: label }));
      assert.deepEqual(calls, [id]);
      assert.equal(useAppStore.getState().ui.statisticsToolOpen, null);
    });
  }
});
