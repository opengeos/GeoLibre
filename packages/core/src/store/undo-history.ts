/**
 * Undo/redo for the app store. zundo's `temporal` middleware tracks only the
 * project-data fields that {@link partializeHistory} lists (layers, groups,
 * basemap, story map, comments, dashboard widgets, legend); every other field,
 * including the whole `ui`
 * dialog sub-state, selection and the camera, is outside the history, so
 * changing it never records an undo step and undo/redo never reverts it.
 *
 * The functions here act on the store bound by {@link bindHistoryStore}
 * rather than importing it, so the slices (whose `newProject`/`loadProject`
 * call {@link clearHistory}) can depend on this module without a cycle.
 */
import { shallow } from "zustand/shallow";
import type { StoreApi } from "zustand";
import type { TemporalState, ZundoOptions } from "zundo";
import { DEFAULT_ELLIPSOID_ID, getPlanetaryBasemapByStyleUrl } from "../ellipsoids";
import {
  getHistoryCoalesceMs,
  getMaxHistoryFeatureCount,
  leadingDebounce,
  trimHistoryBySize,
} from "../history";
import { scrubPrintLayoutForLayers } from "../print-layout-config";
import type { GeoLibreProject, LayerGroup } from "../types";
import { scrubSecondaryPaneLayerVisibility } from "./layer-removal";
import type { AppState } from "./types";

/** The fields undo/redo snapshots, restores and compares. */
export type HistoryState = Pick<
  AppState,
  | "layers"
  | "layerGroups"
  | "basemapStyleUrl"
  | "basemapVisible"
  | "basemapOpacity"
  | "blankBackgroundColor"
  | "storymap"
  | "comments"
  | "widgets"
  | "legend"
>;

/** The parts of the bound store the history functions use. */
interface HistoryStore {
  getState: () => AppState;
  setState: (partial: Partial<AppState>) => void;
  temporal: StoreApi<TemporalState<HistoryState>>;
}

let historyStore: HistoryStore | null = null;

/** Point the history functions at the app store; called once by `store.ts`. */
export function bindHistoryStore(store: HistoryStore): void {
  historyStore = store;
}

function boundStore(): HistoryStore {
  if (!historyStore) throw new Error("The app store has not been created yet.");
  return historyStore;
}

/**
 * Compare two `layerGroups` arrays for undo-history purposes, ignoring the
 * `collapsed` flag so expand/collapse (a UI-panel preference) never records a
 * history entry. Every other field — order, name, visibility, opacity — is
 * still compared, so real edits are tracked.
 */
function layerGroupsEqualForHistory(a: LayerGroup[], b: LayerGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.id !== y.id || x.name !== y.name || x.visible !== y.visible || x.opacity !== y.opacity) {
      return false;
    }
  }
  return true;
}

/** Cancels the active history coalesce window (assigned by zundo's handleSet). */
let cancelHistoryCoalesce: () => void = () => {};

interface ProjectRestoreHistoryEntry {
  before: GeoLibreProject;
  beforePath: string | null;
  after: GeoLibreProject;
  afterPath: string | null;
}

let projectRestoreUndo: ProjectRestoreHistoryEntry | null = null;
let projectRestoreRedo: ProjectRestoreHistoryEntry | null = null;
let applyingProjectRestoreHistory = false;
const projectRestoreHistoryListeners = new Set<() => void>();

function notifyProjectRestoreHistory(): void {
  projectRestoreHistoryListeners.forEach((listener) => listener());
}

export function subscribeProjectRestoreHistory(listener: () => void): () => void {
  projectRestoreHistoryListeners.add(listener);
  return () => projectRestoreHistoryListeners.delete(listener);
}

export function canUndoProjectRestore(): boolean {
  return projectRestoreUndo !== null;
}

export function canRedoProjectRestore(): boolean {
  return projectRestoreRedo !== null;
}

/**
 * Register a whole-project restore as one undoable operation. The regular
 * temporal history intentionally tracks only editing fields, while restoring a
 * history snapshot also changes project metadata, camera, plugins, and other
 * serialized state, so it needs a full canonical project pair.
 */
export function registerProjectRestoreHistory(
  before: GeoLibreProject,
  beforePath: string | null,
  after: GeoLibreProject,
  afterPath: string | null = null,
): void {
  projectRestoreUndo = { before, beforePath, after, afterPath };
  projectRestoreRedo = null;
  notifyProjectRestoreHistory();
}

/**
 * Drop the oldest undo snapshots once their combined feature payload exceeds the
 * configured budget, bounding the memory held by history when a large vector
 * layer is edited repeatedly (issue #341). Called after a snapshot is appended.
 * Operates on the live temporal store directly; this never touches the main
 * store, so it does not itself record a history entry.
 */
function pruneHistoryBySize(): void {
  const temporalStore = boundStore().temporal;
  const { pastStates } = temporalStore.getState();
  const trimmed = trimHistoryBySize(pastStates, getMaxHistoryFeatureCount());
  if (trimmed.length !== pastStates.length) {
    temporalStore.setState({ pastStates: trimmed });
  }
}

/**
 * Only these fields participate in undo/redo; everything else (selection,
 * ui flags, mapView/camera, pointerCoords, project metadata, isDirty, ...)
 * is excluded, so changing them never creates a history entry.
 */
export function partializeHistory(s: AppState): HistoryState {
  return {
    layers: s.layers,
    layerGroups: s.layerGroups,
    basemapStyleUrl: s.basemapStyleUrl,
    basemapVisible: s.basemapVisible,
    basemapOpacity: s.basemapOpacity,
    blankBackgroundColor: s.blankBackgroundColor,
    storymap: s.storymap,
    comments: s.comments,
    // Widgets and legend entries reference layers, and deleting a layer
    // scrubs them; tracking them makes undoing a delete (or a snapshot layer
    // restore) bring them back with the layer instead of leaving them lost or
    // dangling. Secondary panes and the Print Layout are deliberately not
    // tracked (see finishHistoryStep).
    widgets: s.widgets,
    legend: s.legend,
  };
}

/** zundo options for the app store's undo history. */
export function createHistoryOptions(): ZundoOptions<AppState, HistoryState> {
  return {
    partialize: partializeHistory,
    // Records a history entry only when the tracked slice really changed.
    // Basemap fields compare with ===; `layers` is compared element-by-element
    // (Object.is per element) via shallow. Every mutating action creates new
    // layer/group objects, so real changes differ; two distinct empty arrays
    // compare equal, so resetting them (e.g. newProject) records nothing.
    // `storymap` is compared by reference: every authoring action creates a
    // new object, so real edits differ while an unchanged null stays equal.
    // `layerGroups` is compared ignoring `collapsed`, which is a UI preference
    // excluded from undo (see toggleLayerGroupCollapsed).
    // `comments` and `widgets` are compared shallowly by reference, and
    // `legend` by reference: setLegend always stores a new object.
    equality: (a, b) =>
      a.basemapStyleUrl === b.basemapStyleUrl &&
      a.basemapVisible === b.basemapVisible &&
      a.basemapOpacity === b.basemapOpacity &&
      a.blankBackgroundColor === b.blankBackgroundColor &&
      a.storymap === b.storymap &&
      shallow(a.layers, b.layers) &&
      shallow(a.comments, b.comments) &&
      shallow(a.widgets, b.widgets) &&
      a.legend === b.legend &&
      layerGroupsEqualForHistory(a.layerGroups, b.layerGroups),
    limit: 100,
    // Group rapid bursts (slider drags) into one entry; window is 0 in tests.
    // Keep the debounced wrapper so clearHistory can reset an in-flight burst.
    handleSet: (baseHandleSet) => {
      const debounced = leadingDebounce(baseHandleSet, getHistoryCoalesceMs);
      cancelHistoryCoalesce = debounced.cancel;
      // Trim history back under the feature-payload budget so editing large
      // layers can't pin unbounded copies of their feature sets in memory
      // (issue #341). Only the leading-edge call actually pushes a snapshot;
      // burst-suppressed calls leave `pastStates` untouched, so skip the scan
      // unless a new snapshot was appended.
      return (...args: Parameters<typeof debounced>) => {
        const before = boundStore().temporal.getState().pastStates;
        debounced(...args);
        if (boundStore().temporal.getState().pastStates !== before) {
          if (!applyingProjectRestoreHistory && projectRestoreRedo) {
            projectRestoreRedo = null;
            notifyProjectRestoreHistory();
          }
          pruneHistoryBySize();
        }
      };
    },
  };
}

/**
 * After an undo/redo restores the tracked slice, mark the project dirty and
 * drop references the step left pointing at a layer that no longer exists:
 * the selection, per-pane layer visibility, and Print Layout data/atlas
 * blocks. None of those is tracked in history (selection is UI state; panes
 * carry their own camera and must stay in step with the untracked grid
 * layout; the Print Layout composer keeps a local copy it writes back), so
 * they are scrubbed the way deleting the layer would have scrubbed them.
 */
function finishHistoryStep(previousBasemapStyleUrl: string): void {
  const s = boundStore().getState();
  const layerIds = new Set(s.layers.map((layer) => layer.id));
  const danglingPaneIds = new Set<string>();
  for (const pane of s.secondaryMapViews) {
    for (const id of Object.keys(pane.layerVisibility)) {
      if (!layerIds.has(id)) danglingPaneIds.add(id);
    }
  }
  const secondaryMapViews = scrubSecondaryPaneLayerVisibility(s.secondaryMapViews, danglingPaneIds);
  const printLayout = scrubPrintLayoutForLayers(s.printLayout, layerIds);
  const referencePatch = {
    ...(secondaryMapViews !== s.secondaryMapViews ? { secondaryMapViews } : {}),
    ...(printLayout !== s.printLayout ? { printLayout } : {}),
  };
  const selectionDangling =
    s.selectedLayerId !== null && !s.layers.some((layer) => layer.id === s.selectedLayerId);
  // The basemap is in the undo history but the ellipsoid preference is not, so a
  // step that restores a *different* basemap can leave the two out of sync (e.g.
  // undoing a switch to Mars would keep the Mars radius under an Earth basemap).
  // Re-derive the ellipsoid from the restored basemap's body — Earth for a
  // non-planetary basemap — but only when this step actually changed the
  // basemap. Steps that leave the basemap untouched must not touch the ellipsoid,
  // which the user can set independently of the basemap in Settings.
  const restoredEllipsoidId =
    getPlanetaryBasemapByStyleUrl(s.basemapStyleUrl)?.ellipsoidId ?? DEFAULT_ELLIPSOID_ID;
  const ellipsoidPatch =
    s.basemapStyleUrl !== previousBasemapStyleUrl &&
    s.preferences.map.ellipsoidId !== restoredEllipsoidId
      ? {
          preferences: {
            ...s.preferences,
            map: { ...s.preferences.map, ellipsoidId: restoredEllipsoidId },
          },
        }
      : {};
  boundStore().setState(
    selectionDangling
      ? {
          isDirty: true,
          selectedLayerId: null,
          selectedFeatureId: null,
          selectedFeatureIds: [],
          ...ellipsoidPatch,
          ...referencePatch,
        }
      : { isDirty: true, ...ellipsoidPatch, ...referencePatch },
  );
  // The setState above must not leave a coalesce window open for the next edit.
  cancelHistoryCoalesce();
}

/**
 * Step the layer/basemap history back one entry and mark the project dirty.
 * zundo restores the partialized slice via the store's set; the resulting new
 * `layers`/basemap refs drive MapCanvas's existing effects, so the map
 * reconciles through MapController.syncLayers (never mutated directly here).
 */
export function undo(): void {
  const temporal = boundStore().temporal.getState();
  if (temporal.pastStates.length === 0 && projectRestoreUndo) {
    const entry = projectRestoreUndo;
    applyingProjectRestoreHistory = true;
    try {
      boundStore().getState().loadProject(entry.before, entry.beforePath, {
        rememberRecent: false,
        presenting: false,
      });
      projectRestoreUndo = null;
      boundStore().setState({ isDirty: true });
      projectRestoreRedo = entry;
      notifyProjectRestoreHistory();
    } catch (error) {
      console.error("Could not undo the project snapshot restore.", error);
    } finally {
      applyingProjectRestoreHistory = false;
    }
    return;
  }
  if (temporal.pastStates.length === 0) return; // nothing to undo; stay clean
  cancelHistoryCoalesce(); // break any in-flight burst so the next edit records
  const previousBasemapStyleUrl = boundStore().getState().basemapStyleUrl;
  temporal.undo();
  finishHistoryStep(previousBasemapStyleUrl);
}

/** Step the history forward one entry and mark the project dirty. */
export function redo(): void {
  const temporal = boundStore().temporal.getState();
  if (temporal.futureStates.length === 0 && projectRestoreRedo) {
    const entry = projectRestoreRedo;
    applyingProjectRestoreHistory = true;
    try {
      boundStore().getState().loadProject(entry.after, entry.afterPath, {
        rememberRecent: false,
        presenting: false,
      });
      projectRestoreRedo = null;
      boundStore().setState({ isDirty: true });
      projectRestoreUndo = entry;
      notifyProjectRestoreHistory();
    } catch (error) {
      console.error("Could not redo the project snapshot restore.", error);
    } finally {
      applyingProjectRestoreHistory = false;
    }
    return;
  }
  if (temporal.futureStates.length === 0) return; // nothing to redo; stay clean
  cancelHistoryCoalesce(); // break any in-flight burst so the next edit records
  const previousBasemapStyleUrl = boundStore().getState().basemapStyleUrl;
  temporal.redo();
  finishHistoryStep(previousBasemapStyleUrl);
}

/**
 * Apply a store change that is not the user's (data loading in behind a
 * project) without recording an undo step for it. The history stays as it
 * was, so undo neither takes the change back out nor loses earlier steps.
 *
 * @param change - The store updates to apply.
 */
export function withoutHistory(change: () => void): void {
  cancelHistoryCoalesce(); // a burst left open would record this change
  const temporal = boundStore().temporal.getState();
  temporal.pause();
  try {
    change();
  } finally {
    temporal.resume();
  }
}

/** Empty both the undo and redo stacks (e.g. on new/loaded project). */
export function clearHistory(): void {
  cancelHistoryCoalesce(); // reset any in-flight burst so the next edit records
  boundStore().temporal.getState().clear();
  if (!applyingProjectRestoreHistory) {
    projectRestoreUndo = null;
    projectRestoreRedo = null;
    notifyProjectRestoreHistory();
  }
}
