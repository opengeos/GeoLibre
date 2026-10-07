import { fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { NewProjectDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/NewProjectDialog");
const { OPENFREEMAP_BASEMAPS, BLANK_BASEMAP } = await import("@geolibre/core");

function renderDialog() {
  const calls = { created: 0, openChange: [] as boolean[] };
  render(
    createElement(NewProjectDialog, {
      open: true,
      onOpenChange: (open: boolean) => calls.openChange.push(open),
      onSaveCurrentProject: async () => true,
      onProjectCreated: () => {
        calls.created += 1;
      },
    }),
  );
  return calls;
}

describe("NewProjectDialog basemap double-click", () => {
  it("creates the project with the double-clicked basemap", async () => {
    const calls = renderDialog();
    const target = OPENFREEMAP_BASEMAPS.find((b) => b.id !== "liberty")!;
    const button = await screen.findByRole("button", { name: target.name });
    // No preliminary clicks: the selection stays on the default ("liberty"), so
    // this proves creation uses the double-clicked id, not the selection state.
    fireEvent.doubleClick(button);
    assert.equal(calls.created, 1);
    assert.deepEqual(calls.openChange, [false]);
    assert.equal(useAppStore.getState().basemapStyleUrl, target.styleUrl);
  });

  it("creates a blank project on double-click", async () => {
    const calls = renderDialog();
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Blank" }));
    assert.equal(calls.created, 1);
    assert.equal(useAppStore.getState().basemapStyleUrl, BLANK_BASEMAP);
  });

  it("only selects Custom URL on double-click, since it still needs a URL", async () => {
    const calls = renderDialog();
    const button = await screen.findByRole("button", { name: "Custom URL" });
    fireEvent.click(button);
    fireEvent.doubleClick(button);
    assert.equal(calls.created, 0);
    assert.equal(button.getAttribute("aria-pressed"), "true");
  });
});
