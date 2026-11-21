// The DOM helper also initializes the app's English catalog the prompt uses.
import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  confirmDiscardAttributeDrafts,
  pendingAttributeDraftLayerNames,
} from "../apps/geolibre-desktop/src/lib/attribute-draft-guard";

const oneFeature = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [0, 0] },
      properties: { name: "A" },
    },
  ],
};

afterEach(() => {
  useAppStore.getState().newProject({ name: "reset" });
});

describe("pendingAttributeDraftLayerNames", () => {
  it("lists layers with drafts in layer order and skips removed layers", () => {
    assert.deepEqual(
      pendingAttributeDraftLayerNames({
        layers: [
          { id: "a", name: "Roads" },
          { id: "b", name: "Cities" },
          { id: "c", name: "Rivers" },
        ],
        ui: { attributeTableDrafts: { c: {}, a: {}, gone: {} } },
      }),
      ["Roads", "Rivers"],
    );
  });
});

describe("confirmDiscardAttributeDrafts", () => {
  it("does not ask when no layer holds drafts", () => {
    let asked = 0;
    assert.equal(
      confirmDiscardAttributeDrafts(() => {
        asked++;
        return false;
      }),
      true,
    );
    assert.equal(asked, 0);
  });

  it("names the layers and returns the user's answer", () => {
    const store = useAppStore.getState();
    const roads = store.addGeoJsonLayer("Roads", oneFeature);
    const rivers = store.addGeoJsonLayer("Rivers", oneFeature);
    store.setAttributeTableDrafts(roads, { "0": { name: "B" } });
    store.setAttributeTableDrafts(rivers, { "0": { name: "C" } });
    const messages: string[] = [];
    assert.equal(
      confirmDiscardAttributeDrafts((message) => {
        messages.push(message);
        return false;
      }),
      false,
    );
    assert.equal(
      confirmDiscardAttributeDrafts(() => true),
      true,
    );
    assert.match(messages[0], /unsaved edits on 2 layers: Roads and Rivers\./);
  });
});
