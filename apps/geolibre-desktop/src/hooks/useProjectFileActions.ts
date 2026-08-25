import {
  DEFAULT_PROJECT_NAME,
  detachProjectCopy,
  projectFromStore,
  redactProjectCredentials,
  excludeHiddenFieldsFromProject,
  serializeProject,
  useAppStore,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import {
  addArcGISLayer,
  addRasterToMap,
  isRecoverableNonTiledRasterError,
  materializeEmbeddableVectorLayers,
} from "@geolibre/plugins";
import type { FeatureCollection } from "geojson";
import { type FormEvent, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createAppAPI, getPluginManager } from "./usePlugins";
import { pluginManifestUrlsForIds } from "../lib/external-plugins";
import {
  browserSaveFallsBackToDownload,
  isAbsoluteLocalPath,
  isHttpUrl,
  isTauri,
  loadDroppedRasterPaths,
  openArcgisProjectFile,
  openProjectFile,
  openQgisProjectFile,
  openRecentProjectFile,
  RecentProjectGoneError,
  saveProjectFile,
  saveProjectFileToPath,
  saveStartupProjectSnapshot,
  saveTextFileWithFallback,
} from "../lib/tauri-io";
import { useDesktopSettingsStore } from "./useDesktopSettings";
import { buildProjectHtml } from "../lib/html-export";
import { ensureHtmlFileName, ensureProjectFileName } from "../lib/file-names";
import { mergeStringLists } from "../lib/string-lists";
import { fetchProjectFromUrl } from "../lib/project-url";
import { getShareFetch } from "../lib/share-fetch";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { shareAuthorizedFetch } from "../lib/share-gallery";
import { normalizeProjectUrl } from "../lib/urls";
import { recordExplicitProjectSave } from "../lib/project-history-session";
import {
  canSaveVectorFileReferences,
  durableVectorDataChoice,
  rememberProjectSaveChoices,
  reusableCredentialChoice,
  reusableVectorDataChoice,
  saveChoicesForProject,
  type ProjectSaveChoices,
} from "../lib/project-save-choices";
import { startupSettingsAfterForcedSaveAs } from "../lib/startup-project";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import {
  importQgisProject,
  materializeQgisRemoteLayers,
  type QgisProjectImportWarning,
} from "../lib/qgis-project-import";
import { importArcgisProject, type ArcgisProjectImportWarning } from "../lib/arcgis-project-import";
import type { MapControllerRef } from "../components/layout/toolbar/constants";
import { IS_MAS_BUILD } from "../lib/build-flags";

/** A pending "strip credentials before saving?" prompt. */
export interface CredentialStripPrompt {
  count: number;
  /** Project generation that opened the prompt. */
  projectGeneration: number;
  resolve: (choice: "strip" | "keep" | "cancel") => void;
}

/**
 * Embedded-data size above which the save prompt warns that the project will be
 * slow (or impossible) to reopen and points at PMTiles/FlatGeobuf instead.
 *
 * Embedded GeoJSON is parsed and held in memory in full when the project is
 * reopened, so a browser tab can run out of memory and drop the layers with no
 * error (GeoLibre#1829). 50 MB is well under that cliff while leaving ordinary
 * projects unbothered.
 */
export const LARGE_EMBED_WARNING_BYTES = 50 * 1024 * 1024;

/**
 * Messages engines raise when a string passes their maximum length, which is
 * how "this project is too large to serialize" surfaces.
 *
 * Matched by text rather than by error class because there is no typed signal:
 * V8 (Chromium, WebView2) throws `RangeError: Invalid string length`,
 * JavaScriptCore (the macOS and Linux Tauri webviews) reports an out-of-memory
 * error, and SpiderMonkey says "allocation size overflow". Matching only V8's
 * wording would leave desktop users on every other webview with the generic
 * failure message instead of the guidance this exists to give.
 *
 * Deliberately narrow: a genuine serialization bug (a cycle, say, which reads
 * "Converting circular structure to JSON") must not be filed under size.
 */
const SERIALIZATION_TOO_LARGE_PATTERN =
  /invalid string length|out of memory|allocation size overflow|string too long/i;

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
  /**
   * Non-sandboxed desktop hosts can save layers as file references (reloaded
   * from disk on reopen) instead of embedding. Mac App Store builds are desktop
   * hosts too, but must embed because their file access expires after relaunch.
   */
  desktop: boolean;
  /** Whether the host can persist a path-only project that survives relaunch. */
  allowFileReferences: boolean;
  /** Project generation that opened the prompt. */
  projectGeneration: number;
  resolve: (choice: "embed" | "noembed" | "cancel") => void;
}

/**
 * A pending "name this file" prompt, shown when a save runs in a browser that
 * can only download under a fixed name. Used by Save As (or a first Save) and by
 * Export as Interactive HTML; the dialog copy is carried on the prompt so the
 * same component serves both.
 */
export interface SaveNamePrompt {
  /** Project generation that opened the prompt. */
  projectGeneration: number;
  resolve: (name: string | null) => void;
  /** Dialog title. */
  title: string;
  /** Dialog description, explaining the browser-download behaviour. */
  description: string;
  /** Label for the file-name input. */
  label: string;
  /** Placeholder for the file-name input. */
  placeholder: string;
}

/**
 * Detects a plain GeoJSON layer that a desktop drag-drop or Add Data import
 * embedded from a local file whose absolute path was captured, so its data can
 * be re-read from disk on reopen rather than embedded in the project. Excludes
 * Add Vector Layer control layers (restored by their own path) and other
 * external-native/plugin layers, and any layer whose `sourcePath` is a URL.
 *
 * @param layer - A store layer.
 * @returns True when the layer's features should be saved as a path, not embedded.
 */
function isReloadableLocalFileLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    Boolean(layer.geojson) &&
    typeof layer.sourcePath === "string" &&
    isAbsoluteLocalPath(layer.sourcePath) &&
    layer.metadata.externalNativeLayer !== true &&
    layer.metadata.sourceKind == null
  );
}

/**
 * Let React commit a newly loaded project before a plugin attaches native map
 * sources. A project load can replace the MapLibre style (and always schedules
 * a layer sync); adding a raster in the same tick can therefore attach it to
 * the outgoing style. Its store entry survives, but the native raster source
 * is removed by the pending style/layer update.
 */
function importedProjectMapReady(
  mapControllerRef: MapControllerRef,
  basemapWillChange: boolean,
): Promise<void> {
  const map = mapControllerRef.current?.getMap();
  const styleReady =
    map && basemapWillChange
      ? new Promise<void>((resolve) => map.once("style.load", () => resolve()))
      : Promise.resolve();

  return (async () => {
    // Let the project store update commit and its MapCanvas effects run first.
    // Register the style listener above (before loadProject) so a fast inline
    // style cannot finish between the store update and this wait.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await styleReady;
  })();
}

/**
 * Adds one raster from an imported QGIS/ArcGIS Pro project, cleaning up after
 * itself when the raster cannot be loaded.
 *
 * `addRasterToMap` resolves only once the GeoTIFF header has been read, but the
 * control creates the store layer earlier (its `rasteradd` fires before that
 * await). A rejection therefore leaves the layer behind, so importers that
 * simply caught the error listed a raster as unsupported while it was still
 * sitting in the layer list -- see the NLCD case in GeoLibre#1637. Rolling the
 * layer back keeps the warning dialog and the layer list telling the same story.
 *
 * The striped "not tiled" rejection is deliberately not a failure: that layer
 * stays on the map while the registered non-tiled handler offers to convert it
 * to a COG, so it is neither rolled back nor reported.
 *
 * @param app - The app API for the live map.
 * @param source - Raster source resolved from the project's layer path.
 * @param options - Passed through to {@link addRasterToMap}.
 * @param groupId - Imported layer group to move the raster into, if any.
 * @throws The original load error, after the partial layer has been removed.
 */
async function addImportedProjectRaster(
  app: ReturnType<typeof createAppAPI>,
  source: Parameters<typeof addRasterToMap>[1],
  options: Parameters<typeof addRasterToMap>[2],
  groupId: string | undefined,
): Promise<void> {
  const before = new Set(useAppStore.getState().layers.map((layer) => layer.id));
  try {
    const layerId = await addRasterToMap(app, source, options);
    if (groupId) useAppStore.getState().moveLayerToGroup(layerId, groupId);
  } catch (error) {
    if (isRecoverableNonTiledRasterError(error)) {
      // The rejection carried no layer id, but the control already created the
      // store layer and is keeping it while the COG conversion is offered, so
      // it still has to be placed in its imported group -- otherwise a raster
      // that converts successfully ends up at the top level.
      if (groupId) {
        const { layers, moveLayerToGroup } = useAppStore.getState();
        const created = layers.find((layer) => !before.has(layer.id));
        if (created) moveLayerToGroup(created.id, groupId);
      }
      return;
    }
    const { layers, removeLayer } = useAppStore.getState();
    for (const layer of layers) {
      if (!before.has(layer.id)) removeLayer(layer.id);
    }
    throw error;
  }
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
  const projectGeneration = useAppStore((s) => s.projectGeneration);

  const [actionError, setActionError] = useState<string | null>(null);
  const [qgisImportWarnings, setQgisImportWarnings] = useState<QgisProjectImportWarning[] | null>(
    null,
  );
  const [arcgisImportWarnings, setArcgisImportWarnings] = useState<
    ArcgisProjectImportWarning[] | null
  >(null);
  const [projectUrlDialogOpen, setProjectUrlDialogOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectUrlError, setProjectUrlError] = useState<string | null>(null);
  const [projectUrlLoading, setProjectUrlLoading] = useState(false);
  const [credentialStripPrompt, setCredentialStripPrompt] = useState<CredentialStripPrompt | null>(
    null,
  );
  const [embedVectorDataPrompt, setEmbedVectorDataPrompt] = useState<EmbedVectorDataPrompt | null>(
    null,
  );
  const [saveNamePrompt, setSaveNamePrompt] = useState<SaveNamePrompt | null>(null);
  const [saveNameInput, setSaveNameInput] = useState("");
  const projectUrlAbortRef = useRef<AbortController | null>(null);
  const recentAbortRef = useRef<AbortController | null>(null);
  // Separate from projectUrlAbortRef so a gallery open and an Open-from-URL
  // submit can't abort each other's in-flight fetch.
  const shareUrlAbortRef = useRef<AbortController | null>(null);
  // Retain explicit, non-cancel save decisions for this project only. The
  // generation check clears them synchronously when newProject/loadProject
  // switches the store, including before React has rendered the new project.
  const saveChoicesRef = useRef<ProjectSaveChoices | null>(null);
  // Guards against overlapping saves: a second save started while a prompt
  // dialog is open would overwrite the pending prompt and strand the first
  // call's unresolved promise.
  const isSavingRef = useRef(false);

  // Settling a prompt means resolving its promise and clearing the dialog
  // state. Each pattern lives here once so the dialog handlers further down and
  // the generation-change cancellation below cannot drift apart. They close over
  // nothing but their setters, so their identity is stable and the effect below
  // still re-runs only when a prompt or the generation changes.
  const settleCredentialStripPrompt = useCallback(
    (prompt: CredentialStripPrompt | null, choice: "strip" | "keep" | "cancel") => {
      // Resolve outside the state updater (updaters must be side-effect free).
      prompt?.resolve(choice);
      setCredentialStripPrompt(null);
    },
    [],
  );
  const settleEmbedVectorDataPrompt = useCallback(
    (prompt: EmbedVectorDataPrompt | null, choice: "embed" | "noembed" | "cancel") => {
      prompt?.resolve(choice);
      setEmbedVectorDataPrompt(null);
    },
    [],
  );
  const settleSaveNamePrompt = useCallback((prompt: SaveNamePrompt | null, name: string | null) => {
    prompt?.resolve(name);
    setSaveNamePrompt(null);
    setSaveNameInput("");
  }, []);

  // A project can be replaced by an external open action while a modal save
  // prompt is visible. Cancel the stale promise immediately so its dialog does
  // not cover the replacement project and its save guard is released.
  // useLayoutEffect (not useEffect) so the stale dialog is gone in the same
  // commit that swapped the project, rather than lingering for one paint.
  useLayoutEffect(() => {
    if (credentialStripPrompt && credentialStripPrompt.projectGeneration !== projectGeneration) {
      settleCredentialStripPrompt(credentialStripPrompt, "cancel");
    }
    if (embedVectorDataPrompt && embedVectorDataPrompt.projectGeneration !== projectGeneration) {
      settleEmbedVectorDataPrompt(embedVectorDataPrompt, "cancel");
    }
    if (saveNamePrompt && saveNamePrompt.projectGeneration !== projectGeneration) {
      settleSaveNamePrompt(saveNamePrompt, null);
    }
  }, [
    credentialStripPrompt,
    embedVectorDataPrompt,
    projectGeneration,
    saveNamePrompt,
    settleCredentialStripPrompt,
    settleEmbedVectorDataPrompt,
    settleSaveNamePrompt,
  ]);

  // On Android a project lives behind a `content://` URI whose read grant dies
  // with the process, so the startup restore has nothing to reopen on the next
  // launch (GeoLibre#1948). Keep a copy in the app's own storage whenever the
  // startup preference points at the project being opened or saved. Fire and
  // forget: a failed copy is logged inside and must not fail the open or save.
  const rememberStartupProjectSnapshot = (path: string, text: string) => {
    void saveStartupProjectSnapshot(
      path,
      text,
      useDesktopSettingsStore.getState().desktopSettings.startup,
    );
  };

  const handleOpenFromFile = async () => {
    const result = await openProjectFile();
    if (result) {
      try {
        loadProject(await resolveProjectXyzLayers(result.project), result.path, {
          rememberRecent: isTauri(),
        });
        rememberStartupProjectSnapshot(result.path, result.text);
      } catch (error) {
        console.error("Failed to open project", error);
        setActionError(
          error instanceof Error ? error.message : t("toolbar.error.couldNotOpenProject"),
        );
      }
    }
  };

  const handleImportQgisProject = async () => {
    const result = await openQgisProjectFile();
    if (!result) return;
    try {
      const imported = await materializeQgisRemoteLayers(
        importQgisProject(result.data, result.path),
      );
      if (!isTauri()) {
        const unavailableLayerIds = new Set<string>();
        for (const layer of imported.project.layers) {
          if (layer.sourcePath && !isHttpUrl(layer.sourcePath)) {
            unavailableLayerIds.add(layer.id);
            imported.warnings.push({
              layerName: layer.name,
              reason: "browser-local-file",
            });
          }
        }
        imported.project.layers = imported.project.layers.filter(
          (layer) => !unavailableLayerIds.has(layer.id),
        );
        const usedGroupIds = new Set(
          imported.project.layers.flatMap((layer) => (layer.groupId ? [layer.groupId] : [])),
        );
        imported.project.layerGroups = imported.project.layerGroups?.filter((group) =>
          usedGroupIds.has(group.id),
        );
        for (const raster of imported.rasters) {
          imported.warnings.push({
            layerName: raster.name,
            reason: "browser-local-raster",
          });
        }
      }
      const mapReady = importedProjectMapReady(
        mapControllerRef,
        useAppStore.getState().basemapStyleUrl !== imported.project.basemapStyleUrl,
      );
      loadProject(imported.project, null);
      if (isTauri()) {
        await mapReady;
        const app = createAppAPI(mapControllerRef);
        for (const raster of imported.rasters) {
          try {
            const [loaded] = await loadDroppedRasterPaths([raster.sourcePath], {
              importProjectPath: result.path,
            });
            if (!loaded) throw new Error("Unsupported raster path");
            await addImportedProjectRaster(
              app,
              loaded.source,
              {
                name: raster.name,
                localPath: raster.sourcePath,
                // The Tauri/WebKitGTK WASM backend can stall when its first
                // source is created immediately after a project style load.
                // GPU renders this local COG directly and preserves the imported
                // QGIS ramp, so use the verified backend for project imports.
                defaults: { engine: "maplibre-gl-raster" },
                state: {
                  ...raster.state,
                  visible: raster.visible,
                  opacity: raster.opacity,
                },
                beforeId: raster.beforeId,
                zoomTo: false,
              },
              raster.groupId,
            );
          } catch (error) {
            console.error(`Failed to import QGIS raster "${raster.name}"`, error);
            imported.warnings.push({
              layerName: raster.name,
              reason: "format",
            });
          }
        }
      }
      useAppStore.setState({ isDirty: true });
      setQgisImportWarnings(imported.warnings.length > 0 ? imported.warnings : null);
    } catch (error) {
      console.error("Failed to import QGIS project", error);
      setActionError(
        error instanceof Error ? error.message : t("toolbar.error.couldNotImportQgisProject"),
      );
    }
  };

  const handleImportArcgisProject = async () => {
    const result = await openArcgisProjectFile();
    if (!result) return;
    try {
      const imported = importArcgisProject(result.data, result.path);
      if (!isTauri()) {
        const unavailableLayerIds = new Set<string>();
        for (const layer of imported.project.layers) {
          if (layer.sourcePath && !isHttpUrl(layer.sourcePath)) {
            unavailableLayerIds.add(layer.id);
            imported.warnings.push({ layerName: layer.name, reason: "browser-local-file" });
          }
        }
        imported.project.layers = imported.project.layers.filter(
          (layer) => !unavailableLayerIds.has(layer.id),
        );
        for (const raster of imported.rasters) {
          imported.warnings.push({ layerName: raster.name, reason: "browser-local-file" });
        }
        // Rasters never load in the browser build, so drop them before the
        // group prune below rather than letting them keep a group alive that
        // will stay empty. Services still load, so they still count.
        imported.rasters = [];
        // Re-prune the groups: dropping the local-file layers can empty a group
        // that the importer kept, and an empty group left behind shows up as a
        // dangling entry in the layer panel.
        const usedGroupIds = new Set<string>([
          ...imported.project.layers.flatMap((layer) => (layer.groupId ? [layer.groupId] : [])),
          ...imported.services.flatMap((service) => (service.groupId ? [service.groupId] : [])),
        ]);
        // A parent group stays as long as a surviving group still names it, so
        // walk up the chain before filtering.
        const groupById = new Map(
          (imported.project.layerGroups ?? []).map((group) => [group.id, group]),
        );
        for (const id of [...usedGroupIds]) {
          let parentId = groupById.get(id)?.parentId;
          while (parentId && !usedGroupIds.has(parentId)) {
            usedGroupIds.add(parentId);
            parentId = groupById.get(parentId)?.parentId;
          }
        }
        imported.project.layerGroups = imported.project.layerGroups?.filter((group) =>
          usedGroupIds.has(group.id),
        );
      }
      const mapReady = importedProjectMapReady(
        mapControllerRef,
        useAppStore.getState().basemapStyleUrl !== imported.project.basemapStyleUrl,
      );
      loadProject(imported.project, null);
      await mapReady;
      const app = createAppAPI(mapControllerRef);
      if (isTauri()) {
        for (const raster of imported.rasters) {
          try {
            const [loaded] = await loadDroppedRasterPaths([raster.sourcePath], {
              importProjectPath: result.path,
            });
            if (!loaded) throw new Error("Unsupported raster path");
            await addImportedProjectRaster(
              app,
              loaded.source,
              {
                name: raster.name,
                localPath: raster.sourcePath,
                defaults: { engine: "maplibre-gl-raster" },
                state: { visible: raster.visible, opacity: raster.opacity },
                zoomTo: false,
              },
              raster.groupId,
            );
          } catch (error) {
            console.error(`Failed to import ArcGIS raster "${raster.name}"`, error);
            imported.warnings.push({ layerName: raster.name, reason: "format" });
          }
        }
      }
      for (const service of imported.services) {
        try {
          const serviceLayerId = await addArcGISLayer(app, {
            itemId: service.itemId,
            layerType: "vector-tile",
            name: service.name,
            sourceType: "portal-item",
            // The project's saved extent was applied by loadProject above, and
            // this runs after it. Without the opt-out, each imported service
            // would fit the map to its own bounds and throw that extent away.
            zoomTo: false,
          });
          if (service.groupId) {
            useAppStore.getState().moveLayerToGroup(serviceLayerId, service.groupId);
          }
          if (!service.visible) {
            useAppStore.getState().setLayerVisibility(serviceLayerId, false);
          }
        } catch (error) {
          console.error(`Failed to import ArcGIS service "${service.name}"`, error);
          imported.warnings.push({ layerName: service.name, reason: "service" });
        }
      }
      useAppStore.setState({ isDirty: true });
      setArcgisImportWarnings(imported.warnings.length > 0 ? imported.warnings : null);
    } catch (error) {
      console.error("Failed to import ArcGIS project", error);
      setActionError(
        error instanceof Error ? error.message : t("toolbar.error.couldNotImportArcgisProject"),
      );
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
      const result = await openRecentProjectFile(normalizedUrl, controller.signal);
      const project = await resolveProjectXyzLayers(result.project, controller.signal);
      if (controller.signal.aborted) return;
      loadProject(project, result.path);
      setProjectUrl("");
      setProjectUrlDialogOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to open project URL", error);
      setProjectUrlError(
        error instanceof Error ? error.message : t("toolbar.error.couldNotOpenProjectUrl"),
      );
    } finally {
      if (projectUrlAbortRef.current === controller) {
        projectUrlAbortRef.current = null;
      }
      setProjectUrlLoading(false);
    }
  };

  // Load a project directly from a known URL (e.g. a Project Gallery card's raw
  // JSON URL), bypassing the URL-input dialog. Mirrors handleOpenFromUrl's
  // fetch → resolve → loadProject flow but takes the URL as an argument and
  // rethrows on failure so the caller (the gallery dialog) can show the error
  // inline next to the card it came from.
  //
  // When `authToken` is set (the user has a share API token), the request to the
  // share host carries it as a Bearer token so the owner's unlisted and private
  // projects load too. The token is attached only for the share host (see
  // shareAuthorizedFetch), never to third-party hosts a project might reference —
  // so when no share host is configured, the plain fetch is used and the token is
  // simply not sent anywhere. Token-authenticated opens are not remembered as
  // recent (path = null), since reopening a private URL on restart would 403
  // without the header.
  const [saveTemplateDialogOpen, setSaveTemplateDialogOpen] = useState(false);

  const openProjectFromShareUrl = async (
    url: string,
    options: { authToken?: string; asCopy?: boolean } = {},
  ): Promise<void> => {
    const normalizedUrl = normalizeProjectUrl(url);
    if (!normalizedUrl) {
      throw new Error(t("toolbar.error.invalidProjectUrl"));
    }

    shareUrlAbortRef.current?.abort();
    const controller = new AbortController();
    shareUrlAbortRef.current = controller;

    try {
      let project: Awaited<ReturnType<typeof resolveProjectXyzLayers>>;
      // One decision drives both the fetch and whether the URL is remembered: a
      // token is only actually sent when there is a share host to send it to, and
      // an unauthenticated open of a public URL should still be remembered.
      const shareBaseUrl = resolveShareBaseUrl();
      const shareAuth =
        options.authToken && shareBaseUrl
          ? { token: options.authToken, baseUrl: shareBaseUrl }
          : null;
      if (shareAuth) {
        const fetched = await fetchProjectFromUrl(normalizedUrl, {
          signal: controller.signal,
          fetchImpl: shareAuthorizedFetch(shareAuth.token, shareAuth.baseUrl, getShareFetch()),
        });
        project = await resolveProjectXyzLayers(fetched, controller.signal);
      } else {
        const result = await openRecentProjectFile(normalizedUrl, controller.signal);
        project = await resolveProjectXyzLayers(result.project, controller.signal);
      }

      if (controller.signal.aborted) return;

      if (options.asCopy) {
        const detached = detachProjectCopy(project, { nameSuffix: "" });
        loadProject(detached, null);
        useAppStore.setState({ isDirty: true });
      } else {
        loadProject(project, shareAuth ? null : normalizedUrl);
      }
    } finally {
      if (shareUrlAbortRef.current === controller) {
        shareUrlAbortRef.current = null;
      }
    }
  };

  // Returns an error message to surface, or null on success/abort. It does not
  // set the shared `actionError` itself, so each caller can route the failure to
  // its own surface (the toolbar's modal vs. the Browser panel's inline banner)
  // now that a single instance is shared across both.
  const handleOpenRecent = async (path: string): Promise<string | null> => {
    // Cancel any previous in-flight open so rapid clicks cannot race and let a
    // stale fetch win by resolving last.
    recentAbortRef.current?.abort();
    const controller = new AbortController();
    recentAbortRef.current = controller;

    let result: Awaited<ReturnType<typeof openRecentProjectFile>>;

    try {
      result = await openRecentProjectFile(path, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return null;
      // Only drop the entry when the project is permanently gone; preserve it
      // for transient failures (network timeout, 5xx, momentary IO error).
      if (error instanceof RecentProjectGoneError) {
        forgetRecentProject(path);
      }
      console.error("Failed to open recent project", error);
      return error instanceof Error ? error.message : t("toolbar.error.couldNotOpenRecentProject");
    }

    try {
      const project = await resolveProjectXyzLayers(result.project, controller.signal);
      if (controller.signal.aborted) return null;
      loadProject(project, result.path);
      // `loadProject` moves this path to the front of the recent list, so in
      // "last" mode it is now the project the next launch will reopen. Without
      // this, reopening an older project from the recent list would leave the
      // copy on disk holding whichever project was opened through the picker
      // last, and the next cold start would find no copy matching the path it
      // resolves (GeoLibre#1948 review).
      rememberStartupProjectSnapshot(result.path, result.text);
      return null;
    } catch (error) {
      if (controller.signal.aborted) return null;
      console.error("Failed to load recent project", error);
      return error instanceof Error ? error.message : t("toolbar.error.couldNotLoadRecentProject");
    } finally {
      if (recentAbortRef.current === controller) {
        recentAbortRef.current = null;
      }
    }
  };

  // Build the current project from live store + map state and serialize it.
  // Shared by Save/Save As and the Share action so they all capture identical
  // project content (including the current map view and plugin state).
  const buildCurrentProject = (nameOverride?: string, layersOverride?: GeoLibreLayer[]) => {
    const state = useAppStore.getState();
    const defaultProjectName =
      nameOverride?.trim() || state.projectName.trim() || DEFAULT_PROJECT_NAME;
    const pluginProjectState = getPluginManager().getProjectState();
    // Record only the plugin URLs this project actually needs: the ones it
    // already declared, plus the manifest URLs behind the plugins it uses. A
    // plugin counts as used when it is active or has stored project state --
    // `mapControlPositions` is written for every plugin that reports a position,
    // so it says nothing about use.
    //
    // The author's remaining installed URLs are deliberately NOT merged in.
    // Doing so stamped every share with the full list, so recipients were
    // prompted to trust and execute third-party code the project never runs
    // (the prompt is scary by design, and firing it on irrelevant URLs trains
    // people to click through it), and the shared file disclosed exactly which
    // plugins the author had installed.
    const usedPluginIds = new Set([
      ...pluginProjectState.activePluginIds,
      ...Object.keys(pluginProjectState.settings ?? {}),
    ]);
    const pluginManifestUrls = mergeStringLists(
      state.projectPlugins?.manifestUrls ?? [],
      pluginManifestUrlsForIds(usedPluginIds),
    );
    const project = projectFromStore({
      projectName: defaultProjectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: layersOverride ?? state.layers,
      selectedLayerId: state.selectedLayerId,
      layerGroups: state.layerGroups,
      preferences: state.preferences,
      plugins: {
        ...pluginProjectState,
        manifestUrls: pluginManifestUrls,
      },
      legend: state.legend,
      printLayout: state.printLayout,
      storymap: state.storymap,
      models: state.models,
      processingHistory: state.processingHistory,
      widgets: state.widgets,
      dashboardColumns: state.dashboardColumns,
      mapLayout: state.mapLayout,
      secondaryMapViews: state.secondaryMapViews,
      primaryMapLabel: state.primaryMapLabel,
      styleLibrary: state.projectStyleLibrary,
      comments: state.comments,
      metadata: state.metadata,
    });
    // The serialized text is deliberately not returned: every caller
    // re-serializes after redacting credentials, so producing it here doubled
    // the peak memory of a save for a project embedding large vector layers
    // (GeoLibre#1829).
    return {
      project,
      defaultProjectName,
      // Expose the path read from this same snapshot so callers don't take a
      // second `getState()` read that could be misread as a separate instant.
      projectPath: state.projectPath,
    };
  };

  // Serializing a project runs synchronously and throws `RangeError: Invalid
  // string length` once the text passes V8's ~536 MB string cap, which a
  // project embedding large vector layers can still reach. Unguarded, that
  // throw escaped `void handleSave()` as an unhandled rejection and Save
  // silently did nothing (GeoLibre#1829), so report it instead of returning
  // text. Returns null when the project could not be serialized.
  const serializeForSave = (project: GeoLibreProject): string | null => {
    try {
      return serializeProject(project);
    } catch (error) {
      console.error("Failed to serialize project", error);
      // Only the string-length cap means "too large"; anything else is a real
      // serialization bug and must not be filed under a size problem. Matching
      // on `RangeError` alone was too broad — a stack overflow raises one too,
      // and pointing that at PMTiles/FlatGeobuf would send the user chasing a
      // size problem they do not have.
      setActionError(
        error instanceof Error && SERIALIZATION_TOO_LARGE_PATTERN.test(error.message)
          ? t("toolbar.error.projectTooLargeToSave")
          : t("toolbar.error.couldNotSaveProject"),
      );
      return null;
    }
  };

  // Ask whether to strip credentials (environment variables, geocoder keys,
  // layer tokens) before writing the file. The promise resolves when the user
  // picks an option in the dialog.
  const askStripCredentials = (count: number, promptProjectGeneration: number) =>
    new Promise<"strip" | "keep" | "cancel">((resolve) => {
      setCredentialStripPrompt({ count, projectGeneration: promptProjectGeneration, resolve });
    });

  const resolveCredentialStripPrompt = (choice: "strip" | "keep" | "cancel") =>
    settleCredentialStripPrompt(credentialStripPrompt, choice);

  // Ask whether to embed local vector layers' data in the saved file. Resolves
  // when the user picks an option in the dialog.
  const askEmbedVectorData = (
    count: number,
    bytes: number,
    desktop: boolean,
    promptProjectGeneration: number,
  ) =>
    new Promise<"embed" | "noembed" | "cancel">((resolve) => {
      setEmbedVectorDataPrompt({
        count,
        bytes,
        desktop,
        allowFileReferences: canSaveVectorFileReferences(desktop, IS_MAS_BUILD),
        projectGeneration: promptProjectGeneration,
        resolve,
      });
    });

  const resolveEmbedVectorDataPrompt = (choice: "embed" | "noembed" | "cancel") =>
    settleEmbedVectorDataPrompt(embedVectorDataPrompt, choice);

  // Builds the embed-mode layers: every local vector layer carries its own
  // features so the project is self-contained (portable to another machine or
  // share.geolibre.app). Add Vector Layer control layers get their features
  // materialized into `metadata.embeddedGeoJSON`; plain GeoJSON layers already
  // hold their `geojson`. The `localFileReloadable` flag is cleared so the
  // embedded data — not a file path that may not exist elsewhere — is what
  // restores. Used by the save dialog's Embed choice and by Share (always).
  const buildEmbeddedLayers = async (
    layers: GeoLibreLayer[],
    prebuilt?: Map<string, FeatureCollection>,
  ): Promise<GeoLibreLayer[]> => {
    // Reuse a map the caller already materialized (the Embed save path) so each
    // layer's features aren't read from the control twice, but materialize any
    // layer it doesn't cover — e.g. one added while the save dialog was open —
    // so a late addition still gets its data instead of being dropped.
    const embeddable = new Map(prebuilt);
    const uncovered = prebuilt ? layers.filter((layer) => !prebuilt.has(layer.id)) : layers;
    if (uncovered.length > 0) {
      for (const [id, collection] of await materializeEmbeddableVectorLayers(uncovered)) {
        embeddable.set(id, collection);
      }
    }
    return layers.map((layer) => {
      let metadata = layer.metadata;
      const collection = embeddable.get(layer.id);
      if (collection) metadata = { ...metadata, embeddedGeoJSON: collection };
      if (metadata.localFileReloadable === true) {
        const { localFileReloadable: _drop, ...rest } = metadata;
        metadata = rest;
      }
      return metadata === layer.metadata ? layer : { ...layer, metadata };
    });
  };

  // Sums the UTF-8 byte size of every local layer's features, for the embed
  // prompt's size warning. Vector control layers are materialized; plain
  // GeoJSON layers use their `geojson`.
  const estimateEmbedBytes = (
    layers: GeoLibreLayer[],
    embeddable: Map<string, FeatureCollection>,
  ): number => {
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const collection of embeddable.values()) {
      bytes += encoder.encode(JSON.stringify(collection)).length;
    }
    for (const layer of layers) {
      if (isReloadableLocalFileLayer(layer) && layer.geojson) {
        bytes += encoder.encode(JSON.stringify(layer.geojson)).length;
      }
    }
    return bytes;
  };

  // Decides how a save serializes local vector layers. On the web they can only
  // be embedded (no filesystem path), so the prompt offers Embed or Save
  // without data. On desktop they can also be saved as file references that
  // reload from disk on reopen, so the prompt offers Embed or Save file
  // references. The Mac App Store build is the exception: its sandbox drops
  // access to user-selected files once the process exits, so references cannot
  // reload and Embed is the only durable mode (see the guard below). Returns
  // the layers override to serialize, an empty result to use the live layers
  // as-is, or "cancel" to abort the save.
  const resolveLayersForSave = async (): Promise<{ layers?: GeoLibreLayer[] } | "cancel"> => {
    const state = useAppStore.getState();
    const embeddable = await materializeEmbeddableVectorLayers(state.layers);
    if (useAppStore.getState().projectGeneration !== state.projectGeneration) return "cancel";
    const localFileLayers = isTauri() ? state.layers.filter(isReloadableLocalFileLayer) : [];
    if (embeddable.size === 0 && localFileLayers.length === 0) return {};

    const count = embeddable.size + localFileLayers.length;
    const bytes = estimateEmbedBytes(state.layers, embeddable);
    const remembered = saveChoicesForProject(saveChoicesRef.current, state.projectGeneration);
    saveChoicesRef.current = remembered;
    // A remembered Embed choice stays silent until the project crosses the
    // large-data warning threshold, and again whenever the data outgrows the
    // size that was acknowledged. A remembered Save without data stays silent
    // only for the layers whose data the user accepted losing. Both are
    // material risks that deserve a fresh confirmation even though the ordinary
    // per-project choice is remembered. On desktop that second case cannot
    // arise: "without data" writes file references, so nothing is discarded.
    const discardedLayerIds = isTauri() ? [] : [...embeddable.keys()];
    const reusableChoice = reusableVectorDataChoice(remembered, {
      embedBytes: bytes,
      warningBytes: LARGE_EMBED_WARNING_BYTES,
      discardedLayerIds,
    });
    // A remembered choice the durability guard below would have to override is
    // not reusable: silently upgrading it to Embed would skip the prompt, and
    // with it both the large-data warning and the acknowledged-size bookkeeping
    // that a silent reuse deliberately leaves alone.
    const rememberedVectorChoice =
      reusableChoice !== undefined &&
      durableVectorDataChoice(reusableChoice, IS_MAS_BUILD) !== reusableChoice
        ? undefined
        : reusableChoice;
    const requestedChoice =
      rememberedVectorChoice ??
      (await askEmbedVectorData(count, bytes, isTauri(), state.projectGeneration));
    // A Mac App Store app receives temporary access to user-selected files.
    // That access expires when the sandboxed process exits, so a path-only
    // project cannot restore its local vectors after the next launch. Embed is
    // the only durable save mode there. Keep this guard behind the dialog as
    // well, so an old remembered "reference" choice cannot bypass it.
    const choice = durableVectorDataChoice(requestedChoice, IS_MAS_BUILD);
    if (choice === "cancel") return "cancel";
    // A project can be opened while a prompt is visible. Do not apply that
    // prompt's answer to the replacement project or continue saving stale data.
    if (useAppStore.getState().projectGeneration !== state.projectGeneration) return "cancel";
    saveChoicesRef.current = rememberProjectSaveChoices(
      saveChoicesRef.current,
      state.projectGeneration,
      {
        vectorData: choice,
        // Only a size the user was actually shown extends the allowance; a
        // silent reuse must not ratchet it up (or down) on its own.
        acknowledgedEmbedBytes:
          rememberedVectorChoice === undefined &&
          choice === "embed" &&
          bytes >= LARGE_EMBED_WARNING_BYTES
            ? bytes
            : remembered.acknowledgedEmbedBytes,
        // Likewise, only an answered prompt widens the set of layers the user
        // has agreed to lose.
        discardedVectorLayerIds:
          rememberedVectorChoice === undefined && choice === "noembed"
            ? discardedLayerIds
            : remembered.discardedVectorLayerIds,
      },
    );

    if (choice === "embed") {
      // Reuse the map already materialized for the size estimate.
      return {
        layers: await buildEmbeddedLayers(useAppStore.getState().layers, embeddable),
      };
    }

    // "noembed": on the web this saves without the local data (those layers are
    // lost on reopen). On desktop it saves file references — but only for layers
    // that actually have a re-readable path; the rest (e.g. an Add Vector Layer
    // file restored from an embedded copy on a machine without the original) are
    // embedded as a fallback, since referencing them would save no data at all.
    if (!isTauri()) return {};
    let changed = false;
    const layers = useAppStore.getState().layers.map((layer) => {
      // Plain GeoJSON with an absolute path → reference (drop the embedded copy).
      if (isReloadableLocalFileLayer(layer)) {
        changed = true;
        return {
          ...layer,
          metadata: { ...layer.metadata, localFileReloadable: true },
        };
      }
      // An Add Vector Layer control layer already carrying a path references it
      // as-is; one without a path can't be referenced, so embed its features.
      const collection = embeddable.get(layer.id);
      if (collection && layer.metadata.localFileReloadable !== true) {
        changed = true;
        return {
          ...layer,
          metadata: { ...layer.metadata, embeddedGeoJSON: collection },
        };
      }
      return layer;
    });
    return changed ? { layers } : {};
  };

  // Builds the current project with all local vector data embedded, for sharing.
  // A shared project is opened on another machine (or in the browser) where the
  // original files do not exist, so it must be self-contained — never file
  // references. Used by the Share dialog.
  const buildEmbeddedProject = async (nameOverride?: string) => {
    const layers = await buildEmbeddedLayers(useAppStore.getState().layers);
    return buildCurrentProject(nameOverride, layers);
  };

  // Ask the user to name the file. Used only when saving falls back to a browser
  // download (no File System Access picker), where the name is the only thing
  // the user can control. The caller supplies the dialog copy so the same prompt
  // serves both project saves and HTML exports. Resolves with the name, or null
  // if cancelled.
  const askSaveName = (
    defaultName: string,
    labels: Omit<SaveNamePrompt, "projectGeneration" | "resolve">,
    promptProjectGeneration: number,
  ) =>
    new Promise<string | null>((resolve) => {
      setSaveNameInput(defaultName);
      setSaveNamePrompt({ projectGeneration: promptProjectGeneration, resolve, ...labels });
    });

  const submitSaveNamePrompt = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    settleSaveNamePrompt(saveNamePrompt, saveNameInput);
  };

  const cancelSaveNamePrompt = () => settleSaveNamePrompt(saveNamePrompt, null);

  const runSaveProject = async (options?: { saveAs?: boolean }): Promise<boolean> => {
    const saveProjectGeneration = useAppStore.getState().projectGeneration;
    // Offer to embed local vector data (or, on desktop, save file references)
    // first, so the serialized content below reflects the user's choice.
    const layersForSave = await resolveLayersForSave();
    if (
      layersForSave === "cancel" ||
      useAppStore.getState().projectGeneration !== saveProjectGeneration
    ) {
      return false;
    }
    const { project, defaultProjectName, projectPath } = buildCurrentProject(
      undefined,
      layersForSave.layers,
    );
    // Credentials are serialized in plain text for a local project that needs
    // them. Make keeping them an explicit choice and use the same central
    // redaction pass as every external egress.
    let contentToSave: string | null;
    const projectToEgress = excludeHiddenFieldsFromProject(project);
    const redacted = redactProjectCredentials(projectToEgress);
    if (redacted.redactedPaths.length > 0) {
      const remembered = saveChoicesForProject(saveChoicesRef.current, saveProjectGeneration);
      saveChoicesRef.current = remembered;
      const rememberedCredentialChoice = reusableCredentialChoice(remembered, {
        fingerprints: redacted.redactedFingerprints,
        hasUnfingerprintable: redacted.hasUnfingerprintableCredential,
      });
      const choice =
        rememberedCredentialChoice ??
        (await askStripCredentials(redacted.redactedCount, saveProjectGeneration));
      if (choice === "cancel") return false;
      if (useAppStore.getState().projectGeneration !== saveProjectGeneration) return false;
      saveChoicesRef.current = rememberProjectSaveChoices(
        saveChoicesRef.current,
        saveProjectGeneration,
        {
          credentials: choice,
          // Keep covers exactly the credentials the user was asked about, so a
          // later save that would write a different secret asks again.
          keptCredentialFingerprints:
            rememberedCredentialChoice === undefined && choice === "keep"
              ? redacted.redactedFingerprints
              : remembered.keptCredentialFingerprints,
        },
      );
      contentToSave = serializeForSave(choice === "strip" ? redacted.project : projectToEgress);
    } else {
      contentToSave = serializeForSave(projectToEgress);
    }
    if (contentToSave === null) return false;
    // Projects opened from a URL have no writable path, so both Save and
    // Save As fall back to the save dialog for them.
    const existingLocalPath = projectPath && !isHttpUrl(projectPath) ? projectPath : null;
    // Browsers without the File System Access picker (Firefox, Safari) can only
    // download under a fixed name, so Save As (and a first Save) would otherwise
    // reuse a default name — exactly the bug users hit. Prompt for the name so
    // they can choose it; later in-place Saves reuse the chosen name silently.
    let saveName = `${defaultProjectName}.geolibre.json`;
    const promptForName =
      browserSaveFallsBackToDownload() && (options?.saveAs === true || !existingLocalPath);
    if (promptForName) {
      const chosen = await askSaveName(
        saveName,
        {
          title: t("toolbar.item.saveProjectAsTitle"),
          description: t("toolbar.item.saveProjectAsDesc"),
          label: t("toolbar.item.saveProjectFileName"),
          placeholder: t("toolbar.item.saveProjectFileNamePlaceholder"),
        },
        saveProjectGeneration,
      );
      if (chosen === null) return false;
      saveName = ensureProjectFileName(chosen);
    }
    if (useAppStore.getState().projectGeneration !== saveProjectGeneration) return false;
    let path: string | null;
    try {
      path =
        !options?.saveAs && existingLocalPath
          ? await saveProjectFileToPath(contentToSave, existingLocalPath, saveName)
          : await saveProjectFile(
              contentToSave,
              promptForName ? saveName : (existingLocalPath ?? saveName),
            );
    } catch (error) {
      console.error("Failed to save project", error);
      setActionError(
        error instanceof Error ? error.message : t("toolbar.error.couldNotSaveProject"),
      );
      return false;
    }
    if (!path) return false;
    // A native picker can remain open while another project arrives through an
    // external action. The old project may have been written successfully, but
    // never attach its path or saved state to the replacement project.
    if (useAppStore.getState().projectGeneration !== saveProjectGeneration) return false;
    setProjectPath(path);
    rememberRecentProject({
      path,
      name: project.name,
      openedAt: new Date().toISOString(),
    });
    // An ordinary Save that landed somewhere else is Android refusing to write
    // the picked document and the save dialog creating a new one in its place
    // (GeoLibre#1833). Move a startup preference pinned to the old document
    // across, or it keeps naming one nothing can open again. Before the copy
    // below, so that copy lands in the slot the moved preference resolves to.
    const startupSettings = useDesktopSettingsStore.getState().desktopSettings;
    const movedStartup = options?.saveAs
      ? null
      : startupSettingsAfterForcedSaveAs(startupSettings.startup, existingLocalPath, path);
    if (movedStartup) {
      useDesktopSettingsStore
        .getState()
        .setDesktopSettings({ ...startupSettings, startup: movedStartup });
    }
    // Refresh the restorable copy so a startup restore reopens what was just
    // saved rather than the state the project was opened in.
    rememberStartupProjectSnapshot(path, contentToSave);
    markSaved();
    recordExplicitProjectSave();
    return true;
  };

  // Serialize saves so overlapping invocations cannot clobber a pending prompt.
  const saveProject = async (options?: { saveAs?: boolean }): Promise<boolean> => {
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

  // Export the current project as a standalone interactive HTML page (#821).
  // Shares saveProject's guard so a double-click can't open two save dialogs.
  const handleExportHtml = async (): Promise<boolean> => {
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    try {
      const exportProjectGeneration = useAppStore.getState().projectGeneration;
      // Derive the default file name from the project name in the store first,
      // without materializing embedded data, so the prompt can appear right away
      // and a cancel discards no work. This snapshot is passed to
      // buildEmbeddedProject as the name override below, so the file-name slug
      // and the HTML title stay consistent even if the project is renamed while
      // the name prompt is open.
      const projectName = useAppStore.getState().projectName.trim() || DEFAULT_PROJECT_NAME;
      const slug =
        projectName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "geolibre-map";
      // Browsers without the File System Access save picker (Firefox, Safari)
      // would otherwise download immediately under the generated name, with no
      // chance to rename the file (issue #991). Prompt for the name first;
      // desktop and Chromium hosts get a native save dialog from
      // saveTextFileWithFallback below instead.
      let defaultName = `${slug}.html`;
      if (browserSaveFallsBackToDownload()) {
        const chosen = await askSaveName(
          defaultName,
          {
            title: t("toolbar.item.exportHtmlAsTitle"),
            description: t("toolbar.item.exportHtmlAsDesc"),
            label: t("toolbar.item.exportHtmlFileName"),
            placeholder: t("toolbar.item.exportHtmlFileNamePlaceholder"),
          },
          exportProjectGeneration,
        );
        if (chosen === null) return false;
        defaultName = ensureHtmlFileName(chosen, slug);
      }
      // Only now embed local vector data (self-contained, like Share): this can
      // be costly on a project with many local layers, so it runs after the user
      // has committed to the export rather than before the prompt. Reuse the
      // name snapshot so the title matches the slug computed above. Credentials
      // serve no purpose in a static viewer and are removed inside
      // buildProjectHtml, which runs the central redaction pass.
      const { project, defaultProjectName } = await buildEmbeddedProject(projectName);
      if (useAppStore.getState().projectGeneration !== exportProjectGeneration) return false;
      const html = buildProjectHtml({
        project,
        title: defaultProjectName,
      });
      // Returns null when the user cancels the save dialog; report that as a
      // no-op rather than a successful export.
      const savedPath = await saveTextFileWithFallback(html, {
        defaultName,
        filters: [{ name: t("toolbar.item.htmlFile"), extensions: ["html"] }],
        browserTypes: [
          {
            description: t("toolbar.item.htmlFile"),
            accept: { "text/html": [".html"] },
          },
        ],
        mimeType: "text/html",
      });
      if (useAppStore.getState().projectGeneration !== exportProjectGeneration) return false;
      return savedPath !== null;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : t("toolbar.error.couldNotExportHtml"),
      );
      return false;
    } finally {
      isSavingRef.current = false;
    }
  };

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

  const handleDuplicate = () => {
    const { project } = buildCurrentProject();
    const duplicated = detachProjectCopy(project, { nameSuffix: "(copy)" });
    loadProject(duplicated, null);
    useAppStore.setState({ isDirty: true });
  };

  return {
    actionError,
    setActionError,
    qgisImportWarnings,
    setQgisImportWarnings,
    arcgisImportWarnings,
    setArcgisImportWarnings,
    projectUrlDialogOpen,
    setProjectUrlDialogOpen,
    handleProjectUrlDialogOpenChange,
    projectUrl,
    setProjectUrl,
    projectUrlError,
    setProjectUrlError,
    projectUrlLoading,
    saveTemplateDialogOpen,
    setSaveTemplateDialogOpen,
    handleDuplicate,
    handleSaveAsTemplate: () => setSaveTemplateDialogOpen(true),
    credentialStripPrompt,
    resolveCredentialStripPrompt,
    embedVectorDataPrompt,
    resolveEmbedVectorDataPrompt,
    saveNamePrompt,
    saveNameInput,
    setSaveNameInput,
    submitSaveNamePrompt,
    cancelSaveNamePrompt,
    handleOpenFromFile,
    handleImportQgisProject,
    handleImportArcgisProject,
    handleOpenFromUrl,
    openProjectFromShareUrl,
    handleOpenRecent,
    buildCurrentProject,
    buildEmbeddedProject,
    handleSave,
    handleSaveAs,
    handleExportHtml,
  };
}

/**
 * The handlers and state returned by {@link useProjectFileActions}. Exported so
 * a single hoisted instance can be shared as a prop across the toolbar and the
 * Browser panel (two instances don't coordinate their in-flight open aborts).
 */
export type ProjectFileActions = ReturnType<typeof useProjectFileActions>;
