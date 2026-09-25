import { act, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { MountWhenOpened } =
  await import("../apps/geolibre-desktop/src/components/layout/MountWhenOpened");

/** Count how many times the wrapped child has rendered. */
function renderWrapped() {
  const renders = { count: 0 };
  function Child() {
    renders.count += 1;
    return createElement("div", { "data-testid": "child" }, "child");
  }
  render(createElement(MountWhenOpened, { isOpen: (ui) => ui.geocodeOpen }, createElement(Child)));
  return renders;
}

function setGeocodeOpen(open: boolean): void {
  act(() => {
    useAppStore.setState((s) => ({ ui: { ...s.ui, geocodeOpen: open } }));
  });
}

describe("MountWhenOpened", () => {
  it("does not render the child until it is first opened", () => {
    const renders = renderWrapped();

    assert.equal(screen.queryByTestId("child"), null);
    assert.equal(renders.count, 0);

    setGeocodeOpen(true);

    assert.equal(screen.getByTestId("child").textContent, "child");
  });

  it("keeps the child mounted after it closes", () => {
    renderWrapped();
    setGeocodeOpen(true);
    setGeocodeOpen(false);

    assert.equal(screen.getByTestId("child").textContent, "child");
  });

  it("renders immediately when already open at mount", () => {
    setGeocodeOpen(true);
    renderWrapped();

    assert.equal(screen.getByTestId("child").textContent, "child");
  });
});
