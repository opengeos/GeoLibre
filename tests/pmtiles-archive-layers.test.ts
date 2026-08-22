import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPMTilesArchiveLayers,
  type PMTilesStoreLayerOptions,
} from "../packages/map/src/pmtiles-layer";
import { removeLayerFromMap } from "../packages/map/src/layer-sync";

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
    assert.equal(new Set(layers.map((layer) => layer.id)).size, 3, "but each is its own layer");
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
      getStyle: () => ({ layers: [] }),
    };

    removeLayerFromMap(map as never, layers[0].id, layers[0], layers.slice(1));

    assert.equal(
      removedSources.includes("grid"),
      false,
      "the source two siblings still draw from must stay",
    );
  });

  it("removes the source once nothing is left to draw from it", () => {
    const layers = createPMTilesArchiveLayers(archive);
    const removedSources: string[] = [];
    const map = {
      getLayer: () => undefined,
      getSource: (id: string) => ({ id }),
      removeLayer: () => {},
      removeSource: (id: string) => removedSources.push(id),
      getStyle: () => ({ layers: [] }),
    };

    removeLayerFromMap(map as never, layers[0].id, layers[0], []);

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
