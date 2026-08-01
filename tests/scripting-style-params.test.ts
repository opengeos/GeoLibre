import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { styleParamPatch } from "../apps/geolibre-desktop/src/lib/scripting/style-params";

// The notebook client's `add_geojson(gdf, **style)` always sends a `style`
// object, so the scripting handler's `addGeoJsonLayer` decides — via
// `styleParamPatch` — whether that payload is worth a store write at all. The
// handler module itself pulls in the whole plugin/map stack (and its CSS), so
// these tests exercise the decision helper directly and then replay what the
// handler does with it against the real store.

const FC = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [0, 0] },
    },
  ],
};

describe("styleParamPatch", () => {
  it("keeps a non-empty style object", () => {
    const style = { fillColor: "#facc15", strokeWidth: 2 };
    assert.deepEqual(styleParamPatch(style), style);
  });

  it("rejects an empty object, so a style-less call writes nothing", () => {
    assert.equal(styleParamPatch({}), null);
  });

  it("rejects missing and non-object payloads", () => {
    assert.equal(styleParamPatch(undefined), null);
    assert.equal(styleParamPatch(null), null);
    assert.equal(styleParamPatch("fillColor"), null);
    assert.equal(styleParamPatch(["fillColor"]), null);
  });
});

describe("addGeoJsonLayer command styling", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Scripting" });
    useAppStore.temporal.getState().clear();
  });

  it("merges an inline style into the new layer", () => {
    const layerId = useAppStore.getState().addGeoJsonLayer("Styled", FC);
    const style = styleParamPatch({ fillColor: "#facc15", strokeColor: "#d97706" });
    assert.ok(style);
    useAppStore.getState().setLayerStyle(layerId, style);

    const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
    assert.equal(layer?.style?.fillColor, "#facc15");
    assert.equal(layer?.style?.strokeColor, "#d97706");
  });

  it("costs a single undo step when no style kwargs were passed", () => {
    const layerId = useAppStore.getState().addGeoJsonLayer("Plain", FC);
    const style = styleParamPatch({});
    if (style) useAppStore.getState().setLayerStyle(layerId, style);

    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    useAppStore.temporal.getState().undo();
    assert.equal(
      useAppStore.getState().layers.find((item) => item.id === layerId),
      undefined,
    );
  });
});
