import type { useAppStore } from "@geolibre/core";

type AppState = ReturnType<typeof useAppStore.getState>;

/**
 * Reference-compares the store fields that feed a project snapshot. Every
 * mutating store action produces new refs for the slice it touches, so this is
 * a cheap, correct "did the broadcastable project change?" check that ignores
 * selection, UI, and collaboration-slice churn.
 *
 * `mapView` is deliberately NOT compared: each participant keeps their own
 * camera (applyRemoteSnapshot overrides the incoming view), so broadcasting a
 * full-project snapshot on every pan/zoom only churns receivers' layer
 * reconciliation for no visible effect — and that churn was intermittently
 * crashing the map under rapid panning. Camera is shared through presence
 * (viewport rectangles + opt-in follow-host) instead.
 *
 * The compared fields must stay aligned with `buildProjectSnapshot` (minus
 * camera): models, processing history, dashboard widgets, map grid, and the
 * project style library are part of the snapshot payload and must trigger a
 * broadcast when they change on their own. Plugin activation/settings are
 * participant-local: plugin-created layer records trigger their own broadcast,
 * while sharing `activePluginIds` would deactivate controls on other clients.
 * Comments are deliberately excluded:
 * active collaboration sessions synchronize them through `comment-mutation`.
 * Treating an inbound comment as a project change would make every peer answer
 * it with a whole-project snapshot, allowing a comment to overwrite unrelated
 * plugin-managed layer state.
 */
export function projectChanged(a: AppState, b: AppState): boolean {
  return (
    a.projectName !== b.projectName ||
    a.basemapStyleUrl !== b.basemapStyleUrl ||
    a.basemapVisible !== b.basemapVisible ||
    a.basemapOpacity !== b.basemapOpacity ||
    a.blankBackgroundColor !== b.blankBackgroundColor ||
    a.layers !== b.layers ||
    a.layerGroups !== b.layerGroups ||
    a.preferences !== b.preferences ||
    a.legend !== b.legend ||
    a.storymap !== b.storymap ||
    a.models !== b.models ||
    a.processingHistory !== b.processingHistory ||
    a.widgets !== b.widgets ||
    a.dashboardColumns !== b.dashboardColumns ||
    a.mapLayout !== b.mapLayout ||
    a.secondaryMapViews !== b.secondaryMapViews ||
    a.primaryMapLabel !== b.primaryMapLabel ||
    a.projectStyleLibrary !== b.projectStyleLibrary ||
    a.metadata !== b.metadata
  );
}
