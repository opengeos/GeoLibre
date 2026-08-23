import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { KML_FOLDER_PATH_PROPERTY } from "../apps/geolibre-desktop/src/lib/kml";

// tauri-io statically pulls in shpjs, whose bundle reads the browser `self`
// global at module-eval time; shim it before the dynamic import.
(globalThis as { self?: unknown }).self ??= globalThis;

type SplitKmlFolderLayers =
  typeof import("../apps/geolibre-desktop/src/lib/tauri-io").splitKmlFolderLayers;

let splitKmlFolderLayers: SplitKmlFolderLayers;

before(async () => {
  const mod = await import("../apps/geolibre-desktop/src/lib/tauri-io");
  splitKmlFolderLayers = mod.splitKmlFolderLayers;
});

/** A point placemark, optionally inside the given KML Folder ancestry. */
function placemark(name: string | undefined, folders?: string[]): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      ...(name === undefined ? {} : { name }),
      ...(folders ? { [KML_FOLDER_PATH_PROPERTY]: folders } : {}),
    },
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

describe("splitKmlFolderLayers", () => {
  it("leaves a folderless collection as one layer", () => {
    const input = collection([placemark("A"), placemark("B")]);
    const layers = splitKmlFolderLayers(input, "tour.kml");

    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.data, input);
    assert.equal(layers[0]?.path, "tour.kml");
    assert.equal(layers[0]?.groupPath, undefined);
    assert.equal(layers[0]?.name, undefined);
  });

  it("gives each foldered placemark its own named layer and group path", () => {
    const layers = splitKmlFolderLayers(
      collection([
        placemark("Point A", ["Project X", "Subfolder A"]),
        placemark("Point A-1", ["Project X", "Subfolder A", "Subfolder A-1"]),
      ]),
      "tour.kml",
    );

    assert.equal(layers.length, 2);
    // Store insertion is top-first, so the layers come back in reverse document
    // order and the first placemark ends up on top.
    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["Point A-1", "Point A"],
    );
    assert.deepEqual(layers[0]?.groupPath, ["Project X", "Subfolder A", "Subfolder A-1"]);
    assert.deepEqual(layers[1]?.groupPath, ["Project X", "Subfolder A"]);
    assert.equal(layers[0]?.data.features.length, 1);
    assert.equal(layers[1]?.path, "tour.kml");
  });

  it("names an unnamed placemark by its position in the document", () => {
    const layers = splitKmlFolderLayers(
      collection([placemark(undefined, ["Folder"]), placemark("  ", ["Folder"])]),
      "tour.kml",
    );

    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["Placemark 2", "Placemark 1"],
    );
  });

  it("strips the internal folder property from the split features", () => {
    const layers = splitKmlFolderLayers(collection([placemark("A", ["Folder"])]), "tour.kml");

    assert.equal(layers[0]?.data.features[0]?.properties?.[KML_FOLDER_PATH_PROPERTY], undefined);
    assert.equal(layers[0]?.data.features[0]?.properties?.name, "A");
  });

  it("keeps placemarks outside any folder merged into a single layer", () => {
    const layers = splitKmlFolderLayers(
      collection([
        placemark("Flat 1"),
        placemark("Foldered", ["Folder"]),
        placemark("Flat 2"),
        placemark("Flat 3"),
      ]),
      "tour.kml",
    );

    assert.equal(layers.length, 2);
    // The merged layer is added first so the folders settle above it, and it
    // carries no name so the import falls back to the file name.
    assert.equal(layers[0]?.name, undefined);
    assert.equal(layers[0]?.groupPath, undefined);
    assert.deepEqual(
      layers[0]?.data.features.map((feature) => feature.properties?.name),
      ["Flat 1", "Flat 2", "Flat 3"],
    );
    assert.equal(layers[1]?.name, "Foldered");
    assert.deepEqual(layers[1]?.groupPath, ["Folder"]);
  });

  it("ignores blank folder names", () => {
    const layers = splitKmlFolderLayers(
      collection([placemark("A", ["", "  "]), placemark("B", ["Folder"])]),
      "tour.kml",
    );

    // "A" has no usable ancestry left, so it stays in the merged layer.
    assert.equal(layers.length, 2);
    assert.deepEqual(
      layers[0]?.data.features.map((feature) => feature.properties?.name),
      ["A"],
    );
    assert.deepEqual(layers[1]?.groupPath, ["Folder"]);
  });
});
