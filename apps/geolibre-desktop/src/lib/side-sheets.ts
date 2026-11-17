// Below the `md` breakpoint the Layers and Style panels stop sitting beside the
// map and open as sheets over it: Layers from the top, Style from the bottom,
// each up to 42% of the viewport. Two of them leave little or no map, and on a
// short viewport (a laptop at 200% zoom is 640x400) they overlap, with Style
// covering the bottom of Layers. So on a narrow viewport only one stays open:
// the one opened most recently, while the other folds back to its rail.
//
// Each panel owns its own collapse state, so they report it here and read back
// whether to yield. The record is per page, like the app store it sits beside.

/** A side panel that becomes a sheet over the map on narrow viewports. */
export type SideSheetId = "layers" | "style";

/** Which side panels are expanded, and which was expanded most recently. */
export interface SideSheetState {
  readonly expanded: Readonly<Record<SideSheetId, boolean>>;
  readonly lastExpanded: SideSheetId | null;
}

export const INITIAL_SIDE_SHEET_STATE: SideSheetState = {
  expanded: { layers: false, style: false },
  lastExpanded: null,
};

/**
 * Record a panel's expanded state. Expanding a panel that was collapsed makes it
 * the most recent one, on any viewport, so a window that later narrows (or a
 * zoom to 200%) keeps the panel the user opened last.
 *
 * @param state - The current record.
 * @param id - The panel reporting.
 * @param expanded - Whether it is expanded now.
 * @returns The new record, or `state` itself when nothing changed.
 */
export function reportSideSheet(
  state: SideSheetState,
  id: SideSheetId,
  expanded: boolean,
): SideSheetState {
  if (state.expanded[id] === expanded) return state;
  return {
    expanded: { ...state.expanded, [id]: expanded },
    lastExpanded: expanded ? id : state.lastExpanded,
  };
}

/**
 * Whether a panel should fold back to its rail: only on a narrow viewport, only
 * while it is expanded, and only when the other panel is expanded too and was
 * opened after it.
 *
 * @param state - The current record.
 * @param id - The panel asking.
 * @param narrow - Whether the viewport is below the `md` breakpoint.
 * @returns True when the panel should collapse.
 */
export function shouldYieldSideSheet(
  state: SideSheetState,
  id: SideSheetId,
  narrow: boolean,
): boolean {
  const other: SideSheetId = id === "layers" ? "style" : "layers";
  return narrow && state.expanded[id] && state.expanded[other] && state.lastExpanded === other;
}

let sideSheetState = INITIAL_SIDE_SHEET_STATE;
const listeners = new Set<() => void>();

/** Record a panel's expanded state and notify subscribers when it changed. */
export function setSideSheetExpanded(id: SideSheetId, expanded: boolean): void {
  const next = reportSideSheet(sideSheetState, id, expanded);
  if (next === sideSheetState) return;
  sideSheetState = next;
  for (const listener of listeners) listener();
}

/** The current record, for `useSyncExternalStore`. */
export function getSideSheetState(): SideSheetState {
  return sideSheetState;
}

/** Subscribe to record changes, for `useSyncExternalStore`. */
export function subscribeSideSheets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
