// Keeps a host's or session's regional basemap in outgoing project snapshots
// while this client renders the default basemap in its place.
//
// The regional-basemap gate (packages/core/src/regional-basemaps.ts) replaces a
// regional basemap the user has not confirmed, or one the deployment disabled,
// with the default basemap in the store. A bridge that mirrors the store back
// to someone else (the Jupyter widget's Python state, a live collaboration
// session) would otherwise report that local fallback as if the user had
// changed the basemap, and overwrite the host's or the other peers' choice.

import { DEFAULT_BASEMAP, getRegionalBasemapByStyleUrl, useAppStore } from "@geolibre/core";
import type { GeoLibreProject } from "@geolibre/core";

/** A regional basemap the local store is not showing, as of a basemap choice. */
interface WithheldBasemap {
  styleUrl: string;
  choiceGeneration: number;
}

/** Tracks one bridge's withheld basemap; see {@link createBasemapEgressTracker}. */
export interface BasemapEgressTracker {
  /**
   * Record what an inbound project asked for, after it has been applied to the
   * store. Remembers it when it is a regional basemap the store did not apply.
   *
   * @param requestedStyleUrl - The basemap the inbound project named.
   */
  noteInbound(requestedStyleUrl: string): void;
  /**
   * Restore the withheld basemap in an outgoing snapshot. Forgotten as soon as
   * the user picks a basemap locally (or accepts the prompt), which moves the
   * store's `basemapChoiceGeneration`, so their own choice goes out instead.
   *
   * @param project - A snapshot built from the local store.
   * @returns The snapshot to send.
   */
  apply(project: GeoLibreProject): GeoLibreProject;
  /** Forget any withheld basemap (a new connection or session). */
  reset(): void;
}

/**
 * Create a tracker for one outbound bridge.
 *
 * @returns A fresh tracker with nothing withheld.
 */
export function createBasemapEgressTracker(): BasemapEgressTracker {
  let withheld: WithheldBasemap | null = null;
  return {
    noteInbound(requestedStyleUrl) {
      const state = useAppStore.getState();
      withheld =
        getRegionalBasemapByStyleUrl(requestedStyleUrl) &&
        state.basemapStyleUrl !== requestedStyleUrl
          ? { styleUrl: requestedStyleUrl, choiceGeneration: state.basemapChoiceGeneration }
          : null;
    },
    apply(project) {
      if (!withheld) return project;
      if (useAppStore.getState().basemapChoiceGeneration !== withheld.choiceGeneration) {
        withheld = null;
        return project;
      }
      if (project.basemapStyleUrl !== DEFAULT_BASEMAP) return project;
      return { ...project, basemapStyleUrl: withheld.styleUrl };
    },
    reset() {
      withheld = null;
    },
  };
}
