import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  i3sGroundOffset,
  mergeI3sBuildingSelection,
  type I3sBuildingState,
} from "../packages/core/src/i3s-building-state";

describe("i3sGroundOffset (issue #3374)", () => {
  it("lowers a layer with absolute heights when there is no terrain", () => {
    assert.equal(i3sGroundOffset(383.1, false), -383.1);
  });

  it("keeps absolute heights with terrain", () => {
    assert.equal(i3sGroundOffset(383.1, true), 0);
  });

  it("leaves layers that reach sea level, or have no usable base, alone", () => {
    for (const base of [-148.8, 0, null, undefined, "383", Number.NaN]) {
      assert.equal(i3sGroundOffset(base, false), 0);
    }
  });
});

describe("mergeI3sBuildingSelection", () => {
  const node = (id: number, visible: boolean, children?: I3sBuildingState["disciplines"]) => ({
    id,
    name: `n${id}`,
    layerType: children ? "group" : "3DObject",
    visible,
    ...(children ? { children } : {}),
  });

  it("keeps saved choices for nodes that still exist and defaults new ones", () => {
    const saved: I3sBuildingState = {
      mode: "full",
      overviewId: 0,
      disciplines: [node(1, false, [node(2, false), node(3, true)])],
    };
    const fresh: I3sBuildingState = {
      mode: "overview",
      overviewId: 0,
      // Category 3 was replaced by 4 on the service.
      disciplines: [node(1, true, [node(2, true), node(4, true)])],
    };
    const merged = mergeI3sBuildingSelection(fresh, saved);
    assert.equal(merged.mode, "full");
    assert.equal(merged.disciplines[0].visible, false);
    assert.deepEqual(
      merged.disciplines[0].children?.map(({ id, visible }) => ({ id, visible })),
      [
        { id: 2, visible: false },
        { id: 4, visible: true },
      ],
    );
  });

  it("falls back to the full model when the Overview is gone", () => {
    const saved: I3sBuildingState = { mode: "overview", overviewId: 0, disciplines: [] };
    const fresh: I3sBuildingState = {
      mode: "full",
      overviewId: null,
      disciplines: [node(5, true)],
    };
    assert.equal(mergeI3sBuildingSelection(fresh, saved).mode, "full");
  });
});
