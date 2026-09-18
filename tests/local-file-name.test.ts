import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localFileName, uniqueImportedLayerName } from "../packages/core/src/file-name";

const prefix = "content://com.android.externalstorage.documents/document/";

describe("local import filenames", () => {
  it("decodes SAF paths before extracting the filename", () => {
    for (const path of [
      `${prefix}primary%3ADocuments%2Fkml%2Fhydrobasin_Colorado_convex_hull.kml`,
      "primary%3ADocuments%2Fkml%2Fhydrobasin_Colorado_convex_hull.kml",
      "primary%3Ahydrobasin_Colorado_convex_hull.kml",
      "raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fhydrobasin_Colorado_convex_hull.kml",
      `${prefix}primary%3Ahydrobasin_Colorado_convex_hull.kml?query=1#fragment`,
      "file:///home/me/Documents/hydrobasin_Colorado_convex_hull.kml?query=1",
    ])
      assert.equal(localFileName(path), "hydrobasin_Colorado_convex_hull.kml");
  });

  it("supports Unicode, spaces, removable storage, and style presets", () => {
    assert.equal(
      localFileName(`${prefix}ABCD-1234%3AStyles%2F%E6%B0%B4%20style.qml`),
      "水 style.qml",
    );
    assert.equal(localFileName(`${prefix}primary%3AStyles%2Fmap%2520style.sld`), "map%20style.sld");
    assert.equal(localFileName("ABCD-1234%3A%E6%B0%B4%20style.qml"), "水 style.qml");
    assert.equal(localFileName("file:///tmp/my%20file.geojson"), "my file.geojson");
  });

  it("preserves literal percent escapes in desktop filenames", () => {
    assert.equal(localFileName("/tmp/map%20style.qml"), "map%20style.qml");
    assert.equal(localFileName("Report%3AQ1.geojson"), "Report%3AQ1.geojson");
    assert.equal(localFileName("/tmp/Report%3AQ1%2F2024.geojson"), "Report%3AQ1%2F2024.geojson");
    assert.equal(localFileName("C:\\Users\\me\\map.geojson"), "map.geojson");
    assert.equal(localFileName(""), "");
  });

  it("handles malformed escapes and opaque document IDs without throwing", () => {
    assert.equal(localFileName(`${prefix}broken%XX.kml`), "broken%XX.kml");
    assert.equal(localFileName("content://downloads/document/1234"), "1234");
  });

  it("finds the next available suffix without changing a free name", () => {
    assert.equal(uniqueImportedLayerName("cities", ["cities", "cities_2", "cities_4"]), "cities_3");
    assert.equal(uniqueImportedLayerName("Document title", ["cities"]), "Document title");
  });
});

import { useAppStore } from "@geolibre/core";
import { layerNameFromPath } from "../apps/geolibre-desktop/src/components/layout/add-data/helpers";

it("imports duplicate local layers with distinct names and unchanged source URIs", () => {
  useAppStore.setState({ layers: [] });
  const path = `${prefix}primary%3ADocuments%2Fcities.geojson`;
  const data = { type: "FeatureCollection" as const, features: [] };
  const name = layerNameFromPath(path, "Vector Layer");
  for (let i = 0; i < 3; i++) useAppStore.getState().addGeoJsonLayer(name, data, path);
  assert.deepEqual(
    useAppStore.getState().layers.map((layer) => layer.name),
    ["cities", "cities_2", "cities_3"],
  );
  assert.ok(useAppStore.getState().layers.every((layer) => layer.sourcePath === path));
  // Explicit names (an embedded document title, a tool output label) are kept
  // as supplied even when they collide; only filename-derived names get a suffix.
  for (let i = 0; i < 2; i++)
    useAppStore.getState().addGeoJsonLayer("Embedded document title", data, path);
  assert.deepEqual(
    useAppStore
      .getState()
      .layers.slice(-2)
      .map((layer) => layer.name),
    ["Embedded document title", "Embedded document title"],
  );
  useAppStore.setState({ layers: [] });
});
