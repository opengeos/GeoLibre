import {
  hydrateProjectLayer,
  normalizeGroupContiguity,
  normalizeLegendConfig,
  normalizePrintLayoutConfig,
  normalizeProjectComments,
  normalizeSecondaryMapViews,
  normalizeStoryMap,
  normalizeWidgets,
  type DashboardWidget,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
  type LegendConfig,
  type PrintLayoutConfig,
  type ProjectComment,
  type SecondaryMapView,
  type StoryLayerOpacityChange,
  type StoryMap,
} from "@geolibre/core";

/**
 * Build the layer list that results from restoring one layer from a project
 * snapshot, leaving every other layer as it is (Project History's "Restore
 * this layer", GeoLibre#2858).
 *
 * A layer still in the project is replaced wholesale by its snapshot record,
 * in place, so fields added since the snapshot (a filter, a popup) go away
 * too. A layer deleted since the snapshot is re-inserted directly below the
 * nearest layer that sat above it in the snapshot and still exists or, when
 * none does, directly above the nearest surviving layer that sat below it, so
 * it lands where it was relative to its surviving neighbours rather than
 * above layers added since. Group membership is kept only
 * when that group still exists, and group contiguity is re-established.
 *
 * @param current - The live store's layers and layer groups.
 * @param snapshot - The parsed snapshot project.
 * @param layerId - The id of the layer to restore.
 * @returns The new `layers` array, or `null` when the snapshot has no such layer.
 */
export function restoreLayerFromSnapshot(
  current: { layers: GeoLibreLayer[]; layerGroups: LayerGroup[] },
  snapshot: GeoLibreProject,
  layerId: string,
): GeoLibreLayer[] | null {
  const snapshotIndex = snapshot.layers.findIndex((layer) => layer.id === layerId);
  if (snapshotIndex < 0) return null;
  const hydrated = hydrateProjectLayer(snapshot, snapshot.layers[snapshotIndex]);
  const groupIds = new Set(current.layerGroups.map((group) => group.id));
  const restored: GeoLibreLayer =
    hydrated.groupId && !groupIds.has(hydrated.groupId)
      ? { ...hydrated, groupId: undefined }
      : hydrated;

  const existingIndex = current.layers.findIndex((layer) => layer.id === layerId);
  let layers: GeoLibreLayer[];
  if (existingIndex >= 0) {
    layers = current.layers.slice();
    layers[existingIndex] = restored;
  } else {
    const currentIndex = new Map(current.layers.map((layer, i) => [layer.id, i]));
    let insertAt: number | null = null;
    for (let i = snapshotIndex + 1; i < snapshot.layers.length && insertAt === null; i++) {
      const index = currentIndex.get(snapshot.layers[i].id);
      if (index !== undefined) insertAt = index;
    }
    for (let i = snapshotIndex - 1; i >= 0 && insertAt === null; i--) {
      const index = currentIndex.get(snapshot.layers[i].id);
      if (index !== undefined) insertAt = index + 1;
    }
    // No neighbour survives: put it on top, as a newly added layer would be.
    insertAt ??= current.layers.length;
    layers = [...current.layers.slice(0, insertAt), restored, ...current.layers.slice(insertAt)];
  }
  return normalizeGroupContiguity(layers);
}

/** The store sections that hold references to layers by id. */
export interface LayerReferenceState {
  widgets: DashboardWidget[];
  comments: ProjectComment[];
  legend: LegendConfig;
  storymap: StoryMap | null;
  secondaryMapViews: SecondaryMapView[];
  printLayout: PrintLayoutConfig;
}

/**
 * Bring back the references to a layer that deleting it scrubbed (dashboard
 * widgets, feature comments, legend order and overrides, story-map chapter
 * opacity rows, per-pane visibility, and Print Layout data/atlas blocks), taken
 * from the snapshot the layer is being restored from. Companion to
 * {@link restoreLayerFromSnapshot} for a layer that no longer exists.
 *
 * Only additive: a reference comes back only where its container still exists
 * (the same widget id is absent, the chapter and pane still exist, the Print
 * Layout block is still empty), so nothing the user changed since the snapshot
 * is overwritten. Sections with nothing to restore keep their identity.
 *
 * @param current - The live store's reference sections.
 * @param snapshot - The parsed snapshot project.
 * @param layerId - The id of the restored layer.
 * @returns Only the sections that changed.
 */
export function restoreLayerReferencesFromSnapshot(
  current: LayerReferenceState,
  snapshot: GeoLibreProject,
  layerId: string,
): Partial<LayerReferenceState> {
  const patch: Partial<LayerReferenceState> = {};

  const widgetIds = new Set(current.widgets.map((widget) => widget.id));
  const widgets = (normalizeWidgets(snapshot.widgets) ?? []).filter(
    (widget) => widget.layerId === layerId && !widgetIds.has(widget.id),
  );
  if (widgets.length > 0) patch.widgets = [...current.widgets, ...widgets];

  const commentIds = new Set(current.comments.map((comment) => comment.id));
  const comments = normalizeProjectComments(snapshot.comments).filter(
    (comment) =>
      comment.anchor.type === "feature" &&
      comment.anchor.layerId === layerId &&
      !commentIds.has(comment.id),
  );
  if (comments.length > 0) patch.comments = [...current.comments, ...comments];

  const legend = restoreLegendReferences(
    current.legend,
    normalizeLegendConfig(snapshot.legend),
    layerId,
  );
  if (legend !== current.legend) patch.legend = legend;

  const storymap = restoreStorymapReferences(
    current.storymap,
    normalizeStoryMap(snapshot.storymap),
    layerId,
  );
  if (storymap !== current.storymap) patch.storymap = storymap;

  const snapshotPanes = new Map(
    (normalizeSecondaryMapViews(snapshot.secondaryMapViews) ?? []).map((pane) => [pane.id, pane]),
  );
  let panesChanged = false;
  const secondaryMapViews = current.secondaryMapViews.map((pane) => {
    const visible = snapshotPanes.get(pane.id)?.layerVisibility[layerId];
    if (visible === undefined || layerId in pane.layerVisibility) return pane;
    panesChanged = true;
    return { ...pane, layerVisibility: { ...pane.layerVisibility, [layerId]: visible } };
  });
  if (panesChanged) patch.secondaryMapViews = secondaryMapViews;

  const printLayout = restorePrintLayoutReferences(
    current.printLayout,
    normalizePrintLayoutConfig(snapshot.printLayout),
    layerId,
  );
  if (printLayout !== current.printLayout) patch.printLayout = printLayout;

  return patch;
}

function legendKeyLayer(key: string): string {
  return key.includes("::") ? key.slice(0, key.indexOf("::")) : key;
}

function restoreLegendReferences(
  current: LegendConfig,
  snapshot: LegendConfig | undefined,
  layerId: string,
): LegendConfig {
  if (!snapshot) return current;
  let changed = false;

  // An empty order means "default order"; pinning one layer would reorder the
  // rest, so only slot it back into an order the user still has.
  let order = current.order;
  const snapshotIndex = snapshot.order.indexOf(layerId);
  if (snapshotIndex >= 0 && order.length > 0 && !order.includes(layerId)) {
    let insertAt: number | null = null;
    for (let i = snapshotIndex - 1; i >= 0 && insertAt === null; i--) {
      const index = order.indexOf(snapshot.order[i]);
      if (index >= 0) insertAt = index + 1;
    }
    for (let i = snapshotIndex + 1; i < snapshot.order.length && insertAt === null; i++) {
      const index = order.indexOf(snapshot.order[i]);
      if (index >= 0) insertAt = index;
    }
    insertAt ??= order.length;
    order = [...order.slice(0, insertAt), layerId, ...order.slice(insertAt)];
    changed = true;
  }

  let overrides = current.overrides;
  for (const [key, value] of Object.entries(snapshot.overrides)) {
    if (legendKeyLayer(key) !== layerId || key in overrides) continue;
    overrides = { ...overrides, [key]: value };
    changed = true;
  }

  let customEntries = current.customEntries;
  const entry = snapshot.customEntries?.[layerId];
  if (entry && !customEntries?.[layerId]) {
    customEntries = { ...customEntries, [layerId]: entry };
    changed = true;
  }

  return changed ? { ...current, order, overrides, customEntries } : current;
}

function restoreStorymapReferences(
  current: StoryMap | null,
  snapshot: StoryMap | null,
  layerId: string,
): StoryMap | null {
  if (!current || !snapshot) return current;
  const snapshotChapters = new Map(snapshot.chapters.map((chapter) => [chapter.id, chapter]));
  let changed = false;
  const chapters = current.chapters.map((chapter) => {
    const before = snapshotChapters.get(chapter.id);
    if (!before) return chapter;
    const restoreRows = (
      rows: StoryLayerOpacityChange[],
      snapshotRows: StoryLayerOpacityChange[],
    ) => {
      if (rows.some((row) => row.layerId === layerId)) return rows;
      const missing = snapshotRows.filter((row) => row.layerId === layerId);
      return missing.length > 0 ? [...rows, ...missing] : rows;
    };
    const onChapterEnter = restoreRows(chapter.onChapterEnter, before.onChapterEnter);
    const onChapterExit = restoreRows(chapter.onChapterExit, before.onChapterExit);
    if (onChapterEnter === chapter.onChapterEnter && onChapterExit === chapter.onChapterExit) {
      return chapter;
    }
    changed = true;
    return { ...chapter, onChapterEnter, onChapterExit };
  });
  return changed ? { ...current, chapters } : current;
}

function restorePrintLayoutReferences(
  current: PrintLayoutConfig,
  snapshot: PrintLayoutConfig | null,
  layerId: string,
): PrintLayoutConfig {
  if (!snapshot) return current;
  // Deleting the layer cleared these blocks; refill only a block that is
  // still empty, so one the user re-pointed since keeps its layer.
  const table = snapshot.tableLayerId === layerId && current.tableLayerId === "";
  const chart = snapshot.chartLayerId === layerId && current.chartLayerId === "";
  const atlas = snapshot.atlasLayerId === layerId && current.atlasLayerId === "";
  if (!table && !chart && !atlas) return current;
  return {
    ...current,
    ...(table ? { tableLayerId: layerId, showDataTable: snapshot.showDataTable } : {}),
    ...(chart ? { chartLayerId: layerId, showDataChart: snapshot.showDataChart } : {}),
    ...(atlas ? { atlasLayerId: layerId, atlasEnabled: snapshot.atlasEnabled } : {}),
  };
}
