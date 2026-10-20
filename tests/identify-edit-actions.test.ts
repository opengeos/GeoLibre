import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MapCanvasIdentifyEditActions } from "../packages/map/src";
import { identifyEditActionsForLayout } from "../apps/geolibre-desktop/src/lib/identify-edit-actions-layout";

const actions: MapCanvasIdentifyEditActions = {
  canEditGeometry: () => true,
  canEditAttributes: () => true,
  editGeometry: () => {},
  editAttributes: () => {},
};

describe("identifyEditActionsForLayout", () => {
  it("offers no Identify edit actions in the read-only viewer", () => {
    assert.equal(identifyEditActionsForLayout(actions, true), undefined);
  });

  it("passes the actions through in every other layout", () => {
    assert.equal(identifyEditActionsForLayout(actions, false), actions);
  });
});
