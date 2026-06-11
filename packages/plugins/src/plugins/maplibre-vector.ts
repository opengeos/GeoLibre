import { useAppStore } from "@geolibre/core";
import type {
  VectorControl,
  VectorControlEventHandler,
  VectorLayerInfo,
} from "maplibre-gl-vector";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import {
  isVectorControlStoreLayer,
  resetVectorStoreSyncSuspension,
  resumeVectorStoreSync,
  savedVectorState,
  suspendVectorStoreSync,
  syncVectorLayersToStore,
  unwireVectorStoreSync,
  wireVectorStoreSync,
} from "./vector-layer-sync";

const vectorControlPosition: GeoLibreMapControlPosition = "top-left";
const VECTOR_PANEL_CLASS = "geolibre-vector-panel";
const DEFAULT_VECTOR_URL =
  "https://data.source.coop/giswqs/opengeos/countries.parquet";

// These types mirror undocumented private members of VectorControl from
// maplibre-gl-vector (verified against v0.2.0). All access is optional (?.)
// so a rename in a future release degrades to a no-op rather than a crash --
// re-verify these names AND the .vector-control-close selector in
// wireVectorCloseButton when bumping the dependency.
type VectorControlInternals = {
  _clickOutsideHandler?: ((event: MouseEvent) => void) | null;
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
        // upstream release builds the panel DOM (or registers the
        // click-outside handler) lazily on first expand.
        wireVectorCloseButton(control);
        applyVectorPanelClass(control);
        disableVectorClickOutsideCollapse(control);
      } catch (error) {
        console.error(
          "[GeoLibre] Failed to open the vector layer panel",
          error,
        );
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
export async function reloadVectorControlLayer(
  id: string,
): Promise<VectorLayerInfo | undefined> {
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
  const hasVectorLayers = useAppStore
    .getState()
    .layers.some(isVectorControlStoreLayer);
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
    const panelCollapsed = vectorPanelCollapsedFromLayers(
      useAppStore.getState().layers,
    );
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
          typeof layer.source.url === "string" && layer.source.url
            ? layer.source.url
            : undefined;
        if (!url) {
          // Console-only on purpose for this first pass: the plugin layer
          // has no toast/notification API today. Surface this through an
          // in-app notification once one is exposed to plugins.
          console.info(
            `[GeoLibre] Vector layer "${layer.name}" came from a local file and cannot be restored from the saved project.`,
          );
          // removeLayer fires the store subscriber synchronously; the
          // suspension guard keeps it from echoing back at the control.
          useAppStore.getState().removeLayer(layer.id);
          continue;
        }

        pending.push(
          control
            .addData(url, {
              ...savedVectorState(layer),
              fitBounds: false,
              id: layer.id,
              name: layer.name,
              opacity: layer.opacity,
              visible: layer.visible,
            })
            .catch((error) => {
              console.error(
                `[GeoLibre] Failed to restore vector layer "${layer.name}"`,
                error,
              );
            }),
        );
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

async function ensureVectorControl(
  app: GeoLibreAppAPI,
): Promise<VectorControl | null> {
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
    disableVectorClickOutsideCollapse(vectorControl);
    wireVectorCloseButton(vectorControl);
    applyVectorPanelClass(vectorControl);
  }

  return vectorControl;
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

function createVectorControl(
  VectorControlClass: VectorControlConstructor,
): VectorControl {
  const control = new VectorControlClass({
    className: "geolibre-vector-control",
    collapsed: true,
    // Prefilled but not autoLoad: the control also mounts hidden during
    // project restore, where auto-loading the sample would inject it
    // into every restored project.
    defaultUrl: DEFAULT_VECTOR_URL,
    panelWidth: 380,
    title: "Add Vector Layer",
    urlPlaceholder: DEFAULT_VECTOR_URL,
  });

  for (const event of ["layeradded", "layerremoved", "layerupdated"] as const) {
    control.on(event, () => syncVectorLayersToStore(control));
  }
  // syncVectorLayersToStore re-reads getState().collapsed when these fire.
  // Safe: expand()/collapse() delegate to toggle(), which flips
  // _state.collapsed BEFORE emitting the event (verified against v0.2.0) --
  // re-verify that ordering when bumping the dependency.
  const panelStateSyncHandler: VectorControlEventHandler = () =>
    syncVectorLayersToStore(control);
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

function applyRestoredVectorPanelState(
  control: VectorControl,
  panelCollapsed: boolean,
): void {
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
      disableVectorClickOutsideCollapse(control);
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
      isVectorControlStoreLayer(layer) &&
      typeof layer.metadata.panelCollapsed === "boolean",
  )?.metadata.panelCollapsed;
  // Projects without this UI state stay collapsed so loading a vector
  // project does not unexpectedly open the Add Data panel.
  return typeof panelCollapsed === "boolean" ? panelCollapsed : true;
}

// The control collapses its panel when the user clicks anywhere else on the
// page, which fights the panel's role as the Add Vector Layer dialog (e.g.
// panning the map to inspect a loaded layer would close it). Removing the
// handler keeps the panel open until the user closes it explicitly.
function disableVectorClickOutsideCollapse(control: VectorControl): void {
  const internals = control as unknown as VectorControlInternals;
  const handler = internals._clickOutsideHandler;
  if (!handler) return;
  document.removeEventListener("click", handler);
  internals._clickOutsideHandler = null;
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
  const closeButton = panel?.querySelector<HTMLElement>(
    ".vector-control-close",
  );
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hideVectorControl(control));
}
