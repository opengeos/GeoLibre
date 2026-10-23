/**
 * Layers files (Project → Export → Export Layers, and the Startup setting that
 * adds a file's layers to every untitled workspace). The format itself lives in
 * `@geolibre/core` (`layers-file.ts`); this module connects it to the store,
 * the file pickers, and the desktop settings.
 */

import {
  addLayersToProject,
  extractLayersFileContent,
  parseLayersFile,
  projectFromStore,
  redactProjectCredentials,
  useAppStore,
  withoutHistory,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayersFileContent,
} from "@geolibre/core";
import { useDesktopSettingsStore } from "../hooks/useDesktopSettings";
import { openLocalDataFileWithFallback } from "./file-io/file-dialogs";
import { isTauri } from "./is-tauri";
import { refreshGeoJsonLayer, refreshSourceUrl } from "./layer-refresh";
import { layerStylesFileName } from "./layer-style-files";
import { isLocalFileLayer } from "./local-file-watch";

/** A picked and parsed layers file. */
export interface PickedLayersFile extends LayersFileContent {
  /** The picked path (desktop) or file name (browser). */
  path: string;
  /** The file's base name, for display. */
  name: string;
}

/**
 * Let the user pick a layers file and parse it.
 *
 * @returns The parsed file, or null when the picker was cancelled.
 * @throws Error when the picked file is not a usable layers file.
 */
export async function pickLayersFile(): Promise<PickedLayersFile | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "GeoLibre Layers", extensions: ["json"] }],
    accept: ".json,application/json",
    readText: true,
  });
  if (!result || result.text === undefined) return null;
  return {
    path: result.path,
    name: layerStylesFileName(result.path),
    ...parseLayersFile(result.text),
  };
}

/** Host knowledge {@link buildLayersFileContent} needs about a live layer. */
export interface LayersFileHost {
  /**
   * Whether the layer's features come from a local file this host can re-read
   * (a desktop drag-drop or Add Data import). Such a layer is written as its
   * path instead of its features.
   */
  isReloadableLocalFile: (layer: GeoLibreLayer) => boolean;
  /**
   * Whether the layer's features can be fetched again from its URL (a GeoJSON
   * layer loaded from the web). Such a layer is written without its features
   * and re-fetched when it is added again.
   */
  canRefetch: (layer: GeoLibreLayer) => boolean;
}

/** What Export Layers writes, and what it had to leave out or change. */
export interface LayersFileBuild {
  content: LayersFileContent;
  /** Names of layers left out because their data exists only in the app. */
  skipped: string[];
  /** How many credential values (tokens, keys) were removed from the layers. */
  redactedCount: number;
}

/**
 * Build a layers file from the current project's layers, or from a subset.
 *
 * Layers go through the project save path, so they are written exactly as a
 * saved project writes them, then lose any credentials, as a shared project's
 * do: a layers file is meant to be passed around.
 *
 * @param host - Answers which live layers can be written as references.
 * @param layerIds - The layers to include; every layer when omitted.
 * @returns The file content and a report of what was left out.
 */
export function buildLayersFileContent(
  host: LayersFileHost,
  layerIds?: ReadonlySet<string>,
): LayersFileBuild {
  const state = useAppStore.getState();
  const refetchable = new Set<string>();
  const layers = state.layers
    .filter((layer) => !layerIds || layerIds.has(layer.id))
    .map((layer) => {
      if (host.canRefetch(layer)) refetchable.add(layer.id);
      return host.isReloadableLocalFile(layer)
        ? { ...layer, metadata: { ...layer.metadata, localFileReloadable: true } }
        : layer;
    });
  const project = projectFromStore({
    projectName: state.projectName,
    mapView: state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    layers,
    layerGroups: state.layerGroups,
    preferences: state.preferences,
    metadata: {},
  });
  const referenced: GeoLibreProject = {
    ...project,
    layers: project.layers.map((layer) => {
      if (!layer.geojson || !refetchable.has(layer.id)) return layer;
      const { geojson: _geojson, ...rest } = layer;
      return rest;
    }),
  };
  const redaction = redactProjectCredentials(referenced);
  const { content, skipped } = extractLayersFileContent(redaction.project);
  return { content, skipped, redactedCount: redaction.redactedCount };
}

/**
 * The layers file chosen in Startup settings, or null when none is set.
 *
 * @returns The layers to add to an untitled workspace.
 */
export function startupLayersContent(): LayersFileContent | null {
  return useDesktopSettingsStore.getState().desktopSettings.startup.layers;
}

/**
 * A project with the Startup setting's layers added, or the project unchanged
 * when none are set.
 *
 * @param project - The untitled project about to be shown.
 * @returns The project to load.
 */
export function withStartupLayers(project: GeoLibreProject): GeoLibreProject {
  const content = startupLayersContent();
  return content ? addLayersToProject(project, content) : project;
}

/**
 * The ids of the layers {@link withStartupLayers} added to a project.
 *
 * @param project - A project returned by {@link withStartupLayers}.
 * @returns The ids of the Startup setting's layers in it.
 */
export function startupLayerIds(project: GeoLibreProject): Set<string> {
  const ids = new Set((startupLayersContent()?.layers ?? []).map((layer) => layer.id));
  return new Set(project.layers.map((layer) => layer.id).filter((id) => ids.has(id)));
}

/**
 * Fetch the features of the layers a layers file added without them (GeoJSON
 * layers loaded from a URL). Each result lands only while the same workspace is
 * open, a workspace that was clean stays clean, and the fetch records no undo
 * step: the user did not edit it.
 *
 * @param needsFetch - Whether a store layer is one to fetch.
 * @param fetchFeatures - Fetches a layer's features.
 * @returns Resolves once every fetch has settled.
 */
export async function fetchStartupLayerFeatures(
  needsFetch: (layer: GeoLibreLayer) => boolean,
  fetchFeatures: (layer: GeoLibreLayer) => Promise<GeoLibreLayer["geojson"]>,
): Promise<void> {
  const generation = useAppStore.getState().projectGeneration;
  const pending = useAppStore.getState().layers.filter(needsFetch);
  await Promise.all(
    pending.map(async (layer) => {
      try {
        const geojson = await fetchFeatures(layer);
        const state = useAppStore.getState();
        if (state.projectGeneration !== generation) return;
        if (!state.layers.some((entry) => entry.id === layer.id)) return;
        const wasDirty = state.isDirty;
        // Not an undo step: undo must not take the fetched features back out.
        // The dirty flag is put back in the same synchronous turn, before any
        // render or debounced subscriber (autosave) reads it.
        withoutHistory(() => {
          state.updateLayer(layer.id, { geojson });
          if (!wasDirty) useAppStore.setState({ isDirty: false });
        });
      } catch (error) {
        console.warn(`[GeoLibre] Could not load startup layer "${layer.name}".`, error);
      }
    }),
  );
}

/** This app's answers for {@link buildLayersFileContent}. */
export const APP_LAYERS_FILE_HOST: LayersFileHost = {
  // Only the desktop host can read a path back.
  isReloadableLocalFile: (layer) => isTauri() && isLocalFileLayer(layer),
  canRefetch: (layer) => refreshSourceUrl(layer) !== null,
};

/**
 * Whether a store layer is a GeoJSON layer added without its features that
 * nothing else will fetch. A WFS layer is fetched by the layer panel's own
 * bootstrap, and a local file by the project restore pass.
 */
function needsStartupFetch(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    !layer.geojson &&
    layer.metadata.sourceKind !== "wfs-getfeature" &&
    layer.metadata.localFileReloadable !== true &&
    refreshSourceUrl(layer) !== null
  );
}

/**
 * Fetch the features of the URL GeoJSON layers the Startup setting just added
 * to the untitled workspace.
 *
 * @param layerIds - The ids of the layers the setting added. Other layers are
 *   left to whatever loaded them.
 * @returns Resolves once every fetch has settled.
 */
export function fetchStartupLayerData(layerIds: ReadonlySet<string>): Promise<void> {
  return fetchStartupLayerFeatures(
    (layer) => layerIds.has(layer.id) && needsStartupFetch(layer),
    async (layer) => (await refreshGeoJsonLayer(layer)).geojson,
  );
}
