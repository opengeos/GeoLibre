import type { GeoLibreProject, MapViewState, ProjectPluginState } from "@geolibre/core";

/**
 * Keep participant-local runtime state out of an inbound collaboration
 * snapshot. External plugin code is installed and activated independently on
 * each client; applying a peer's activePluginIds would deactivate local
 * controls and let their teardown remove every native layer they own.
 *
 * Plugin-created layers themselves remain in `project.layers` and are portable
 * GeoJSON, so they still synchronize and render without synchronizing plugin
 * lifecycle state.
 */
export function mergeInboundCollaborationProject(
  project: GeoLibreProject,
  localView: MapViewState,
  localPlugins: ProjectPluginState | null,
): GeoLibreProject {
  const merged: GeoLibreProject = { ...project, mapView: localView };
  if (localPlugins) {
    merged.plugins = localPlugins;
  } else {
    delete merged.plugins;
  }
  return merged;
}
