/**
 * Putting a PMTiles archive into the store: the pieces go in one at a time, then into a folder.
 * Shared so an archive from the control and one from a STAC asset cannot drift apart.
 */

import { type GeoLibreLayer, useAppStore } from "@geolibre/core";

/** Archive ids already reported as reused, so a re-add does not warn about them again. */
const reportedSourceIdClashes = new Set<string>();

/** @internal Exported only so one test's clash does not silence another's. */
export function __resetReportedPMTilesSourceIdClashesForTests(): void {
  reportedSourceIdClashes.clear();
}

/** Whether this clash is being reported for the first time. */
function claimPMTilesSourceIdClash(archiveId: string, url: string): boolean {
  const key = JSON.stringify([archiveId, url]);
  if (reportedSourceIdClashes.has(key)) return false;
  reportedSourceIdClashes.add(key);
  return true;
}

/**
 * Add an archive's layers, or update them where they are already on the map.
 *
 * @param layers - What {@link createPMTilesArchiveLayers} built.
 * @param name - What to call the folder holding them.
 * @returns The ids newly added; empty when every layer was already there.
 */
export function addPMTilesArchive(layers: readonly GeoLibreLayer[], name: string): string[] {
  const store = useAppStore.getState();
  // Taken before the adds: ids within one archive are distinct, so nothing added here reads back.
  const known = new Set(store.layers.map((item) => item.id));
  const ids = new Set(layers.map((layer) => layer.id));
  const added: string[] = [];
  for (const layer of layers) {
    if (known.has(layer.id)) {
      // Re-pointed, not rebuilt: the user's styling, opacity and visibility stand, and `metadata`
      // is merged so a plugin's own keys survive. A re-add is reached by closing the panel and
      // adding the archive again — not a reason to undo what was done to the layer since.
      //
      // The layer may belong to a *different* archive whose id the control reused, in which case
      // this takes it over silently, keeping the old name, folder and styling. A changed URL is not
      // evidence of a different archive (a presigned URL re-signed), so warning here would cry wolf.
      const before = store.layers.find((item) => item.id === layer.id);
      store.updateLayer(layer.id, {
        metadata: { ...before?.metadata, ...layer.metadata },
        source: layer.source,
        // Must follow the archive: it is what the sweep below matches on, and a stale one gets the
        // layer swept away as some other archive's old shape.
        sourcePath: layer.sourcePath,
      });
      continue;
    }
    store.addLayer(layer);
    added.push(layer.id);
  }
  // The old shape goes, or it stays on the map drawing the whole archive under the layers that
  // replaced it. After the adds, so the archive is never momentarily layerless — the store
  // subscriber reads that as gone and hands its ownership back to the control.
  //
  // Matched on the URL as well as the id, because archive ids are not unique over a session: the
  // control's counter restarts whenever the panel is reopened. Without it, a new archive would
  // delete an unrelated one that happens to hold the same `pmtiles-source-N`. The cost is two
  // archives on one `metadata.sourceId`, and so one MapLibre source — hence the warning below.
  //
  // A departing layer can name native layers a survivor also names, both drawing from that one
  // source. Safe only because a sync pass runs every removal before any add
  // (`MapController.syncLayers`, `createLayerSync`); move removals after adds and this breaks.
  let inheritedGroupId: string | undefined;
  const archiveId = layers[0]?.metadata.sourceId;
  const archiveUrl = layers[0]?.sourcePath;
  if (typeof archiveId === "string") {
    const emptied = new Set<string | undefined>();
    // The pre-add snapshot, so `removeLayer` can replace the array while this walks it.
    for (const stale of store.layers) {
      // `metadata.sourceId` is a key every layer kind sets, so the type is checked as well.
      if (stale.type !== "pmtiles" || stale.metadata.sourceId !== archiveId) continue;
      // Before the URL check: a layer being taken over still shows its old URL here.
      if (ids.has(stale.id)) continue;
      if (stale.sourcePath !== archiveUrl) {
        // Nothing else can see this, and it looks like a rendering fault: one source between two
        // archives means one of them draws nothing.
        if (claimPMTilesSourceIdClash(archiveId, archiveUrl ?? "")) {
          console.warn(
            `PMTiles archive "${archiveId}" is already "${stale.sourcePath}"; "${archiveUrl}" reuses the id and one of them will not draw.`,
          );
        }
        continue;
      }
      emptied.add(stale.groupId);
      store.removeLayer(stale.id);
    }
    const afterStale = useAppStore.getState();
    // The folder the old shape sat in, when the replacement belongs there rather than in a fresh
    // one. Without this the placement is lost: the folder prunes as empty and the archive reappears
    // beside it — or, where it survives, next to a second folder of the same name.
    //
    // Ours to take away only if this function would have made it *and* nothing else is left in it.
    // Anything else is the user's arrangement, and the replacement goes back into it.
    inheritedGroupId = [...emptied].find((groupId) => {
      if (groupId === undefined) return false;
      const group = afterStale.layerGroups.find((item) => item.id === groupId);
      if (!group) return false;
      if (afterStale.layers.some((layer) => layer.groupId === groupId)) return true;
      return group.name !== name;
    });
    // The folder the old shape sat in goes with it when nothing is left in it, the same way the
    // control's own removal prunes one — otherwise the archive comes back beside an empty husk.
    for (const groupId of emptied) {
      if (!groupId || groupId === inheritedGroupId) continue;
      if (afterStale.layers.some((layer) => layer.groupId === groupId)) continue;
      afterStale.removeLayerGroup(groupId);
    }
  }
  // Read back after the adds, so a source layer reported later joins the folder its siblings are in.
  if (added.length > 0) {
    const state = useAppStore.getState();
    // A sibling's folder, if any sibling is still in one: a user who dragged them all out has said
    // this archive is not a folder any more. Where an id was reused, whatever was taken over counts
    // as a sibling, so the two archives share a folder under whichever name got there first.
    //
    // First match wins, deliberately. A user who has split this archive's layers across folders has
    // no folder that is the right one, and picking the most populated would be a guess dressed up
    // as a rule — the layers are theirs to move, and this only decides where a *new* one lands.
    const existing =
      state.layers.find((item) => ids.has(item.id) && item.groupId)?.groupId ?? inheritedGroupId;
    if (existing) {
      state.moveLayersToGroup(added, existing);
    } else if (layers.length > 1) {
      state.addLayerGroup(name, added);
    }
  }
  return added;
}
