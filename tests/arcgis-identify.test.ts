import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { IDENTIFY_ALL_LAYERS_ID, useAppStore } from "@geolibre/core";
import { createArcgisIdentify } from "../packages/map/src/arcgis-identify";
import { DEFAULT_IDENTIFY_ALL_LABELS } from "../packages/map/src/identify-all-popup";
import type { IdentifiedFeature } from "../packages/map/src/map-engine";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The Identify click flow the ArcGIS canvas runs (issue #2477): the same popup
// templates, selection hand-off and "Identify visible layers" grouping as the
// MapLibre and Mapbox canvases, over the engine's asynchronous hit test.

const parks = geojsonLayer({ id: "parks", name: "Parks" });
const roads = geojsonLayer({ id: "roads", name: "Roads" });

function makeHost(hits: IdentifiedFeature[]) {
  const shown: { content: HTMLElement; onClose?: () => void }[] = [];
  let removed = 0;
  const host = {
    identifyFeaturesAt: async (_point: unknown, layerId?: string) =>
      layerId ? hits.filter((hit) => hit.layerId === layerId) : hits,
    toLngLat: () => [10, 20] as [number, number],
    zoom: () => 8,
    showPopup: (_at: unknown, content: HTMLElement, _width: string, onClose?: () => void) => {
      shown.push({ content, onClose });
    },
    removePopup: () => {
      removed++;
    },
    labels: () => DEFAULT_IDENTIFY_ALL_LABELS,
    identifyRaster: () => undefined,
  };
  return { identify: createArcgisIdentify(host), shown, removed: () => removed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createArcgisIdentify", () => {
  let previous: { document: unknown };
  beforeEach(() => {
    previous = { document: globalThis.document };
    Object.assign(globalThis, { document: parseHTML("<html><body></body></html>").document });
    useAppStore.setState({
      layers: [parks, roads],
      layerGroups: [],
      selectedLayerId: "roads",
      selectedFeatureId: null,
      selectedFeatureIds: [],
    });
  });
  afterEach(() => {
    Object.assign(globalThis, previous);
    useAppStore.setState({ identifyLayerId: null, layers: [] });
  });

  it("shows one layer's hit with its template and gives the selection back on close", async () => {
    useAppStore.setState({ identifyLayerId: "parks" });
    const { identify, shown } = makeHost([
      { layerId: "parks", featureId: "p1", properties: { name: "Green" }, geometry: null },
    ]);
    identify.click({ x: 1, y: 2 });
    await settle();
    assert.equal(shown.length, 1);
    assert.match(shown[0].content.textContent ?? "", /Green/);
    assert.equal(useAppStore.getState().selectedLayerId, "parks");
    assert.equal(useAppStore.getState().selectedFeatureId, "p1");
    shown[0].onClose?.();
    assert.equal(useAppStore.getState().selectedLayerId, "roads");
  });

  it("clears the selection on a miss", async () => {
    useAppStore.setState({ identifyLayerId: "parks", selectedFeatureId: "old" });
    const { identify, shown } = makeHost([]);
    identify.click({ x: 1, y: 2 });
    await settle();
    assert.equal(shown.length, 0);
    assert.equal(useAppStore.getState().selectedFeatureId, null);
  });

  it("groups every visible layer's hits for Identify visible layers", async () => {
    useAppStore.setState({ identifyLayerId: IDENTIFY_ALL_LAYERS_ID });
    const { identify, shown } = makeHost([
      { layerId: "parks", featureId: "p1", properties: { name: "Green" }, geometry: null },
      { layerId: "roads", featureId: "r1", properties: { name: "Main" }, geometry: null },
    ]);
    identify.click({ x: 1, y: 2 });
    await settle();
    assert.equal(shown.length, 1);
    const text = shown[0].content.textContent ?? "";
    assert.match(text, /Identified results \(2\)/);
    assert.match(text, /Parks/);
    assert.match(text, /Roads/);
  });
});
