import type { GeoLibreProject } from "@geolibre/core";

export interface DroppedProjectWorkspaceState {
  projectGeneration: number;
  projectFingerprint: string;
}

interface ResolveDroppedProjectOptions {
  project: GeoLibreProject;
  projectGeneration: number;
  projectFingerprint: string;
  getWorkspaceState: () => DroppedProjectWorkspaceState;
  resolveProject: (project: GeoLibreProject) => Promise<GeoLibreProject>;
  loadProject: (project: GeoLibreProject) => void;
  workspaceChanged: (state: DroppedProjectWorkspaceState) => void;
}

/** Resolve remote layers without replacing a project that changed while awaiting them. */
export async function resolveDroppedProjectIfCurrent({
  project,
  projectGeneration,
  projectFingerprint,
  getWorkspaceState,
  resolveProject,
  loadProject,
  workspaceChanged,
}: ResolveDroppedProjectOptions): Promise<boolean> {
  if (getWorkspaceState().projectGeneration !== projectGeneration) return false;
  const resolvedProject = await resolveProject(project);
  const current = getWorkspaceState();
  if (current.projectGeneration !== projectGeneration) return false;
  if (current.projectFingerprint !== projectFingerprint) {
    workspaceChanged(current);
    return false;
  }
  loadProject(resolvedProject);
  return true;
}
