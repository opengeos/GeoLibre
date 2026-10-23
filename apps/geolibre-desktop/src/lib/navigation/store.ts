import { create } from "zustand";

/** A point handed to the navigation tool when it is opened from the map. */
export interface NavigationSeed {
  lng: number;
  lat: number;
}

/**
 * Open/close state for the turn-by-turn navigation tool.
 *
 * The tool is reached from places that share no React tree -- the Controls
 * menu, the command palette, and the map's right-click menu ("Directions to
 * here" / "Directions from here") -- so its state lives in a tiny store rather
 * than in any one of them. It is UI state only: nothing here is saved with the
 * project.
 */
interface NavigationToolState {
  open: boolean;
  /** A destination to start from, when opened with "Directions to here". */
  destination: NavigationSeed | null;
  /** An origin to start from, when opened with "Directions from here". */
  origin: NavigationSeed | null;
  /** Bumped on every open, so the panel takes a new seed even when already open. */
  request: number;
  /**
   * Open the tool.
   *
   * @param seed - The clicked point and whether it is the trip's start or end.
   */
  openNavigation: (seed?: { point: NavigationSeed; as: "origin" | "destination" } | null) => void;
  /** Close the tool, ending any drive. */
  closeNavigation: () => void;
}

export const useNavigationTool = create<NavigationToolState>((set) => ({
  open: false,
  destination: null,
  origin: null,
  request: 0,
  openNavigation: (seed = null) =>
    set((state) => ({
      open: true,
      destination: seed?.as === "destination" ? seed.point : null,
      origin: seed?.as === "origin" ? seed.point : null,
      request: state.request + 1,
    })),
  closeNavigation: () => set({ open: false, destination: null, origin: null }),
}));
