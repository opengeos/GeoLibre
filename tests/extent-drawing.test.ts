import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { drawExtentOnCanvas, extentFromCorners } from "../packages/map/src/extent-drawing";

const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.window = originalWindow;
});

test("extent corners preserve the short arc across the antimeridian in either direction", () => {
  assert.deepEqual(extentFromCorners([179, 10], [-179, -10]), [179, -10, -179, 10]);
  assert.deepEqual(extentFromCorners([-179, -10], [179, 10]), [179, -10, -179, 10]);
  assert.deepEqual(extentFromCorners([190, 4], [200, 8]), [-170, 4, -160, 8]);
});

function setup() {
  const { window, document } = parseHTML("<html><body><canvas></canvas></body></html>");
  globalThis.window = window as unknown as Window & typeof globalThis;
  const canvas = document.querySelector("canvas")!;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const emit = (target: EventTarget, type: string, values = {}) => {
    const event = new window.Event(type);
    Object.assign(event, { button: 0, pointerId: 1, clientX: 1, clientY: 2 }, values);
    target.dispatchEvent(event);
  };
  let restores = 0;
  let cancelled = 0;
  let done = 0;
  const changes: number[][] = [];
  const dispose = drawExtentOnCanvas(
    canvas,
    (p) => (p.x < 0 ? null : [p.x, p.y]),
    () => () => {
      restores++;
    },
    {
      onChange: (b) => changes.push(b),
      onDone: () => {
        done++;
      },
      onCancel: () => {
        cancelled++;
      },
    },
  );
  return { canvas, window, emit, dispose, state: () => ({ restores, cancelled, done, changes }) };
}

test("only the initiating pointer completes a drag; final position and navigation restore once", () => {
  const s = setup();
  s.emit(s.canvas, "pointerdown");
  s.emit(s.window, "pointerup", { pointerId: 2, clientX: 10, clientY: 20 });
  assert.equal(s.state().done, 0);
  s.emit(s.window, "pointerup", { clientX: 10, clientY: 20 });
  s.dispose();
  assert.deepEqual(s.state(), { restores: 1, cancelled: 0, done: 1, changes: [[1, 2, 10, 20]] });
  s.emit(s.window, "pointermove");
  assert.equal(s.state().changes.length, 1);
});

test("sky release cancels and does not fabricate an extent", () => {
  const s = setup();
  s.emit(s.canvas, "pointerdown");
  s.emit(s.window, "pointerup", { clientX: -1 });
  assert.deepEqual(s.state(), { restores: 1, cancelled: 1, done: 0, changes: [] });
});

for (const type of ["blur", "pointercancel", "keydown"]) {
  test(`${type} cancels and restores navigation exactly once`, () => {
    const s = setup();
    s.emit(s.canvas, "pointerdown");
    s.emit(s.window, type, { key: "Escape" });
    s.dispose();
    s.emit(s.window, "pointerup");
    assert.deepEqual(s.state(), { restores: 1, cancelled: 1, done: 0, changes: [] });
  });
}
