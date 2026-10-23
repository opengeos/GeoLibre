import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { firstFocusable, focusPanel, restorePanelFocus } =
  await import("../packages/plugins/src/plugins/panel-focus");

/** happy-dom does no layout, so set whether each element counts as rendered. */
function rendered<T extends HTMLElement>(element: T, shown = true): T {
  element.getClientRects = () => ({ length: shown ? 1 : 0 }) as unknown as DOMRectList;
  return element;
}

function buildPanel(): { panel: HTMLElement; close: HTMLElement; input: HTMLElement } {
  const panel = document.createElement("div");
  const close = rendered(document.createElement("button"));
  close.className = "panel-close";
  const hidden = rendered(document.createElement("input"), false);
  const input = rendered(document.createElement("input"));
  panel.append(close, hidden, input);
  document.body.append(panel);
  return { panel, close, input };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("panel focus", () => {
  it("finds the first rendered control, passing over the skipped one", () => {
    const { panel, input } = buildPanel();
    assert.equal(firstFocusable(panel)?.className, "panel-close");
    assert.equal(
      firstFocusable(panel, ".panel-close") === input,
      true,
      "skips the unrendered input",
    );
    panel.remove();
  });

  it("moves focus into the panel and hands it back on close", async () => {
    const trigger = rendered(document.createElement("button"));
    trigger.textContent = "Add Data";
    document.body.append(trigger);
    trigger.focus();
    const { panel, input } = buildPanel();

    focusPanel(panel, ".panel-close");
    await nextFrame();
    assert.equal(document.activeElement === input, true, "focus should be in the panel");

    restorePanelFocus(panel);
    assert.equal(document.activeElement === trigger, true, "focus should return to the trigger");
    panel.remove();
    trigger.remove();
  });

  it("leaves focus alone when the user already moved out of the panel", async () => {
    const trigger = rendered(document.createElement("button"));
    const elsewhere = rendered(document.createElement("button"));
    document.body.append(trigger, elsewhere);
    trigger.focus();
    const { panel } = buildPanel();

    focusPanel(panel);
    await nextFrame();
    elsewhere.focus();
    restorePanelFocus(panel);
    assert.equal(document.activeElement === elsewhere, true);
    panel.remove();
    trigger.remove();
    elsewhere.remove();
  });
});
