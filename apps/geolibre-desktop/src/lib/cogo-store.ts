import { create } from "zustand";

/**
 * Open/close state for the COGO and trace digitizing panel (#3530). It is
 * opened from the command palette and the map's right-click menu, which share
 * no React tree, so the state lives in a tiny store like the Line of Sight
 * tool's. UI state only: nothing here is saved with the project.
 */
interface CogoToolState {
  open: boolean;
  /** A start vertex (the right-clicked point), or null to pick one. */
  seed: { lng: number; lat: number } | null;
  /** Bumped on every open, so the panel restarts even when already open. */
  request: number;
  /**
   * Open the panel.
   *
   * @param seed - The first vertex, when opened from a clicked point.
   */
  openCogo: (seed?: { lng: number; lat: number } | null) => void;
  /** Close the panel and clear its drawing. */
  closeCogo: () => void;
}

export const useCogoTool = create<CogoToolState>((set) => ({
  open: false,
  seed: null,
  request: 0,
  openCogo: (seed = null) => set((state) => ({ open: true, seed, request: state.request + 1 })),
  closeCogo: () => set({ open: false, seed: null }),
}));
