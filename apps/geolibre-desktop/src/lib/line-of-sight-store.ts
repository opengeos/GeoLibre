import { create } from "zustand";

/**
 * Open/close state for the interactive Line of Sight tool (issue #2858).
 *
 * The tool is reached from two places that share no React tree -- the map's
 * right-click menu and the command palette -- so its state lives in a tiny
 * store rather than in either one. It is UI state only: nothing here is saved
 * with the project.
 */
interface LineOfSightToolState {
  open: boolean;
  /**
   * An observer to start from (the right-clicked point), or null to start by
   * picking one. Paired with {@link request} so a second "from here" on the
   * same point still restarts the tool.
   */
  seed: { lng: number; lat: number } | null;
  /** Bumped on every open, so the panel restarts even when already open. */
  request: number;
  /**
   * Open the tool.
   *
   * @param seed - The observer, when the tool is opened from a clicked point.
   */
  openLineOfSight: (seed?: { lng: number; lat: number } | null) => void;
  /** Close the tool and clear its drawing. */
  closeLineOfSight: () => void;
}

export const useLineOfSightTool = create<LineOfSightToolState>((set) => ({
  open: false,
  seed: null,
  request: 0,
  openLineOfSight: (seed = null) =>
    set((state) => ({ open: true, seed, request: state.request + 1 })),
  closeLineOfSight: () => set({ open: false, seed: null }),
}));
