import { useEffect } from "react";

/** What decides whether the current project has finished restoring. */
export interface ProjectReadyState {
  /** The store's project generation, bumped by every New/Open. */
  projectGeneration: number;
  /** Whether the external (installed) plugins have finished loading. */
  externalPluginsReady: boolean;
  /** Plugin URLs from the project still waiting on a trust decision. */
  pendingTrustCount: number;
  /** The generation whose saved plugin state was last restored. */
  restoredProjectGeneration: number | null;
}

/**
 * The generation to publish as "ready", or an empty string while the project
 * is still restoring.
 *
 * Args:
 *   state: The project, plugin and trust state to judge.
 *
 * Returns:
 *   The project generation as a string once it is ready, otherwise `""`.
 */
export function projectReadyGeneration(state: ProjectReadyState): string {
  return state.externalPluginsReady &&
    state.pendingTrustCount === 0 &&
    state.restoredProjectGeneration === state.projectGeneration
    ? String(state.projectGeneration)
    : "";
}

/**
 * Publish the project generation and its "ready" generation on the root
 * element (`data-geolibre-project-generation` and
 * `data-geolibre-project-ready-generation`), so external readers such as the
 * screenshot service and end-to-end tests can wait for a project to finish
 * restoring. Both markers are cleared on unmount so an embed teardown or hot
 * reload cannot leave a stale "ready" generation behind.
 *
 * Args:
 *   state: The project, plugin and trust state to judge.
 */
export function useProjectReadyMarkers(state: ProjectReadyState): void {
  const { projectGeneration, externalPluginsReady, pendingTrustCount, restoredProjectGeneration } =
    state;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.geolibreProjectGeneration = String(projectGeneration);
    root.dataset.geolibreProjectReadyGeneration = projectReadyGeneration({
      projectGeneration,
      externalPluginsReady,
      pendingTrustCount,
      restoredProjectGeneration,
    });
    return () => {
      delete root.dataset.geolibreProjectReadyGeneration;
      delete root.dataset.geolibreProjectGeneration;
    };
  }, [externalPluginsReady, projectGeneration, pendingTrustCount, restoredProjectGeneration]);
}
