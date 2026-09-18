import type { GeoLibreProject } from "@geolibre/core";

export interface DroppedProjectWorkspaceState {
  projectGeneration: number;
  isDirty: boolean;
  projectFingerprint: string | null;
}

interface ResolveDroppedProjectOptions {
  project: GeoLibreProject;
  projectGeneration: number;
  projectFingerprint: string | null;
  isCurrentOperation: () => boolean;
  getWorkspaceState: () => DroppedProjectWorkspaceState;
  resolveProject: (project: GeoLibreProject) => Promise<GeoLibreProject>;
  loadProject: (project: GeoLibreProject) => void;
  workspaceChanged: (state: DroppedProjectWorkspaceState, project: GeoLibreProject) => void;
}

/** Resolve remote layers without replacing a project that changed while awaiting them. */
export async function resolveDroppedProjectIfCurrent({
  project,
  projectGeneration,
  projectFingerprint,
  isCurrentOperation,
  getWorkspaceState,
  resolveProject,
  loadProject,
  workspaceChanged,
}: ResolveDroppedProjectOptions): Promise<boolean> {
  if (!isCurrentOperation()) return false;
  const resolvedProject = await resolveProject(project);
  if (!isCurrentOperation()) return false;
  const current = getWorkspaceState();
  if (current.projectGeneration !== projectGeneration) return false;
  const changed =
    projectFingerprint === null
      ? current.isDirty
      : current.projectFingerprint !== projectFingerprint;
  if (changed) {
    workspaceChanged(current, resolvedProject);
    return false;
  }
  loadProject(resolvedProject);
  return true;
}
