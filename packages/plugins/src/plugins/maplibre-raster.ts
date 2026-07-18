import { useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type {
  RasterControl,
  RasterControlEventHandler,
  RasterSampleDataset,
} from "maplibre-gl-raster";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";
import {
  ensureSharedDeckOverlay,
  onSharedDeckDevice,
  setSharedDeckLayers,
} from "./shared-deck-overlay";
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
import { disposeAllPaletteLegends, disposePaletteLegend } from "./raster-palette";

const rasterControlPosition: GeoLibreMapControlPosition = "top-left";
const RASTER_PANEL_CLASS = "geolibre-raster-panel";

// One-click sample COGs shown in the panel's "Load sample data" dropdown.
// Edit this list to offer different (or more) demonstration rasters; loading
// is opt-in, so an empty list simply hides the dropdown. URLs must be
// CORS-enabled and range-request capable (source.coop is both). Labels are
// rendered by the upstream control, which exposes no i18n callback, so they
// stay plain strings (same gap as the vector plugin's sample list).
const SAMPLE_RASTER_DATASETS: RasterSampleDataset[] = [
  {
    label: "Land cover",
    url: "https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif",
    attribution: "U.S. Geological Survey (USGS)",
  },
  {
    label: "Elevation (DEM)",
    url: "https://data.source.coop/giswqs/opengeos/dem.tif",
    attribution: "U.S. Geological Survey (USGS)",
  },
  {
    // Global ocean/land bathymetry: a single-band DEM good for the colormap
    // and hillshade modes. Attribution feeds the map's attribution control
    // while the layer is visible (upstream RasterSampleDataset.attribution).
    label: "Bathymetry (GEBCO)",
    url: "https://data.source.coop/giswqs/gebco-bathymetry/gebco_2026/gebco_2026.tif",
    attribution: "GEBCO Compilation Group (2026)",
  },
  {
    // A multiband Sentinel-2 L2A scene: good for RGB composites and the
    // normalized-difference index mode (NDVI and friends).
    label: "Sentinel-2 (multiband)",
    url: "https://data.source.coop/opengeos/geoai/S2C-MSIL2A-20250920T162001-subset.tif",
    attribution: "Copernicus Sentinel data (ESA)",
  },
  {
    // A gdalbuildvrt mosaic of six NAIP COG tiles (4-band RGB+NIR), read
    // straight from the .vrt: exercises maplibre-gl-raster's VRT support
    // (v0.11.0+), which renders a plain COG mosaic in the browser without GDAL.
    label: "NAIP mosaic (VRT)",
    url: "https://data.source.coop/giswqs/opengeos/naip_water_train.vrt",
    attribution: "USDA Farm Service Agency (FSA)",
  },
];

// This type mirrors undocumented private members of RasterControl from
// maplibre-gl-raster (re-verified against v0.11.1). All access is optional (?.)
// so a rename in a future release degrades to a no-op rather than a crash --
// re-verify these names AND the .mlr-control-close selector in
// wireRasterCloseButton when bumping the dependency.
type RasterControlInternals = {
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
type MapboxOverlayConstructor = new (props: Record<string, unknown>) => OverlayLike;
type RasterLayerManagerInternals = {
  /** The currently selected raster id (read to restore it after inspect). */
  selectedId?: string | null;
  _deps?: {
    createOverlay?: (map: MapControlHost, options: OverlayFactoryOptions) => OverlayLike;
    removeOverlay?: (map: MapControlHost, overlay: OverlayLike) => void;
    loadGeoTIFF?: (url: string) => Promise<unknown>;
    geolibreTransparentOverlayPatched?: boolean;
    geolibreTauriNodataPatched?: boolean;
    geolibreSharedOverlayPatched?: boolean;
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
// Unsubscribes the web raster overlay proxy from the shared Deck's device
// notifications when the control's overlay is torn down (see
// patchWebRasterOverlayFactory).
let rasterSharedOverlayDeviceUnsubscribe: (() => void) | null = null;

/**
 * Details of a raster that the panel could not render because it is a striped
 * (non-tiled) GeoTIFF rather than a tiled COG. Covers both a local file and a
 * remote URL. Passed to a host handler registered via
 * {@link setNonTiledRasterHandler}, which can offer to convert it to a COG (the
 * conversion + UI live in the app layer, which has i18n and the client-side
 * converter; this framework-agnostic package only detects the case).
 */
export interface NonTiledRasterRequest {
  /** The failed layer's id. */
  layerId: string;
  /** The failed layer's display name (used for the converted layer too). */
  name: string;
  /** Whether {@link readBytes} streams a full file over the network (a remote
   * URL source) rather than resolving instantly from a local blob URL. The host
   * uses this to confirm with the user *before* a potentially large download
   * starts, instead of after. */
  bytesAreRemote: boolean;
  /** Reads the original bytes (a local file from its blob URL, or a remote URL
   * fetched whole). Must be awaited before {@link dismiss}, which revokes a
   * local file's blob URL. */
  readBytes: () => Promise<Uint8Array>;
  /** Removes the failed layer from the map and the store. */
  dismiss: () => void;
}

type NonTiledRasterHandler = (request: NonTiledRasterRequest) => void | Promise<void>;

let nonTiledRasterHandler: NonTiledRasterHandler | null = null;
// Layer ids currently being handled, so a repeated 'error' event for the same
// failed layer does not prompt twice.
const nonTiledInFlight = new Set<string>();
// Cap the whole-file fetch of a remote striped GeoTIFF so a slow or stalled
// server surfaces a clear conversion failure instead of hanging the handler
// until the browser's (often minutes-long) global network timeout. A local
// file's blob URL resolves instantly, so the bound only ever bites remote URLs.
// Tuning knob: generous for the small striped GeoTIFFs this targets, but a very
// large file on a slow link could hit it (the host then shows a download error);
// raise it if that becomes common.
const NON_TILED_FETCH_TIMEOUT_MS = 60_000;

/**
 * Register (or clear, with `null`) a handler invoked when a GeoTIFF (local file
 * or remote URL) fails to load because it is striped rather than tiled. The app
 * uses this to offer an in-browser convert-to-COG flow. Only one handler is
 * active at a time.
 *
 * @param handler - The handler, or `null` to unregister.
 */
export function setNonTiledRasterHandler(handler: NonTiledRasterHandler | null): void {
  nonTiledRasterHandler = handler;
}

/** Whether a raster load error is the upstream "striped, not tiled" failure.
 * maplibre-gl-raster (re-verified against v0.11.1) rejects non-tiled GeoTIFFs with a message
 * containing "not tiled"; this is the only signal it exposes, so the match is
 * coupled to that wording. Re-verify it (and broaden if needed) when bumping the
 * dependency -- a reworded message degrades to the plain error, not a crash. */
function isNonTiledRasterError(error: Error | null | undefined): boolean {
  return error != null && /not tiled/i.test(error.message);
}

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
        // upstream release builds the panel DOM lazily on first expand.
        wireRasterCloseButton(control);
        applyRasterPanelClass(control);
      } catch (error) {
        console.error("[GeoLibre] Failed to open the raster layer panel", error);
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
  // For File-backed rasters the control retains the original bytes behind a
  // blob URL (source.objectUrl), which the store sync surfaces as
  // metadata.localBytesUrl so in-browser tools (the WASM Whitebox runner) can
  // read the data back. No extra bookkeeping is needed here.
  await control.addRaster(source, {
    name: options.name,
    zoomTo: true,
  });
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
export function applyRasterLayerOrder(layerId: string, beforeId: string | undefined): void {
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

// The panel selection in effect before inspect stole focus, so it can be
// restored when inspect stops (see setRasterPixelInspect).
let rasterInspectPriorSelection: string | null = null;

/**
 * Drives the raster control's pixel-inspect mode for a raster/COG layer so the
 * Layers-panel Identify action can read source band values on map click — the
 * same behavior as the raster panel's Inspect button. Selects the target raster
 * before enabling so the inspector reads the right layer, then restores the
 * panel's prior selection when inspect stops so it doesn't silently steal focus
 * from a raster the user had selected for editing. No-ops when the control
 * isn't mounted (no raster layer exists yet).
 *
 * @param layerId - The raster/COG layer id to inspect.
 * @param enabled - True to start inspecting, false to stop.
 */
export function setRasterPixelInspect(layerId: string, enabled: boolean): void {
  if (!rasterControl) return;
  const manager = (rasterControl as unknown as RasterControlInternals)._layerManager;
  if (enabled) {
    rasterInspectPriorSelection = manager?.selectedId ?? null;
    rasterControl.selectRaster(layerId);
    rasterControl.setInspect(true);
  } else {
    rasterControl.setInspect(false);
    // Restore the prior selection only if inspect actually changed it.
    if (rasterInspectPriorSelection !== layerId) {
      rasterControl.selectRaster(rasterInspectPriorSelection);
    }
    rasterInspectPriorSelection = null;
  }
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
  const hasRasterLayers = useAppStore.getState().layers.some(isRasterControlStoreLayer);
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
    const panelCollapsed = rasterPanelCollapsedFromLayers(useAppStore.getState().layers);
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
          typeof layer.source.url === "string" && layer.source.url ? layer.source.url : undefined;
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
              console.error(`[GeoLibre] Failed to restore raster layer "${layer.name}"`, error);
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

async function ensureRasterControl(app: GeoLibreAppAPI): Promise<RasterControl | null> {
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
    // On web the control renders interleaved, which shares deck.gl's per-map
    // Deck with the other interleaved overlays; route it through the shared
    // overlay so it coexists with them (#1149). No-op on Tauri (overlaid).
    patchWebRasterOverlayFactory(app, rasterControl);
    // Patch the deck.gl render path so classified single-band rasters sample a
    // custom stepped colormap. Must run after addMapControl: the LayerManager
    // (and its _renderTileFor / _device) is created in the control's onAdd,
    // not its constructor.
    activateRasterClassification(rasterControl);
    hideRasterControl(rasterControl);
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

function createRasterControl(RasterControlClass: RasterControlConstructor): RasterControl {
  rasterControlInterleaved = !isTauriRuntime();
  const control = new RasterControlClass({
    className: "geolibre-raster-control",
    collapsed: true,
    // No prefilled URL: the input stays empty (the upstream control supplies
    // a generic COG-URL placeholder), and the sample COGs below are the
    // explicit, opt-in way to load a demonstration raster.
    sampleData: SAMPLE_RASTER_DATASETS,
    // The panel doubles as the Add Raster Layer dialog, so it stays open
    // until the user closes it; clicking the map must not collapse it.
    closeOnOutsideClick: false,
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
  // Free the per-layer classification GPU texture when its raster is dropped.
  // The control owns the File-backed bytes blob (source.objectUrl) and revokes
  // it on removeRaster, so there is nothing to clean up here for that.
  control.on("rasterremove", (event) => {
    if (!event.layerId) return;
    disposeRasterClassification(event.layerId);
    disposePaletteLegend(event.layerId);
  });
  // A striped (non-tiled) GeoTIFF cannot be streamed as tiles, so the upstream
  // fails the layer with a "not tiled" error. Offer the registered host handler
  // a chance to convert it to a COG instead of leaving the user with a blank,
  // errored layer. See opengeos/GeoLibre#789.
  control.on("error", (event) => {
    if (!event.layerId || !nonTiledRasterHandler) return;
    const layerId = event.layerId;
    if (nonTiledInFlight.has(layerId)) return;
    const info = control.getRaster(layerId);
    if (!info || !isNonTiledRasterError(info.error)) return;
    // Re-read the original bytes so the host can convert them to a COG: a local
    // file from its blob URL, a remote URL by fetching it whole. In the browser
    // the remote fetch needs the server to allow CORS, which it normally has
    // already (the panel range-fetched the header to detect "not tiled"); the
    // Tauri build can patch the header read to go through Tauri commands, so a
    // non-CORS URL can still reach here and the fetch below then fails -- it
    // degrades safely to the host's download-failed message, not a crash. See
    // opengeos/GeoLibre#916. The explicit per-kind check (rather than a file/else
    // ternary) means a future source kind without a fetchable URL bails here
    // instead of silently passing fetch(undefined), which would request the
    // current page.
    const bytesUrl =
      info.source.kind === "file"
        ? info.source.objectUrl
        : info.source.kind === "url"
          ? info.source.url
          : undefined;
    if (!bytesUrl) return;
    // A remote URL streams the whole file over the network when read; a local
    // file's blob URL resolves instantly. The host confirms before the download.
    const bytesAreRemote = info.source.kind === "url";
    const handler = nonTiledRasterHandler;
    nonTiledInFlight.add(layerId);
    // Invoke inside the promise chain so even a synchronous throw from the
    // handler still clears the in-flight guard via finally. Clears once handling
    // settles (converted, cancelled, or failed) so a later retry can prompt
    // again.
    void Promise.resolve()
      .then(() =>
        handler({
          layerId,
          name: info.name,
          bytesAreRemote,
          readBytes: async () => {
            // Only bound the remote download; a local blob URL resolves from
            // memory in microseconds, so a timeout timer there is pure overhead.
            const response = await fetch(
              bytesUrl,
              bytesAreRemote
                ? { signal: AbortSignal.timeout(NON_TILED_FETCH_TIMEOUT_MS) }
                : undefined,
            );
            if (!response.ok) {
              throw new Error(`Failed to read raster bytes: ${response.status}`);
            }
            return new Uint8Array(await response.arrayBuffer());
          },
          dismiss: () => {
            // removeRaster emits 'rasterremove', which syncs the removal into
            // the store and revokes any retained blob URL.
            control.removeRaster(layerId);
          },
        }),
      )
      .catch((error: unknown) => console.error("[GeoLibre] Non-tiled raster handler failed", error))
      .finally(() => nonTiledInFlight.delete(layerId));
  });
  // syncRasterLayersToStore re-reads getState().collapsed when these fire.
  // Safe: expand()/collapse() delegate to toggle(), which flips
  // _state.collapsed BEFORE emitting the event (re-verified against v0.11.1) --
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

async function patchTauriRasterOverlayFactory(control: RasterControl): Promise<void> {
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
    deps.loadGeoTIFF = async (url) => patchGeoTiffNumericNodata(await loadGeoTIFF(url));
    deps.geolibreTauriNodataPatched = true;
  }
}

/**
 * On web the raster control renders interleaved, so its deck.gl overlay reuses
 * deck.gl's single per-map Deck (`map.__deck`) -- and each interleaved overlay's
 * setProps overwrites that Deck's whole layer list with only its own layers, so
 * a raster and a Google/deckgl-viz overlay silently erase each other
 * (opengeos/GeoLibre#1149). This routes the control's interleaved layers through
 * the single shared deck overlay (./shared-deck-overlay.ts) instead: createOverlay
 * returns a lightweight proxy whose only job is to forward the control's setProps
 * into the shared overlay under the "raster" source, and the shared Deck's luma
 * device is fed to the control's onDeviceInitialized so its classification
 * colormap textures still allocate against the right GPU context.
 *
 * No-op on Tauri, which renders overlaid (a separate deck canvas that owns its
 * own Deck) and so never touches the shared interleaved Deck.
 *
 * @param app - The host application API (drives the shared overlay).
 * @param control - The mounted maplibre-gl-raster control.
 */
function patchWebRasterOverlayFactory(app: GeoLibreAppAPI, control: RasterControl): void {
  if (isTauriRuntime()) return;

  const manager = (control as unknown as RasterControlInternals)._layerManager;
  const deps = manager?._deps;
  if (!deps || deps.geolibreSharedOverlayPatched) return;

  deps.createOverlay = (_map, options) => {
    void ensureSharedDeckOverlay(app);
    // Feed the shared Deck's device to the control so its GPU colormap textures
    // allocate against the same context its COGLayers render in.
    rasterSharedOverlayDeviceUnsubscribe?.();
    rasterSharedOverlayDeviceUnsubscribe = onSharedDeckDevice((device) => {
      options.onDeviceInitialized(device);
    });
    return {
      setProps: (props: { layers?: unknown[] }) => {
        setSharedDeckLayers("raster", (props.layers ?? []) as Layer[]);
      },
    };
  };

  // maplibre-gl-raster (re-verified against v0.11.1) calls `_deps.removeOverlay(this._map, this._overlay)`
  // from its LayerManager teardown (after the last raster is removed / the
  // control is destroyed); re-verify this hook exists when bumping the
  // dependency. Even if a future version stopped calling it, the control still
  // pushes an empty layer list through the proxy's setProps first, so the
  // "raster" source is cleared regardless -- this only also drops the device
  // subscription.
  deps.removeOverlay = () => {
    rasterSharedOverlayDeviceUnsubscribe?.();
    rasterSharedOverlayDeviceUnsubscribe = null;
    setSharedDeckLayers("raster", []);
  };

  deps.geolibreSharedOverlayPatched = true;
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
    disposeAllPaletteLegends();
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

function applyRestoredRasterPanelState(control: RasterControl, panelCollapsed: boolean): void {
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
      isRasterControlStoreLayer(layer) && typeof layer.metadata.panelCollapsed === "boolean",
  )?.metadata.panelCollapsed;
  // Older projects did not persist this UI state. Keep them collapsed so
  // loading a raster project does not unexpectedly open the Add Data panel.
  return typeof panelCollapsed === "boolean" ? panelCollapsed : true;
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
