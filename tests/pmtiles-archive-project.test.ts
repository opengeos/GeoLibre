import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { applyProjectToStore, parseProject, projectFromStore } from "../packages/core/src/project";
import { applyGroupEffects } from "../packages/core/src/layer-groups";
import { useAppStore } from "../packages/core/src/store";
import { createPMTilesArchiveLayers } from "../packages/map/src/pmtiles-layer";
import { addPMTilesArchive } from "../packages/plugins/src/plugins/pmtiles-archive-store";

/** Save the store the way the app does, then read it back. */
function roundTrip() {
  const project = projectFromStore(useAppStore.getState() as never);
  return applyProjectToStore(parseProject(JSON.stringify(project)));
}

// The archive is split across several layers held together by a folder, and both halves have to
// survive a save: layers whose folder is gone are scrubbed loose on load.
// Hiding the folder hides what is in it. An archive's source layers are external native layers,
// whose visibility reaches the map by a different path than an ordinary layer's, so the folding
// `applyGroupEffects` does upstream of the sync has to survive that path.
describe("hiding the folder an archive sits in", () => {
  beforeEach(() => {
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
    for (const group of [...state.layerGroups]) state.removeLayerGroup(group.id);
  });

  it("hides every source layer of it, and shows them again", () => {
    addPMTilesArchive(
      createPMTilesArchiveLayers({
        id: "grid",
        name: "MGRS grid",
        url: "https://example.org/mgrs.pmtiles",
        tileType: "vector",
        sourceLayers: ["gzd", "hundredkm"],
      }),
      "MGRS grid",
    );
    const store = useAppStore.getState();
    const groupId = store.layerGroups[0]!.id;

    store.setLayerGroupVisibility(groupId, false);
    const hidden = useAppStore.getState();
    assert.deepEqual(
      applyGroupEffects(hidden.layers, hidden.layerGroups).map((layer) => layer.visible),
      [false, false],
      "the folder's state reaches each source layer",
    );

    useAppStore.getState().setLayerGroupVisibility(groupId, true);
    const shown = useAppStore.getState();
    assert.deepEqual(
      applyGroupEffects(shown.layers, shown.layerGroups).map((layer) => layer.visible),
      [true, true],
      "and showing it again brings them all back",
    );
  });
});

// Adding an archive writes to the store once per source layer plus once for the folder. Undo
// coalesces changes made in the same tick, so the whole archive is one step back, not ten.
describe("undoing an archive", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "undo" });
    useAppStore.temporal.getState().clear();
  });

  it("takes it back in a single step, folder and all", () => {
    addPMTilesArchive(
      createPMTilesArchiveLayers({
        id: "grid",
        name: "MGRS grid",
        url: "https://example.org/mgrs.pmtiles",
        tileType: "vector",
        sourceLayers: ["gzd", "hundredkm", "labels"],
      }),
      "MGRS grid",
    );
    assert.equal(useAppStore.getState().layers.length, 3);

    useAppStore.temporal.getState().undo();

    const state = useAppStore.getState();
    assert.deepEqual(state.layers, [], "every source layer went back");
    assert.deepEqual(state.layerGroups, [], "and the folder with them");
  });
});

describe("an archive across a project save and reload", () => {
  beforeEach(() => {
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
    for (const group of [...state.layerGroups]) state.removeLayerGroup(group.id);
  });

  it("comes back as the same layers in the same folder", () => {
    addPMTilesArchive(
      createPMTilesArchiveLayers({
        id: "grid",
        name: "MGRS grid",
        url: "https://example.org/mgrs.pmtiles",
        tileType: "vector",
        sourceLayers: ["gzd", "hundredkm", "labels"],
      }),
      "MGRS grid",
    );

    const reloaded = roundTrip();

    const groups = reloaded.layerGroups;
    assert.equal(groups.length, 1, "the folder survived");
    assert.equal(groups[0]!.name, "MGRS grid");
    assert.deepEqual(
      reloaded.layers.map((layer) => layer.name),
      ["gzd", "hundredkm", "labels"],
      "every source layer survived",
    );
    assert.deepEqual(
      new Set(reloaded.layers.map((layer) => layer.groupId)),
      new Set([groups[0]!.id]),
      "and each is still in the folder",
    );
  });

  it("keeps them all drawing from the archive's one source", () => {
    addPMTilesArchive(
      createPMTilesArchiveLayers({
        id: "grid",
        name: "MGRS grid",
        url: "https://example.org/mgrs.pmtiles",
        tileType: "vector",
        sourceLayers: ["gzd", "hundredkm"],
      }),
      "MGRS grid",
    );

    const reloaded = roundTrip();

    // Both halves of the id: a reloaded layer naming its own id as the source would draw from a
    // source nothing adds, and `removeLayerFromMap` would stop refcounting the shared one.
    assert.deepEqual(
      new Set(reloaded.layers.map((layer) => layer.metadata.sourceId)),
      new Set(["grid"]),
    );
    assert.deepEqual(
      new Set(reloaded.layers.map((layer) => layer.source.sourceId)),
      new Set(["grid"]),
    );
  });
});
