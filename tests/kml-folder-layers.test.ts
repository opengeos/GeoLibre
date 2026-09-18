import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { KML_FOLDER_PATH_PROPERTY, KML_TIME_PROPERTY } from "../apps/geolibre-desktop/src/lib/kml";

// tauri-io statically pulls in shpjs, whose bundle reads the browser `self`
// global at module-eval time; shim it before the dynamic import.
(globalThis as { self?: unknown }).self ??= globalThis;

type SplitKmlFolderLayers =
  typeof import("../apps/geolibre-desktop/src/lib/tauri-io").splitKmlFolderLayers;

type TauriIo = typeof import("../apps/geolibre-desktop/src/lib/tauri-io");

let splitKmlFolderLayers: SplitKmlFolderLayers;
let sequenceTimeFrames: TauriIo["sequenceTimeFrames"];
let placemarkLayerLimit: number;
let timeFrameLayerLimit: number;

before(async () => {
  const mod = await import("../apps/geolibre-desktop/src/lib/tauri-io");
  splitKmlFolderLayers = mod.splitKmlFolderLayers;
  sequenceTimeFrames = mod.sequenceTimeFrames;
  placemarkLayerLimit = mod.KML_PLACEMARK_LAYER_LIMIT;
  timeFrameLayerLimit = mod.KML_TIME_FRAME_LAYER_LIMIT;
});

/** A point placemark, optionally inside the given KML Folder ancestry and time window. */
function placemark(
  name: string | undefined,
  folders?: string[],
  time?: { begin: number | null; end: number | null },
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      ...(name === undefined ? {} : { name }),
      ...(folders ? { [KML_FOLDER_PATH_PROPERTY]: folders } : {}),
      ...(time ? { [KML_TIME_PROPERTY]: time } : {}),
    },
  };
}

const HOUR = 3_600_000;
const T0 = Date.UTC(2024, 0, 1);

/** `count` placemarks named `${prefix} n`, all in one folder and time window. */
function placemarks(
  count: number,
  prefix: string,
  folders: string[],
  time?: { begin: number | null; end: number | null },
): Feature[] {
  return Array.from({ length: count }, (_, index) =>
    placemark(`${prefix} ${index}`, folders, time),
  );
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

  it("merges placemarks into one layer per folder above the per-placemark limit", () => {
    const layers = splitKmlFolderLayers(
      collection([
        ...placemarks(placemarkLayerLimit, "a", ["Root", "A"]),
        ...placemarks(2, "b", ["Root", "B"]),
      ]),
      "big.kml",
    );

    // Store insertion is top-first, so the folders come back in reverse order.
    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.groupPath, layer.data.features.length]),
      [
        ["B", ["Root"], 2],
        ["A", ["Root"], placemarkLayerLimit],
      ],
    );
    assert.equal(layers[1]?.data.features[0]?.properties?.[KML_FOLDER_PATH_PROPERTY], undefined);
  });

  it("keeps a merged folder as a group when it also has sub-folders", () => {
    const layers = splitKmlFolderLayers(
      collection([
        ...placemarks(placemarkLayerLimit, "root", ["Root"]),
        ...placemarks(1, "child", ["Root", "Child"]),
      ]),
      "big.kml",
    );

    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.groupPath]),
      [
        ["Child", ["Root"]],
        ["Root", ["Root"]],
      ],
    );
  });

  it("turns time-step folders into Time Slider frames", () => {
    const steps = [0, 1, 2].map((step) => ({
      begin: T0 + step * HOUR,
      end: T0 + (step + 1) * HOUR,
    }));
    const layers = splitKmlFolderLayers(
      collection(
        steps.flatMap((time, step) =>
          placemarks(40, "tri", ["3D concentration isosurfaces", `Step ${step}`], time),
        ),
      ),
      "plume.kmz",
    );

    assert.equal(layers.length, 3);
    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.groupPath, layer.timeSpan, layer.visible]),
      [
        ["Step 2", ["3D concentration isosurfaces"], steps[2], false],
        ["Step 1", ["3D concentration isosurfaces"], steps[1], false],
        ["Step 0", ["3D concentration isosurfaces"], steps[0], true],
      ],
    );
    assert.ok(layers[0]?.groupId);
    assert.ok(layers.every((layer) => layer.groupId === layers[0]?.groupId));
    assert.equal(layers[0]?.data.features[0]?.properties?.[KML_TIME_PROPERTY], undefined);
  });

  it("gives small time-tagged placemark files per-placemark frames", () => {
    const layers = splitKmlFolderLayers(
      collection([
        placemark("First", ["Track"], { begin: T0, end: null }),
        placemark("Second", ["Track"], { begin: T0 + HOUR, end: null }),
      ]),
      "track.kml",
    );

    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.timeSpan, layer.visible]),
      [
        ["Second", { begin: T0 + HOUR, end: null }, false],
        ["First", { begin: T0, end: T0 + HOUR }, true],
      ],
    );
  });

  it("splits untimed and timed placemarks outside any folder", () => {
    const layers = splitKmlFolderLayers(
      collection([
        placemark("Static"),
        placemark("t0", undefined, { begin: T0, end: T0 + HOUR }),
        placemark("t1", undefined, { begin: T0 + HOUR, end: T0 + 2 * HOUR }),
      ]),
      "flat.kml",
    );

    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.timeSpan?.begin, layer.visible]),
      [
        ["2024-01-01 01:00", T0 + HOUR, false],
        ["2024-01-01", T0, true],
        [undefined, undefined, undefined],
      ],
    );
  });

  it("loads too many distinct times as static layers instead of one layer per time", () => {
    // A flat GPS track: every point carries its own <TimeStamp>, no Folder.
    const track = Array.from({ length: timeFrameLayerLimit + 1 }, (_, index) =>
      placemark(`Point ${index}`, undefined, { begin: T0 + index * HOUR, end: null }),
    );
    const warn = console.warn;
    console.warn = () => {};
    try {
      const layers = splitKmlFolderLayers(collection(track), "track.kml");

      assert.equal(layers.length, 1);
      assert.equal(layers[0]?.data.features.length, timeFrameLayerLimit + 1);
      assert.equal(layers[0]?.timeSpan, undefined);
      assert.equal(layers[0]?.data.features[0]?.properties?.[KML_TIME_PROPERTY], undefined);
    } finally {
      console.warn = warn;
    }
  });

  it("does not animate placemarks that all share one inherited time", () => {
    const time = { begin: T0, end: null };
    const layers = splitKmlFolderLayers(
      collection([placemark("A", undefined, time), placemark("B", undefined, time)]),
      "static.kml",
    );

    assert.equal(layers.length, 1);
    assert.equal(layers[0]?.timeSpan, undefined);
    assert.equal(layers[0]?.visible, undefined);
    assert.equal(layers[0]?.data.features[0]?.properties?.[KML_TIME_PROPERTY], undefined);
  });
});

describe("sequenceTimeFrames", () => {
  it("steps frames that share a start time together", () => {
    const frames = sequenceTimeFrames([
      { timeSpan: { begin: T0 + HOUR, end: null } },
      { timeSpan: { begin: T0, end: null } },
      { timeSpan: { begin: T0, end: null } },
    ]);

    assert.deepEqual(
      frames.map((frame) => [frame.timeSpan, frame.visible]),
      [
        [{ begin: T0 + HOUR, end: null }, false],
        [{ begin: T0, end: T0 + HOUR }, true],
        [{ begin: T0, end: T0 + HOUR }, true],
      ],
    );
  });
});
