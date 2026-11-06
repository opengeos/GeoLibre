import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  i3sBuildingSublayerUrl,
  i3sLayerDocumentUrl,
  isI3sBuildingLayerDocument,
  parseI3sBuildingLayer,
  setI3sBuildingNodeVisible,
  visibleI3sBuildingSublayers,
} from "../packages/plugins/src/plugins/i3s-building";

/** The shape of Esri's Turanga Library Building Scene Layer (trimmed). */
const TURANGA = {
  layerType: "Building",
  sublayers: [
    {
      id: 200,
      name: "Full Model",
      modelName: "FullModel",
      layerType: "group",
      visibility: false,
      sublayers: [
        {
          id: 230,
          name: "Architectural",
          modelName: "Architectural",
          layerType: "group",
          sublayers: [
            { id: 19, name: "Walls", modelName: "Walls", layerType: "3DObject", visibility: false },
            { id: 20, name: "Windows", modelName: "Windows", layerType: "3DObject" },
          ],
        },
        {
          id: 220,
          name: "Structural",
          modelName: "Structural",
          layerType: "group",
          sublayers: [
            { id: 5, name: "Columns", modelName: "StructuralColumns", layerType: "3DObject" },
          ],
        },
      ],
    },
    { id: 0, name: "Overview", modelName: "Overview", layerType: "3DObject" },
  ],
};

describe("I3S Building Scene Layers", () => {
  it("recognizes a Building layer document", () => {
    assert.equal(isI3sBuildingLayerDocument(TURANGA), true);
    assert.equal(isI3sBuildingLayerDocument({ layerType: "3DObject" }), false);
    assert.equal(isI3sBuildingLayerDocument(null), false);
  });

  it("starts on the Overview and lists the Full Model's disciplines", () => {
    const state = parseI3sBuildingLayer(TURANGA);
    assert.equal(state.mode, "overview");
    assert.equal(state.overviewId, 0);
    assert.deepEqual(
      state.disciplines.map((node) => node.name),
      ["Architectural", "Structural"],
    );
    assert.deepEqual(visibleI3sBuildingSublayers(state), [0]);
  });

  it("draws every category of the full model, the service's hidden flags notwithstanding", () => {
    const state = { ...parseI3sBuildingLayer(TURANGA), mode: "full" as const };
    assert.deepEqual(visibleI3sBuildingSublayers(state), [19, 20, 5]);
  });

  it("hides a discipline or a single category", () => {
    const full = { ...parseI3sBuildingLayer(TURANGA), mode: "full" as const };
    assert.deepEqual(visibleI3sBuildingSublayers(setI3sBuildingNodeVisible(full, 230, false)), [5]);
    const noWalls = setI3sBuildingNodeVisible(full, 19, false);
    assert.deepEqual(visibleI3sBuildingSublayers(noWalls), [20, 5]);
    // The input is not changed.
    assert.deepEqual(visibleI3sBuildingSublayers(full), [19, 20, 5]);
  });

  it("falls back to the full model without an Overview sublayer", () => {
    const state = parseI3sBuildingLayer({ ...TURANGA, sublayers: [TURANGA.sublayers[0]] });
    assert.equal(state.mode, "full");
    assert.equal(state.overviewId, null);
    assert.deepEqual(visibleI3sBuildingSublayers({ ...state, mode: "overview" }), [19, 20, 5]);
  });

  it("builds sublayer and layer document URLs", () => {
    const base = "https://host/arcgis/rest/services/Lib/SceneServer";
    assert.equal(i3sBuildingSublayerUrl(`${base}/layers/0`, 19), `${base}/layers/0/sublayers/19`);
    assert.equal(
      i3sBuildingSublayerUrl(`${base}/layers/0/?token=t`, 19),
      `${base}/layers/0/sublayers/19?token=t`,
    );
    assert.equal(i3sLayerDocumentUrl(base), `${base}/layers/0`);
    assert.equal(i3sLayerDocumentUrl(`${base}/layers/2?token=t`), `${base}/layers/2?token=t`);
    assert.equal(i3sLayerDocumentUrl("https://host/tileset.json"), null);
  });
});
