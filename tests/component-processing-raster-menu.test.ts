import { act, fireEvent, render, screen, i18n, useAppStore, waitFor, within } from "./helpers/dom";
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

describe("Processing menu browser raster entries", () => {
  for (const [id, key] of [
    ["change-difference", "changeDifference"],
    ["ndvi-change", "ndviChange"],
    ["transition-matrix", "transitionMatrix"],
    ["sar-db", "sarDb"],
    ["speckle-filter", "speckleFilter"],
    ["sar-rgb", "sarRgb"],
    ["flood-map", "floodMap"],
    ["cut-fill", "cutFill"],
  ] as const) {
    it(`opens ${id} from the raster menu`, async () => {
      renderMenu();
      const menu = await openGroup("Raster");
      fireEvent.click(
        await within(menu).findByRole("menuitem", { name: i18n.t(`toolbar.rasterTool.${key}`) }),
      );
      assert.equal(useAppStore.getState().ui.rasterToolOpen, id);
    });
    it(`opens ${id} on Android`, async () => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: "Mozilla/5.0 Android",
      });
      try {
        renderMenu();
        const menu = await openGroup("Raster");
        fireEvent.click(
          await within(menu).findByRole("menuitem", { name: i18n.t(`toolbar.rasterTool.${key}`) }),
        );
        assert.equal(useAppStore.getState().ui.rasterToolOpen, id);
      } finally {
        if (descriptor) Object.defineProperty(navigator, "userAgent", descriptor);
        else Reflect.deleteProperty(navigator, "userAgent");
      }
    });
  }
});
