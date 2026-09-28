import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installSelectionDragGuard,
  type SelectionLike,
} from "../packages/map/src/selection-drag-guard";

function fakeSelection(collapsed: boolean): SelectionLike & { cleared: number } {
  const selection = {
    isCollapsed: collapsed,
    cleared: 0,
    removeAllRanges() {
      selection.cleared += 1;
      selection.isCollapsed = true;
    },
  };
  return selection;
}

function mouseDown(button: number): Event {
  return Object.assign(new Event("mousedown", { cancelable: true }), { button });
}

function dragStartFrom(draggable: string | null): Event {
  const event = new Event("dragstart", { cancelable: true });
  Object.defineProperty(event, "target", {
    value: { getAttribute: (name: string) => (name === "draggable" ? draggable : null) },
  });
  return event;
}

describe("installSelectionDragGuard", () => {
  it("collapses an active selection when the map is pressed", () => {
    const container = new EventTarget();
    const selection = fakeSelection(false);
    installSelectionDragGuard(container, () => selection);

    container.dispatchEvent(mouseDown(0));

    assert.equal(selection.cleared, 1);
  });

  it("leaves a collapsed selection and non-primary buttons alone", () => {
    const container = new EventTarget();
    const collapsed = fakeSelection(true);
    installSelectionDragGuard(container, () => collapsed);
    container.dispatchEvent(mouseDown(0));
    assert.equal(collapsed.cleared, 0);

    const other = new EventTarget();
    const selection = fakeSelection(false);
    installSelectionDragGuard(other, () => selection);
    other.dispatchEvent(mouseDown(2));
    assert.equal(selection.cleared, 0);
  });

  it("cancels the implicit native drag but honours draggable=true", () => {
    const container = new EventTarget();
    installSelectionDragGuard(container, () => null);

    const implicit = dragStartFrom(null);
    container.dispatchEvent(implicit);
    assert.equal(implicit.defaultPrevented, true);

    const optedIn = dragStartFrom("true");
    container.dispatchEvent(optedIn);
    assert.equal(optedIn.defaultPrevented, false);
  });

  it("removes its listeners on dispose", () => {
    const container = new EventTarget();
    const selection = fakeSelection(false);
    const dispose = installSelectionDragGuard(container, () => selection);
    dispose();

    container.dispatchEvent(mouseDown(0));
    const drag = dragStartFrom(null);
    container.dispatchEvent(drag);

    assert.equal(selection.cleared, 0);
    assert.equal(drag.defaultPrevented, false);
  });
});
