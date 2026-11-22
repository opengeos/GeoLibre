import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";
import { type Command, rankCommands } from "../apps/geolibre-desktop/src/lib/commands";
import type { FeatureSearchMatch } from "../apps/geolibre-desktop/src/lib/feature-search";
import {
  MAX_LAYER_RESULTS,
  mergePaletteResults,
  type PaletteSearchOptions,
  paletteFeatureResults,
  paletteLayerResults,
  palettePlaceResult,
  refineFeatureResults,
} from "../apps/geolibre-desktop/src/lib/palette-search";

/** Build a point feature carrying `properties`. */
function point(properties: Record<string, unknown>, id?: string): Feature {
  return {
    type: "Feature",
    ...(id === undefined ? {} : { id }),
    properties,
    geometry: { type: "Point", coordinates: [0, 0] },
  };
}

/** Build a minimal store layer, a GeoJSON one when `features` is given. */
function layer(
  id: string,
  name: string,
  features?: Feature[],
  overrides: Partial<GeoLibreLayer> = {},
): GeoLibreLayer {
  const geojson: FeatureCollection | undefined = features
    ? { type: "FeatureCollection", features }
    : undefined;
  return {
    id,
    name,
    type: features ? "geojson" : "vector-tile",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    geojson,
    ...overrides,
  } as GeoLibreLayer;
}

/** Records what each result's run() was asked to do. */
function harness(overrides: Partial<PaletteSearchOptions> = {}) {
  const calls: string[] = [];
  const features: FeatureSearchMatch[] = [];
  const options: PaletteSearchOptions = {
    actions: {
      openLayer: (id) => calls.push(`layer:${id}`),
      openFeature: (match) => {
        features.push(match);
        calls.push(`feature:${match.layerId}:${match.featureId}`);
      },
      searchPlace: (query) => calls.push(`place:${query}`),
    },
    labels: {
      layersGroup: "Layers",
      featuresGroup: (name, partial) => `Features in ${name}${partial ? " (partial)" : ""}`,
      placesGroup: "Places",
      searchPlace: (query) => `Search places for “${query}”`,
    },
    ...overrides,
  };
  return { calls, features, options };
}

const PARCELS = layer("parcels", "Parcels 2024", [
  point({ pin: "14-200-001", owner: "Maple Holdings LLC" }, "a"),
  point({ pin: "14-200-002", owner: "Riverside Farm" }, "b"),
  point({ pin: "15-001-900", owner: "City of Maplewood" }, "c"),
]);
const ROADS = layer("roads", "Roads", [point({ name: "Maple Avenue" }, "r1")]);
const BASEMAP_TILES = layer("tiles", "Parcel tiles");

describe("paletteLayerResults", () => {
  it("matches every query token in a layer name, in any order", () => {
    const { options } = harness();
    const titles = (query: string) =>
      paletteLayerResults([PARCELS, ROADS], query, options).map((r) => r.command.title);
    assert.deepEqual(titles("parcels"), ["Parcels 2024"]);
    assert.deepEqual(titles("2024 parcels"), ["Parcels 2024"]);
    assert.deepEqual(titles("parcels 2023"), []);
  });

  it("ranks an exact name, then a name prefix, then any other match", () => {
    const { options } = harness();
    const layers = [layer("1", "Old roads"), layer("2", "Roads and rail"), layer("3", "Roads")];
    const results = paletteLayerResults(layers, "roads", options);
    assert.deepEqual(
      results.map((r) => [r.command.title, r.rank]),
      [
        ["Roads", 0],
        ["Roads and rail", 1],
        ["Old roads", 2],
      ],
    );
  });

  it("lists tile layers too, which carry no features but can still be framed", () => {
    const { options } = harness();
    const results = paletteLayerResults([BASEMAP_TILES], "parcel", options);
    assert.deepEqual(
      results.map((r) => r.command.title),
      ["Parcel tiles"],
    );
  });

  it("keeps at most MAX_LAYER_RESULTS, best first", () => {
    const { options } = harness();
    const many = Array.from({ length: MAX_LAYER_RESULTS + 4 }, (_, i) =>
      layer(`l${i}`, `Zone ${i}`),
    );
    many.push(layer("exact", "zone"));
    const results = paletteLayerResults(many, "zone", options);
    assert.equal(results.length, MAX_LAYER_RESULTS);
    assert.equal(results[0].command.id, "palette-layer:exact");
  });

  it("selects the layer when run, under the Layers heading", () => {
    const { options, calls } = harness();
    const [result] = paletteLayerResults([ROADS], "roads", options);
    assert.equal(result.command.group, "Layers");
    result.command.run();
    assert.deepEqual(calls, ["layer:roads"]);
  });

  it("matches nothing for a blank query", () => {
    const { options } = harness();
    assert.deepEqual(paletteLayerResults([ROADS], "   ", options), []);
  });
});

describe("paletteFeatureResults", () => {
  it("lists matching values under a heading per layer, with the field as detail", () => {
    const { options } = harness();
    const results = paletteFeatureResults([PARCELS, ROADS], "maple", options);
    assert.deepEqual(
      results.map((r) => [r.command.group, r.command.title, r.command.detail, r.rank]),
      [
        ["Features in Parcels 2024", "Maple Holdings LLC", "owner", 1],
        ["Features in Parcels 2024", "City of Maplewood", "owner", 2],
        ["Features in Roads", "Maple Avenue", "name", 1],
      ],
    );
  });

  it("ranks an exact value 0, like an exact command title", () => {
    const { options } = harness();
    const [result] = paletteFeatureResults([PARCELS], "14-200-002", options);
    assert.equal(result.command.title, "14-200-002");
    assert.equal(result.rank, 0);
  });

  it("selects the matched feature when run", () => {
    const { options, calls } = harness();
    const [result] = paletteFeatureResults([PARCELS], "riverside", options);
    result.command.run();
    assert.deepEqual(calls, ["feature:parcels:b"]);
  });

  it("gives every row a distinct id", () => {
    const { options } = harness();
    const ids = paletteFeatureResults([PARCELS, ROADS], "a", options).map((r) => r.command.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("skips a layer that is hidden, or inside a hidden group", () => {
    const { options } = harness();
    const hidden = layer("h", "Hidden", [point({ name: "Maple Court" })], { visible: false });
    const grouped = layer("g", "Grouped", [point({ name: "Maple Lane" })], { groupId: "grp" });
    const groups = [{ id: "grp", name: "Group", visible: false } as LayerGroup];
    assert.deepEqual(paletteFeatureResults([hidden, grouped], "maple", { ...options, groups }), []);
  });

  it("marks a layer whose scan stopped early as partial", () => {
    const { options } = harness();
    const results = paletteFeatureResults([PARCELS], "14", {
      ...options,
      featureOptions: { maxFeaturesPerLayer: 1 },
    });
    assert.equal(results[0].command.group, "Features in Parcels 2024 (partial)");
  });

  it("scans nothing for a one-character query", () => {
    const { options } = harness();
    assert.deepEqual(paletteFeatureResults([PARCELS], "m", options), []);
  });
});

describe("refineFeatureResults", () => {
  it("keeps only the previous scan's rows that match the query as typed now", () => {
    const { options } = harness();
    const earlier = paletteFeatureResults([PARCELS], "14-200", options);
    assert.deepEqual(
      earlier.map((r) => r.command.title),
      ["14-200-001", "14-200-002"],
    );
    const refined = refineFeatureResults(earlier, "14-200-002");
    assert.deepEqual(
      refined.map((r) => [r.command.title, r.rank]),
      [["14-200-002", 0]],
    );
  });

  it("ranks each carried-over row against the new query", () => {
    const { options } = harness();
    const earlier = paletteFeatureResults([PARCELS], "map", options);
    assert.deepEqual(
      refineFeatureResults(earlier, "maple").map((r) => [r.command.title, r.rank]),
      [
        ["Maple Holdings LLC", 1],
        ["City of Maplewood", 2],
      ],
    );
  });

  it("drops everything for a blank query", () => {
    const { options } = harness();
    assert.deepEqual(
      refineFeatureResults(paletteFeatureResults([PARCELS], "14", options), " "),
      [],
    );
  });
});

describe("palettePlaceResult", () => {
  it("offers one place search for the trimmed query, ranked below everything", () => {
    const { options, calls } = harness();
    const [result] = palettePlaceResult("  Lisbon, Portugal ", options);
    assert.equal(result.rank, 3);
    assert.equal(result.command.title, "Search places for “Lisbon, Portugal”");
    assert.equal(result.command.group, "Places");
    // Nothing is geocoded until the row is picked.
    assert.deepEqual(calls, []);
    result.command.run();
    assert.deepEqual(calls, ["place:Lisbon, Portugal"]);
  });

  it("is not offered for a one-character query, or when places are off", () => {
    const { options } = harness();
    assert.deepEqual(palettePlaceResult("s", options), []);
    assert.deepEqual(palettePlaceResult("lisbon", { ...options, places: false }), []);
  });
});

describe("mergePaletteResults", () => {
  const command = (id: string, title: string, group: string): Command => ({
    id,
    title,
    group,
    run: () => {},
  });
  const COMMANDS = [
    command("save", "Save project", "Project"),
    command("zoom", "Zoom to selection", "View"),
  ];
  const TOOLS = [
    command("slope", "Slope", "Terrain"),
    command("slope-plot", "Slope Vs Aspect Plot", "Terrain"),
    command("maple-tool", "Maple tool", "Tools"),
  ];

  /** Merge the three sources for `query` the way the palette does. */
  function merged(query: string, layers: GeoLibreLayer[]): string[] {
    const { options } = harness();
    const results = [
      ...paletteLayerResults(layers, query, options),
      ...palettePlaceResult(query, options),
      ...paletteFeatureResults(layers, query, options),
    ];
    return mergePaletteResults(
      rankCommands(COMMANDS, query),
      results,
      rankCommands(TOOLS, query),
    ).map((c) => c.title);
  }

  it("keeps a matching command first, and the place search last", () => {
    assert.deepEqual(merged("save", [layer("s", "Saved sites")]), [
      "Save project",
      "Saved sites",
      "Search places for “save”",
    ]);
  });

  it("lists a matching layer and feature ahead of a tool that matches as well", () => {
    const roads = layer("m", "Maple roads", [point({ name: "Maple Avenue" }, "x")]);
    assert.deepEqual(merged("maple", [roads]), [
      "Maple roads",
      "Maple Avenue",
      "Maple tool",
      "Search places for “maple”",
    ]);
  });

  it("still puts an exact tool name ahead of a value that only starts with the query", () => {
    const terrain = layer("t", "Terrain", [point({ class: "Slope over 30%" }, "x")]);
    assert.deepEqual(merged("slope", [terrain]), [
      "Slope",
      "Slope Vs Aspect Plot",
      "Slope over 30%",
      "Search places for “slope”",
    ]);
  });

  it("answers a query no command matches with data and places alone", () => {
    assert.deepEqual(merged("14-200-001", [PARCELS]), [
      "14-200-001",
      "Search places for “14-200-001”",
    ]);
  });
});
