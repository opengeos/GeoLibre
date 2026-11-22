/**
 * Locate folder for ArcGIS Pro project layers whose data has moved.
 *
 * An ArcGIS Pro project records each layer's workspace folder as it was on the
 * machine that saved it -- often a Windows drive or a network share -- so a
 * project opened anywhere else finds none of its files. The importer keeps each
 * folder-backed layer's original workspace and file name
 * ({@link ArcgisFolderSource}); here the layers that did not load are grouped
 * by that workspace, and when the user picks the folder's new location the same
 * file names are read from it, through the loader a reopened project uses.
 *
 * Only the folder the user picks is read. Nothing is searched for, the project
 * file is not changed, and a pick only applies to the one workspace it was made
 * for, so an unrelated folder that happens to share its name is never matched.
 */
import { withoutHistory, type AppState, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  arcgisWorkspaceIdentity,
  type ArcgisFolderSource,
  type ArcgisProjectImportResult,
  type ArcgisProjectImportWarning,
} from "./arcgis-project-import";
import { joinLocalPath } from "./file-io/paths";

/** A layer that did not load, with where the project said its data was. */
export interface ArcgisRepairEntry {
  layer: GeoLibreLayer;
  source: ArcgisFolderSource;
}

/** The layers an import could not load that a Locate folder can still add. */
export interface ArcgisWorkspaceRepairSession {
  /** Path of the imported project file, for relative workspaces. */
  projectPath: string;
  /** The import's `layerOrder`: import ids, bottom first. */
  order: readonly string[];
  /**
   * Store id of every imported item on the map, by import id. Located layers
   * are added to it as they are added to the store.
   */
  storeIds: Map<string, string>;
  /** Layers still waiting for their folder, by import id. */
  pending: Map<string, ArcgisRepairEntry>;
  /**
   * The store's `projectLoadCount` once the import loaded its project. Any
   * other value means another project replaced it, and its layers are gone.
   */
  projectLoadCount: number;
}

/** One saved workspace folder and the layers waiting for it. */
export interface ArcgisRepairGroup {
  key: string;
  /** The folder as the project recorded it, shown to the user. */
  label: string;
  layerIds: string[];
  /** Names of those layers, so the user can see what a Locate adds. */
  layerNames: string[];
}

/** Reads the features of the layers that share one local file; see `readLocalVectorFeatures`. */
export type ReadLayerFeatures = (
  path: string,
  layers: GeoLibreLayer[],
) => Promise<Map<string, FeatureCollection> | null>;

/**
 * Read every folder-backed layer the import resolved to a local path, and set
 * the layers that fail aside for a Locate folder rather than loading the
 * project with records that would only be dropped once their read failed.
 *
 * Mutates `imported.project.layers` (loaded layers gain their `geojson`,
 * missing ones are removed) and `imported.warnings` (one per missing layer,
 * carrying its id). `imported.layerOrder` keeps every id, so a layer located
 * later goes back into its saved place.
 *
 * @param imported - The import result, before its project is loaded.
 * @param projectPath - Path of the imported project file.
 * @param readFeatures - Reads the features of layers that share one file.
 * @returns The layers waiting for a Locate folder, by import id.
 */
export async function loadArcgisFolderLayers(
  imported: ArcgisProjectImportResult,
  projectPath: string,
  readFeatures: ReadLayerFeatures,
): Promise<Map<string, ArcgisRepairEntry>> {
  const { folderSources, unresolvedLayers } = imported.repair;
  const pending = new Map<string, ArcgisRepairEntry>();
  for (const layer of unresolvedLayers) {
    const source = folderSources.get(layer.id);
    if (source) pending.set(layer.id, { layer, source });
  }

  const byPath = new Map<string, GeoLibreLayer[]>();
  for (const layer of imported.project.layers) {
    if (!folderSources.has(layer.id) || !layer.sourcePath) continue;
    const list = byPath.get(layer.sourcePath);
    if (list) list.push(layer);
    else byPath.set(layer.sourcePath, [layer]);
  }
  const missing = new Set<string>();
  await Promise.all(
    Array.from(byPath, async ([path, layers]) => {
      const features = await readFeatures(path, layers).catch((error: unknown) => {
        console.warn(`[GeoLibre] Could not read ArcGIS project data "${path}".`, error);
        return null;
      });
      for (const layer of layers) {
        const geojson = features?.get(layer.id);
        if (geojson) layer.geojson = geojson;
        else missing.add(layer.id);
      }
    }),
  );
  imported.project.layers = imported.project.layers.filter((layer) => {
    const source = folderSources.get(layer.id);
    if (!missing.has(layer.id) || !source) return true;
    const { sourcePath: _savedPath, ...record } = layer;
    pending.set(layer.id, { layer: record, source });
    imported.warnings.push({ layerName: layer.name, reason: "data-not-found", layerId: layer.id });
    return false;
  });
  return pending;
}

/**
 * The import warnings left once a Locate folder has loaded some layers: each
 * loaded layer's load failure goes, but its symbology notes stay, since they
 * describe how the now-visible layer is drawn.
 *
 * @param warnings - The warnings the report shows.
 * @param loaded - Import ids of the layers the Locate folder added.
 */
export function withoutLocatedWarnings(
  warnings: readonly ArcgisProjectImportWarning[],
  loaded: ReadonlySet<string>,
): ArcgisProjectImportWarning[] {
  return warnings.filter(
    (warning) => warning.symbologyIssue || !warning.layerId || !loaded.has(warning.layerId),
  );
}

/**
 * The saved workspace folders that still have layers waiting, top first as
 * ArcGIS Pro lists them.
 *
 * @param session - The repair session.
 * @returns One group per distinct workspace.
 */
export function arcgisRepairGroups(session: ArcgisWorkspaceRepairSession): ArcgisRepairGroup[] {
  const groups = new Map<string, ArcgisRepairGroup>();
  for (const id of [...session.order].reverse()) {
    const entry = session.pending.get(id);
    if (!entry) continue;
    const { key, label } = arcgisWorkspaceIdentity(entry.source.workspace, session.projectPath);
    const group = groups.get(key);
    if (group) {
      group.layerIds.push(id);
      group.layerNames.push(entry.layer.name);
    } else {
      groups.set(key, { key, label, layerIds: [id], layerNames: [entry.layer.name] });
    }
  }
  return [...groups.values()];
}

/** A folder's file names, indexed once for {@link locatedFilePath}. */
export interface FolderListing {
  exact: ReadonlySet<string>;
  /** Lower-case name → the one entry with it, or null when several differ only in case. */
  lower: ReadonlyMap<string, string | null>;
}

/**
 * Index a folder's file names for {@link locatedFilePath}.
 *
 * @param names - Names of the files in the folder.
 */
export function indexFolderListing(names: readonly string[]): FolderListing {
  const lower = new Map<string, string | null>();
  for (const name of names) {
    const key = name.toLowerCase();
    lower.set(key, lower.has(key) ? null : name);
  }
  return { exact: new Set(names), lower };
}

/**
 * The path a layer's file has in a located folder, or null when the folder's
 * listing shows it is not there.
 *
 * A name that differs only in case is accepted when it is the only such entry:
 * a project saved on Windows records names as typed, not as stored, and a
 * case-sensitive disk would otherwise miss them.
 *
 * @param folder - The folder the user picked.
 * @param file - The layer's file inside its workspace.
 * @param listing - The folder's names, or null when it could not be listed.
 */
export function locatedFilePath(
  folder: string,
  file: string,
  listing: FolderListing | null,
): string | null {
  const segments = file.split("/");
  if (listing && segments.length === 1) {
    const name = listing.exact.has(file) ? file : listing.lower.get(file.toLowerCase());
    return name ? joinLocalPath(folder, name) : null;
  }
  return segments.reduce((path, segment) => joinLocalPath(path, segment), folder);
}

/**
 * Read the layers of one workspace from the folder the user located for it.
 *
 * Nothing is committed here: the caller adds the returned layers, after
 * checking the project they belong to is still the one open.
 *
 * @param session - The repair session.
 * @param key - The workspace's {@link ArcgisRepairGroup.key}.
 * @param folder - The folder the user picked.
 * @param listing - Names in the folder, or null when it could not be listed.
 * @param readFeatures - Reads the features of layers that share one file.
 * @returns The layers that loaded, pointing at their new path, with features.
 */
export async function readLocatedArcgisLayers(
  session: ArcgisWorkspaceRepairSession,
  key: string,
  folder: string,
  listing: string[] | null,
  readFeatures: ReadLayerFeatures,
): Promise<GeoLibreLayer[]> {
  const byPath = new Map<string, ArcgisRepairEntry[]>();
  const index = listing && indexFolderListing(listing);
  // Several layers can read one file; each file is matched once.
  const paths = new Map<string, string | null>();
  for (const entry of session.pending.values()) {
    if (arcgisWorkspaceIdentity(entry.source.workspace, session.projectPath).key !== key) continue;
    const { file } = entry.source;
    let path = paths.get(file);
    if (path === undefined) {
      path = locatedFilePath(folder, file, index);
      paths.set(file, path);
    }
    if (!path) continue;
    const list = byPath.get(path);
    if (list) list.push(entry);
    else byPath.set(path, [entry]);
  }
  // Files are read together, as at import; each read keeps its own layers.
  const reads = await Promise.all(
    Array.from(byPath, async ([path, entries]) => {
      const layers = entries.map((entry) => entry.layer);
      const features = await readFeatures(path, layers).catch((error: unknown) => {
        console.warn(`[GeoLibre] Could not read located ArcGIS project data "${path}".`, error);
        return null;
      });
      return layers.flatMap((layer) => {
        const geojson = features?.get(layer.id);
        return geojson ? [{ ...layer, sourcePath: path, geojson }] : [];
      });
    }),
  );
  return reads.flat();
}

/** The store state and actions {@link commitLocatedArcgisLayers} uses. */
export type RepairStore = Pick<AppState, "layers" | "layerGroups" | "addLayer" | "applyLayerOrder">;

/**
 * Add located layers to the open project, each in its saved group (if the
 * group is still there). Group contiguity keeps an outermost group and
 * everything nested in it in one block, wherever the user has moved it, so a
 * layer goes next to the nearest member of its outermost group in the saved
 * order: just below the one above it, or else just above the one below it.
 * With no such member on the map, it joins any layer the user put in that
 * group, or else goes just below the block of the next imported item above it
 * in the saved order, or else just above the block of the previous one.
 *
 * The import's layers are then reapplied in the order they now stand, which
 * keeps any rearranging the user did since the import, except inside the
 * outermost group of each located layer: that group goes back to its saved
 * order, which places the located layers among their siblings and undoes any
 * arrangement contiguity made while a member was missing. Removes the layers
 * from the session, so a second Locate cannot add them again.
 *
 * @param session - The repair session.
 * @param restored - Layers returned by {@link readLocatedArcgisLayers}.
 * @param getStore - Reads the current store state.
 * @returns Import ids of the layers added.
 */
export function commitLocatedArcgisLayers(
  session: ArcgisWorkspaceRepairSession,
  restored: GeoLibreLayer[],
  getStore: () => RepairStore,
): string[] {
  const { order, storeIds, pending } = session;
  const byId = new Map(restored.map((layer) => [layer.id, layer]));
  const groupIds = new Set(getStore().layerGroups.map((group) => group.id));
  const parents = new Map(getStore().layerGroups.map((group) => [group.id, group.parentId]));
  const outermost = (groupId: string | undefined) => {
    for (let depth = 0; groupId !== undefined && depth < parents.size; depth++) {
      const parent = parents.get(groupId);
      if (parent === undefined) return groupId;
      groupId = parent;
    }
    return groupId;
  };
  // The group each layer on the map is in, by store id; located layers join
  // as they are added.
  const live = new Map(getStore().layers.map((layer) => [layer.id, layer.groupId]));
  // Store ids that other import entries map to, whether or not still on the map.
  const mapped = new Set(storeIds.values());
  const onMap = (id: string) => {
    const storeId = storeIds.get(id);
    return storeId !== undefined && live.has(storeId) ? storeId : undefined;
  };
  const located = (index: number) => {
    const layer = byId.get(order[index]);
    return layer && pending.has(order[index]) ? layer : undefined;
  };
  const savedGroup = (layer: GeoLibreLayer) =>
    layer.groupId !== undefined && groupIds.has(layer.groupId) ? layer.groupId : undefined;
  /** Whether a store layer is in the same block as `storeId`. */
  const sameBlock = (storeId: string) => {
    const block = outermost(live.get(storeId));
    return (layer: GeoLibreLayer) =>
      block === undefined ? layer.id === storeId : outermost(layer.groupId) === block;
  };
  /** The layer just above `storeId`, skipping those `skip` holds for. */
  const after = (storeId: string, skip: (layer: GeoLibreLayer) => boolean = () => false) => {
    const { layers } = getStore();
    const at = layers.findIndex((entry) => entry.id === storeId);
    return layers.find((entry, index) => index > at && !skip(entry))?.id ?? null;
  };

  // The nearest item on the map above each located layer, overall and in its
  // outermost group: one pass from the top, before anything is added.
  const above = new Map<number, { any?: string; inBlock?: string }>();
  let anyAbove: string | undefined;
  const blockAbove = new Map<string | undefined, string>();
  for (let index = order.length - 1; index >= 0; index--) {
    const layer = located(index);
    const own = layer && outermost(savedGroup(layer));
    if (layer) above.set(index, { any: anyAbove, inBlock: own && blockAbove.get(own) });
    const storeId = onMap(order[index]);
    if (storeId === undefined) continue;
    anyAbove = storeId;
    blockAbove.set(outermost(live.get(storeId)), storeId);
  }

  // Then upwards, adding each layer and tracking the nearest item below.
  const added: string[] = [];
  let below: string | undefined;
  const blockBelow = new Map<string | undefined, string>();
  const passed = (storeId: string) => {
    below = storeId;
    blockBelow.set(outermost(live.get(storeId)), storeId);
  };
  order.forEach((id, index) => {
    const layer = located(index);
    if (!layer) {
      const storeId = onMap(id);
      if (storeId !== undefined) passed(storeId);
      return;
    }
    pending.delete(id);
    const group = savedGroup(layer);
    const own = outermost(group);
    // Next to a saved neighbour in its own block, so the reorder below does
    // not move members across a layer the user added to the group, except to
    // undo an arrangement contiguity made while a member was missing.
    const { any, inBlock } = above.get(index)!;
    const ownBelow = own && blockBelow.get(own);
    const member = own && getStore().layers.find((entry) => outermost(entry.groupId) === own);
    let beforeId: string | null = null;
    if (inBlock !== undefined) beforeId = inBlock;
    else if (ownBelow !== undefined) beforeId = after(ownBelow);
    else if (member) beforeId = member.id;
    else if (any !== undefined) beforeId = getStore().layers.find(sameBlock(any))!.id;
    else if (below !== undefined) beforeId = after(below, sameBlock(below));
    const { groupId: _savedGroupId, ...rest } = layer;
    // The import id is normally free; a layer added since could hold it. An
    // id another import entry still maps to is not reused either, even once
    // that layer is removed, so the two never share a drawing-order anchor.
    let storeId = id;
    for (let n = 2; live.has(storeId) || mapped.has(storeId); n++) storeId = `${id}-${n}`;
    mapped.add(storeId);
    // The project's saved name, not one derived from the file, so it is kept.
    getStore().addLayer(
      { ...rest, id: storeId, ...(group !== undefined ? { groupId: group } : {}) },
      beforeId,
      { keepName: true },
    );
    storeIds.set(id, storeId);
    live.set(storeId, group);
    passed(storeId);
    added.push(id);
  });
  if (added.length > 0) {
    const { layers, applyLayerOrder } = getStore();
    const touched = new Set(added.map((id) => outermost(live.get(storeIds.get(id)!))));
    touched.delete(undefined);
    // The members of each outermost group a layer was located into, top
    // first: with a member missing, contiguity may have arranged that group
    // differently from a full import.
    const saved = new Map<string | undefined, string[]>();
    for (let index = order.length - 1; index >= 0; index--) {
      const storeId = onMap(order[index]);
      if (storeId === undefined) continue;
      const block = outermost(live.get(storeId));
      if (!touched.has(block)) continue;
      const list = saved.get(block);
      if (list) list.push(storeId);
      else saved.set(block, [storeId]);
    }
    // The import's layers as they stand now, each of those groups refilled
    // in its saved order where it stands.
    const imported = new Set(storeIds.values());
    const ids = layers.flatMap((layer) =>
      imported.has(layer.id) ? [saved.get(outermost(layer.groupId))?.pop() ?? layer.id] : [],
    );
    // Part of placing the layers the user asked for, not a separate edit.
    withoutHistory(() => applyLayerOrder(ids));
  }
  return added;
}
