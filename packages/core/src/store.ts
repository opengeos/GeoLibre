/**
 * The app store: one Zustand store wrapped in zundo's undo history, composed
 * from the slices under `./store/` (zustand's slices pattern). The split is
 * internal — the hook, the state shape and every export are unchanged, and
 * consumers keep importing from here (or `@geolibre/core`).
 *
 * Slices: project (identity and lifecycle), map-view (camera, basemap, grid),
 * layers, layer-groups, project-content (comments, dashboard, story map),
 * processing (models, run history), libraries (style / layer / template),
 * session (selection and live readouts), collaboration, capabilities, and ui
 * (dialog and panel flags). Undo history lives in `./store/undo-history.ts`.
 */
import { create } from "zustand";
import { temporal } from "zundo";
import { appPrivilegeReason } from "./capabilities";
import { setActiveEllipsoidId } from "./ellipsoids";
import type { AppPrivilege } from "./types";
import { createCapabilitiesSlice } from "./store/capabilities-slice";
import { createCollaborationSlice } from "./store/collaboration-slice";
import { createLayerGroupsSlice } from "./store/layer-groups-slice";
import { createLayersSlice } from "./store/layers-slice";
import { createLibrariesSlice } from "./store/libraries-slice";
import { createMapViewSlice } from "./store/map-view-slice";
import { createProcessingSlice } from "./store/processing-slice";
import { createProjectContentSlice } from "./store/project-content-slice";
import { createProjectSlice } from "./store/project-slice";
import { createSessionSlice } from "./store/session-slice";
import { createUiSlice } from "./store/ui-slice";
import type { AppState } from "./store/types";
import { bindHistoryStore, createHistoryOptions } from "./store/undo-history";

export type { AppState } from "./store/types";
export type {
  ConversionToolKind,
  NetworkToolKind,
  RasterToolKind,
  StatisticsToolKind,
  VectorToolKind,
} from "./store/ui-slice";
export {
  type GpsStatusFix,
  IDENTIFY_ALL_LAYERS_ID,
  type IdentifyState,
  identifyAllIncludes,
  identifyStateWithoutLayers,
  resolveIdentifyTarget,
} from "./store/session-slice";
export { DEFAULT_COLLABORATION_STATE } from "./store/collaboration-slice";
export { projectPathLabel } from "./store/project-slice";
export {
  canRedoProjectRestore,
  canUndoProjectRestore,
  clearHistory,
  redo,
  registerProjectRestoreHistory,
  subscribeProjectRestoreHistory,
  undo,
} from "./store/undo-history";

export const useAppStore = create<AppState>()(
  temporal(
    (set, get) => ({
      ...createProjectSlice(set, get),
      ...createMapViewSlice(set, get),
      ...createLayersSlice(set, get),
      ...createLayerGroupsSlice(set, get),
      ...createProjectContentSlice(set, get),
      ...createProcessingSlice(set, get),
      ...createLibrariesSlice(set, get),
      ...createSessionSlice(set, get),
      ...createCollaborationSlice(set, get),
      ...createCapabilitiesSlice(set, get),
      ...createUiSlice(set, get),
    }),
    createHistoryOptions(),
  ),
);

bindHistoryStore(useAppStore);

// Mirror the project's ellipsoid into the module-level singleton the
// measurement helpers read. One subscription covers every path that changes
// preferences (setPreferences, load/new project, undo/redo) without threading
// the value through each call site. The subscription runs on every store
// mutation (e.g. setPointerCoords on each mousemove), so guard on the id to skip
// the redundant work for a value that changes at most once per session.
let lastEllipsoidId = useAppStore.getState().preferences.map.ellipsoidId;
setActiveEllipsoidId(lastEllipsoidId);
useAppStore.subscribe((state) => {
  const id = state.preferences.map.ellipsoidId;
  if (id === lastEllipsoidId) return;
  lastEllipsoidId = id;
  setActiveEllipsoidId(id);
});

/**
 * React hook for consuming application capability state for a specific privilege.
 *
 * @param privilege - The privilege to check.
 * @returns `{ granted: boolean, reason?: string }`
 */
export function useAppCapability(privilege: AppPrivilege): { granted: boolean; reason?: string } {
  const capabilities = useAppStore((state) => state.capabilities);
  return {
    granted: capabilities.privileges.includes(privilege),
    reason: appPrivilegeReason(capabilities, privilege),
  };
}
