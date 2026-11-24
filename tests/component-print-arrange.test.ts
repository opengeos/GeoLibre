import { render, screen, fireEvent, i18n } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { createDefaultPrintLayout } from "../packages/core/src/print-layout-config";
import type { PrintLayoutAction } from "../apps/geolibre-desktop/src/components/layout/print-layout/state";

const { ArrangeOverlay } =
  await import("../apps/geolibre-desktop/src/components/layout/print-layout/ArrangeOverlay");

it("ignores pointer jitter but applies a drag from its original press point", () => {
  const actions: PrintLayoutAction[] = [];
  render(
    createElement(ArrangeOverlay, {
      frame: {
        boxes: { map: { box: { x: 0, y: 0, w: 50, h: 50 } } },
        pageW: 100,
        pageH: 100,
        cssW: 100,
        cssH: 100,
      },
      layout: createDefaultPrintLayout(),
      dispatch: (action) => actions.push(action),
    }),
  );
  const handle = screen.getByRole("button", { name: i18n.t("printLayout.arrange.element.map") });
  Object.assign(handle, { setPointerCapture: () => {}, hasPointerCapture: () => false });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: 11, clientY: 11 });
  fireEvent.pointerUp(handle, { pointerId: 1 });
  assert.equal(actions.length, 0);
  fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { pointerId: 2, clientX: 20, clientY: 10 });
  fireEvent.pointerUp(handle, { pointerId: 2 });
  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.type, "setLayout");
  if (action.type === "setLayout") assert.equal(action.patch.mapFrameBox?.x, 0.1);
});
