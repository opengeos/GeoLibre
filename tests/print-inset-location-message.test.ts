import { render, screen } from "./helpers/dom";
import { createElement } from "react";
import { createDefaultPrintLayout } from "@geolibre/core";
import { it } from "node:test";
import assert from "node:assert/strict";

const { InsetMapEditor } =
  await import("../apps/geolibre-desktop/src/components/layout/print-layout/InsetMapEditor");

it("does not tell a located globe capture to switch to flat 2D", () => {
  render(
    createElement(InsetMapEditor, {
      layout: createDefaultPrintLayout(),
      dispatch: () => {},
      hasLocation: true,
      status: { loading: false, failed: false, retry: () => {} },
    }),
  );
  assert.equal(screen.queryByText(/flat 2D capture/), null);
  assert.equal(screen.queryByText(/This capture has no map location/), null);
});

it("explains an unavailable capture location without requiring an affine projection", () => {
  render(
    createElement(InsetMapEditor, {
      layout: createDefaultPrintLayout(),
      dispatch: () => {},
      hasLocation: false,
      status: { loading: false, failed: false, retry: () => {} },
    }),
  );
  assert.ok(screen.getByText(/This capture has no map location/));
});
