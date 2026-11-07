import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import {
  collectLevels,
  compileLayerFilters,
  compileLevelFilter,
  currentLevelChoice,
  featureLevel,
  guessLevelField,
  hasActiveLayerFilter,
  levelValueMatches,
  matchingLevelValues,
  mergeLevels,
  parseLevelValue,
  resolveLevelLinks,
  selectLevel,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";

function feature(level: unknown) {
  return {
    type: "Feature" as const,
    properties: { level, name: `room ${String(level)}` },
    geometry: { type: "Point" as const, coordinates: [0, 0] },
  };
}

/** OSM-style indoor rooms: text levels, one spanning two floors, one a range. */
const ROOMS = [
  feature("-1"),
  feature("-1"),
  feature("0"),
  feature("0;1"),
  feature("1"),
  feature("-1-0"),
];

/** Evaluate a compiled filter the way every renderer does (style-spec). */
function matches(filter: unknown[] | null, level: unknown): boolean {
  if (filter === null) return true;
  const compiled = featureFilter(filter as never, "layers[0].filter");
  return compiled.filter(
    { zoom: 18 } as never,
    {
      type: 1,
      properties: { level },
      geometry: [],
    } as never,
  );
}

describe("parseLevelValue", () => {
  it("reads numbers, OSM lists, spans and named floors", () => {
    assert.deepEqual(
      parseLevelValue("0;1").map((token) => token.label),
      ["0", "1"],
    );
    assert.deepEqual(
      parseLevelValue("-2--1").map((token) => token.ordinal),
      [-2, -1],
    );
    assert.deepEqual(
      parseLevelValue("-1-1").map((token) => token.ordinal),
      [-1, 0, 1],
    );
    assert.deepEqual(parseLevelValue(3), [{ label: "3", ordinal: 3 }]);
    assert.deepEqual(parseLevelValue("01"), [{ label: "1", ordinal: 1 }]);
    assert.deepEqual(parseLevelValue(" G "), [{ label: "G", ordinal: null }]);
    assert.deepEqual(parseLevelValue(null), []);
    assert.deepEqual(parseLevelValue(true), []);
    assert.deepEqual(parseLevelValue(" ; "), []);
  });

  it("reads a span past the safe-integer range as its ends instead of looping", () => {
    const tokens = parseLevelValue("9007199254740992-9007199254740992");
    assert.equal(tokens.length, 2);
  });
});

describe("collectLevels", () => {
  it("lists floors top down with feature counts", () => {
    const levels = collectLevels(ROOMS, "level");
    assert.deepEqual(
      levels.map((entry) => [entry.label, entry.count]),
      [
        ["1", 2],
        ["0", 3],
        ["-1", 3],
      ],
    );
  });

  it("puts named floors after numbered ones", () => {
    const levels = collectLevels([feature("G"), feature("2"), feature("B")], "level");
    assert.deepEqual(
      levels.map((entry) => entry.label),
      ["2", "B", "G"],
    );
  });

  it("merges several layers' floors", () => {
    const merged = mergeLevels([
      collectLevels([feature("0"), feature("1")], "level"),
      collectLevels([feature(0), feature(2)], "level"),
    ]);
    assert.deepEqual(
      merged.map((entry) => [entry.label, entry.count]),
      [
        ["2", 1],
        ["1", 1],
        ["0", 2],
      ],
    );
  });
});

describe("level matching", () => {
  it("matches one floor, including features that span it", () => {
    assert.equal(levelValueMatches("0;1", "1", "only"), true);
    assert.equal(levelValueMatches("-1-0", "0", "only"), true);
    assert.equal(levelValueMatches("-1", "0", "only"), false);
    assert.equal(levelValueMatches(0, "0", "only"), true);
    assert.equal(levelValueMatches("G", "G", "only"), true);
  });

  it("matches the floors below in below mode", () => {
    assert.equal(levelValueMatches("-1", "0", "below"), true);
    assert.equal(levelValueMatches("1", "0", "below"), false);
    assert.equal(levelValueMatches("0;1", "0", "below"), true);
    // A named floor has no order, so below mode matches only itself.
    assert.equal(levelValueMatches("B", "G", "below"), false);
  });

  it("resolves the distinct raw values that match", () => {
    assert.deepEqual(matchingLevelValues(ROOMS, "level", "0", "only"), ["0", "0;1", "-1-0"]);
    assert.deepEqual(matchingLevelValues(ROOMS, "level", "0", "below"), ["-1", "0", "0;1", "-1-0"]);
  });
});

describe("compileLevelFilter", () => {
  it("compiles to nothing until a floor is chosen", () => {
    assert.equal(compileLevelFilter(undefined), null);
    assert.equal(compileLevelFilter({ field: "level" }), null);
    assert.equal(compileLevelFilter({ field: "level", mode: "all", level: null }), null);
    // A chosen floor whose values are not resolved yet draws every floor.
    assert.equal(compileLevelFilter({ field: "level", mode: "only", level: "0" }), null);
  });

  it("draws exactly the chosen floor through the style-spec evaluator", () => {
    const link = selectLevel({ field: "level" }, ROOMS, "0", "only");
    const filter = compileLevelFilter(link);
    assert.equal(matches(filter, "0"), true);
    assert.equal(matches(filter, "0;1"), true);
    assert.equal(matches(filter, "-1"), false);
    assert.equal(matches(filter, "1"), false);
    assert.equal(matches(filter, undefined), false);
  });

  it("keeps numeric values numeric", () => {
    const features = [feature(0), feature(1), feature(2)];
    const filter = compileLevelFilter(selectLevel({ field: "level" }, features, "1", "below"));
    assert.equal(matches(filter, 0), true);
    assert.equal(matches(filter, 1), true);
    assert.equal(matches(filter, 2), false);
  });

  it("matches a layer whose level values mix numbers and text", () => {
    const features = [feature(0), feature("0;1"), feature("1")];
    const link = selectLevel({ field: "level" }, features, "0", "only");
    assert.deepEqual(link.values, [0, "0;1"]);
    const filter = compileLevelFilter(link);
    assert.equal(matches(filter, 0), true);
    assert.equal(matches(filter, "0;1"), true);
    assert.equal(matches(filter, "1"), false);
  });

  it("draws nothing for a floor with no features", () => {
    const filter = compileLevelFilter(selectLevel({ field: "level" }, ROOMS, "7", "only"));
    assert.equal(matches(filter, "0"), false);
  });

  it("joins the layer's other filters but not the filtered indicator", () => {
    const link = selectLevel({ field: "level" }, ROOMS, "1", "only");
    const layer = { filterExpression: ["has", "name"], levelFilter: link };
    const composed = compileLayerFilters(layer);
    assert.equal(composed?.[0], "all");
    assert.equal(composed?.length, 3);
    assert.equal(hasActiveLayerFilter({ levelFilter: link }), false);
    assert.equal(hasActiveLayerFilter(layer), true);
  });
});

describe("guessLevelField", () => {
  it("prefers the usual floor fields, case-insensitively", () => {
    assert.equal(guessLevelField(["name", "LEVEL", "id"]), "LEVEL");
    assert.equal(guessLevelField(["name", "ordinal", "floor"]), "ordinal");
    assert.equal(guessLevelField(["name", "height"]), null);
  });
});

describe("setLevelSelection", () => {
  function layer(id: string, levels: unknown[], linked: boolean): GeoLibreLayer {
    return {
      id,
      name: id,
      type: "geojson",
      visible: true,
      opacity: 1,
      source: {},
      metadata: {},
      style: {},
      geojson: { type: "FeatureCollection", features: levels.map(feature) },
      ...(linked ? { levelFilter: { field: "level" } } : {}),
    } as unknown as GeoLibreLayer;
  }

  beforeEach(() => {
    useAppStore.setState({
      layers: [
        layer("rooms", ["0", "1"], true),
        layer("doors", [0, 1], true),
        layer("roads", [0], false),
      ],
      isDirty: false,
    });
  });

  it("narrows every linked layer from its own features in one update", () => {
    useAppStore.getState().setLevelSelection("1", "only");
    const [rooms, doors, roads] = useAppStore.getState().layers;
    assert.deepEqual(rooms.levelFilter, {
      field: "level",
      mode: "only",
      level: "1",
      values: ["1"],
    });
    assert.deepEqual(doors.levelFilter, { field: "level", mode: "only", level: "1", values: [1] });
    assert.equal(roads.levelFilter, undefined);
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("shows every floor again", () => {
    useAppStore.getState().setLevelSelection("1", "below");
    useAppStore.getState().setLevelSelection(null, "all");
    const [rooms] = useAppStore.getState().layers;
    assert.deepEqual(rooms.levelFilter, { field: "level", mode: "all", level: null });
    assert.equal(compileLevelFilter(rooms.levelFilter), null);
  });

  it("unlinks a layer", () => {
    useAppStore.getState().setLayerLevelFilter("rooms", null);
    assert.equal(useAppStore.getState().layers[0].levelFilter, undefined);
  });
});

describe("unresolved and re-resolved links", () => {
  it("leaves the values unresolved without local features", () => {
    const link = selectLevel({ field: "level" }, undefined, "0", "only");
    assert.deepEqual(link, { field: "level", mode: "only", level: "0" });
    assert.equal(compileLevelFilter(link), null);
  });

  it("puts a newly linked layer on the floor in view", () => {
    const rooms = {
      id: "rooms",
      levelFilter: selectLevel({ field: "level" }, ROOMS, "1", "below"),
      geojson: { features: ROOMS },
    };
    const doors = {
      id: "doors",
      levelFilter: { field: "level" },
      geojson: { features: [feature(0), feature(2)] },
    };
    assert.deepEqual(currentLevelChoice([doors, rooms]), { level: "1", mode: "below" });
    assert.deepEqual(resolveLevelLinks([rooms, doors]), [
      { id: "doors", levelFilter: { field: "level", mode: "below", level: "1", values: [0] } },
    ]);
  });

  it("re-resolves the values when the layer's data changes", () => {
    // A project authored without the values (or before an edit added a floor).
    const stale = { field: "level", mode: "only" as const, level: "0" };
    const replaced = [feature("0"), feature("0;1"), feature("-1")];
    const [update] = resolveLevelLinks([
      { id: "rooms", levelFilter: stale, geojson: { features: replaced } },
    ]);
    assert.deepEqual(update.levelFilter.values, ["0", "0;1"]);
    const composed = compileLayerFilters({ levelFilter: update.levelFilter });
    assert.equal(matches(composed, "0;1"), true);
    assert.equal(matches(composed, "-1"), false);
    // Already current: nothing to write.
    assert.deepEqual(
      resolveLevelLinks([
        { id: "rooms", levelFilter: update.levelFilter, geojson: { features: replaced } },
      ]),
      [],
    );
  });
});

describe("reconcileLevelLinks", () => {
  it("writes re-resolved links without marking the project unsaved", () => {
    useAppStore.setState({
      layers: [
        {
          id: "rooms",
          name: "rooms",
          type: "geojson",
          visible: true,
          opacity: 1,
          source: {},
          metadata: {},
          style: {},
          geojson: { type: "FeatureCollection", features: ROOMS },
          levelFilter: { field: "level", mode: "only", level: "1" },
        } as unknown as GeoLibreLayer,
      ],
      isDirty: false,
    });
    const updates = resolveLevelLinks(useAppStore.getState().layers);
    useAppStore.getState().reconcileLevelLinks(updates);
    assert.deepEqual(useAppStore.getState().layers[0].levelFilter?.values, ["0;1", "1"]);
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("does not throw on a hand-edited link whose values are not a list", () => {
    const bad = { field: "level", mode: "only" as const, level: "0", values: "ab" as never };
    assert.doesNotThrow(() =>
      resolveLevelLinks([
        { id: "x", levelFilter: bad, geojson: { features: [feature("0"), feature("1")] } },
      ]),
    );
  });
});

describe("floor picker bookkeeping", () => {
  it("keeps a saved link while the layer's data is still loading", () => {
    const saved = { field: "level", mode: "only" as const, level: "0", values: ["0"] };
    assert.deepEqual(resolveLevelLinks([{ id: "rooms", levelFilter: saved }]), []);
  });

  it("does not mark the project unsaved when the floor shown is chosen again", () => {
    useAppStore.setState({
      layers: [
        {
          id: "rooms",
          name: "rooms",
          type: "geojson",
          visible: true,
          opacity: 1,
          source: {},
          metadata: {},
          style: {},
          geojson: { type: "FeatureCollection", features: ROOMS },
          levelFilter: { field: "level" },
        } as unknown as GeoLibreLayer,
      ],
      isDirty: false,
    });
    useAppStore.getState().setLevelSelection("1", "only");
    useAppStore.setState({ isDirty: false });
    const before = useAppStore.getState().layers;
    useAppStore.getState().setLevelSelection("1", "only");
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.getState().layers, before);
  });
});

describe("clampFloorListHeight", () => {
  it("keeps at least three floors and stays within the room the map leaves", async () => {
    const { clampFloorListHeight } =
      await import("../apps/geolibre-desktop/src/components/floor-picker/floor-list-size");
    assert.equal(clampFloorListHeight(10, 25, 600), 75);
    assert.equal(clampFloorListHeight(400, 25, 600), 400);
    assert.equal(clampFloorListHeight(5000, 25, 600), 600);
    // Too little room keeps the three-floor minimum.
    assert.equal(clampFloorListHeight(400, 25, 40), 75);
    assert.equal(clampFloorListHeight(5000, 25, null), 5000);
  });
});

describe("featureLevel", () => {
  it("names the first listed floor a feature is on", () => {
    const levels = collectLevels(ROOMS, "level");
    assert.equal(featureLevel("1", levels), "1");
    assert.equal(featureLevel("0;1", levels), "0");
    assert.equal(featureLevel(0, levels), "0");
    assert.equal(featureLevel("7", levels), null);
    // An unlisted first floor is skipped for the next one the picker lists.
    assert.equal(featureLevel("7;1", levels), "1");
    assert.equal(featureLevel(null, levels), null);
  });
});
