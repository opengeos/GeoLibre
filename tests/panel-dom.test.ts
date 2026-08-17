import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { el, setDisabled } from "../packages/plugins/src/panel-dom";

// Panels are built by hand against the DOM, so these tests need real elements.
// A minimal stub is enough: the helpers only touch createElement, textContent,
// `disabled`, and inline style properties.
class StubStyle {
  cssText = "";
  opacity = "";
  cursor = "";
}

class StubElement {
  textContent: string | undefined;
  disabled = false;
  style = new StubStyle();
  constructor(readonly tagName: string) {}
}

beforeEach(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new StubElement(tag),
  };
});

describe("el", () => {
  it("creates an element and sets text only when given", () => {
    const withText = el("button", "Add") as unknown as StubElement;
    assert.equal(withText.tagName, "button");
    assert.equal(withText.textContent, "Add");
    assert.equal((el("div") as unknown as StubElement).textContent, undefined);
  });
});

describe("setDisabled", () => {
  // GeoLibre#1970: the STAC panel styles its buttons with inline
  // background/color/cursor, which overrides the browser's own disabled
  // rendering. Setting `.disabled` alone left a disabled Add button pixel
  // identical to the enabled Zoom and Download buttons beside it, so the
  // disabled state has to carry its own visual treatment.
  it("gives a disabled button a visual treatment an enabled one does not have", () => {
    const button = el("button", "Add") as unknown as StubElement;
    setDisabled(button as unknown as HTMLButtonElement, true);

    assert.equal(button.disabled, true);
    assert.equal(button.style.opacity, "0.5");
    assert.equal(button.style.cursor, "not-allowed");
  });

  it("restores the enabled look, so a re-enabled button is not left dimmed", () => {
    const button = el("button", "Clear results") as unknown as StubElement;
    setDisabled(button as unknown as HTMLButtonElement, true);
    setDisabled(button as unknown as HTMLButtonElement, false);

    assert.equal(button.disabled, false);
    assert.equal(button.style.opacity, "1");
    assert.equal(button.style.cursor, "pointer");
  });

  it("leaves the disabled and enabled looks distinguishable in both directions", () => {
    const enabled = el("button", "Zoom") as unknown as StubElement;
    const disabled = el("button", "Add") as unknown as StubElement;
    setDisabled(enabled as unknown as HTMLButtonElement, false);
    setDisabled(disabled as unknown as HTMLButtonElement, true);

    assert.notEqual(enabled.style.opacity, disabled.style.opacity);
    assert.notEqual(enabled.style.cursor, disabled.style.cursor);
  });
});
