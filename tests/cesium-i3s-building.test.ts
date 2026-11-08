import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { I3SDataProvider } from "@cesium/engine";
import { applyI3sBuildingVisibility } from "../packages/map/src/cesium-layer-sync";
import type { GeoLibreLayer } from "../packages/core/src/types";

interface FakeSub {
  data: { id: number; modelName: string };
  sublayers?: FakeSub[];
  visibility: boolean;
}

/** A Building Scene Layer tree as Cesium's I3SDataProvider exposes it. */
function provider(): { sublayers: FakeSub[] } {
  const leaf = (id: number, modelName: string): FakeSub => ({
    data: { id, modelName },
    visibility: true,
  });
  return {
    sublayers: [
      leaf(0, "Overview"),
      {
        data: { id: 1, modelName: "FullModel" },
        visibility: true,
        sublayers: [
          {
            data: { id: 2, modelName: "Architectural" },
            visibility: true,
            sublayers: [leaf(3, "Walls"), leaf(4, "Doors")],
          },
          {
            data: { id: 5, modelName: "Structural" },
            visibility: true,
            sublayers: [leaf(6, "Columns")],
          },
        ],
      },
    ],
  };
}

const layer = (metadata: Record<string, unknown>) =>
  ({ id: "b", type: "3d-tiles", source: {}, metadata }) as unknown as GeoLibreLayer;

const shown = (p: { sublayers: FakeSub[] }): number[] => {
  const out: number[] = [];
  const walk = (subs: FakeSub[]) => {
    for (const sub of subs) {
      if (sub.visibility && !sub.sublayers) out.push(sub.data.id);
      if (sub.sublayers) walk(sub.sublayers);
    }
  };
  walk(p.sublayers);
  return out;
};

describe("applyI3sBuildingVisibility (issue #3374)", () => {
  it("shows only the Overview for a layer with no Building settings", () => {
    const p = provider();
    applyI3sBuildingVisibility(p as unknown as I3SDataProvider, layer({}));
    assert.deepEqual(shown(p), [0]);
    assert.equal(p.sublayers[1].visibility, false);
  });

  it("follows the Full model choice and hidden disciplines", () => {
    const p = provider();
    applyI3sBuildingVisibility(
      p as unknown as I3SDataProvider,
      layer({
        i3sBuilding: {
          mode: "full",
          overviewId: 0,
          disciplines: [
            {
              id: 2,
              name: "Architectural",
              layerType: "group",
              visible: true,
              children: [
                { id: 3, name: "Walls", layerType: "3DObject", visible: true },
                { id: 4, name: "Doors", layerType: "3DObject", visible: false },
              ],
            },
            {
              id: 5,
              name: "Structural",
              layerType: "group",
              visible: false,
              children: [{ id: 6, name: "Columns", layerType: "3DObject", visible: true }],
            },
          ],
        },
      }),
    );
    assert.deepEqual(shown(p), [3]);
    assert.equal(p.sublayers[0].visibility, false);
    assert.equal(p.sublayers[1].visibility, true);
    assert.equal(p.sublayers[1].sublayers?.[1].visibility, false);
  });

  it("leaves a provider without sublayers alone", () => {
    assert.doesNotThrow(() =>
      applyI3sBuildingVisibility({ sublayers: [] } as unknown as I3SDataProvider, layer({})),
    );
  });
});
