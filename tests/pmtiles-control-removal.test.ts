import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { createPMTilesArchiveLayers } from "../packages/map/src/pmtiles-layer";
import {
  pmtilesArchivesFullyRemoved,
  pmtilesLayerIdsToRemove,
} from "../packages/plugins/src/plugins/maplibre-components";

/** An archive added without the control — a STAC asset, a basemap extract. */
function archive(id: string, sourceLayers: string[]): GeoLibreLayer[] {
  return createPMTilesArchiveLayers({
    id,
    name: id,
    url: `https://example.org/${id}.pmtiles`,
    tileType: "vector",
    sourceLayers,
  });
}

/** The archives the control added this session, which are the only ones it may remove. */
function owned(layers: readonly GeoLibreLayer[]): Set<string> {
  return new Set(
    layers
      .map((layer) => layer.metadata.controlArchiveId)
      .filter((id): id is string => typeof id === "string"),
  );
}

/** The same, as the control adds it: marked with the id the control knows the archive by. */
function controlArchive(id: string, sourceLayers: string[]): GeoLibreLayer[] {
  return archive(id, sourceLayers).map((layer) => ({
    ...layer,
    metadata: { ...layer.metadata, controlArchiveId: id },
  }));
}

// The control knows an archive by one id; the store holds a layer per source layer, each named
// after that source layer. Matching the two on layer id silently does the wrong thing both ways.
describe("removing an archive the control has dropped", () => {
  it("takes every layer split out of it", () => {
    const layers = [
      ...controlArchive("a", ["roads", "water"]),
      ...controlArchive("b", ["parcels", "zoning"]),
    ];

    const removed = pmtilesLayerIdsToRemove(
      layers,
      { layerId: "a", state: { layers: [] } },
      owned(layers),
    );

    assert.deepEqual(removed, ["a-roads", "a-water"]);
  });

  it("keeps the layers of an archive the control still lists", () => {
    const layers = [
      ...controlArchive("a", ["roads", "water"]),
      ...controlArchive("b", ["parcels", "zoning"]),
    ];

    // No layerId: the control is reporting which archives it still has, and "a" is one of them.
    const removed = pmtilesLayerIdsToRemove(
      layers,
      { state: { layers: [{ id: "a" }] } },
      owned(layers),
    );

    assert.deepEqual(removed, ["b-parcels", "b-zoning"], "only the archive it dropped");
  });
});

// A STAC asset and a basemap extract build the same kind of layer without going through the
// control, so neither is in its list — which the "everything I still have" branch reads as dropped.
describe("an archive the control never added", () => {
  it("survives the control reporting what it still has", () => {
    const mine = archive("from-stac", ["faults", "folds"]);
    const controls = controlArchive("a", ["roads"]);

    const removed = pmtilesLayerIdsToRemove(
      [...mine, ...controls],
      { state: { layers: [] } },
      new Set(["a"]),
    );

    assert.deepEqual(removed, ["a"], "only the control's own");
  });

  it("is never reported back to the control as gone", () => {
    const mine = archive("from-stac", ["faults", "folds"]);

    assert.deepEqual(pmtilesArchivesFullyRemoved(mine, [], owned(mine)), []);
  });
});

// A saved project keeps `controlArchiveId`, but a reloaded one is drawn by `syncLayers` with the
// control holding nothing — so the mark is not a claim, and clear-all must not act on it.
describe("an archive reloaded from a saved project", () => {
  it("is not the control's to remove, mark or no mark", () => {
    const reloaded = controlArchive("a", ["roads", "water"]);

    const removed = pmtilesLayerIdsToRemove(reloaded, { state: { layers: [] } }, new Set());

    assert.deepEqual(removed, [], "nothing was added by this session's control");
  });
});

// Closing the panel drops the claims; the mark on the layers survives, in the project file too. A
// control that never loaded an archive must not be told it has lost one.
describe("telling a control about an archive it never loaded", () => {
  it("says nothing, mark or no mark", () => {
    const reloaded = controlArchive("a", ["roads", "water"]);

    assert.deepEqual(pmtilesArchivesFullyRemoved(reloaded, [], new Set()), []);
  });
});

describe("telling the control an archive is gone", () => {
  it("says nothing while other source layers of it are still on the map", () => {
    const layers = controlArchive("a", ["roads", "water"]);

    const gone = pmtilesArchivesFullyRemoved(layers, [layers[1]!], owned(layers));

    assert.deepEqual(gone, [], "'roads' left, but the archive is still drawing 'water'");
  });

  it("names the archive, not the layer, once its last source layer goes", () => {
    const layers = controlArchive("a", ["roads", "water"]);

    const gone = pmtilesArchivesFullyRemoved(layers, [], owned(layers));

    assert.deepEqual(gone, ["a"]);
  });
});
