import type { CapabilitiesSlice } from "./capabilities-slice";
import type { CollaborationSlice } from "./collaboration-slice";
import type { LayerGroupsSlice } from "./layer-groups-slice";
import type { LayersSlice } from "./layers-slice";
import type { LibrariesSlice } from "./libraries-slice";
import type { MapViewSlice } from "./map-view-slice";
import type { ProcessingSlice } from "./processing-slice";
import type { ProjectContentSlice } from "./project-content-slice";
import type { ProjectSlice } from "./project-slice";
import type { SessionSlice } from "./session-slice";
import type { UiSlice } from "./ui-slice";

/**
 * The whole app store: every slice's state and actions in one flat object.
 * The slices are an internal split of `store.ts`; consumers see one store.
 */
export interface AppState
  extends
    ProjectSlice,
    MapViewSlice,
    LayersSlice,
    LayerGroupsSlice,
    ProjectContentSlice,
    ProcessingSlice,
    LibrariesSlice,
    SessionSlice,
    CollaborationSlice,
    CapabilitiesSlice,
    UiSlice {}

/** The store's `set`, as each slice creator receives it. */
export type StoreSet = (
  partial: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>),
) => void;

/** The store's `get`, as each slice creator receives it. */
export type StoreGet = () => AppState;

/**
 * A slice creator: builds one slice's initial state and actions. Actions may
 * read and write any part of the store through `set`/`get` (for example
 * `removeLayer` scrubs references held by other slices).
 */
export type SliceCreator<TSlice> = (set: StoreSet, get: StoreGet) => TSlice;
