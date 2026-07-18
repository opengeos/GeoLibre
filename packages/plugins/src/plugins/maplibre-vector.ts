import { getSpatialExtensionPath, hasPathTraversal, useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  VectorControl,
  VectorControlEventHandler,
  VectorLayerInfo,
  VectorLayerOptions,
  VectorSampleDataset,
} from "maplibre-gl-vector";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePickedVectorFile,
} from "../types";
import {
  isEmbeddableLocalVectorLayer,
  isVectorControlStoreLayer,
  resetVectorStoreSyncSuspension,
  resumeVectorStoreSync,
  savedVectorState,
  suspendVectorStoreSync,
  syncVectorLayersToStore,
  unwireVectorStoreSync,
  wireVectorStoreSync,
} from "./vector-layer-sync";
import type { FeatureCollection } from "geojson";

const vectorControlPosition: GeoLibreMapControlPosition = "top-left";
const VECTOR_PANEL_CLASS = "geolibre-vector-panel";

// Extensions the desktop restore will re-read from a path persisted in a
// project file. Generous enough for every format the Add Vector Layer panel
// loads (the spatial extension's GDAL readers), but a guard so a hand-edited
// project cannot point `sourcePath` at an arbitrary file on disk. Matched
// case-insensitively against the end of the path. Keep this in sync with
// `VECTOR_FILE_DIALOG_EXTENSIONS` in the desktop app's `tauri-io.ts` (the
// package boundary prevents sharing the list): a format loadable through the
// picker but missing here would be dropped on reopen.
const RESTORABLE_VECTOR_PATH =
  /\.(geojson|json|gpkg|geoparquet|parquet|fgb|flatgeobuf|csv|tsv|kml|kmz|gml|gpx|dxf|tab|shp|zip)$/i;

// Generic, non-loading watermark for the URL input. The real demonstration
// links live in SAMPLE_VECTOR_DATASETS below, so the input no longer ships
// prefilled with a live URL (see opengeos/GeoLibre#661).
const VECTOR_URL_PLACEHOLDER = "https://example.com/data.geojson";

// One-click sample datasets shown under the URL input. Edit this list to
// offer different (or more) demonstration layers; loading is opt-in, so an
// empty list simply hides the row. URLs must be CORS-enabled to load in the
// browser build; source.coop sends `Access-Control-Allow-Origin: *`.
const SAMPLE_VECTOR_DATASETS: VectorSampleDataset[] = [
  {
    label: "Countries",
    url: "https://data.source.coop/giswqs/opengeos/countries.parquet",
  },
  {
    label: "US cities",
    url: "https://data.source.coop/giswqs/opengeos/us_cities.geojson",
  },
  {
    label: "World cities",
    url: "https://data.source.coop/giswqs/opengeos/world_cities.geojson",
  },
  {
    label: "Las Vegas buildings",
    url: "https://data.source.coop/giswqs/opengeos/las-vegas-buildings.geojson",
  },
];

// This type mirrors an undocumented private member of VectorControl from
// maplibre-gl-vector (verified against v0.5.1). Access is optional (?.) so a
// rename in a future release degrades to a no-op rather than a crash --
// re-verify this name AND the .vector-control-close selector in
// wireVectorCloseButton when bumping the dependency.
type VectorControlInternals = {
  _panel?: HTMLElement;
};

type VectorControlConstructor = typeof VectorControl;

let vectorControlClassPromise: Promise<VectorControlConstructor> | null = null;
let vectorControl: VectorControl | null = null;
let vectorControlMounted = false;
let openPanelTimeout: number | null = null;
let restorePanelExpandTimeout: number | null = null;

/**
 * Opens the maplibre-gl-vector panel, mounting the control on first use.
 * Replaces the former Add Vector Layer dialog: the panel loads GeoJSON,
 * GeoPackage, Shapefile, GeoParquet, FlatGeobuf, CSV, and other
 * GDAL-readable formats from URLs or local files (drag-and-drop), renders
 * large datasets as DuckDB-generated dynamic tiles, and edits per-layer
 * styles.
 *
 * @param app - The GeoLibre app API.
 */
export function openVectorLayerPanel(app: GeoLibreAppAPI): void {
  void (async () => {
    const control = await ensureVectorControl(app);
    if (!control) return;
    // Defer by one task so the control finishes its mount cycle before the
    // panel is shown and expanded, matching the other standalone panels
    // (Earth Engine, 3D Tiles, raster); expanding in the same task as
    // addControl can measure the panel before MapLibre has laid the
    // control out. Tracked so close/teardown can cancel it before it runs
    // against a torn-down control.
    if (openPanelTimeout !== null) window.clearTimeout(openPanelTimeout);
    openPanelTimeout = window.setTimeout(() => {
      openPanelTimeout = null;
      // The IIFE's catch cannot see exceptions thrown in this later task.
      try {
        showVectorControl(control);
        control.expand();
        // Idempotent (guarded by a dataset flag / null checks): retried on
        // every open so the panel chrome stays wired even if a future
        // upstream release builds the panel DOM lazily on first expand.
        wireVectorCloseButton(control);
        applyVectorPanelClass(control);
        wireDesktopFilePicker(control, app);
      } catch (error) {
        console.error("[GeoLibre] Failed to open the vector layer panel", error);
      }
    }, 0);
  })().catch((error) => {
    console.error("[GeoLibre] Failed to open the vector layer panel", error);
  });
}

export function closeVectorLayerPanel(app: GeoLibreAppAPI): void {
  if (openPanelTimeout !== null) {
    window.clearTimeout(openPanelTimeout);
    openPanelTimeout = null;
  }
  if (restorePanelExpandTimeout !== null) {
    window.clearTimeout(restorePanelExpandTimeout);
    restorePanelExpandTimeout = null;
  }

  if (vectorControl && vectorControlMounted) {
    app.removeMapControl(vectorControl);
    return;
  }

  unwireVectorStoreSync();
  resetVectorStoreSyncSuspension();
  vectorControl = null;
  vectorControlMounted = false;
}

/**
 * Re-fetches a URL-backed Add Vector Layer layer in place through the
 * control's reloadLayer API, preserving the layer id. Returns the refreshed
 * layer info, or undefined when the control singleton is null (not yet
 * created or already removed) or the layer id is unknown to the control.
 *
 * @param id - The store/control layer id.
 * @returns The refreshed layer info, or undefined.
 */
export async function reloadVectorControlLayer(id: string): Promise<VectorLayerInfo | undefined> {
  if (!vectorControl) return undefined;
  return vectorControl.reloadLayer(id);
}

/**
 * Replays URL-backed vector layers from the loaded project into the
 * control and drops control layers the project does not contain. Called by
 * the desktop shell whenever a project is loaded or the map is
 * reinitialised, mirroring restoreRasterLayers. Local-file layers cannot
 * be reloaded from a saved project, so their panel entries are removed
 * with a notice.
 *
 * @param app - The GeoLibre app API.
 */
export function restoreVectorLayers(app: GeoLibreAppAPI): void {
  const hasVectorLayers = useAppStore.getState().layers.some(isVectorControlStoreLayer);
  if (!hasVectorLayers && !vectorControl) return;

  void (async () => {
    const control = await ensureVectorControl(app);
    if (!control) return;

    // Re-read the store after the await: the project may have changed while
    // the control class was loading.
    const storeLayerIds = new Set(
      useAppStore
        .getState()
        .layers.filter(isVectorControlStoreLayer)
        .map((layer) => layer.id),
    );

    const pending: Promise<unknown>[] = [];
    const panelCollapsed = vectorPanelCollapsedFromLayers(useAppStore.getState().layers);
    // Unlike maplibre-gl-raster (whose addRaster registers the raster
    // synchronously before loading), VectorControl.addData only adds a
    // layer to its list after the data has loaded, so each layeradded
    // event fires while OTHER restores may still be loading. Syncing on
    // one of those events would diff a partially restored control list
    // against the full project and prune layers still in flight; the
    // suspension is therefore held across the whole async window and
    // lifted by the Promise.allSettled pass below.
    suspendVectorStoreSync();
    let resumed = false;
    const resumeOnce = () => {
      if (resumed) return;
      resumed = true;
      resumeVectorStoreSync();
    };
    try {
      // Isolated so a DOM error from the panel-state restore cannot abort
      // the layer replay below.
      try {
        applyRestoredVectorPanelState(control, panelCollapsed);
      } catch (error) {
        console.error("[GeoLibre] Failed to restore vector panel state", error);
      }

      for (const info of control.getLayers()) {
        if (!storeLayerIds.has(info.id)) control.removeLayer(info.id);
      }

      for (const layer of useAppStore.getState().layers) {
        if (!isVectorControlStoreLayer(layer)) continue;
        if (control.getLayer(layer.id)) continue;

        const url =
          typeof layer.source.url === "string" && layer.source.url ? layer.source.url : undefined;
        if (url) {
          pending.push(replayVectorLayer(control, layer, url));
          continue;
        }

        // A desktop host persisted the absolute path the file was read from, so
        // re-read it from disk and replay the same render/style state. (A
        // browser-picked file has no path and so no flag.)
        const localPath =
          layer.metadata.localFileReloadable === true &&
          typeof layer.sourcePath === "string" &&
          layer.sourcePath.trim() &&
          // The path comes from the (possibly hand-edited) project file, so
          // only re-read recognized vector extensions, and reject `..`
          // traversal: a crafted project must not coax the desktop app into
          // reading an arbitrary file (e.g. /etc/passwd, ~/.ssh/id_rsa) off
          // disk. The host's filesystem scope is the real boundary; this is
          // cheap defense-in-depth.
          RESTORABLE_VECTOR_PATH.test(layer.sourcePath) &&
          !hasPathTraversal(layer.sourcePath)
            ? layer.sourcePath
            : undefined;
        if (localPath && app.readLocalVectorFile) {
          pending.push(
            app
              .readLocalVectorFile(localPath)
              .then((file) => {
                if (!file) {
                  // The file moved or was deleted since the project was saved.
                  console.info(
                    `[GeoLibre] Vector layer "${layer.name}" could not be re-read from "${localPath}"; removing it.`,
                  );
                  useAppStore.getState().removeLayer(layer.id);
                  return undefined;
                }
                const source = file.nativeData
                  ? nativeGeoJsonFile(file.file, file.nativeData)
                  : file.file;
                return replayVectorLayer(control, layer, source, {
                  companionFiles: file.nativeData ? undefined : file.companionFiles,
                  localPath,
                });
              })
              .catch((error) => {
                console.error(`[GeoLibre] Failed to restore vector layer "${layer.name}"`, error);
                // Consistent with the missing-file case above: drop the layer
                // rather than leave a zombie panel entry with no map output.
                useAppStore.getState().removeLayer(layer.id);
              }),
          );
          continue;
        }

        // The web Save flow can embed a local file's features in the project.
        // Replay them directly (re-ingesting tiles when that was the render
        // mode); the restored layer becomes data-backed and re-embeds on the
        // next save.
        const embedded = readEmbeddedVectorGeoJSON(layer.metadata.embeddedGeoJSON);
        if (embedded) {
          pending.push(replayVectorLayer(control, layer, embedded));
          continue;
        }

        // No URL and no re-readable local path (a browser-picked file, or a
        // desktop file whose path was not persisted): it cannot be restored.
        // Console-only on purpose: the plugin layer has no toast/notification
        // API today. Surface this through an in-app notification once one is
        // exposed to plugins.
        console.info(
          `[GeoLibre] Vector layer "${layer.name}" came from a local file and cannot be restored from the saved project.`,
        );
        // removeLayer fires the store subscriber synchronously; the
        // suspension guard keeps it from echoing back at the control.
        useAppStore.getState().removeLayer(layer.id);
      }
    } catch (error) {
      resumeOnce();
      throw error;
    }

    // The deferred panel expand in applyRestoredVectorPanelState fires its
    // expand event while the suspension is still held, so this final pass
    // (after the suspension lifts) settles the panel state and every layer
    // that either loaded or failed.
    void Promise.allSettled(pending).then(() => {
      resumeOnce();
      window.setTimeout(() => {
        // A control torn down mid-restore (map reinitialisation) must not
        // let this stale callback rewrite layers owned by its successor.
        if (control !== vectorControl) return;
        syncVectorLayersToStore(control);
      }, 0);
    });
  })().catch((error) => {
    console.error("[GeoLibre] Failed to restore vector layers", error);
  });
}

/**
 * Replays one saved Add Vector Layer layer into the control, preserving its
 * id, name, visibility, opacity, and persisted render/style state. The source
 * is a URL (URL-backed layers), a File re-read from disk (desktop local-file
 * layers), or an embedded FeatureCollection (web). `options.localPath` is
 * forwarded as `sourcePath` so a re-read file keeps its absolute path and stays
 * reloadable on the next reopen, and `options.companionFiles` carries a
 * shapefile's sidecars. Errors are logged, not thrown, so one failed layer
 * never aborts the others.
 *
 * @param control - The vector control to add the layer to.
 * @param layer - The saved store layer being restored.
 * @param source - The URL, File, or FeatureCollection to load the data from.
 * @param options - The shapefile sidecars and/or absolute path of a File source.
 * @returns A promise that settles when the layer has loaded or failed.
 */
function replayVectorLayer(
  control: VectorControl,
  layer: GeoLibreLayer,
  source: string | File | FeatureCollection,
  options: { companionFiles?: File[]; localPath?: string } = {},
): Promise<unknown> {
  return control
    .addData(source, {
      ...savedVectorState(layer),
      ...(options.companionFiles?.length ? { companionFiles: options.companionFiles } : {}),
      ...(options.localPath ? { sourcePath: options.localPath } : {}),
      fitBounds: false,
      id: layer.id,
      name: layer.name,
      opacity: layer.opacity,
      visible: layer.visible,
    })
    .catch((error) => {
      console.error(`[GeoLibre] Failed to restore vector layer "${layer.name}"`, error);
    });
}

/**
 * Materializes the features of every embeddable local-file Add Vector Layer
 * layer as GeoJSON, so the web Save flow can offer to embed them in the saved
 * project (a browser-picked local file is otherwise lost on reopen, since the
 * browser exposes no path to re-read). Desktop path-backed and URL-backed
 * layers are skipped: they restore without embedding. Layers whose data cannot
 * be read back (e.g. a streamed GeoParquet) are omitted.
 *
 * @param layers - The current store layers.
 * @returns A map from layer id to its features, for layers worth embedding.
 */
export async function materializeEmbeddableVectorLayers(
  layers: GeoLibreLayer[],
): Promise<Map<string, FeatureCollection>> {
  const result = new Map<string, FeatureCollection>();
  // The control is created on project load (restoreVectorLayers) and on first
  // panel open, so it exists whenever embeddable layers do; the null guard is
  // just for a save issued before any vector layer has been touched, where
  // there is nothing to embed anyway.
  const control = vectorControl;
  if (!control) return result;
  // Materialize the layers concurrently: each getLayerGeoJSON may query DuckDB,
  // so serial awaits would add up for a project with several embeddable layers.
  const entries = await Promise.allSettled(
    layers.filter(isEmbeddableLocalVectorLayer).map(async (layer) => {
      const collection = await control.getLayerGeoJSON(layer.id);
      // Embed any readable collection, including an empty one: a layer loaded
      // from an empty file is still valid project state that would otherwise
      // be dropped on reopen. null means the data is not held locally.
      return collection && Array.isArray(collection.features)
        ? ([layer.id, collection] as const)
        : null;
    }),
  );
  for (const entry of entries) {
    if (entry.status === "fulfilled" && entry.value) {
      result.set(entry.value[0], entry.value[1]);
    } else if (entry.status === "rejected") {
      console.error("[GeoLibre] Could not read data for a vector layer to embed it", entry.reason);
    }
  }
  return result;
}

// Upper bound on a restored embedded layer's feature count. The data is the
// user's own (they chose to embed it on save, behind a size warning), and the
// whole project was already parsed into memory before restore runs, so this is
// a sanity guard against a hand-crafted project allocating an absurd number of
// map features, not a tight size cap. Generous: a real embedded dataset stays
// well under it.
const MAX_EMBEDDED_FEATURES = 5_000_000;

/**
 * Validates the `embeddedGeoJSON` read from a (possibly hand-edited) project
 * file: a FeatureCollection with a features array within {@link
 * MAX_EMBEDDED_FEATURES}. Returns it when well-formed, else null so a malformed
 * or pathological value is skipped rather than crashing restore.
 *
 * @param value - The raw `metadata.embeddedGeoJSON` value.
 * @returns The FeatureCollection, or null.
 */
function readEmbeddedVectorGeoJSON(value: unknown): FeatureCollection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { type?: unknown; features?: unknown };
  if (candidate.type !== "FeatureCollection") return null;
  if (!Array.isArray(candidate.features)) return null;
  if (candidate.features.length > MAX_EMBEDDED_FEATURES) {
    console.warn(
      `[GeoLibre] Ignoring embedded vector data with ${candidate.features.length} features (over the ${MAX_EMBEDDED_FEATURES} limit).`,
    );
    return null;
  }
  return value as FeatureCollection;
}

async function ensureVectorControl(app: GeoLibreAppAPI): Promise<VectorControl | null> {
  const VectorControlClass = await getVectorControlClass();

  vectorControl ??= createVectorControl(VectorControlClass);

  if (!vectorControlMounted) {
    const added = app.addMapControl(vectorControl, vectorControlPosition);
    if (!added) {
      unwireVectorStoreSync();
      vectorControl = null;
      return null;
    }
    vectorControlMounted = true;
    // The control mounts hidden: project restore must not surface a map
    // button the user never asked for. openVectorLayerPanel shows it.
    hideVectorControl(vectorControl);
    wireVectorCloseButton(vectorControl);
    applyVectorPanelClass(vectorControl);
    wireDesktopFilePicker(vectorControl, app);
  }

  return vectorControl;
}

/**
 * Loads a remote vector dataset through the Add Vector Layer control, without
 * opening its panel.
 *
 * This is the programmatic door onto everything the panel can already read —
 * GeoParquet, GeoJSON, FlatGeobuf, GeoPackage, CSV, and the other GDAL-readable
 * formats — including the DuckDB-WASM conversion, the dynamic-tile render path
 * for large datasets, and the existing store sync that puts the result in the
 * Layers panel and the project file. Callers that discover a vector URL
 * elsewhere in the UI (the Source Cooperative browser, say) should come through
 * here rather than re-implementing any of that.
 *
 * The control mounts hidden (see {@link ensureVectorControl}), so this adds a
 * layer without surfacing a map button the user did not ask for.
 *
 * @param app - The GeoLibre app API.
 * @param url - An http(s) URL to a vector dataset.
 * @param options - Display name, fitBounds, explicit format, ...
 * @returns True when the layer was added.
 */
export async function addVectorLayerFromUrl(
  app: GeoLibreAppAPI,
  url: string,
  options: VectorLayerOptions = {},
): Promise<boolean> {
  const control = await ensureVectorControl(app);
  if (!control) return false;
  await control.addData(url, options);
  return true;
}

function getVectorControlClass(): Promise<VectorControlConstructor> {
  // Defer the maplibre-gl-vector import until the user first opens the
  // panel or a project restores a vector layer (DuckDB-WASM itself is
  // lazy-loaded by the control on first non-GeoJSON load).
  vectorControlClassPromise ??= import("maplibre-gl-vector").then(
    (module) => module.VectorControl,
    (error: unknown) => {
      // Do not cache the rejection: a transient failure (e.g. the dev
      // server restarting) would otherwise make every later open re-throw
      // until the page reloads.
      vectorControlClassPromise = null;
      throw error;
    },
  );
  return vectorControlClassPromise;
}

function createVectorControl(VectorControlClass: VectorControlConstructor): VectorControl {
  const control = new VectorControlClass({
    className: "geolibre-vector-control",
    collapsed: true,
    panelWidth: 380,
    title: "Add Vector Layer",
    // Empty input with a generic watermark; the sample datasets below are
    // the explicit, opt-in way to load a demonstration layer.
    urlPlaceholder: VECTOR_URL_PLACEHOLDER,
    sampleData: SAMPLE_VECTOR_DATASETS,
    // Let the user resize the dialog from its bottom corners.
    resizable: true,
    // The panel doubles as the Add Vector Layer dialog, so it stays open
    // until the user closes it; clicking the map must not collapse it.
    closeOnOutsideClick: false,
    // Skip the remote spatial-extension install in offline/sandboxed
    // environments when a local extension path is configured.
    spatialExtensionPath: getSpatialExtensionPath(),
  });

  for (const event of ["layeradded", "layerremoved", "layerupdated"] as const) {
    control.on(event, () => syncVectorLayersToStore(control));
  }
  // syncVectorLayersToStore re-reads getState().collapsed when these fire.
  // Safe: expand()/collapse() delegate to toggle(), which flips
  // _state.collapsed BEFORE emitting the event (verified against v0.5.1) --
  // re-verify that ordering when bumping the dependency.
  const panelStateSyncHandler: VectorControlEventHandler = () => syncVectorLayersToStore(control);
  control.on("expand", panelStateSyncHandler);
  control.on("collapse", panelStateSyncHandler);
  wireVectorStoreSync(control);
  patchVectorControlOnRemove(control, panelStateSyncHandler);

  return control;
}

function patchVectorControlOnRemove(
  control: VectorControl,
  panelStateSyncHandler: VectorControlEventHandler,
): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    try {
      originalOnRemove();
    } finally {
      // In a finally block (without a return, so an exception from the
      // upstream teardown still propagates) because skipping this cleanup
      // would leave the module pointing at a removed control until reload.
      if (vectorControl === control) {
        // Symmetric with unwireVectorStoreSync below: a removed control
        // must not keep syncing panel state if a stale reference toggles
        // it.
        control.off("expand", panelStateSyncHandler);
        control.off("collapse", panelStateSyncHandler);
        if (openPanelTimeout !== null) {
          window.clearTimeout(openPanelTimeout);
          openPanelTimeout = null;
        }
        if (restorePanelExpandTimeout !== null) {
          window.clearTimeout(restorePanelExpandTimeout);
          restorePanelExpandTimeout = null;
        }
        unwireVectorStoreSync();
        // A control torn down mid-restore must not leave its successor
        // permanently suppressing store sync events.
        resetVectorStoreSyncSuspension();
        // Store layers are intentionally NOT pruned here: the control is
        // removed on map reinitialisation, where they must survive so
        // restoreVectorLayers can replay them into the successor control.
        vectorControl = null;
        vectorControlMounted = false;
      }
    }
  };
}

function showVectorControl(control: VectorControl): void {
  const container = control.getContainer();
  if (container) container.style.display = "";
}

function hideVectorControl(control: VectorControl): void {
  control.collapse();
  const container = control.getContainer();
  if (container) container.style.display = "none";
}

function applyRestoredVectorPanelState(control: VectorControl, panelCollapsed: boolean): void {
  // A restore queued by an earlier project load must not fire after this
  // one has applied a different panel state to the same control, and a
  // pending openVectorLayerPanel defer must not re-show a panel the
  // restored project keeps collapsed.
  if (openPanelTimeout !== null) {
    window.clearTimeout(openPanelTimeout);
    openPanelTimeout = null;
  }
  if (restorePanelExpandTimeout !== null) {
    window.clearTimeout(restorePanelExpandTimeout);
    restorePanelExpandTimeout = null;
  }

  if (panelCollapsed) {
    hideVectorControl(control);
    return;
  }

  showVectorControl(control);
  // Defer the expand like openVectorLayerPanel does: on a first-mount
  // restore this runs in the same task as addControl, and expanding before
  // MapLibre has laid the control out can measure the panel at zero size.
  restorePanelExpandTimeout = window.setTimeout(() => {
    restorePanelExpandTimeout = null;
    // A control torn down before this task runs (map reinitialisation)
    // must not expand or fire panel-state syncs against its successor.
    if (control !== vectorControl) return;
    try {
      control.expand();
      wireVectorCloseButton(control);
      applyVectorPanelClass(control);
    } catch (error) {
      console.error("[GeoLibre] Failed to restore vector panel state", error);
    }
  }, 0);
}

function vectorPanelCollapsedFromLayers(
  layers: ReturnType<typeof useAppStore.getState>["layers"],
): boolean {
  const panelCollapsed = layers.find(
    (layer) =>
      isVectorControlStoreLayer(layer) && typeof layer.metadata.panelCollapsed === "boolean",
  )?.metadata.panelCollapsed;
  // Projects without this UI state stay collapsed so loading a vector
  // project does not unexpectedly open the Add Data panel.
  return typeof panelCollapsed === "boolean" ? panelCollapsed : true;
}

// The upstream stylesheet themes the panel from prefers-color-scheme (the
// OS setting), while GeoLibre themes from the .dark class on <html>. The
// app maps the panel's --vc-* custom properties onto its own theme tokens
// under this class (see index.css), so the panel follows the app theme.
function applyVectorPanelClass(control: VectorControl): void {
  const internals = control as unknown as VectorControlInternals;
  internals._panel?.classList.add(VECTOR_PANEL_CLASS);
}

// The upstream close button only collapses the panel, leaving the map
// button visible. Hide the whole control too so closing the panel restores
// the pre-open map, like dismissing the dialog it replaces. Loaded layers
// keep rendering; the layer panel still manages them.
function wireVectorCloseButton(control: VectorControl): void {
  const panel = (control as unknown as VectorControlInternals)._panel;
  const closeButton = panel?.querySelector<HTMLElement>(".vector-control-close");
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hideVectorControl(control));
}

// On desktop the host can read a chosen `.shp`'s sidecar files from the same
// directory, so a loose `.shp` loads without the user selecting every component
// (.shx, .dbf, .prj, ...). The upstream panel's file input yields sandboxed File
// objects with no filesystem path, so intercept its click and route through the
// host's native picker (which returns the sidecars via companionFiles), then
// hand the result back to the panel so the layer stays panel-managed. No-op on
// the web, where `pickVectorFilesWithSidecars` is absent and the native input is
// the only way to read files. The selector mirrors the upstream panel's file
// input (verified against v0.5.1) -- re-verify when bumping the dependency.
function wireDesktopFilePicker(control: VectorControl, app: GeoLibreAppAPI): void {
  const pickFiles = app.pickVectorFilesWithSidecars;
  if (!pickFiles) return;
  const panel = (control as unknown as VectorControlInternals)._panel;
  const fileInput = panel?.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput || fileInput.dataset.geolibreDesktopPickerWired === "true") {
    return;
  }
  fileInput.dataset.geolibreDesktopPickerWired = "true";
  fileInput.addEventListener("click", (event) => {
    // Suppress the sandboxed picker (no path) in favor of the host dialog. Also
    // covers the "click to browse" drop zone, which delegates to this input.
    event.preventDefault();
    void (async () => {
      try {
        await addPickedVectorFiles(control, await pickFiles());
      } catch (error) {
        console.error("[GeoLibre] Failed to load vector files from the desktop picker", error);
      }
    })();
  });
}

/** The subset of VectorControl used to load picked files (eases testing). */
export type VectorDataSink = Pick<VectorControl, "addData">;

/**
 * Loads files picked through {@link GeoLibreAppAPI.pickVectorFilesWithSidecars}
 * into a vector control, passing a shapefile's sidecars as `companionFiles` so a
 * loose `.shp` loads as a single layer. Each file is added independently; an
 * empty list (e.g. a cancelled dialog) loads nothing.
 *
 * @param control - The vector control (or anything with `addData`).
 * @param picked - The picked files (empty when the dialog was cancelled).
 */
export async function addPickedVectorFiles(
  control: VectorDataSink,
  picked: GeoLibrePickedVectorFile[],
): Promise<void> {
  for (const { file, companionFiles, sourcePath, nativeData } of picked) {
    const source = nativeData ? nativeGeoJsonFile(file, nativeData) : file;
    await control.addData(source, {
      ...(nativeData ? { name: file.name } : {}),
      ...(!nativeData && companionFiles.length > 0 ? { companionFiles } : {}),
      ...(sourcePath ? { sourcePath } : {}),
    });
  }
}

function nativeGeoJsonFile(file: File, data: FeatureCollection): File {
  return new File([JSON.stringify(data)], `${fileBaseName(file.name)}.geojson`, {
    type: "application/geo+json",
  });
}

function fileBaseName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "vector";
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const fileName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return fileName.replace(/\.[^.]+$/, "") || "vector";
}
