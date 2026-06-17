import { useAppStore } from "@geolibre/core";
import type {
  RasterControl,
  RasterControlEventHandler,
} from "maplibre-gl-raster";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";
import {
  isRasterControlStoreLayer,
  resetRasterStoreSyncSuspension,
  runWithRasterStoreSyncSuspended,
  savedRasterState,
  syncRasterLayersToStoreWithOptions,
  unwireRasterStoreSync,
  wireRasterStoreSync,
} from "./raster-layer-sync";
import {
  activateRasterClassification,
  disposeAllRasterClassification,
  disposeRasterClassification,
} from "./raster-symbology-texture";

const rasterControlPosition: GeoLibreMapControlPosition = "top-left";
const RASTER_PANEL_CLASS = "geolibre-raster-panel";
const DEFAULT_RASTER_URL =
  "https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif";

// These types mirror undocumented private members of RasterControl from
// maplibre-gl-raster (verified against v0.2.0). All access is optional (?.)
// so a rename in a future release degrades to a no-op rather than a crash --
// re-verify these names AND the .mlr-control-close selector in
// wireRasterCloseButton when bumping the dependency.
type RasterControlInternals = {
  _clickOutsideHandler?: ((event: MouseEvent) => void) | null;
  _layerManager?: RasterLayerManagerInternals;
  _panel?: HTMLElement;
};

type RasterControlConstructor = typeof RasterControl;
type OverlayFactoryOptions = {
  interleaved: boolean;
  onDeviceInitialized: (device: unknown) => void;
};
type OverlayLike = {
  setProps: (props: { layers?: unknown[] }) => void;
};
type MapControlHost = {
  addControl: (control: unknown) => void;
};
type MapboxOverlayConstructor = new (
  props: Record<string, unknown>,
) => OverlayLike;
type RasterLayerManagerInternals = {
  _deps?: {
    createOverlay?: (
      map: MapControlHost,
      options: OverlayFactoryOptions,
    ) => OverlayLike;
    loadGeoTIFF?: (url: string) => Promise<unknown>;
    geolibreTransparentOverlayPatched?: boolean;
    geolibreTauriNodataPatched?: boolean;
  };
};
type RasterTileArray = {
  bands?: unknown[];
  data?: unknown;
  nodata?: number | null;
};
type RasterTile = {
  array?: RasterTileArray;
};
type TiledRasterSource = {
  fetchTile?: (...args: unknown[]) => Promise<RasterTile>;
  geolibreNodataPatched?: boolean;
};
type GeoTiffWithOverviews = TiledRasterSource & {
  overviews?: TiledRasterSource[];
};

let rasterControlClassPromise: Promise<RasterControlConstructor> | null = null;
let mapboxOverlayClassPromise: Promise<MapboxOverlayConstructor> | null = null;
let rasterControl: RasterControl | null = null;
let rasterControlMounted = false;
let restorePanelExpandTimeout: number | null = null;
let rasterControlInterleaved = true;
// Blob URLs minted for File-backed rasters (see addRasterToMap), keyed by
// raster layer id. Tracked here so they can be revoked when the raster is
// removed; otherwise each would leak until the page unloads.
const localBytesUrls = new Map<string, string>();

/**
 * Opens the maplibre-gl-raster panel, mounting the control on first use.
 * Replaces the former Add Raster Layer dialog: the panel loads COGs and
 * GeoTIFFs from URLs or local files and edits bands, rescale, colormaps,
 * nodata, stretch, gamma, and opacity per layer.
 *
 * @param app - The GeoLibre app API.
 */
export function openRasterLayerPanel(app: GeoLibreAppAPI): void {
  void (async () => {
    const control = await ensureRasterControl(app);
    if (!control) return;
    // Defer by one task so the control finishes its mount cycle before the
    // panel is shown and expanded, matching the other standalone panels
    // (Earth Engine, 3D Tiles); expanding in the same task as addControl can
    // measure the panel before MapLibre has laid the control out.
    window.setTimeout(() => {
      // The IIFE's catch cannot see exceptions thrown in this later task.
      try {
        showRasterControl(control);
        control.expand();
        // Idempotent (guarded by a dataset flag / null checks): retried on
        // every open so the panel chrome stays wired even if a future
        // upstream release builds the panel DOM (or registers the
        // click-outside handler) lazily on first expand.
        wireRasterCloseButton(control);
        applyRasterPanelClass(control);
        disableRasterClickOutsideCollapse(control);
      } catch (error) {
        console.error(
          "[GeoLibre] Failed to open the raster layer panel",
          error,
        );
      }
    }, 0);
  })().catch((error) => {
    console.error("[GeoLibre] Failed to open the raster layer panel", error);
  });
}

/**
 * Adds a raster (GeoTIFF/COG) to the map from a remote URL or a local File,
 * mounting the raster control on first use and zooming to the new layer. Used by
 * the map drag and drop handler. The control's `rasteradd` event syncs the layer
 * into the store, so it appears in the layer list and renders like any raster
 * layer.
 *
 * @param app - The GeoLibre app API.
 * @param source - A remote COG URL or a local GeoTIFF File.
 * @param options - Optional display name for the layer.
 */
export async function addRasterToMap(
  app: GeoLibreAppAPI,
  source: string | File,
  options: { name?: string } = {},
): Promise<void> {
  const control = await ensureRasterControl(app);
  if (!control) {
    throw new Error("The raster control could not be initialized.");
  }
  const id = await control.addRaster(source, {
    name: options.name,
    zoomTo: true,
  });
  // Retain the source bytes for File-backed rasters. The store layer only
  // records the file name (no fetchable URL), so in-browser tools (the WASM
  // Whitebox runner) could not read it back. Stamp a blob URL onto the layer
  // so the data stays runnable for the lifetime of the session. The raster
  // store sync preserves this key across its metadata rebuilds.
  if (typeof source !== "string") {
    const store = useAppStore.getState();
    const layer = store.layers.find((current) => current.id === id);
    if (layer) {
      // Defensive: if this id ever reused an existing entry, revoke the old
      // blob URL before replacing it so it cannot leak.
      const previous = localBytesUrls.get(id);
      if (previous) URL.revokeObjectURL(previous);
      const blobUrl = URL.createObjectURL(source);
      localBytesUrls.set(id, blobUrl);
      store.updateLayer(id, {
        metadata: {
          ...layer.metadata,
          localBytesUrl: blobUrl,
        },
      });
    }
  }
}

/**
 * Pushes a layer's interleave position into the raster control: draw the raster
 * (a deck.gl COG) beneath `beforeId`, or on top when `beforeId` is undefined.
 *
 * `@geolibre/map`'s layer-sync computes the beforeId from the store order but
 * cannot move the deck layer itself (it has no real MapLibre style layer), so
 * the desktop shell wires this as its deck-layer order handler. A no-op for any
 * id the raster control does not own.
 *
 * @param layerId - The store/raster layer id.
 * @param beforeId - The MapLibre style layer id to draw beneath, or undefined.
 */
export function applyRasterLayerOrder(
  layerId: string,
  beforeId: string | undefined,
): void {
  rasterControl?.setRasterBeforeId(layerId, beforeId ?? null);
}

export function closeRasterLayerPanel(app: GeoLibreAppAPI): void {
  if (restorePanelExpandTimeout !== null) {
    window.clearTimeout(restorePanelExpandTimeout);
    restorePanelExpandTimeout = null;
  }

  if (rasterControl && rasterControlMounted) {
    app.removeMapControl(rasterControl);
    return;
  }

  unwireRasterStoreSync();
  resetRasterStoreSyncSuspension();
  rasterControl = null;
  rasterControlMounted = false;
}

/**
 * Replays URL-backed rasters from the loaded project into the control and
 * drops control rasters the project does not contain. Called by the desktop
 * shell whenever a project is loaded or the map is reinitialised, mirroring
 * restoreThreeDTilesLayers. Local-file rasters cannot be reloaded from a
 * saved project, so their panel entries are removed with a notice.
 *
 * @param app - The GeoLibre app API.
 */
export function restoreRasterLayers(app: GeoLibreAppAPI): void {
  const hasRasterLayers = useAppStore
    .getState()
    .layers.some(isRasterControlStoreLayer);
  if (!hasRasterLayers && !rasterControl) return;

  void (async () => {
    const control = await ensureRasterControl(app);
    if (!control) return;

    // Re-read the store after the await: the project may have changed while
    // the control class was loading.
    const storeLayerIds = new Set(
      useAppStore
        .getState()
        .layers.filter(isRasterControlStoreLayer)
        .map((layer) => layer.id),
    );

    const pending: Promise<unknown>[] = [];
    const panelCollapsed = rasterPanelCollapsedFromLayers(
      useAppStore.getState().layers,
    );
    // The suspension covers the synchronous events fired inside this block:
    // removeRaster's rasterremove, and the rasteradd each addRaster emits
    // before it awaits the GeoTIFF header (without it, the first rasteradd
    // sync would prune store layers not yet replayed). The rasterchange
    // events that follow header loads land after this window and sync
    // incrementally; the Promise.allSettled pass below settles the rest.
    runWithRasterStoreSyncSuspended(() => {
      // Isolated so a DOM error from the panel-state restore cannot abort
      // the raster replay below.
      try {
        applyRestoredRasterPanelState(control, panelCollapsed);
      } catch (error) {
        console.error("[GeoLibre] Failed to restore raster panel state", error);
      }

      for (const info of control.getRasters()) {
        if (!storeLayerIds.has(info.id)) control.removeRaster(info.id);
      }

      for (const layer of useAppStore.getState().layers) {
        if (!isRasterControlStoreLayer(layer)) continue;
        if (control.getRaster(layer.id)) continue;

        const url =
          typeof layer.source.url === "string" && layer.source.url
            ? layer.source.url
            : undefined;
        if (!url) {
          // Console-only on purpose for this first pass: the plugin layer has
          // no toast/notification API today. Surface this through an in-app
          // notification once one is exposed to plugins.
          console.info(
            `[GeoLibre] Raster layer "${layer.name}" came from a local file and cannot be restored from the saved project.`,
          );
          // removeLayer fires the store subscriber synchronously; the
          // suspension guard keeps it from echoing back at the control.
          useAppStore.getState().removeLayer(layer.id);
          continue;
        }

        pending.push(
          control
            .addRaster(url, {
              id: layer.id,
              name: layer.name,
              state: {
                ...savedRasterState(layer),
                opacity: layer.opacity,
                visible: layer.visible,
              },
              zoomTo: false,
            })
            .catch((error) => {
              console.error(
                `[GeoLibre] Failed to restore raster layer "${layer.name}"`,
                error,
              );
            }),
        );
      }
    });

    // Each addRaster syncs on its own events too, but those run while other
    // restores may still be loading; this final pass settles the store once
    // every raster has either loaded or failed.
    void Promise.allSettled(pending).then(() => {
      // Defer one task so this sync runs after the deferred panel expand in
      // applyRestoredRasterPanelState: with no pending rasters, allSettled
      // resolves as a microtask, and syncing then would briefly write the
      // pre-expand collapsed state to the store. Ordering invariant: the
      // expand timer is registered synchronously inside the suspension
      // block above, this one from a microtask after it, and same-delay
      // timers fire FIFO -- revisit if applyRestoredRasterPanelState ever
      // becomes async.
      window.setTimeout(() => {
        // A control torn down mid-restore (map reinitialisation) must not
        // let this stale callback rewrite layers owned by its successor.
        if (control !== rasterControl) return;
        syncRasterLayersToStoreForRuntime(control);
      }, 0);
    });
  })().catch((error) => {
    console.error("[GeoLibre] Failed to restore raster layers", error);
  });
}

async function ensureRasterControl(
  app: GeoLibreAppAPI,
): Promise<RasterControl | null> {
  const RasterControlClass = await getRasterControlClass();

  rasterControl ??= createRasterControl(RasterControlClass);

  if (!rasterControlMounted) {
    const added = app.addMapControl(rasterControl, rasterControlPosition);
    if (!added) {
      unwireRasterStoreSync();
      rasterControl = null;
      return null;
    }
    rasterControlMounted = true;
    // The control mounts hidden: project restore must not surface a map
    // button the user never asked for. openRasterLayerPanel shows it.
    await patchTauriRasterOverlayFactory(rasterControl);
    // Patch the deck.gl render path so classified single-band rasters sample a
    // custom stepped colormap. Must run after addMapControl: the LayerManager
    // (and its _renderTileFor / _device) is created in the control's onAdd,
    // not its constructor.
    activateRasterClassification(rasterControl);
    hideRasterControl(rasterControl);
    disableRasterClickOutsideCollapse(rasterControl);
    wireRasterCloseButton(rasterControl);
    applyRasterPanelClass(rasterControl);
  }

  return rasterControl;
}

function getRasterControlClass(): Promise<RasterControlConstructor> {
  // Defer the maplibre-gl-raster import (and its deck.gl GeoTIFF pipeline)
  // until the user first opens the panel or a project restores a raster.
  rasterControlClassPromise ??= import("maplibre-gl-raster").then(
    (module) => module.RasterControl,
    (error: unknown) => {
      // Do not cache the rejection: a transient failure (e.g. the dev
      // server restarting) would otherwise make every later open re-throw
      // until the page reloads.
      rasterControlClassPromise = null;
      throw error;
    },
  );
  return rasterControlClassPromise;
}

function getMapboxOverlayClass(): Promise<MapboxOverlayConstructor> {
  mapboxOverlayClassPromise ??= import("@deck.gl/mapbox").then(
    (module) => module.MapboxOverlay as unknown as MapboxOverlayConstructor,
  );
  return mapboxOverlayClassPromise;
}

function createRasterControl(
  RasterControlClass: RasterControlConstructor,
): RasterControl {
  rasterControlInterleaved = !isTauriRuntime();
  const control = new RasterControlClass({
    className: "geolibre-raster-control",
    collapsed: true,
    defaultUrl: DEFAULT_RASTER_URL,
    interleaved: rasterControlInterleaved,
    panelWidth: 380,
    title: "Add Raster Layer",
  });

  // deck.gl's COG tile traversal does not support MapLibre's globe view
  // ("TODO: implement getBoundingVolume in Globe view"), so adding a raster
  // switches the map to mercator, like the other deck.gl-backed plugins.
  control.on("rasteradd", () => ensureMercatorProjection(control.getMap()));
  for (const event of ["rasteradd", "rasterchange", "rasterremove"] as const) {
    control.on(event, () => syncRasterLayersToStoreForRuntime(control));
  }
  // Free the per-layer classification GPU texture, and revoke any retained
  // local-bytes blob URL, when its raster is dropped.
  control.on("rasterremove", (event) => {
    if (!event.layerId) return;
    disposeRasterClassification(event.layerId);
    const blobUrl = localBytesUrls.get(event.layerId);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      localBytesUrls.delete(event.layerId);
    }
  });
  // syncRasterLayersToStore re-reads getState().collapsed when these fire.
  // Safe: expand()/collapse() delegate to toggle(), which flips
  // _state.collapsed BEFORE emitting the event (verified against v0.2.0) --
  // re-verify that ordering when bumping the dependency.
  const panelStateSyncHandler: RasterControlEventHandler = () =>
    syncRasterLayersToStoreForRuntime(control);
  control.on("expand", panelStateSyncHandler);
  control.on("collapse", panelStateSyncHandler);
  wireRasterStoreSync(control);
  patchRasterControlOnRemove(control, panelStateSyncHandler);

  return control;
}

function syncRasterLayersToStoreForRuntime(control: RasterControl): void {
  syncRasterLayersToStoreWithOptions(control, {
    interleaved: rasterControlInterleaved,
  });
}

async function patchTauriRasterOverlayFactory(
  control: RasterControl,
): Promise<void> {
  if (!isTauriRuntime()) return;

  const manager = (control as unknown as RasterControlInternals)._layerManager;
  const deps = manager?._deps;
  if (!deps) return;

  if (deps.createOverlay && !deps.geolibreTransparentOverlayPatched) {
    const MapboxOverlayClass = await getMapboxOverlayClass();
    deps.createOverlay = (map, options) => {
      const overlay = new MapboxOverlayClass({
        deviceProps: {
          createCanvasContext: { alphaMode: "premultiplied" },
          webgl: {
            alpha: true,
            premultipliedAlpha: true,
          },
        },
        interleaved: false,
        layers: [],
        onDeviceInitialized: options.onDeviceInitialized,
        parameters: {
          clearColor: [0, 0, 0, 0],
        },
      });
      map.addControl(overlay);
      return overlay;
    };
    deps.geolibreTransparentOverlayPatched = true;
  }

  if (deps.loadGeoTIFF && !deps.geolibreTauriNodataPatched) {
    const loadGeoTIFF = deps.loadGeoTIFF;
    deps.loadGeoTIFF = async (url) =>
      patchGeoTiffNumericNodata(await loadGeoTIFF(url));
    deps.geolibreTauriNodataPatched = true;
  }
}

function patchGeoTiffNumericNodata(tiff: unknown): unknown {
  patchTiledRasterSource(tiff);
  for (const overview of (tiff as GeoTiffWithOverviews).overviews ?? []) {
    patchTiledRasterSource(overview);
  }
  return tiff;
}

function patchTiledRasterSource(source: unknown): void {
  const tiledSource = source as TiledRasterSource;
  if (!tiledSource.fetchTile || tiledSource.geolibreNodataPatched) return;

  const fetchTile = tiledSource.fetchTile.bind(source);
  tiledSource.fetchTile = async (...args) => {
    const tile = await fetchTile(...args);
    normalizeTileNumericNodata(tile);
    return tile;
  };
  tiledSource.geolibreNodataPatched = true;
}

function normalizeTileNumericNodata(tile: RasterTile): void {
  const array = tile.array;
  if (!array) return;
  const nodata = array.nodata;
  if (typeof nodata !== "number" || !Number.isFinite(nodata)) return;

  let replaced = false;
  if (Array.isArray(array.bands)) {
    for (const band of array.bands) {
      replaced = replaceFloat32NodataWithNaN(band, nodata) || replaced;
    }
  } else {
    replaced = replaceFloat32NodataWithNaN(array.data, nodata);
  }

  if (replaced) array.nodata = Number.NaN;
}

function replaceFloat32NodataWithNaN(data: unknown, nodata: number): boolean {
  if (!(data instanceof Float32Array)) return false;

  let replaced = false;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === nodata) {
      data[index] = Number.NaN;
      replaced = true;
    }
  }
  return replaced;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function patchRasterControlOnRemove(
  control: RasterControl,
  panelStateSyncHandler: RasterControlEventHandler,
): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    if (rasterControl !== control) return;
    // Symmetric with unwireRasterStoreSync below: a removed control must
    // not keep syncing panel state if a stale reference toggles it.
    control.off("expand", panelStateSyncHandler);
    control.off("collapse", panelStateSyncHandler);
    if (restorePanelExpandTimeout !== null) {
      window.clearTimeout(restorePanelExpandTimeout);
      restorePanelExpandTimeout = null;
    }
    unwireRasterStoreSync();
    disposeAllRasterClassification();
    // A control torn down mid-restore must not leave its successor
    // permanently suppressing store sync events.
    resetRasterStoreSyncSuspension();
    // Store layers are intentionally NOT pruned here: the control is
    // removed on map reinitialisation, where they must survive so
    // restoreRasterLayers can replay them into the successor control.
    rasterControl = null;
    rasterControlMounted = false;
  };
}

function showRasterControl(control: RasterControl): void {
  const container = control.getContainer();
  if (container) container.style.display = "";
}

function hideRasterControl(control: RasterControl): void {
  control.collapse();
  const container = control.getContainer();
  if (container) container.style.display = "none";
}

function applyRestoredRasterPanelState(
  control: RasterControl,
  panelCollapsed: boolean,
): void {
  // A restore queued by an earlier project load must not fire after this
  // one has applied a different panel state to the same control.
  if (restorePanelExpandTimeout !== null) {
    window.clearTimeout(restorePanelExpandTimeout);
    restorePanelExpandTimeout = null;
  }

  if (panelCollapsed) {
    hideRasterControl(control);
    return;
  }

  showRasterControl(control);
  // Defer the expand like openRasterLayerPanel does: on a first-mount
  // restore this runs in the same task as addControl, and expanding before
  // MapLibre has laid the control out can measure the panel at zero size.
  restorePanelExpandTimeout = window.setTimeout(() => {
    restorePanelExpandTimeout = null;
    // A control torn down before this task runs (map reinitialisation)
    // must not expand or fire panel-state syncs against its successor.
    if (control !== rasterControl) return;
    try {
      control.expand();
      wireRasterCloseButton(control);
      applyRasterPanelClass(control);
      disableRasterClickOutsideCollapse(control);
    } catch (error) {
      console.error("[GeoLibre] Failed to restore raster panel state", error);
    }
  }, 0);
}

function rasterPanelCollapsedFromLayers(
  layers: ReturnType<typeof useAppStore.getState>["layers"],
): boolean {
  const panelCollapsed = layers.find(
    (layer) =>
      isRasterControlStoreLayer(layer) &&
      typeof layer.metadata.panelCollapsed === "boolean",
  )?.metadata.panelCollapsed;
  // Older projects did not persist this UI state. Keep them collapsed so
  // loading a raster project does not unexpectedly open the Add Data panel.
  return typeof panelCollapsed === "boolean" ? panelCollapsed : true;
}

// The control collapses its panel when the user clicks anywhere else on the
// page, which fights the panel's role as the Add Raster Layer dialog (e.g.
// panning the map to inspect a loaded COG would close it). Removing the
// handler keeps the panel open until the user closes it explicitly.
function disableRasterClickOutsideCollapse(control: RasterControl): void {
  const internals = control as unknown as RasterControlInternals;
  const handler = internals._clickOutsideHandler;
  if (!handler) return;
  document.removeEventListener("click", handler);
  internals._clickOutsideHandler = null;
}

// The upstream stylesheet themes the panel from prefers-color-scheme (the
// OS setting), while GeoLibre themes from the .dark class on <html>. The
// app maps the panel's --mlr-* custom properties onto its own theme tokens
// under this class (see index.css), so the panel follows the app theme.
function applyRasterPanelClass(control: RasterControl): void {
  const internals = control as unknown as RasterControlInternals;
  internals._panel?.classList.add(RASTER_PANEL_CLASS);
}

// The upstream close button only collapses the panel, leaving the map
// button visible. Hide the whole control too so closing the panel restores
// the pre-open map, like dismissing the dialog it replaces. Loaded rasters
// keep rendering; the layer panel still manages them.
function wireRasterCloseButton(control: RasterControl): void {
  const panel = (control as unknown as RasterControlInternals)._panel;
  const closeButton = panel?.querySelector<HTMLElement>(".mlr-control-close");
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hideRasterControl(control));
}
