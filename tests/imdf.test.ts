import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isImdfArchive,
  localizedText,
  parseImdfArchive,
} from "../apps/geolibre-desktop/src/lib/imdf";

const square = (x: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ],
  ],
});
const point = (x: number) => ({ type: "Point", coordinates: [x, 0.5] });

function collection(featureType: string, features: Array<Record<string, unknown>>) {
  return JSON.stringify({
    type: "FeatureCollection",
    features: features.map(({ id, geometry, ...properties }) => ({
      type: "Feature",
      id,
      feature_type: featureType,
      geometry: geometry ?? null,
      properties,
    })),
  });
}

/** A two-storey venue in the shape of Apple's IMDF sample archives. */
function archive(): Map<string, string> {
  return new Map([
    ["IMDF/manifest.json", JSON.stringify({ version: "1.0.0", language: "fr" })],
    [
      "IMDF/venue.geojson",
      collection("venue", [
        { id: "v", geometry: square(0), name: { en: "Museum", fr: "Musée" }, category: "museum" },
      ]),
    ],
    [
      "IMDF/level.geojson",
      collection("level", [
        { id: "L0", geometry: square(0), ordinal: 0, short_name: { fr: "RDC" }, outdoor: false },
        { id: "L1", geometry: square(0), ordinal: 1, short_name: { "fr-CA": "1" }, outdoor: false },
        { id: "L1o", geometry: square(2), ordinal: 1, name: { en: "Terrace" }, outdoor: true },
      ]),
    ],
    [
      "IMDF/unit.geojson",
      collection("unit", [
        {
          id: "u0",
          geometry: square(0),
          level_id: "L0",
          category: "room",
          name: { fr: "Hall" },
          display_point: point(0),
        },
        { id: "u1", geometry: square(0), level_id: "L1", category: "room", name: null },
        { id: "u2", geometry: square(2), level_id: "L1o", category: "walkway" },
        { id: "u-orphan", geometry: square(4), level_id: "missing", category: "room" },
      ]),
    ],
    [
      "IMDF/amenity.geojson",
      collection("amenity", [
        { id: "a", geometry: point(0), category: "elevator", unit_ids: ["nope", "u1"] },
      ]),
    ],
    [
      "IMDF/anchor.geojson",
      collection("anchor", [{ id: "an", geometry: point(1), unit_id: "u0" }]),
    ],
    [
      "IMDF/occupant.geojson",
      collection("occupant", [
        { id: "o", geometry: null, anchor_id: "an", name: { fr: "Café" }, category: "restaurant" },
        { id: "o-lost", geometry: null, anchor_id: "none", name: { fr: "Lost" } },
      ]),
    ],
    [
      "IMDF/address.geojson",
      collection("address", [{ id: "ad", geometry: null, address: "1 Main St" }]),
    ],
  ]);
}

describe("isImdfArchive", () => {
  it("needs a manifest and a core feature file", () => {
    assert.equal(isImdfArchive(["x/manifest.json", "x/unit.geojson"]), true);
    assert.equal(isImdfArchive(["manifest.json", "venue.geojson"]), true);
    assert.equal(isImdfArchive(["unit.geojson", "level.geojson"]), false);
    assert.equal(isImdfArchive(["manifest.json", "roads.shp"]), false);
  });
});

describe("localizedText", () => {
  it("prefers the language, then its base language, then any text", () => {
    assert.equal(localizedText({ en: "Hall", fr: "Salle" }, "fr"), "Salle");
    assert.equal(localizedText({ "fr-CA": "Salle" }, "fr"), "Salle");
    assert.equal(localizedText({ de: "Halle" }, "fr"), "Halle");
    assert.equal(localizedText("plain", "fr"), "plain");
    assert.equal(localizedText(null, "fr"), null);
  });
});

describe("parseImdfArchive", () => {
  const result = parseImdfArchive(archive());
  const layer = (type: string) => result.layers.find((item) => item.featureType === type);

  it("reads the venue name, language and ordinal range", () => {
    assert.equal(result.venueName, "Musée");
    assert.equal(result.language, "fr");
    assert.deepEqual(result.ordinalRange, { min: 0, max: 1 });
  });

  it("orders the layers bottom first and skips reference records", () => {
    assert.deepEqual(
      result.layers.map((item) => item.featureType),
      ["venue", "level", "unit", "amenity", "occupant"],
    );
  });

  it("joins each unit to its level's ordinal and name", () => {
    const units = layer("unit")!.geojson.features.map((feature) => feature.properties);
    assert.deepEqual(
      units.map((props) => [props.id, props.ordinal, props.level_name, props.outdoor]),
      [
        ["u0", 0, "RDC", undefined],
        ["u1", 1, "1", undefined],
        ["u2", 1, "Terrace", true],
        ["u-orphan", undefined, undefined, undefined],
      ],
    );
    assert.equal(units[0].name, "Hall");
    assert.equal("display_point" in units[0], false);
    assert.equal(units[0].feature_type, "unit");
    assert.equal(layer("unit")!.onLevels, true);
    assert.equal(layer("venue")!.onLevels, false);
  });

  it("puts an amenity on the floor of the first unit it names that has one", () => {
    const [amenity] = layer("amenity")!.geojson.features;
    assert.equal(amenity.properties.ordinal, 1);
    // Arrays become JSON text so the attribute table shows them.
    assert.equal(amenity.properties.unit_ids, '["nope","u1"]');
  });

  it("draws an occupant at its anchor on the anchor's unit's floor", () => {
    const occupants = layer("occupant")!.geojson.features;
    assert.equal(occupants.length, 1);
    assert.deepEqual(occupants[0].geometry, point(1));
    assert.equal(occupants[0].properties.name, "Café");
    assert.equal(occupants[0].properties.ordinal, 0);
  });

  it("reports a broken feature file by name", () => {
    const files = archive();
    files.set("IMDF/unit.geojson", "{oops");
    assert.throws(
      () => parseImdfArchive(files),
      /IMDF archive could not be read: unit\.geojson is not valid JSON/,
    );
  });
});

describe("readImdfZip", () => {
  it("reads a zipped archive and ignores other zips", async () => {
    const { strToU8, zipSync } = await import("fflate");
    const { readImdfZip } = await import("../apps/geolibre-desktop/src/lib/imdf");
    const entries: Record<string, Uint8Array> = {};
    for (const [path, text] of archive()) entries[path] = strToU8(text);
    entries["__MACOSX/IMDF/._unit.geojson"] = strToU8("not json");
    const result = readImdfZip(zipSync(entries));
    assert.equal(result?.venueName, "Musée");
    assert.equal(
      result?.layers.find((layer) => layer.featureType === "unit")?.geojson.features.length,
      4,
    );
    assert.equal(
      readImdfZip(zipSync({ "roads.shp": strToU8("x"), "roads.dbf": strToU8("y") })),
      null,
    );
  });
});

describe("imdfLoadedLayers", () => {
  it("stacks units from the ordinal and links every floor layer to the picker", async () => {
    const { imdfLoadedLayers, IMDF_FLOOR_SPACING } =
      await import("../apps/geolibre-desktop/src/lib/imdf-layers");
    const files = archive();
    // A basement makes the lowest floor -1, so the stack is lifted by one floor.
    files.set(
      "IMDF/level.geojson",
      collection("level", [
        { id: "L0", geometry: square(0), ordinal: -1, short_name: { fr: "S" } },
        { id: "L1", geometry: square(0), ordinal: 1, short_name: { fr: "1" } },
      ]),
    );
    const layers = imdfLoadedLayers(parseImdfArchive(files), "/data/museum.zip");
    const byEntry = new Map(layers.map((layer) => [layer.sourceEntry, layer]));
    const units = byEntry.get("imdf:unit")!;
    assert.equal(units.style?.extrusionEnabled, true);
    assert.equal(units.style?.extrusionBaseProperty, "ordinal");
    assert.equal(units.style?.extrusionBaseScale, IMDF_FLOOR_SPACING);
    assert.equal(units.style?.extrusionBase, IMDF_FLOOR_SPACING);
    assert.deepEqual(units.filterExpression, ["!=", ["get", "category"], "opentobelow"]);
    assert.deepEqual(units.levelFilter, { field: "ordinal", mode: "all", level: null });
    assert.match(units.style?.extrusionColorExpression ?? "", /"match"/);
    // The venue outline is not on a floor, so it stays out of the picker.
    assert.equal(byEntry.get("imdf:venue")!.levelFilter, undefined);
    assert.equal(byEntry.get("imdf:venue")!.style?.extrusionEnabled, undefined);
    for (const layer of layers) {
      assert.deepEqual(layer.groupPath, ["Musée"]);
      assert.equal(layer.path, "/data/museum.zip");
    }
  });
});
