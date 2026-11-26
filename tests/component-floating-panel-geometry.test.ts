import { act } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";

const { draggedPanelPosition, resizedPanelGeometry, useFloatingPanelGeometry } =
  await import("../apps/geolibre-desktop/src/hooks/useFloatingPanelGeometry");

const limits = { defaultWidth: 320, margin: 12, minWidth: 260, minHeight: 240 };

afterEach(() => {
  document.documentElement.dir = "ltr";
});

describe("dragged panel position", () => {
  const panel = { width: 300, height: 200 };
  const parent = { width: 1000, height: 800 };

  it("follows the pointer inside the parent", () => {
    assert.deepEqual(draggedPanelPosition({ x: 10, y: 20 }, { x: 5, y: 7 }, panel, parent, 12), {
      x: 15,
      y: 27,
    });
  });

  it("stops at the start edges and a margin short of the far edges", () => {
    assert.deepEqual(
      draggedPanelPosition({ x: 10, y: 20 }, { x: -50, y: -50 }, panel, parent, 12),
      { x: 0, y: 0 },
    );
    assert.deepEqual(
      draggedPanelPosition({ x: 10, y: 20 }, { x: 5000, y: 5000 }, panel, parent, 12),
      { x: 688, y: 588 },
    );
  });

  it("pins to the start when the panel is wider than its parent, and is unbounded without one", () => {
    assert.deepEqual(
      draggedPanelPosition(
        { x: 0, y: 0 },
        { x: 40, y: 40 },
        panel,
        { width: 200, height: 100 },
        12,
      ),
      { x: 0, y: 0 },
    );
    assert.deepEqual(draggedPanelPosition({ x: 0, y: 0 }, { x: 4000, y: 9 }, panel, null, 12), {
      x: 4000,
      y: 9,
    });
  });
});

describe("resized panel geometry", () => {
  const start = { x: 500, y: 400, w: 320, h: 300, left: 100, top: 50, parentW: 1000, parentH: 800 };

  it("grows toward the grip and keeps the position in a left-to-right layout", () => {
    assert.deepEqual(resizedPanelGeometry(start, { x: 600, y: 450 }, false, limits), {
      pos: null,
      size: { w: 420, h: 350 },
    });
  });

  it("clamps to the minimum size and to the room left to the edge", () => {
    assert.deepEqual(resizedPanelGeometry(start, { x: 0, y: 0 }, false, limits).size, {
      w: 260,
      h: 240,
    });
    assert.deepEqual(resizedPanelGeometry(start, { x: 9000, y: 9000 }, false, limits).size, {
      w: 888,
      h: 738,
    });
  });

  it("lets a cramped parent shrink the panel below its minimum", () => {
    const cramped = { ...start, parentW: 300, parentH: 200 };
    assert.deepEqual(resizedPanelGeometry(cramped, { x: 0, y: 0 }, false, limits).size, {
      w: 188,
      h: 138,
    });
  });

  it("inverts the drag and pins the physical right edge in a right-to-left layout", () => {
    const next = resizedPanelGeometry(start, { x: 400, y: 400 }, true, limits);
    assert.deepEqual(next.size, { w: 408, h: 300 });
    assert.deepEqual(next.pos, { x: 12, y: 50 });
    assert.equal(next.pos!.x + next.size.w, start.left + start.w);
  });
});

/** A panel element inside a positioned parent with fixed client rects. */
function panelElement() {
  const parent = document.createElement("div");
  const panel = document.createElement("div");
  parent.appendChild(panel);
  document.body.appendChild(parent);
  const rect = (x: number, y: number, width: number, height: number) =>
    ({ left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;
  parent.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  panel.getBoundingClientRect = () => rect(100, 50, 320, 300);
  return panel as HTMLDivElement;
}

/** A pointer event aimed at `target`, with capture calls recorded. */
function pointer(target: HTMLElement, clientX: number, clientY: number) {
  const captured: number[] = [];
  target.setPointerCapture = (id: number) => void captured.push(id);
  target.releasePointerCapture = () => {};
  target.hasPointerCapture = () => true;
  const event = {
    target,
    currentTarget: target,
    pointerId: 1,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as ReactPointerEvent<HTMLDivElement>;
  return { event, captured };
}

describe("useFloatingPanelGeometry", () => {
  it("starts unplaced, then drags the panel by its handle until the pointer is released", () => {
    const panelRef = { current: panelElement() };
    const { result } = renderHook(() => useFloatingPanelGeometry(panelRef, limits));
    assert.equal(result.current.pos, null);
    assert.equal(result.current.size, null);

    const handle = document.createElement("div");
    const { event, captured } = pointer(handle, 200, 100);
    act(() => result.current.handleDragStart(event));
    assert.deepEqual(result.current.pos, { x: 100, y: 50 });
    assert.deepEqual(captured, [1]);

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 260, clientY: 130 }));
    });
    assert.deepEqual(result.current.pos, { x: 160, y: 80 });
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointerup"));
      handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 900, clientY: 700 }));
    });
    assert.deepEqual(result.current.pos, { x: 160, y: 80 });
  });

  it("ignores a press on a header button", () => {
    const panelRef = { current: panelElement() };
    const { result } = renderHook(() => useFloatingPanelGeometry(panelRef, limits));
    const button = document.createElement("button");
    act(() => result.current.handleDragStart(pointer(button, 0, 0).event));
    assert.equal(result.current.pos, null);
  });

  it("resizes from the grip with the top-start corner pinned", () => {
    const panelRef = { current: panelElement() };
    const { result } = renderHook(() => useFloatingPanelGeometry(panelRef, limits));
    const grip = document.createElement("div");
    act(() => result.current.handleResizeStart(pointer(grip, 420, 350).event));
    assert.deepEqual(result.current.pos, { x: 100, y: 50 });
    act(() => result.current.handleResizeMove(pointer(grip, 520, 400).event));
    assert.deepEqual(result.current.size, { w: 420, h: 350 });
    act(() => result.current.handleResizeEnd(pointer(grip, 520, 400).event));
    act(() => result.current.handleResizeMove(pointer(grip, 900, 900).event));
    assert.deepEqual(result.current.size, { w: 420, h: 350 });
  });

  it("moves the position while resizing in a right-to-left document", () => {
    document.documentElement.dir = "rtl";
    const panelRef = { current: panelElement() };
    const { result } = renderHook(() => useFloatingPanelGeometry(panelRef, limits));
    const grip = document.createElement("div");
    act(() => result.current.handleResizeStart(pointer(grip, 100, 350).event));
    act(() => result.current.handleResizeMove(pointer(grip, 60, 350).event));
    assert.deepEqual(result.current.size, { w: 360, h: 300 });
    assert.deepEqual(result.current.pos, { x: 60, y: 50 });
  });
});
