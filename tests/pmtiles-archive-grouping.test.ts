import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { PMTilesLayerInfo } from "maplibre-gl-components";
import { useAppStore } from "../packages/core/src/store";
import { isPlaceholderLayer } from "../packages/map/src/placeholders";
import { createPMTilesArchiveLayers } from "../packages/map/src/pmtiles-layer";
import {
  __resetReportedPMTilesSourceIdClashesForTests,
  addPMTilesArchive,
} from "../packages/plugins/src/plugins/pmtiles-archive-store";
import {
  __beginProgrammaticPMTilesAddForTests,
  __mountPMTilesControlForTests,
  __resetPMTilesControlForTests,
  createPMTilesLayerAddHandler,
  createPMTilesLayerRemoveHandler,
  teardownPMTilesControl,
} from "../packages/plugins/src/plugins/maplibre-components";

/**
 * What the control reports for an archive it has loaded, with `sourceLayers` it has discovered.
 * `layerIds` is built the way the real control builds it — `${sourceId}-${rawName}-${kind}` for
 * every source layer it drew, ticked ones alone when the panel has a selection.
 */
function addEvent(
  sourceLayers: string[],
  id = "pmtiles-1",
  url = "https://example.org/units.pmtiles",
  selectedSourceLayers: string[] = [],
) {
  // What the control draws, and so what it names ids for: the ticked source layers, or the whole
  // archive when the panel has none ticked.
  const drawn = selectedSourceLayers.length > 0 ? selectedSourceLayers : sourceLayers;
  const layer: PMTilesLayerInfo = {
    id,
    url,
    name: "Units",
    tileType: "vector",
    sourceLayers,
    layerIds: drawn.flatMap((sourceLayer) =>
      ["fill", "line", "circle"].map((kind) => `${id}-${sourceLayer}-${kind}`),
    ),
    opacity: 0.8,
    pickable: true,
  };
  return { layerId: id, state: { layers: [layer], selectedSourceLayers } } as never;
}

function archiveLayers() {
  const state = useAppStore.getState();
  return state.layers.filter((layer) => layer.id.startsWith("pmtiles-1"));
}

// A catalog asset and a control add go through one function, so an archive opened from STAC is
// taken apart the same way rather than landing as one flat layer.
describe("adding an archive from anywhere", () => {
  beforeEach(() => {
    __resetPMTilesControlForTests();
    __resetReportedPMTilesSourceIdClashesForTests();
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
    for (const group of [...state.layerGroups]) state.removeLayerGroup(group.id);
  });

  it("splits and folders it whichever door it came in", () => {
    const layers = createPMTilesArchiveLayers({
      id: "asset-1",
      name: "Quaternary faults",
      url: "https://example.org/qfaults.pmtiles",
      tileType: "vector",
      sourceLayers: ["faults", "folds"],
    });

    const added = addPMTilesArchive(layers, "Quaternary faults");

    const state = useAppStore.getState();
    assert.deepEqual(added, ["asset-1-faults", "asset-1-folds"]);
    assert.equal(state.layerGroups.length, 1);
    assert.equal(state.layerGroups[0]!.name, "Quaternary faults");
    assert.deepEqual(
      new Set(state.layers.map((layer) => layer.groupId)),
      new Set([state.layerGroups[0]!.id]),
    );
  });

  // The same archive can be read twice under one id — re-added after the panel was closed and
  // reopened, which restarts the control's counter — and one source layer is named after the
  // archive while several are named after each, so its shape decides the id scheme.
  //
  // The control emits `layeradd` once per add, so this is a *re-add*, never a second event for an
  // add still in flight. Nothing here is progressive metadata discovery.
  it("replaces the archive when a later read finds more source layers", () => {
    const one = createPMTilesArchiveLayers({
      id: "asset-3",
      name: "Faults",
      url: "https://example.org/f.pmtiles",
      tileType: "vector",
      sourceLayers: ["faults"],
    });
    addPMTilesArchive(one, "Faults");
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      ["asset-3"],
    );

    const many = createPMTilesArchiveLayers({
      id: "asset-3",
      name: "Faults",
      url: "https://example.org/f.pmtiles",
      tileType: "vector",
      sourceLayers: ["faults", "folds"],
    });
    addPMTilesArchive(many, "Faults");

    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      ["asset-3-faults", "asset-3-folds"],
      "the layer under the old scheme went with it",
    );
  });

  // Archive ids are not unique over a session: the control numbers them from a counter a fresh
  // instance restarts at 0, and closing the panel destroys the instance while leaving its layers in
  // the store. So the next archive added can carry an id another one is already using.
  it("leaves an unrelated archive alone when a new one reuses its id", () => {
    const first = createPMTilesArchiveLayers({
      id: "pmtiles-source-0",
      name: "Faults",
      url: "https://example.org/faults.pmtiles",
      tileType: "vector",
      sourceLayers: ["faults", "folds"],
    });
    addPMTilesArchive(first, "Faults");

    // The panel is closed and reopened, and a different archive takes the same id.
    const second = createPMTilesArchiveLayers({
      id: "pmtiles-source-0",
      name: "Parcels",
      url: "https://example.org/parcels.pmtiles",
      tileType: "vector",
      sourceLayers: ["parcels"],
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      addPMTilesArchive(second, "Parcels");
    } finally {
      console.warn = warn;
    }

    const state = useAppStore.getState();
    assert.deepEqual(
      state.layers.map((layer) => layer.name),
      ["faults", "folds", "Parcels"],
      "the archive that was already there is untouched",
    );
    assert.equal(state.layerGroups.length, 1, "and it still has its folder");
  });

  // The reused id lands on a layer that is already there, so it is updated rather than added — and
  // an update that leaves `sourcePath` behind leaves the layer answering to an archive it no longer
  // draws, which the sweep above then matches when that archive comes back.
  it("re-points a layer a different archive has taken over", () => {
    const shaped = (id: string, name: string, url: string, sourceLayers: string[]) =>
      createPMTilesArchiveLayers({ id, name, url, tileType: "vector", sourceLayers });
    const faults = "https://example.org/faults.pmtiles";
    addPMTilesArchive(shaped("pmtiles-source-0", "Faults", faults, ["faults"]), "Faults");
    // The panel is closed and reopened, and a different archive takes the same id.
    addPMTilesArchive(
      shaped("pmtiles-source-0", "Parcels", "https://example.org/parcels.pmtiles", ["parcels"]),
      "Parcels",
    );
    assert.match(
      useAppStore.getState().layers[0]!.sourcePath ?? "",
      /parcels/,
      "the layer draws the archive that took it over",
    );

    // And once more, back to the first archive, now split. Its old shape is gone — that layer is
    // the parcels archive now — so nothing of it is there to sweep.
    const warn = console.warn;
    console.warn = () => {};
    try {
      addPMTilesArchive(
        shaped("pmtiles-source-0", "Faults", faults, ["faults", "folds"]),
        "Faults",
      );
    } finally {
      console.warn = warn;
    }

    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      ["pmtiles-source-0", "pmtiles-source-0-faults", "pmtiles-source-0-folds"],
      "the parcels archive is left standing rather than swept as the old shape of this one",
    );
  });

  // A re-add is reached by closing the PMTiles panel and adding the same archive again, which is a
  // re-read of what is already there — not a reason to undo what the user has done to it since.
  it("keeps a layer's styling when its archive is added again", () => {
    const shaped = () =>
      createPMTilesArchiveLayers({
        id: "pmtiles-source-0",
        name: "Faults",
        url: "https://example.org/faults.pmtiles",
        tileType: "vector",
        sourceLayers: ["faults"],
      });
    addPMTilesArchive(shaped(), "Faults");
    const store = useAppStore.getState();
    store.updateLayer("pmtiles-source-0", {
      style: { ...store.layers[0]!.style, fillColor: "#123456" },
      opacity: 0.3,
      visible: false,
      metadata: { ...store.layers[0]!.metadata, somePluginKey: "kept" },
    });

    addPMTilesArchive(shaped(), "Faults");

    const layer = useAppStore.getState().layers[0]!;
    assert.equal(layer.style.fillColor, "#123456", "the colour the user chose is still there");
    assert.equal(layer.opacity, 0.3, "and the opacity, which the panel's slider never reports");
    assert.equal(layer.visible, false, "and so is the fact they hid it");
    assert.equal(layer.metadata.somePluginKey, "kept", "and what a plugin parked on it");
    assert.deepEqual(
      layer.metadata.sourceLayers,
      ["faults"],
      "while the archive's own facts stand",
    );
  });

  // A layer the add takes over is not a second archive on the id — it is this one now, so nothing
  // is left mis-drawing and nothing is said. The layer keeps the name, folder and styling of the
  // archive it used to draw, which is the cost of an id the control handed out twice.
  it("says nothing when the new archive takes over every layer of the old", () => {
    const shaped = (name: string, url: string) =>
      createPMTilesArchiveLayers({
        id: "pmtiles-source-0",
        name,
        url,
        tileType: "vector",
        sourceLayers: ["roads", "water"],
      });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      addPMTilesArchive(shaped("A", "https://example.org/a.pmtiles"), "A");
      addPMTilesArchive(shaped("B", "https://example.org/b.pmtiles"), "B");
    } finally {
      console.warn = warn;
    }

    assert.deepEqual(warnings, [], "nothing was left drawing the archive that was replaced");
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.sourcePath),
      ["pmtiles://https://example.org/b.pmtiles", "pmtiles://https://example.org/b.pmtiles"],
    );
  });

  // Two archives on one id name one MapLibre source, so the first to sync creates it and the other
  // resolves source layers that are not in it. Nothing else can see that, so it is said here.
  it("says so when a new archive reuses an id another one is drawing", () => {
    const shaped = (name: string, url: string, sourceLayers: string[]) =>
      createPMTilesArchiveLayers({
        id: "pmtiles-source-0",
        name,
        url,
        tileType: "vector",
        sourceLayers,
      });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => warnings.push(String(message));
    try {
      addPMTilesArchive(shaped("A", "https://example.org/a.pmtiles", ["faults", "folds"]), "A");
      addPMTilesArchive(shaped("B", "https://example.org/b.pmtiles", ["roads", "water"]), "B");
    } finally {
      console.warn = warn;
    }

    assert.equal(warnings.length, 1, "one clash, one warning");
    assert.match(warnings[0]!, /b\.pmtiles/);
    const state = useAppStore.getState();
    assert.equal(state.layerGroups.length, 2, "and the two archives are not filed as one");
    assert.deepEqual(
      state.layerGroups.map((group) => group.name),
      ["A", "B"],
    );
  });

  it("takes the old folder with the old shape, rather than leaving an empty one", () => {
    const shaped = (sourceLayers: string[]) =>
      createPMTilesArchiveLayers({
        id: "asset-4",
        name: "Faults",
        url: "https://example.org/f.pmtiles",
        tileType: "vector",
        sourceLayers,
      });
    addPMTilesArchive(shaped(["faults", "folds"]), "Faults");
    assert.equal(useAppStore.getState().layerGroups.length, 1, "the split archive made a folder");

    // A later read finds only one source layer, so the archive is one layer named after itself.
    addPMTilesArchive(shaped(["faults"]), "Faults");

    const state = useAppStore.getState();
    assert.deepEqual(
      state.layers.map((layer) => layer.id),
      ["asset-4"],
    );
    assert.deepEqual(state.layerGroups, [], "the folder the split layers sat in went with them");
  });

  // The store subscriber reads "no layers left for this archive" as the archive being gone and
  // tells the control so, which hands back the ownership the replacing layers need. So the archive
  // must never be momentarily layerless while it changes shape.
  it("never leaves the archive layerless while it changes shape", () => {
    const shaped = (sourceLayers: string[]) =>
      createPMTilesArchiveLayers({
        id: "asset-6",
        name: "Faults",
        url: "https://example.org/f.pmtiles",
        tileType: "vector",
        sourceLayers,
      });
    addPMTilesArchive(shaped(["faults"]), "Faults");

    const counts: number[] = [];
    const unsubscribe = useAppStore.subscribe((state) => {
      counts.push(state.layers.filter((l) => l.metadata.sourceId === "asset-6").length);
    });
    addPMTilesArchive(shaped(["faults", "folds"]), "Faults");
    unsubscribe();

    assert.ok(counts.length > 0, "the store did change");
    assert.ok(!counts.includes(0), `archive was empty at some point: ${counts.join(",")}`);
  });

  it("puts only the layers it added into a new folder", () => {
    const shaped = (sourceLayers: string[]) =>
      createPMTilesArchiveLayers({
        id: "asset-7",
        name: "Faults",
        url: "https://example.org/f.pmtiles",
        tileType: "vector",
        sourceLayers,
      });
    addPMTilesArchive(shaped(["faults", "folds"]), "Faults");
    // The user takes both out of the folder and deletes it.
    const first = useAppStore.getState();
    first.moveLayersToGroup(
      first.layers.map((layer) => layer.id),
      null,
    );
    for (const group of [...useAppStore.getState().layerGroups]) {
      useAppStore.getState().removeLayerGroup(group.id);
    }

    addPMTilesArchive(shaped(["faults", "folds", "scarps"]), "Faults");

    const state = useAppStore.getState();
    assert.equal(state.layerGroups.length, 1);
    const inFolder = state.layers.filter((l) => l.groupId === state.layerGroups[0]!.id);
    assert.deepEqual(
      inFolder.map((l) => l.id),
      ["asset-7-scarps"],
      "the ones the user pulled out stay out",
    );
  });

  it("leaves a single-source-layer archive as the one layer it is", () => {
    const layers = createPMTilesArchiveLayers({
      id: "asset-2",
      name: "Parcels",
      url: "https://example.org/parcels.pmtiles",
      tileType: "vector",
      sourceLayers: ["parcels"],
    });

    const added = addPMTilesArchive(layers, "Parcels");

    assert.deepEqual(added, ["asset-2"], "no per-source-layer id, and so no folder");
    assert.deepEqual(useAppStore.getState().layerGroups, []);
  });
});

describe("the folder an archive's source layers are added into", () => {
  beforeEach(() => {
    __resetPMTilesControlForTests();
    __resetReportedPMTilesSourceIdClashesForTests();
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
    for (const group of [...state.layerGroups]) state.removeLayerGroup(group.id);
  });

  it("puts every source layer in one folder named after the archive", () => {
    createPMTilesLayerAddHandler()(addEvent(["roads", "water"]));

    const groups = useAppStore.getState().layerGroups;
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.name, "Units");
    assert.deepEqual(
      new Set(archiveLayers().map((layer) => layer.groupId)),
      new Set([groups[0]!.id]),
    );
  });

  it("takes the folder away with the archive, rather than leaving it empty", () => {
    const handle = createPMTilesLayerAddHandler();
    handle(addEvent(["roads", "water"]));
    assert.equal(useAppStore.getState().layerGroups.length, 1);

    createPMTilesLayerRemoveHandler()({ layerId: "pmtiles-1", state: { layers: [] } });

    const state = useAppStore.getState();
    assert.deepEqual(archiveLayers(), [], "every layer of the archive went");
    assert.deepEqual(state.layerGroups, [], "and its folder went with them");
  });

  it("leaves a folder standing when the user has put something else in it", () => {
    const handle = createPMTilesLayerAddHandler();
    handle(addEvent(["roads", "water"]));
    const groupId = useAppStore.getState().layerGroups[0]!.id;
    // Not one of the archive's: a layer the user dragged into the same folder.
    const source = archiveLayers()[0]!;
    const mine = {
      ...source,
      id: "a-layer-of-my-own",
      groupId: undefined,
      metadata: { ...source.metadata, sourceKind: "geojson-file", sourceId: "mine" },
    };
    useAppStore.getState().addLayer(mine);
    useAppStore.getState().moveLayersToGroup([mine.id], groupId);

    createPMTilesLayerRemoveHandler()({ layerId: "pmtiles-1", state: { layers: [] } });

    const state = useAppStore.getState();
    assert.deepEqual(archiveLayers(), [], "the archive still went");
    assert.equal(state.layerGroups.length, 1, "but the folder stayed, holding the user's layer");
    assert.deepEqual(
      state.layers.map((layer) => layer.id),
      [mine.id],
    );
  });

  // A `layerremove` names one archive. Releasing every archive missing from its snapshot would hand
  // back ownership of ones the event never mentioned, and the control could no longer clear those.
  it("keeps its claim on the archives an event did not name", () => {
    const handle = createPMTilesLayerAddHandler();
    handle(addEvent(["roads", "water"]));
    handle(addEvent(["parcels"], "pmtiles-2"));

    // The control drops the first archive, and its snapshot lists neither.
    createPMTilesLayerRemoveHandler()({ layerId: "pmtiles-1", state: { layers: [] } });
    // The second archive is still the control's, so its own clear-all still takes it.
    createPMTilesLayerRemoveHandler()({ layerId: "pmtiles-2", state: { layers: [] } });

    assert.deepEqual(useAppStore.getState().layers, [], "both archives went");
  });

  // Closing the panel destroys the control; reopening builds one holding nothing, while the layers
  // it added are still on the map.
  it("stops being the control's once the panel that added it has closed", () => {
    createPMTilesLayerAddHandler()(addEvent(["roads", "water"]));
    teardownPMTilesControl({ removeMapControl: () => true } as never);

    createPMTilesLayerRemoveHandler()({ state: { layers: [] } });

    assert.equal(archiveLayers().length, 2, "a new control's clear-all does not take them");
  });

  // The control's own `onRemove` clears every layer it drew and emits a `layerremove` naming no
  // archive — before it drops its handlers, so the one above still runs. Claims held that late read
  // it as the user deleting all of them, and closing the panel or disabling this plugin would take
  // the project's layers with it. Off the map is all it may mean; the next sync redraws them.
  it("does not delete them when the closing control clears what it drew", () => {
    createPMTilesLayerAddHandler()(addEvent(["roads", "water"]));
    const onRemove = createPMTilesLayerRemoveHandler();
    __mountPMTilesControlForTests({});

    teardownPMTilesControl({
      removeMapControl: () => {
        onRemove({ state: { layers: [] } });
        return true;
      },
    } as never);

    assert.equal(archiveLayers().length, 2, "the layers it drew are still the project's");
    assert.equal(useAppStore.getState().layerGroups.length, 1, "and so is their folder");
  });

  // `addLayer(url)` does not reset the panel's tick selection, so an archive added by URL is drawn
  // with whatever was last ticked for a different one and reports ids for those alone. Add Data,
  // Source Cooperative and Hugging Face have no tick UI, so reading that as this archive's
  // selection would strand the rest of it outside the store with no way back.
  it("keeps the whole archive when it was added by URL rather than through the panel", () => {
    const url = "https://example.org/by-url.pmtiles";
    // The panel holds a tick left over from a different archive.
    const event = addEvent(["roads", "water"], "pmtiles-3", url, ["roads"]);
    const endAdd = __beginProgrammaticPMTilesAddForTests(url);
    try {
      createPMTilesLayerAddHandler()(event);
    } finally {
      endAdd();
    }

    assert.deepEqual(
      useAppStore
        .getState()
        .layers.filter((layer) => layer.id.startsWith("pmtiles-3"))
        .map((layer) => layer.name),
      ["roads", "water"],
      "both source layers are the project's, not just the stale tick",
    );
  });

  // The panel's tick selection is a field of the state the control hands every handler, so it is
  // read rather than reconstructed from the ids it drew — which spell a name raw where this
  // package encodes it, and so agree only for names needing no encoding.
  it("adds only the source layers the panel has ticked", () => {
    createPMTilesLayerAddHandler()(
      addEvent(["roads", "water", "zones residentielles"], "pmtiles-4", undefined, [
        "roads",
        "zones residentielles",
      ]),
    );

    assert.deepEqual(
      useAppStore
        .getState()
        .layers.filter((layer) => layer.id.startsWith("pmtiles-4"))
        .map((layer) => layer.name),
      ["roads", "zones residentielles"],
      "the unticked one is not a layer, and the encoded name is not mistaken for one",
    );
  });

  // One ticked source layer is not a folder of one: the archive stays the single layer it was
  // before the split, named after itself and drawing only what was ticked.
  it("stays one layer named after the archive when a single source layer is ticked", () => {
    createPMTilesLayerAddHandler()(addEvent(["roads", "water"], "pmtiles-6", undefined, ["water"]));

    const layers = useAppStore
      .getState()
      .layers.filter((layer) => layer.id.startsWith("pmtiles-6"));
    assert.deepEqual(
      layers.map((layer) => [layer.name, layer.source.sourceLayers]),
      [["Units", ["water"]]],
    );
    assert.deepEqual(useAppStore.getState().layerGroups, [], "and no folder for the one of it");
  });

  // A selection naming a source layer this archive does not have is the panel still holding another
  // archive's, alongside that archive's checkbox list — so the user could not tick the rest back.
  it("takes the whole archive when the selection names something it does not have", () => {
    createPMTilesLayerAddHandler()(
      addEvent(["roads", "water"], "pmtiles-7", undefined, ["roads", "elevation"]),
    );

    assert.deepEqual(
      useAppStore
        .getState()
        .layers.filter((layer) => layer.id.startsWith("pmtiles-7"))
        .map((layer) => layer.name),
      ["roads", "water"],
      "not just the half of a stale selection that happens to overlap",
    );
  });

  // A stale selection is discarded, so the store takes source layers the control drew and ones it
  // did not. The ids it did draw still have to be kept: dropping the lot because some of them name
  // a phantom leaves the part that is really on the map deriving an encoded id of its own, drawn
  // over the control's — which is the whole reason both id schemes are matched.
  it("keeps the ids for the source layers the control really drew", () => {
    const name = "zones residentielles";
    createPMTilesLayerAddHandler()(
      addEvent([name, "water"], "pmtiles-9", undefined, [name, "elevation"]),
    );

    const layers = useAppStore.getState().layers.filter((l) => l.id.startsWith("pmtiles-9"));
    assert.deepEqual(
      layers.map((layer) => layer.metadata.nativeLayerIds),
      [
        // The control's own, spelling the name raw.
        [`pmtiles-9-${name}-fill`, `pmtiles-9-${name}-line`, `pmtiles-9-${name}-circle`],
        // Nothing drew this one, so it derives its own.
        ["pmtiles-9-water-fill", "pmtiles-9-water-line", "pmtiles-9-water-circle"],
      ],
    );
  });

  // An archive with no `vector_layers` has nothing to derive ids from, so the control's have to
  // stand however stale the tick beside them: dropped, the layer renders as a placeholder.
  it("keeps the control's ids for an archive with no source layers of its own", () => {
    createPMTilesLayerAddHandler()(addEvent([], "pmtiles-8", undefined, ["roads"]));

    const layer = useAppStore.getState().layers.find((item) => item.id === "pmtiles-8")!;
    assert.equal(isPlaceholderLayer(layer), false, "it renders rather than placeholding");
    assert.deepEqual(layer.metadata.nativeLayerIds, [
      "pmtiles-8-roads-fill",
      "pmtiles-8-roads-line",
      "pmtiles-8-roads-circle",
    ]);
  });

  // The control drew what the stale tick named, so its ids name that and not what the store holds.
  // Kept, they would be what `layer-sync` hides, styles and removes instead of the real layers.
  it("drops the control's ids when they do not name what is drawn", () => {
    createPMTilesLayerAddHandler()(addEvent(["buildings"], "pmtiles-5", undefined, ["roads"]));

    const layer = useAppStore.getState().layers.find((item) => item.id === "pmtiles-5")!;
    assert.deepEqual(
      layer.metadata.nativeLayerIds,
      ["pmtiles-5-buildings-fill", "pmtiles-5-buildings-line", "pmtiles-5-buildings-circle"],
      "derived for what is drawn, not the phantom `roads` ids the control reported",
    );
  });

  // A re-add of an archive already in the store can report a source layer the first read did not.
  // That layer belongs with its siblings, not in a folder of its own. Defence in depth: the control
  // emits `layeradd` once per add, so this arrives as a fresh add rather than a follow-up event.
  it("puts a source layer a later event reports into the folder that already exists", () => {
    const handle = createPMTilesLayerAddHandler();
    handle(addEvent(["roads", "water"]));
    const groupId = useAppStore.getState().layerGroups[0]!.id;

    handle(addEvent(["roads", "water", "buildings"]));

    const groups = useAppStore.getState().layerGroups;
    assert.equal(groups.length, 1, "no second folder beside the first");
    assert.equal(groups[0]!.id, groupId, "and it is the same folder");
    const layers = archiveLayers();
    assert.equal(layers.length, 3, "the newly reported source layer was added");
    assert.deepEqual(
      new Set(layers.map((layer) => layer.groupId)),
      new Set([groupId]),
      "every source layer sits in it, the late one included",
    );
  });
});

// A folder the user made is not the one this function adds, and a shape change must not cost them
// the placement: the old layer is swept, its folder would prune as empty, and the replacement would
// appear beside it in a fresh folder named after the archive.
describe("an archive the user has filed in a folder of their own", () => {
  beforeEach(() => {
    __resetPMTilesControlForTests();
    __resetReportedPMTilesSourceIdClashesForTests();
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
    for (const group of [...state.layerGroups]) state.removeLayerGroup(group.id);
  });

  const shaped = (sourceLayers: string[]) =>
    createPMTilesArchiveLayers({
      id: "asset-8",
      name: "Faults",
      url: "https://example.org/f.pmtiles",
      tileType: "vector",
      sourceLayers,
    });

  // The user's folder may happen to carry the archive's own name. Told apart by the name alone it
  // reads as the one this function makes, and the replacement starts a second folder beside it.
  it("rejoins a folder of its own name that the user keeps other layers in", () => {
    addPMTilesArchive(shaped(["faults"]), "Faults");
    const store = useAppStore.getState();
    store.addLayerGroup("Faults", []);
    const mine = useAppStore.getState().layerGroups.at(-1)!.id;
    const source = useAppStore.getState().layers[0]!;
    useAppStore.getState().addLayer({
      ...source,
      id: "a-layer-of-my-own",
      groupId: undefined,
      metadata: { ...source.metadata, sourceId: "mine", sourceKind: "geojson-file" },
    });
    useAppStore.getState().moveLayersToGroup(["asset-8", "a-layer-of-my-own"], mine);

    addPMTilesArchive(shaped(["faults", "folds"]), "Faults");

    const state = useAppStore.getState();
    assert.equal(state.layerGroups.length, 1, "no second folder of the same name");
    assert.deepEqual(
      state.layers.filter((layer) => layer.id.startsWith("asset-8")).map((layer) => layer.groupId),
      [mine, mine],
      "the replacement went back where the user keeps it",
    );
  });

  it("stays in that folder when a later read changes its shape", () => {
    addPMTilesArchive(shaped(["faults"]), "Faults");
    const store = useAppStore.getState();
    store.addLayerGroup("My stuff", []);
    const mine = useAppStore.getState().layerGroups.at(-1)!.id;
    useAppStore.getState().moveLayersToGroup(["asset-8"], mine);

    addPMTilesArchive(shaped(["faults", "folds"]), "Faults");

    const state = useAppStore.getState();
    assert.deepEqual(
      state.layerGroups.map((group) => group.name),
      ["My stuff"],
      "no second folder named after the archive",
    );
    assert.deepEqual(
      state.layers.map((layer) => [layer.id, layer.groupId]),
      [
        ["asset-8-faults", mine],
        ["asset-8-folds", mine],
      ],
      "the split layers took the place the single layer held",
    );
  });
});
