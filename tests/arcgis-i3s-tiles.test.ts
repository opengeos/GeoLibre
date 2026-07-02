import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isArcgisI3sSceneLayerUrl,
  isArcgisI3sTilesLayer,
  ARCGIS_I3S_SOURCE_KIND,
} from "../packages/plugins/src/plugins/arcgis-i3s-tiles";
import type { GeoLibreLayer } from "../packages/core/src/types";

describe("isArcgisI3sSceneLayerUrl", () => {
  it("matches SceneServer endpoints", () => {
    for (const url of [
      "https://tiles.arcgis.com/tiles/ab/arcgis/rest/services/SF_Bldgs/SceneServer/layers/0",
      "https://services.arcgis.com/ab/arcgis/rest/services/Trees/SceneServer",
      "https://example.com/server/rest/services/City/SceneServer?token=xyz",
      "https://host/SceneServer/",
    ]) {
      assert.equal(isArcgisI3sSceneLayerUrl(url), true, url);
    }
  });

  it("does not match non-I3S URLs", () => {
    for (const url of [
      "https://example.com/tileset.json",
      "https://tile.googleapis.com/v1/3dtiles/root.json",
      "https://services.arcgis.com/ab/arcgis/rest/services/Roads/FeatureServer/0",
      "https://example.com/scenes/my-scene.json",
    ]) {
      assert.equal(isArcgisI3sSceneLayerUrl(url), false, url);
    }
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(
      isArcgisI3sSceneLayerUrl("  https://host/City/SceneServer  "),
      true,
    );
  });
});

describe("isArcgisI3sTilesLayer", () => {
  const base: GeoLibreLayer = {
    id: "x",
    name: "x",
    type: "3d-tiles",
    source: { sourceId: "x", type: ARCGIS_I3S_SOURCE_KIND, url: "u" },
    visible: true,
    opacity: 1,
    style: {},
    metadata: { sourceKind: ARCGIS_I3S_SOURCE_KIND },
  } as unknown as GeoLibreLayer;

  it("matches a 3d-tiles layer with the arcgis-i3s source kind", () => {
    assert.equal(isArcgisI3sTilesLayer(base), true);
  });

  it("rejects other 3d-tiles layers and other types", () => {
    assert.equal(
      isArcgisI3sTilesLayer({
        ...base,
        metadata: { sourceKind: "google-photorealistic-3d-tiles" },
      } as unknown as GeoLibreLayer),
      false,
    );
    assert.equal(
      isArcgisI3sTilesLayer({
        ...base,
        type: "raster",
      } as unknown as GeoLibreLayer),
      false,
    );
  });
});
