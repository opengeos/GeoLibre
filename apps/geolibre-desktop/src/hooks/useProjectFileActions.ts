import {
  DEFAULT_PROJECT_NAME,
  projectFromStore,
  serializeProject,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import { materializeEmbeddableVectorLayers } from "@geolibre/plugins";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPluginManager } from "./usePlugins";
import { useDesktopSettingsStore } from "./useDesktopSettings";
import {
  browserSaveFallsBackToDownload,
  isHttpUrl,
  isTauri,
  openProjectFile,
  openRecentProjectFile,
  RecentProjectGoneError,
  saveProjectFile,
  saveProjectFileToPath,
} from "../lib/tauri-io";
import { mergeStringLists } from "../lib/string-lists";
import { normalizeProjectUrl } from "../lib/urls";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import type { MapControllerRef } from "../components/layout/toolbar/constants";

/** A pending "strip env vars before saving?" prompt. */
export interface EnvStripPrompt {
  count: number;
  resolve: (choice: "strip" | "keep" | "cancel") => void;
}

/**
 * A pending "embed local vector data?" prompt, shown on the web when saving a
 * project that has local-file Add Vector Layer layers whose data would
 * otherwise be lost on reopen (the browser exposes no path to re-read them).
 */
export interface EmbedVectorDataPrompt {
  /** Number of local-file vector layers that can be embedded. */
  count: number;
  /** Total embedded size in bytes, for the size warning. */
  bytes: number;
  resolve: (choice: "embed" | "skip" | "cancel") => void;
}

/**
 * A pending "name this project file" prompt, shown when Save As (or a first
 * Save) runs in a browser that can only download under a fixed name.
 */
export interface SaveNamePrompt {
  resolve: (name: string | null) => void;
}

/**
 * Ensure a user-entered project file name carries a recognized extension,
 * defaulting to `.geolibre.json` when none is present so the downloaded file
 * opens cleanly again later. Falls back to the default project name when blank.
 *
 * @param name - The raw file name the user typed.
 * @returns A sanitized file name ending in a project extension.
 */
function ensureProjectFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${DEFAULT_PROJECT_NAME}.geolibre.json`;
  return /\.(geolibre\.json|geolibre|json)$/i.test(trimmed)
    ? trimmed
    : `${trimmed}.geolibre.json`;
}

/**
 * Bundles every project file action (open from file/URL/recent, save, save as)
 * along with the related dialog state (Open-from-URL, env-var strip prompt, and
 * the shared action-error dialog).
 *
 * @param mapControllerRef - Ref to the live MapController, read when serializing.
 * @returns Handlers and state consumed by the toolbar menus and dialogs.
 */
export function useProjectFileActions(mapControllerRef: MapControllerRef) {
  const { t } = useTranslation();
  const loadProject = useAppStore((s) => s.loadProject);
  const setProjectPath = useAppStore((s) => s.setProjectPath);
  const rememberRecentProject = useAppStore((s) => s.rememberRecentProject);
  const forgetRecentProject = useAppStore((s) => s.forgetRecentProject);
  const markSaved = useAppStore((s) => s.markSaved);

  const [actionError, setActionError] = useState<string | null>(null);
  const [projectUrlDialogOpen, setProjectUrlDialogOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectUrlError, setProjectUrlError] = useState<string | null>(null);
  const [projectUrlLoading, setProjectUrlLoading] = useState(false);
  const [envStripPrompt, setEnvStripPrompt] = useState<EnvStripPrompt | null>(
    null,
  );
  const [embedVectorDataPrompt, setEmbedVectorDataPrompt] =
    useState<EmbedVectorDataPrompt | null>(null);
  const [saveNamePrompt, setSaveNamePrompt] = useState<SaveNamePrompt | null>(
    null,
  );
  const [saveNameInput, setSaveNameInput] = useState("");
  const projectUrlAbortRef = useRef<AbortController | null>(null);
  const recentAbortRef = useRef<AbortController | null>(null);
  // Guards against overlapping saves: a second save started while a prompt
  // dialog is open would overwrite the pending prompt and strand the first
  // call's unresolved promise.
  const isSavingRef = useRef(false);

  const handleOpenFromFile = async () => {
    const result = await openProjectFile();
    if (result) {
      try {
        loadProject(
          await resolveProjectXyzLayers(result.project),
          result.path,
          { rememberRecent: isTauri() },
        );
      } catch (error) {
        console.error("Failed to open project", error);
        setActionError(
          error instanceof Error
            ? error.message
            : t("toolbar.error.couldNotOpenProject"),
        );
      }
    }
  };

  const handleOpenFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUrl = normalizeProjectUrl(projectUrl);
    if (!normalizedUrl) {
      setProjectUrlError(t("toolbar.error.invalidProjectUrl"));
      return;
    }

    projectUrlAbortRef.current?.abort();
    const controller = new AbortController();
    projectUrlAbortRef.current = controller;

    setProjectUrlLoading(true);
    setProjectUrlError(null);

    try {
      const result = await openRecentProjectFile(
        normalizedUrl,
        controller.signal,
      );
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      loadProject(project, result.path);
      setProjectUrl("");
      setProjectUrlDialogOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to open project URL", error);
      setProjectUrlError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotOpenProjectUrl"),
      );
    } finally {
      if (projectUrlAbortRef.current === controller) {
        projectUrlAbortRef.current = null;
      }
      setProjectUrlLoading(false);
    }
  };

  const handleOpenRecent = async (path: string) => {
    // Cancel any previous in-flight open so rapid clicks cannot race and let a
    // stale fetch win by resolving last.
    recentAbortRef.current?.abort();
    const controller = new AbortController();
    recentAbortRef.current = controller;

    let result: Awaited<ReturnType<typeof openRecentProjectFile>>;

    try {
      result = await openRecentProjectFile(path, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      // Only drop the entry when the project is permanently gone; preserve it
      // for transient failures (network timeout, 5xx, momentary IO error).
      if (error instanceof RecentProjectGoneError) {
        forgetRecentProject(path);
      }
      console.error("Failed to open recent project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotOpenRecentProject"),
      );
      return;
    }

    try {
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      loadProject(project, result.path);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to load recent project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotLoadRecentProject"),
      );
    } finally {
      if (recentAbortRef.current === controller) {
        recentAbortRef.current = null;
      }
    }
  };

  // Build the current project from live store + map state and serialize it.
  // Shared by Save/Save As and the Share action so they all capture identical
  // project content (including the current map view and plugin state).
  const buildCurrentProject = (
    nameOverride?: string,
    layersOverride?: GeoLibreLayer[],
  ) => {
    const state = useAppStore.getState();
    const defaultProjectName =
      nameOverride?.trim() || state.projectName.trim() || DEFAULT_PROJECT_NAME;
    const pluginManifestUrls = mergeStringLists(
      state.projectPlugins?.manifestUrls ?? [],
      useDesktopSettingsStore.getState().desktopSettings.pluginManifestUrls,
    );
    const project = projectFromStore({
      projectName: defaultProjectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: layersOverride ?? state.layers,
      layerGroups: state.layerGroups,
      preferences: state.preferences,
      plugins: {
        ...getPluginManager().getProjectState(),
        manifestUrls: pluginManifestUrls,
      },
      legend: state.legend,
      storymap: state.storymap,
      models: state.models,
      widgets: state.widgets,
      dashboardColumns: state.dashboardColumns,
      mapLayout: state.mapLayout,
      secondaryMapViews: state.secondaryMapViews,
      primaryMapLabel: state.primaryMapLabel,
      metadata: state.metadata,
    });
    return {
      project,
      defaultProjectName,
      content: serializeProject(project),
      // Expose the path read from this same snapshot so callers don't take a
      // second `getState()` read that could be misread as a separate instant.
      projectPath: state.projectPath,
    };
  };

  // Ask whether to strip environment variables before writing the file. The
  // promise resolves when the user picks an option in the dialog.
  const askStripEnvVars = (count: number) =>
    new Promise<"strip" | "keep" | "cancel">((resolve) => {
      setEnvStripPrompt({ count, resolve });
    });

  const resolveEnvStripPrompt = (choice: "strip" | "keep" | "cancel") => {
    // Resolve outside the state updater (updaters must be side-effect free).
    envStripPrompt?.resolve(choice);
    setEnvStripPrompt(null);
  };

  // Ask whether to embed local vector layers' data in the saved file. Resolves
  // when the user picks an option in the dialog.
  const askEmbedVectorData = (count: number, bytes: number) =>
    new Promise<"embed" | "skip" | "cancel">((resolve) => {
      setEmbedVectorDataPrompt({ count, bytes, resolve });
    });

  const resolveEmbedVectorDataPrompt = (choice: "embed" | "skip" | "cancel") => {
    embedVectorDataPrompt?.resolve(choice);
    setEmbedVectorDataPrompt(null);
  };

  // Web only: local-file Add Vector Layer layers have no path to re-read on
  // reopen (the browser hides it), so offer to embed their features in the
  // saved file. Returns the layers to serialize (with data embedded), an empty
  // result to save unchanged, or "cancel" to abort the save. Desktop layers
  // reload from their stored path, so nothing is embedded there.
  const resolveLayersForSave = async (): Promise<
    { layers?: GeoLibreLayer[] } | "cancel"
  > => {
    if (isTauri()) return {};
    const state = useAppStore.getState();
    const embeddable = await materializeEmbeddableVectorLayers(state.layers);
    if (embeddable.size === 0) return {};

    let bytes = 0;
    for (const collection of embeddable.values()) {
      bytes += JSON.stringify(collection).length;
    }
    const choice = await askEmbedVectorData(embeddable.size, bytes);
    if (choice === "cancel") return "cancel";
    if (choice === "skip") return {};

    // Re-read the layers after the modal: the store may have changed while the
    // prompt was open (layers added/removed/reordered). Embedded layer ids
    // still present get their data; any that vanished are simply skipped.
    const layers = useAppStore.getState().layers.map((layer) => {
      const collection = embeddable.get(layer.id);
      return collection
        ? {
            ...layer,
            metadata: { ...layer.metadata, embeddedGeoJSON: collection },
          }
        : layer;
    });
    return { layers };
  };

  // Ask the user to name the project file. Used only when saving falls back to
  // a browser download (no File System Access picker), where the name is the
  // only thing the user can control. Resolves with the name, or null if cancelled.
  const askSaveName = (defaultName: string) =>
    new Promise<string | null>((resolve) => {
      setSaveNameInput(defaultName);
      setSaveNamePrompt({ resolve });
    });

  const submitSaveNamePrompt = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    saveNamePrompt?.resolve(saveNameInput);
    setSaveNamePrompt(null);
    setSaveNameInput("");
  };

  const cancelSaveNamePrompt = () => {
    saveNamePrompt?.resolve(null);
    setSaveNamePrompt(null);
    setSaveNameInput("");
  };

  const runSaveProject = async (options?: {
    saveAs?: boolean;
  }): Promise<boolean> => {
    // Offer to embed local vector data first (web only), so the serialized
    // content below reflects the user's choice.
    const layersForSave = await resolveLayersForSave();
    if (layersForSave === "cancel") return false;
    const { project, defaultProjectName, content, projectPath } =
      buildCurrentProject(undefined, layersForSave.layers);
    // Env vars (possibly API keys) are serialized in plain text. If any are set,
    // offer to strip them from the saved file before writing.
    let contentToSave = content;
    const envVarCount = (project.preferences.environmentVariables ?? []).filter(
      (variable) => variable.key.trim(),
    ).length;
    if (envVarCount > 0) {
      const choice = await askStripEnvVars(envVarCount);
      if (choice === "cancel") return false;
      if (choice === "strip") {
        contentToSave = serializeProject({
          ...project,
          preferences: { ...project.preferences, environmentVariables: [] },
        });
      }
    }
    // Projects opened from a URL have no writable path, so both Save and
    // Save As fall back to the save dialog for them.
    const existingLocalPath =
      projectPath && !isHttpUrl(projectPath) ? projectPath : null;
    // Browsers without the File System Access picker (Firefox, Safari) can only
    // download under a fixed name, so Save As (and a first Save) would otherwise
    // reuse a default name — exactly the bug users hit. Prompt for the name so
    // they can choose it; later in-place Saves reuse the chosen name silently.
    let saveName = `${defaultProjectName}.geolibre.json`;
    const promptForName =
      browserSaveFallsBackToDownload() &&
      (options?.saveAs === true || !existingLocalPath);
    if (promptForName) {
      const chosen = await askSaveName(saveName);
      if (chosen === null) return false;
      saveName = ensureProjectFileName(chosen);
    }
    let path: string | null;
    try {
      path =
        !options?.saveAs && existingLocalPath
          ? await saveProjectFileToPath(contentToSave, existingLocalPath)
          : await saveProjectFile(
              contentToSave,
              promptForName ? saveName : (existingLocalPath ?? saveName),
            );
    } catch (error) {
      console.error("Failed to save project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotSaveProject"),
      );
      return false;
    }
    if (!path) return false;
    setProjectPath(path);
    rememberRecentProject({
      path,
      name: project.name,
      openedAt: new Date().toISOString(),
    });
    markSaved();
    return true;
  };

  // Serialize saves so overlapping invocations cannot clobber a pending prompt.
  const saveProject = async (options?: {
    saveAs?: boolean;
  }): Promise<boolean> => {
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    try {
      return await runSaveProject(options);
    } finally {
      isSavingRef.current = false;
    }
  };

  const handleSave = () => saveProject();
  const handleSaveAs = () => saveProject({ saveAs: true });

  // Open-change handler for the Open-from-URL dialog; aborts an in-flight fetch
  // and resets the form when the dialog closes.
  const handleProjectUrlDialogOpenChange = (open: boolean) => {
    setProjectUrlDialogOpen(open);
    if (!open) {
      projectUrlAbortRef.current?.abort();
      projectUrlAbortRef.current = null;
      setProjectUrl("");
      setProjectUrlError(null);
      setProjectUrlLoading(false);
    }
  };

  return {
    actionError,
    setActionError,
    projectUrlDialogOpen,
    setProjectUrlDialogOpen,
    handleProjectUrlDialogOpenChange,
    projectUrl,
    setProjectUrl,
    projectUrlError,
    setProjectUrlError,
    projectUrlLoading,
    envStripPrompt,
    resolveEnvStripPrompt,
    embedVectorDataPrompt,
    resolveEmbedVectorDataPrompt,
    saveNamePrompt,
    saveNameInput,
    setSaveNameInput,
    submitSaveNamePrompt,
    cancelSaveNamePrompt,
    handleOpenFromFile,
    handleOpenFromUrl,
    handleOpenRecent,
    buildCurrentProject,
    handleSave,
    handleSaveAs,
  };
}
