import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { getHistoryCoalesceMs, setHistoryCoalesceMs } from "../packages/core/src/history";
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

// Captured before any test changes it, so the app's real window is what the
// coalescing case exercises and what cleanup restores — not a copy of it that
// would go stale if the default moved.
const APP_COALESCE_MS = getHistoryCoalesceMs();

/** What the `addGeoJsonLayer` handler does with a raw `style` param. */
function addGeoJsonCommand(name: string, style: unknown): string {
  const layerId = useAppStore.getState().addGeoJsonLayer(name, FC);
  const patch = styleParamPatch(style);
  if (patch) useAppStore.getState().setLayerStyle(layerId, patch);
  return layerId;
}

describe("addGeoJsonLayer command styling", () => {
  beforeEach(() => {
    // 0 so each store write is its own history entry: with the app's default
    // coalesce window the two writes of a styled add would merge and the guard
    // below would pass whether or not it works.
    setHistoryCoalesceMs(0);
    useAppStore.getState().newProject({ name: "Scripting" });
    useAppStore.temporal.getState().clear();
  });

  afterEach(() => {
    setHistoryCoalesceMs(APP_COALESCE_MS);
  });

  it("merges an inline style into the new layer", () => {
    const layerId = addGeoJsonCommand("Styled", {
      fillColor: "#facc15",
      strokeColor: "#d97706",
    });

    const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
    assert.equal(layer?.style?.fillColor, "#facc15");
    assert.equal(layer?.style?.strokeColor, "#d97706");
  });

  it("writes nothing extra when no style kwargs were passed", () => {
    const layerId = addGeoJsonCommand("Plain", {});

    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    useAppStore.temporal.getState().undo();
    assert.equal(
      useAppStore.getState().layers.find((item) => item.id === layerId),
      undefined,
    );
  });

  it("coalesces a styled add into one undo step at the app's window", () => {
    // The two writes land in the same tick, so the leading debounce in the
    // store's `handleSet` records only the first: one Ctrl+Z removes the
    // styled layer outright rather than leaving an unstyled one behind.
    setHistoryCoalesceMs(APP_COALESCE_MS);
    const layerId = addGeoJsonCommand("Styled", { fillColor: "#facc15" });

    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    useAppStore.temporal.getState().undo();
    assert.equal(
      useAppStore.getState().layers.find((item) => item.id === layerId),
      undefined,
    );
  });
});
