import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPMTilesArchiveLayers,
  type PMTilesStoreLayerOptions,
} from "../packages/map/src/pmtiles-layer";
import {
  externalSourceIdsFor,
  hasPMTilesArchive,
  registerPMTilesArchive,
  removeLayerFromMap,
} from "../packages/map/src/layer-sync";
import {
  blendModeForNativeLayer,
  resetLayerBlendModes,
  syncLayerBlendModes,
} from "../packages/map/src/layer-blend-modes";

const archive: PMTilesStoreLayerOptions = {
  id: "grid",
  name: "MGRS grid",
  url: "https://example.org/mgrs.pmtiles",
  tileType: "vector",
  sourceLayers: ["gzd", "hundredkm", "labels"],
  sourceLayerColors: { gzd: "#b23434", hundredkm: "#3cdd6b", labels: "#8311d4" },
};

// An archive is several things. Expanded into a layer each, the panel can name, reorder, style and
// hide them with what it already has — but they draw from one source, which is the part that needs
// care on both ends: sharing it, and not pulling it out from under the others.
describe("expanding an archive into a layer per source layer", () => {
  it("names each layer after the source layer it draws", () => {
    const layers = createPMTilesArchiveLayers(archive);
    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["gzd", "hundredkm", "labels"],
    );
    assert.deepEqual(
      layers.map((layer) => layer.source.sourceLayers),
      [["gzd"], ["hundredkm"], ["labels"]],
    );
  });

  it("gives each the colour the archive assigned it", () => {
    const layers = createPMTilesArchiveLayers(archive);
    assert.deepEqual(
      layers.map((layer) => layer.style.fillColor),
      ["#b23434", "#3cdd6b", "#8311d4"],
    );
  });

  it("puts them all on one MapLibre source", () => {
    const layers = createPMTilesArchiveLayers(archive);
    assert.deepEqual(new Set(layers.map((layer) => layer.metadata.sourceId)), new Set(["grid"]));
    // Both places name it: readers are split on which one they consult. `getPMTilesSourceId`
    // prefers the metadata, but `loadedVectorTileFeatures` reads `source.sourceId` alone and
    // swallows a bad id in a `catch` — a layer naming a source that does not exist would report
    // no features rather than fail, and the geometry backfill would infer nothing.
    assert.deepEqual(new Set(layers.map((layer) => layer.source.sourceId)), new Set(["grid"]));
    assert.equal(new Set(layers.map((layer) => layer.id)).size, 3, "but each is its own layer");
  });

  // `encodeVectorTileLayerPart` is not injective — `a/b` and `a_2Fb` both encode to `a_2Fb` — and an
  // archive's metadata can repeat a name outright. Either way a second layer would take the first
  // one's id, and the store would hold two layers answering to it.
  it("gives two source layers that would share an id a single layer", () => {
    const warn = console.warn;
    console.warn = () => {};
    let layers;
    try {
      layers = createPMTilesArchiveLayers({
        ...archive,
        sourceLayerColors: undefined,
        sourceLayers: ["a/b", "a_2Fb", "roads"],
      });
    } finally {
      console.warn = warn;
    }

    assert.equal(new Set(layers.map((layer) => layer.id)).size, layers.length, "no id twice");
    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["a_2Fb", "roads"],
      "the id goes to the name that is its own id, not to whichever was read first",
    );
  });

  // Order decides which name reaches the id first, but not which keeps it: whichever encodes to
  // itself is the one the control's raw ids name, so drawing the other in its place would put a
  // source layer on the map that nothing ticked. Where neither name is its own id the winner is
  // still first-wins, which nothing on the map depends on.
  it("gives the shared id to whichever name is its own id, however they are ordered", () => {
    const warn = console.warn;
    console.warn = () => {};
    const drawn = (sourceLayers: string[]) =>
      createPMTilesArchiveLayers({
        ...archive,
        sourceLayerColors: undefined,
        sourceLayers,
      }).map((layer) => layer.name);
    try {
      assert.deepEqual(drawn(["a_2Fb", "a/b", "roads"]), ["a_2Fb", "roads"]);
      assert.deepEqual(drawn(["a/b", "a_2Fb", "roads"]), ["a_2Fb", "roads"]);
    } finally {
      console.warn = warn;
    }
  });

  // The collider is dropped, so the ids that drew it are not this layer's to hide, style or remove.
  it("does not carry a dropped collider's ids into the layer that kept the id", () => {
    const warn = console.warn;
    console.warn = () => {};
    let layers;
    try {
      layers = createPMTilesArchiveLayers({
        ...archive,
        sourceLayerColors: undefined,
        sourceLayers: ["a/b", "a_2Fb"],
        nativeLayerIds: ["a/b", "a_2Fb"].flatMap((name) =>
          ["fill", "line", "circle"].map((kind) => `grid-${name}-${kind}`),
        ),
      });
    } finally {
      console.warn = warn;
    }

    assert.equal(layers.length, 1);
    assert.deepEqual(layers[0]!.metadata.nativeLayerIds, [
      "grid-a_2Fb-fill",
      "grid-a_2Fb-line",
      "grid-a_2Fb-circle",
    ]);
  });

  it("keeps a repeated source layer to one layer", () => {
    const layers = createPMTilesArchiveLayers({
      ...archive,
      sourceLayerColors: undefined,
      sourceLayers: ["roads", "roads", "water"],
    });

    assert.deepEqual(
      layers.map((layer) => layer.name),
      ["roads", "water"],
    );
  });

  it("says so when a colliding source layer is left undrawn", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      // Its own archive URL, so the two adds below are two archives rather than one read twice.
      createPMTilesArchiveLayers({
        ...archive,
        url: "https://example.org/collides.pmtiles",
        sourceLayerColors: undefined,
        sourceLayers: ["a/b", "a_2Fb", "roads"],
      });
      // A repeat of the same name is not a collision — nothing is lost, so nothing is said.
      createPMTilesArchiveLayers({
        ...archive,
        url: "https://example.org/repeats.pmtiles",
        sourceLayerColors: undefined,
        sourceLayers: ["roads", "roads", "water"],
      });
    } finally {
      console.warn = warn;
    }

    assert.equal(warnings.length, 1, "one collision, one warning");
    assert.match(warnings[0]!, /"a\/b" collides with "a_2Fb"/);
  });

  // A control re-reports its source layers as an archive's metadata arrives, so the same collision
  // would otherwise be logged on every read.
  it("says it once, however often the archive is read", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      for (let read = 0; read < 3; read += 1) {
        createPMTilesArchiveLayers({
          ...archive,
          url: "https://example.org/read-again.pmtiles",
          sourceLayerColors: undefined,
          sourceLayers: ["a/b", "a_2Fb", "roads"],
        });
      }
    } finally {
      console.warn = warn;
    }

    assert.equal(warnings.length, 1, "three reads, one warning");
  });

  // Archive ids come from a counter the control resets when it is rebuilt, so `pmtiles-source-0`
  // names one archive in this project and a different one in the next. Keyed by id, the second
  // would lose a source layer with nothing said about it.
  it("says it again for a different archive that reuses the id", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      for (const url of [
        "https://example.org/first.pmtiles",
        "https://example.org/second.pmtiles",
      ]) {
        createPMTilesArchiveLayers({
          ...archive,
          id: "pmtiles-source-0",
          url,
          sourceLayerColors: undefined,
          sourceLayers: ["a/b", "a_2Fb", "roads"],
        });
      }
    } finally {
      console.warn = warn;
    }

    assert.equal(warnings.length, 2, "two archives, two warnings");
  });

  it("says nothing about a raster archive, which never splits", () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      createPMTilesArchiveLayers({
        ...archive,
        // Its own URL, so the silence is the raster early return and not a collision an earlier
        // test already reported for this pair.
        url: "https://example.org/raster.pmtiles",
        tileType: "raster",
        sourceLayerColors: undefined,
        sourceLayers: ["a/b", "a_2Fb"],
      });
    } finally {
      console.warn = warn;
    }

    assert.deepEqual(warnings, [], "the id math means nothing for raster tiles");
  });

  it("does not carry a repeated source layer into an unsplit archive", () => {
    const layers = createPMTilesArchiveLayers({
      ...archive,
      sourceLayerColors: undefined,
      sourceLayers: ["units", "units"],
    });

    assert.equal(layers.length, 1, "one name, so one layer");
    assert.deepEqual(layers[0]!.source.sourceLayers, ["units"], "and it is named once");
  });

  it("leaves an archive with one source layer, or a raster one, as a single layer", () => {
    assert.equal(createPMTilesArchiveLayers({ ...archive, sourceLayers: ["only"] }).length, 1);
    assert.equal(createPMTilesArchiveLayers({ ...archive, tileType: "raster" }).length, 1);
  });
});

describe("removing one of an archive's layers", () => {
  it("leaves the shared source alone while its siblings still draw from it", () => {
    const layers = createPMTilesArchiveLayers(archive);
    const removedSources: string[] = [];
    const map = {
      getLayer: () => undefined,
      getSource: (id: string) => ({ id }),
      removeLayer: () => {},
      removeSource: (id: string) => removedSources.push(id),
      getLayersOrder: () => [],
    };

    removeLayerFromMap(
      map as never,
      layers[0].id,
      layers[0],
      externalSourceIdsFor(layers.slice(1)),
    );

    assert.equal(
      removedSources.includes("grid"),
      false,
      "the source two siblings still draw from must stay",
    );
  });

  // Deleting the folder removes every child in one store commit, so the sync loop takes them one
  // after another with the same (empty) survivor list. The source must outlive the siblings still
  // on the map, or MapLibre reports an error for each of them.
  it("keeps the source while a sibling's style layers are still on the map", () => {
    const layers = createPMTilesArchiveLayers(archive);
    let style = layers.flatMap((layer) =>
      (layer.metadata.nativeLayerIds as string[]).map((id) => ({ id, source: "grid" })),
    );
    const removedSources: string[] = [];
    const map = {
      getLayersOrder: () => style.map((layer) => layer.id),
      getLayer: (id: string) => style.find((layer) => layer.id === id),
      removeLayer: (id: string) => {
        style = style.filter((layer) => layer.id !== id);
      },
      getSource: (id: string) => (removedSources.includes(id) ? undefined : { id }),
      removeSource: (id: string) => removedSources.push(id),
    };

    // The controller's loop when the whole folder goes: no survivors, one layer at a time.
    layers.forEach((layer, index) => {
      removeLayerFromMap(map as never, layer.id, layer, new Set());
      const last = index === layers.length - 1;
      assert.equal(
        removedSources.includes("grid"),
        last,
        last ? "gone with the last one" : "still held by the siblings",
      );
    });
  });

  it("removes the source once nothing is left to draw from it", () => {
    const layers = createPMTilesArchiveLayers(archive);
    const removedSources: string[] = [];
    const map = {
      getLayer: () => undefined,
      getSource: (id: string) => ({ id }),
      removeLayer: () => {},
      removeSource: (id: string) => removedSources.push(id),
      getLayersOrder: () => [],
    };

    removeLayerFromMap(map as never, layers[0].id, layers[0], new Set());

    assert.equal(removedSources.includes("grid"), true);
  });
});

// Source layer names overlap in real archives — `water` and `waterway` in the Protomaps basemap —
// and the ids each layer claims decide what the sync path styles, reorders and hides.
describe("splitting an archive whose source layer names overlap", () => {
  it("gives each layer only the ids that are its own", () => {
    const layers = createPMTilesArchiveLayers({
      id: "a",
      name: "overlapping",
      url: "https://example.org/a.pmtiles",
      tileType: "vector",
      sourceLayers: ["water", "waterway"],
      nativeLayerIds: [
        "a-water-fill",
        "a-water-line",
        "a-water-circle",
        "a-waterway-fill",
        "a-waterway-line",
        "a-waterway-circle",
      ],
    });

    assert.deepEqual(layers[0].metadata.nativeLayerIds, [
      "a-water-fill",
      "a-water-line",
      "a-water-circle",
    ]);
    assert.deepEqual(layers[1].metadata.nativeLayerIds, [
      "a-waterway-fill",
      "a-waterway-line",
      "a-waterway-circle",
    ]);
  });

  // Blend modes resolve a native layer back to its store layer by the ids that layer declares, so
  // the same partition that keeps `water` from styling `waterway` keeps it from blending it.
  it("blends only its own natives when one source layer is set to blend", () => {
    const layers = createPMTilesArchiveLayers({
      id: "a",
      name: "overlapping",
      url: "https://example.org/a.pmtiles",
      tileType: "vector",
      sourceLayers: ["water", "waterway"],
      nativeLayerIds: [
        "a-water-fill",
        "a-water-line",
        "a-water-circle",
        "a-waterway-fill",
        "a-waterway-line",
        "a-waterway-circle",
      ],
    });

    syncLayerBlendModes(
      layers.map((layer) =>
        layer.name === "water"
          ? { ...layer, style: { ...layer.style, blendMode: "multiply" } }
          : layer,
      ),
    );

    assert.equal(blendModeForNativeLayer("a-water-fill"), "multiply");
    assert.equal(blendModeForNativeLayer("a-waterway-fill"), null, "its neighbour is left alone");
    resetLayerBlendModes();
  });

  it("derives ids for a layer whose control named none of them, rather than drawing nothing", () => {
    const layers = createPMTilesArchiveLayers({
      id: "a",
      name: "renamed",
      url: "https://example.org/a.pmtiles",
      tileType: "vector",
      sourceLayers: ["water", "waterway"],
      nativeLayerIds: ["some-other-naming-scheme"],
    });

    // The ids `ensurePMTilesExternalLayer` creates: scoped to the archive, not to this layer, so
    // deriving them from the layer's own id would name ids nothing on the map answers to.
    assert.deepEqual(layers[0].metadata.nativeLayerIds, [
      "a-water-fill",
      "a-water-line",
      "a-water-circle",
    ]);
  });
});

// An offline extract's bytes live in a registry keyed by URL, and every layer of a split archive
// names the same URL. Freeing them when the first child goes leaves its siblings resolving tiles
// against a protocol entry that is no longer there.
describe("removing one layer of an archive whose bytes are held in memory", () => {
  const offline = (): PMTilesStoreLayerOptions => ({
    ...archive,
    url: registerPMTilesArchive("split-extract.pmtiles", new Uint8Array([1, 2, 3])),
    sourceLayerColors: undefined,
  });

  it("keeps the archive registered while a sibling still draws from it", () => {
    const layers = createPMTilesArchiveLayers(offline());
    const key = layers[0]!.sourcePath!;
    const map = {
      getLayer: () => undefined,
      getSource: (id: string) => ({ id }),
      removeLayer: () => {},
      removeSource: () => {},
      getLayersOrder: () => [],
    };

    removeLayerFromMap(
      map as never,
      layers[0]!.id,
      layers[0],
      externalSourceIdsFor(layers.slice(1)),
    );

    assert.equal(hasPMTilesArchive(key), true, "its siblings still read these bytes");
  });

  it("frees the archive once the last layer of it goes", () => {
    const layers = createPMTilesArchiveLayers(offline());
    const key = layers[0]!.sourcePath!;
    const map = {
      getLayer: () => undefined,
      getSource: (id: string) => ({ id }),
      removeLayer: () => {},
      removeSource: () => {},
      getLayersOrder: () => [],
    };

    for (const [index, layer] of layers.entries()) {
      removeLayerFromMap(
        map as never,
        layer.id,
        layer,
        externalSourceIdsFor(layers.slice(index + 1)),
      );
    }

    assert.equal(hasPMTilesArchive(key), false, "nothing is left holding them");
  });
});

// Nothing points an archive at a source other than its own id today, but the option exists and the
// split path used to ignore it — every part would have named a source nothing on the map answers to.
describe("splitting an archive that draws from someone else's source", () => {
  it("gives every part that source, and the ids that go with it", () => {
    const layers = createPMTilesArchiveLayers({
      ...archive,
      id: "asset-9",
      sourceId: "shared-archive",
      sourceLayerColors: undefined,
      sourceLayers: ["roads", "water"],
      nativeLayerIds: ["fill", "line", "circle"].map((kind) => `shared-archive-roads-${kind}`),
    });

    assert.deepEqual(
      layers.map((layer) => [layer.id, layer.source.sourceId, layer.metadata.nativeLayerIds]),
      [
        [
          "asset-9-roads",
          "shared-archive",
          ["shared-archive-roads-fill", "shared-archive-roads-line", "shared-archive-roads-circle"],
        ],
        [
          "asset-9-water",
          "shared-archive",
          ["shared-archive-water-fill", "shared-archive-water-line", "shared-archive-water-circle"],
        ],
      ],
      "the control's ids for `roads` are kept, and `water` derives its own against the same source",
    );
  });
});
