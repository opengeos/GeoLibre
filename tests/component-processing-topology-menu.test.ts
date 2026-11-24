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

describe("Processing menu topology entries", () => {
  for (const [id, label] of [
    ["fix-polygon-overlaps", "Fix polygon overlaps"],
    ["fill-polygon-gaps", "Fill polygon gaps"],
    ["create-routes", "Create routes"],
    ["locate-features-along-routes", "Locate features along routes"],
    ["dynamic-segmentation", "Dynamic segmentation"],
  ] as const) {
    it(`opens ${id} from the vector menu`, async () => {
      renderMenu();
      const menu = await openGroup("Vector");
      fireEvent.click(await within(menu).findByRole("menuitem", { name: label }));
      assert.equal(useAppStore.getState().ui.vectorToolOpen, id);
    });
  }
});
