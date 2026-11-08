import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProject, withI3sSceneLayerKind } from "../packages/core/src/project";
import type { GeoLibreLayer } from "../packages/core/src/types";

const SF =
  "https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/SanFrancisco_Bldgs/SceneServer/layers/0";

/** The record the Python add_3d_tiles() wrote before issue #3377. */
function legacyRecord(url: string): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "SF buildings",
    type: "3d-tiles",
    visible: true,
    opacity: 0.8,
    style: {},
    source: { type: "3d-tiles", url, sourceId: "layer-1", altitudeOffset: 2 },
    metadata: {
      sourceKind: "3d-tiles-url",
      externalNativeLayer: true,
      customLayerType: "3d-tiles",
      identifiable: false,
      sourceId: "layer-1",
      nativeLayerIds: ["layer-1"],
      altitudeOffset: 2,
      panelCollapsed: true,
      status: "loading",
    },
    sourcePath: url,
  } as unknown as GeoLibreLayer;
}

describe("withI3sSceneLayerKind (issue #3377)", () => {
  it("re-files a SceneServer tileset record as an I3S scene layer", () => {
    const layer = withI3sSceneLayerKind(legacyRecord(SF));
    assert.equal(layer.source.type, "arcgis-i3s");
    assert.equal(layer.source.url, SF);
    assert.equal(layer.source.altitudeOffset, 2);
    assert.equal(layer.metadata.sourceKind, "arcgis-i3s");
    assert.equal(layer.metadata.customLayerType, "arcgis-i3s");
    assert.equal(layer.metadata.externalDeckLayer, true);
    assert.deepEqual(layer.metadata.nativeLayerIds, ["layer-1-deck"]);
    // The 3D Tiles control's panel state does not apply to the I3S overlay.
    assert.equal(layer.metadata.status, undefined);
    assert.equal(layer.metadata.panelCollapsed, undefined);
    assert.equal(layer.name, "SF buildings");
    assert.equal(layer.opacity, 0.8);
  });

  it("leaves plain tilesets and other layers alone", () => {
    const tileset = legacyRecord("https://example.com/tileset.json");
    assert.equal(withI3sSceneLayerKind(tileset), tileset);
    const i3s = withI3sSceneLayerKind(legacyRecord(SF));
    assert.equal(withI3sSceneLayerKind(i3s), i3s);
    const vector = { ...tileset, type: "geojson" } as GeoLibreLayer;
    assert.equal(withI3sSceneLayerKind(vector), vector);
  });

  it("matches SceneServer in the URL path only", () => {
    const tileset = legacyRecord("https://host/tileset.json?ref=/SceneServer/x");
    assert.equal(withI3sSceneLayerKind(tileset), tileset);
    // A tileset document stored under a SceneServer folder is not a scene service.
    const underFolder = legacyRecord("https://host/SceneServer/tileset.json");
    assert.equal(withI3sSceneLayerKind(underFolder), underFolder);
  });

  it("passes a record without a usable URL through unchanged", () => {
    const noSource = { ...legacyRecord(SF), source: undefined } as unknown as GeoLibreLayer;
    assert.equal(withI3sSceneLayerKind(noSource), noSource);
    const numeric = {
      ...legacyRecord(SF),
      source: { type: "3d-tiles", url: 42 },
    } as unknown as GeoLibreLayer;
    assert.equal(withI3sSceneLayerKind(numeric), numeric);
  });

  it("applies when a project is opened", () => {
    const project = parseProject(
      JSON.stringify({
        version: "1.0",
        name: "P",
        mapView: { center: [-122.4, 37.79], zoom: 15, bearing: 0, pitch: 0 },
        layers: [legacyRecord(SF)],
      }),
    );
    assert.equal(project.layers[0].metadata.sourceKind, "arcgis-i3s");
  });
});
