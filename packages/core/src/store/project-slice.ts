/**
 * Project identity and lifecycle: name, path, dirty flag, recent projects, and
 * the project-level settings that have no richer home (plugins, legend, print
 * layout, metadata). `newProject` and `loadProject` replace the whole document
 * (every slice's project fields) and clear undo history.
 */
import {
  applyProjectToStore,
  type CreateProjectOptions,
  createEmptyProject,
  DEFAULT_PROJECT_NAME,
} from "../project";
import {
  createDefaultPrintLayout,
  printLayoutConfigsEqual,
  type PrintLayoutConfig,
} from "../print-layout-config";
import { reapplyLayerJoins } from "../joins";
import {
  DEFAULT_LEGEND_CONFIG,
  type GeoLibreProject,
  type LegendConfig,
  type ProjectPluginState,
  type RecentProjectEntry,
} from "../types";
import { resolveIdentifyTarget } from "./session-slice";
import type { SliceCreator } from "./types";
import { clearHistory } from "./undo-history";

const MAX_RECENT_PROJECTS = 10;

/** Derive a human-friendly display name from a file path or URL. */
export function projectPathLabel(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function normalizeRecentProjects(projects: RecentProjectEntry[]): RecentProjectEntry[] {
  const seen = new Set<string>();
  const normalized: RecentProjectEntry[] = [];

  for (const project of projects) {
    const path = project.path.trim();
    if (!path || seen.has(path)) continue;

    const name = project.name.trim() || projectPathLabel(path);
    normalized.push({
      path,
      name,
      openedAt: project.openedAt || new Date().toISOString(),
    });
    seen.add(path);
  }

  return normalized.slice(0, MAX_RECENT_PROJECTS);
}

export interface ProjectSlice {
  projectName: string;
  projectPath: string | null;
  projectGeneration: number;
  isDirty: boolean;
  projectPlugins: ProjectPluginState | null;
  legend: LegendConfig;
  /** Print Layout composer settings for the open project (discussion #1992). */
  printLayout: PrintLayoutConfig;
  metadata: Record<string, unknown>;
  recentProjects: RecentProjectEntry[];

  setLegend: (legend: LegendConfig) => void;
  /**
   * Replace the Print Layout composer settings. A config equal to the current
   * one is ignored, so re-opening the composer (or a project load seeding the
   * dialog) never marks the project dirty.
   */
  setPrintLayout: (printLayout: PrintLayoutConfig) => void;
  setProjectPlugins: (projectPlugins: ProjectPluginState | null, shouldMarkDirty?: boolean) => void;
  newProject: (options?: CreateProjectOptions & { name?: string }) => void;
  loadProject: (
    project: GeoLibreProject,
    path?: string | null,
    options?: { rememberRecent?: boolean; presenting?: boolean },
  ) => void;
  setProjectPath: (path: string | null) => void;
  setProjectName: (name: string) => void;
  setRecentProjects: (projects: RecentProjectEntry[]) => void;
  rememberRecentProject: (entry: RecentProjectEntry) => void;
  forgetRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  markSaved: () => void;
}

export const createProjectSlice: SliceCreator<ProjectSlice> = (set, get) => ({
  projectName: DEFAULT_PROJECT_NAME,
  projectPath: null,
  projectGeneration: 0,
  isDirty: false,
  projectPlugins: null,
  legend: { ...DEFAULT_LEGEND_CONFIG },
  printLayout: createDefaultPrintLayout(),
  metadata: {},
  recentProjects: [],

  setLegend: (legend) => set({ legend, isDirty: true }),

  setPrintLayout: (printLayout) =>
    set((s) =>
      printLayoutConfigsEqual(s.printLayout, printLayout) ? s : { printLayout, isDirty: true },
    ),
  // When shouldMarkDirty is false the existing dirty flag is preserved rather
  // than set; it cannot clear the flag (only markSaved() does that).
  setProjectPlugins: (projectPlugins, shouldMarkDirty = true) =>
    set((s) => ({
      projectPlugins,
      isDirty: shouldMarkDirty || s.isDirty,
    })),

  setProjectPath: (path) => set({ projectPath: path }),
  setProjectName: (name) => set({ projectName: name, isDirty: true }),
  setRecentProjects: (projects) => set({ recentProjects: normalizeRecentProjects(projects) }),
  rememberRecentProject: (entry) =>
    set((s) => ({
      recentProjects: normalizeRecentProjects([entry, ...s.recentProjects]),
    })),
  forgetRecentProject: (path) => {
    // Compare with separators normalized so a backslash/forward-slash mismatch
    // on Windows does not leave a stale entry behind.
    const normalized = path.replace(/\\/g, "/");
    set((s) => ({
      recentProjects: s.recentProjects.filter(
        (project) => project.path.replace(/\\/g, "/") !== normalized,
      ),
    }));
  },
  clearRecentProjects: () => set({ recentProjects: [] }),
  markSaved: () => set({ isDirty: false }),

  newProject: (options = {}) => {
    const project = createEmptyProject(options.name, options);
    const applied = applyProjectToStore(project);
    set((s) => ({
      ...applied,
      projectPath: null,
      projectGeneration: s.projectGeneration + 1,
      isDirty: false,
      selectedLayerId: null,
      selectedFeatureId: null,
      selectedFeatureIds: [],
      identifyLayerId: null,
      identifyLayerIds: null,
      // The copied style names a layer from the previous project, so a
      // paste in the new one would apply an orphaned entry.
      copiedLayerStyle: null,
      pointerCoords: null,
      pointerElevation: null,
      cameraAltitude: null,
      attributeFilter: "",
      // Don't carry an active story presentation into a different project.
      ui: {
        ...s.ui,
        storymapPresenting: false,
        storymapReturnToEditor: false,
        storymapLayerOpacity: {},
        storymapPanelOpen: false,
        storymapComposingId: null,
        // An open selection dialog (and its preselected layer id) belongs
        // to the previous project's layers.
        selectByExpressionOpen: false,
        selectByExpressionLayerId: null,
        selectByLocationOpen: false,
        selectByLocationLayerId: null,
        loadEditorFeaturesOpen: false,
        loadEditorFeaturesLayerId: null,
        // A pending assistant-requested Model Builder load names a model in
        // the previous project's `savedModels`.
        modelBuilderRequestedModelId: null,
      },
    }));
    clearHistory();
  },

  loadProject: (project, path = null, options = {}) => {
    const applied = applyProjectToStore(project);
    // Re-resolve persistent attribute joins against the loaded layer set,
    // so joined columns reflect the join tables as saved (and a stale
    // saved copy of the joined output self-heals).
    applied.layers = reapplyLayerJoins(applied.layers);
    // A project that ships a story map opens straight into the presentation
    // so the reader sees the story, not the editor. Projects without a story
    // (or with an empty one) open normally. Callers that open a project for
    // authoring rather than viewing can pass `presenting: false` to override.
    const presentStory = options.presenting ?? (applied.storymap?.chapters.length ?? 0) > 0;
    const selectedLayerId =
      project.selectedLayerId === null
        ? null
        : typeof project.selectedLayerId === "string" &&
            applied.layers.some((layer) => layer.id === project.selectedLayerId)
          ? project.selectedLayerId
          : (applied.layers[0]?.id ?? null);
    set((s) => ({
      ...applied,
      projectPath: path,
      projectGeneration: s.projectGeneration + 1,
      isDirty: false,
      selectedLayerId,
      selectedFeatureId: null,
      selectedFeatureIds: [],
      // A project that saved an Identify target (issue #2688) opens with it
      // armed; any other load disarms Identify, since the previous target
      // named a layer of the project being replaced.
      ...resolveIdentifyTarget(
        applied.projectInteraction?.identify,
        applied.layers.map((layer) => layer.id),
      ),
      // The copied style names a layer from the previous project, so a
      // paste in the loaded one would apply an orphaned entry.
      copiedLayerStyle: null,
      // Ephemeral readouts describe the previous project's map. The
      // elevation and altitude especially: a project that switches to a
      // planetary body would otherwise keep showing Earth-scaled values
      // until the next hover or camera move.
      pointerCoords: null,
      pointerElevation: null,
      cameraAltitude: null,
      // Present a bundled story on load; otherwise drop any presentation
      // carried over from the previous project.
      ui: {
        ...s.ui,
        storymapPresenting: presentStory,
        // A bundled story auto-presents for viewing, so exiting it should
        // not pop open the editor (#918).
        storymapReturnToEditor: false,
        storymapLayerOpacity: {},
        storymapPanelOpen: false,
        storymapComposingId: null,
        // An open selection dialog (and its preselected layer id) belongs
        // to the previous project's layers.
        selectByExpressionOpen: false,
        selectByExpressionLayerId: null,
        selectByLocationOpen: false,
        selectByLocationLayerId: null,
        loadEditorFeaturesOpen: false,
        loadEditorFeaturesLayerId: null,
        // A pending assistant-requested Model Builder load names a model in
        // the previous project's `savedModels`.
        modelBuilderRequestedModelId: null,
      },
    }));
    clearHistory();
    if (path && options.rememberRecent !== false) {
      get().rememberRecentProject({
        path,
        name: project.name,
        openedAt: new Date().toISOString(),
      });
    }
  },
});
