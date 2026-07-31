import { styleValue, useAppStore } from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type {
  RasterControl,
  RasterControlEventHandler,
  RasterLayerState,
  RasterSampleDataset,
  RenderEngine,
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
  rememberLocalRasterPath,
  rendersNativeMapLibreLayer,
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

// The rendering backend rasters are decoded with unless the user picks another
// one in the panel. `cog-tiler-wasm` feeds a native MapLibre raster source/layer,
// so ordering is the map's own in both the web and desktop builds. Tauri local
// files are exposed through its range-capable asset protocol; do not switch the
// desktop default back to the GPU engine to work around local-file stalls, since
// that would only mask an asset-protocol/read-path regression.
//
// Trade-off: the WASM tiler renders from its own built-in colormaps, so the
// GPU-only symbology GeoLibre injects into the deck.gl pipeline -- "Classify
// into discrete classes" and custom color ramps (see raster-symbology-texture)
// -- does not apply while this engine is active. Users who need it can switch
// the panel's Rendering engine back to maplibre-gl-raster (GPU).
const DEFAULT_RASTER_ENGINE: RenderEngine = "cog-tiler-wasm";

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
  {
    // A STAC FeatureCollection of 2023 North Dakota NAIP scenes, whose assets
    // resolve to COGs on Azure blob storage: exercises maplibre-gl-raster's
    // STAC mosaic support (v0.12.0+), which stitches the scenes at read time
    // rather than requiring a prebuilt VRT or MosaicJSON.
    label: "NAIP STAC mosaic (North Dakota)",
    url: "https://data.source.coop/giswqs/opengeos/naip_nd_2023_stac.json",
    attribution: "USDA Farm Service Agency (FSA)",
  },
];

// This type mirrors undocumented private members of RasterControl from
// maplibre-gl-raster (re-verified against v0.12.0). All access is optional (?.)
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
  _device?: unknown;
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
// The host API the mounted control belongs to, so panel chrome wired outside a
// call that carries it (the browse-button interception) can still add layers.
let rasterHostApp: GeoLibreAppAPI | null = null;
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

/**
 * Reads a raster off the local filesystem, given the absolute path a previous
 * session recorded. Only the desktop host can implement this; in the browser
 * there is no path and none is registered.
 */
export type LocalRasterFileReader = (path: string) => Promise<File | string>;

/** A raster the user picked from a native file dialog: its bytes and its path. */
export interface PickedLocalRaster {
  file: File | string;
  path: string;
}

/**
 * Opens a native "choose a raster file" dialog. Registered by the desktop host
 * so the panel's own browse button yields files whose paths GeoLibre can record
 * (a webview `<input type="file">` gives a `File` with no path, which is why a
 * panel-opened raster used to be lost on project reload). Resolves to an empty
 * array when the user cancels.
 */
export type LocalRasterPicker = () => Promise<PickedLocalRaster[]>;

let localRasterFileReader: LocalRasterFileReader | null = null;
let localRasterPicker: LocalRasterPicker | null = null;

/**
 * Register (or clear, with `null`) the reader that reloads a File-backed raster
 * from its recorded path when a saved project is reopened. Without one, such a
 * raster is dropped on restore with a notice, as before.
 *
 * @param reader - The reader, or `null` to unregister.
 */
export function setLocalRasterFileReader(reader: LocalRasterFileReader | null): void {
  localRasterFileReader = reader;
}

/**
 * Register (or clear, with `null`) the native file picker the raster panel's
 * browse button should use instead of its built-in `<input type="file">`.
 *
 * @param picker - The picker, or `null` to unregister.
 */
export function setLocalRasterPicker(picker: LocalRasterPicker | null): void {
  localRasterPicker = picker;
}

/** Whether a raster load error is the upstream "striped, not tiled" failure.
 * maplibre-gl-raster (re-verified against v0.12.0) rejects non-tiled GeoTIFFs with a message
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
        wireRasterBrowseButton(control);
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
 * @param options - Optional display name for the layer, and, when the host read
 *   the File off disk, the absolute path it came from so a saved project can
 *   reload it.
 */
export async function addRasterToMap(
  app: GeoLibreAppAPI,
  source: string | File,
  options: {
    name?: string;
    localPath?: string;
    defaults?: RasterVisualizationDefaults;
    /** Initial renderer state supplied by programmatic COG callers. */
    state?: Partial<RasterLayerState>;
    /** Existing map style layer beneath which the raster is inserted. */
    beforeId?: string;
    /** Whether to fit the map to the raster after loading. Defaults to true. */
    zoomTo?: boolean;
  } = {},
): Promise<string> {
  const control = await ensureRasterControl(app);
  if (!control) {
    throw new Error("The raster control could not be initialized.");
  }
  // For File-backed rasters the control retains the original bytes behind a
  // blob URL (source.objectUrl), which the store sync surfaces as
  // metadata.localBytesUrl so in-browser tools (the WASM Whitebox runner) can
  // read the data back. No extra bookkeeping is needed here.
  // Before the add, so the layer is decoded by the chosen engine rather than
  // being rendered once and swapped.
  if (options.defaults?.engine && control.getEngine() !== options.defaults.engine) {
    control.setEngine(options.defaults.engine);
  }
  // A project/basemap load can replace the MapLibre style after the control's
  // one-time mount warm-up. On Tauri/WebKitGTK that leaves the WASM backend
  // waiting for an accelerated canvas until the user manually switches to the
  // GPU engine and back. Repeat that inexpensive toggle at the add boundary,
  // against the current style, before the COG source starts opening.
  await warmTauriWasmEngine(control);
  const id = await control.addRaster(source, {
    name: options.name,
    zoomTo: options.zoomTo ?? true,
    // Safe to pass before the band count is known: the renderer applies a
    // colormap only in single-band mode and ignores it otherwise.
    ...(options.state || options.defaults?.colormap
      ? {
          state: {
            ...(options.defaults?.colormap ? { colormap: options.defaults.colormap } : {}),
            ...options.state,
          },
        }
      : {}),
    ...(options.beforeId ? { beforeId: options.beforeId } : {}),
  });
  applyRgbBandDefaults(control, id, options.defaults?.rgbBands);
  if (options.localPath) {
    // The id only exists once addRaster resolves, which is after the rasteradd
    // sync has already written the store layer -- so record the path and re-run
    // the (diffing, idempotent) sync to put it on the layer.
    rememberLocalRasterPath(id, options.localPath);
    syncRasterLayersToStoreForRuntime(control);
  }
  return id;
}

/**
 * Mount and warm the raster control without opening its panel.
 *
 * Desktop calls this as soon as a native file drag enters the window, so the
 * control and its selected rendering backend can initialize while the user is
 * still positioning the drop. Without that head start, drag-and-drop pays the
 * full lazy-import/setup cost after release; the Add Raster Layer picker hides
 * the same work behind the native file dialog and therefore feels immediate.
 *
 * Safe to call repeatedly: {@link ensureRasterControl} reuses the mounted
 * control and the module-level import promises.
 *
 * @param app - The GeoLibre app API for the current map.
 */
export async function prepareRasterControl(app: GeoLibreAppAPI): Promise<void> {
  await ensureRasterControl(app);
}

/**
 * How a raster should look when it is first added, for callers that let the
 * user set a house style (the Hugging Face browser's Settings tab).
 *
 * Split in two because a raster only ever honours one of them: an RGB band
 * triple applies to multiband imagery, a colormap to single-band.
 */
export interface RasterVisualizationDefaults {
  /** 1-indexed [R, G, B] to select when the image has three or more bands. */
  rgbBands?: [number, number, number];
  /** Colormap name for single-band imagery. */
  colormap?: string;
  /**
   * Which renderer decodes the imagery.
   *
   * Unlike the two above, this is **not** per layer: the control holds one
   * engine for every raster it manages, so setting it here re-renders the
   * rasters already on the map too. Callers that expose it should say so.
   */
  engine?: RasterRenderEngine;
}

/**
 * The renderers the raster control can decode with:
 * `maplibre-gl-raster` reads the COG on the GPU via deck.gl,
 * `cog-tiler-wasm` decodes in a WebAssembly tiler,
 * `titiler` delegates to a TiTiler server.
 */
export type RasterRenderEngine = RenderEngine;

/**
 * Applies a default RGB band triple once the header has loaded.
 *
 * Done after the add rather than through `addRaster`'s `state` because the
 * choice depends on the band count, which is only known once the GeoTIFF
 * header is read — and `addRaster` resolves at exactly that point. Forcing
 * `mode: "rgb"` up front would ask a single-band image for bands it does not
 * have.
 */
function applyRgbBandDefaults(
  control: RasterControl,
  id: string,
  rgbBands: [number, number, number] | undefined,
): void {
  if (!rgbBands) return;
  const bandCount = control.getRasters().find((raster) => raster.id === id)?.bandCount ?? 0;
  // Single-band and two-band images render through the colormap instead.
  if (bandCount < 3) return;
  const bands = rgbBands.map((band) =>
    Math.min(Math.max(Math.round(band), 1), bandCount),
  ) as number[];
  control.setRasterState(id, { mode: "rgb", bands });
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
  rasterHostApp = null;
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
 * Replays rasters from the loaded project into the control and drops control
 * rasters the project does not contain. Called by the desktop shell whenever a
 * project is loaded or the map is reinitialised, mirroring
 * restoreThreeDTilesLayers.
 *
 * URL-backed rasters replay from `source.url`. A raster that was opened from a
 * local file replays from `metadata.localFilePath` when the host registered a
 * reader (desktop) and the file is still there; otherwise -- the browser, a
 * moved file, a project carried to another machine -- its panel entry is
 * removed with a notice, as before.
 *
 * @param app - The GeoLibre app API.
 */
export function restoreRasterLayers(app: GeoLibreAppAPI): void {
  const hasRasterLayers = useAppStore.getState().layers.some(isRasterControlStoreLayer);
  if (!hasRasterLayers && !rasterControl) return;

  void (async () => {
    const control = await ensureRasterControl(app);
    if (!control) return;

    // Read every local raster off disk BEFORE the suspension block below, so
    // the replay stays synchronous. An await inside it would end the window
    // early, and the next control event would then prune the not-yet-replayed
    // layers out of the store.
    const localFiles = await readLocalRasterFiles(control);

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
        // A local file that was re-read above replays from its bytes; the
        // control re-derives its own blob URL from the File, as on a fresh add.
        const source = url ?? localFiles.get(layer.id);
        if (!source) {
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
            .addRaster(source, {
              id: layer.id,
              name: layer.name,
              state: {
                ...savedRasterState(layer),
                opacity: layer.opacity,
                visible: layer.visible,
                // The zoom range lives on layer.style (the shared Style-panel
                // control), not in metadata.rasterState, so it is replayed here
                // to survive a project reload / map reinitialisation.
                minZoom: styleValue(layer.style, "minZoom"),
                maxZoom: styleValue(layer.style, "maxZoom"),
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

/**
 * Re-reads every project raster that carries a recorded local path and is not
 * already loaded in the control, keyed by layer id. Also re-registers each path
 * so the raster stays restorable when the project is saved again.
 *
 * Resolves to an empty map in the browser (no reader is registered) and skips
 * any file that has since been moved or deleted -- the caller then falls back
 * to dropping that layer with a notice.
 *
 * @param control - The mounted raster control.
 * @returns The re-read files, by store layer id.
 */
async function readLocalRasterFiles(control: RasterControl): Promise<Map<string, File | string>> {
  const files = new Map<string, File | string>();
  const reader = localRasterFileReader;
  if (!reader) return files;

  for (const layer of useAppStore.getState().layers) {
    if (!isRasterControlStoreLayer(layer)) continue;
    if (control.getRaster(layer.id)) continue;
    if (typeof layer.source.url === "string" && layer.source.url) continue;
    const path = layer.metadata.localFilePath;
    if (typeof path !== "string" || !path) continue;

    try {
      files.set(layer.id, await reader(path));
      // The in-memory registry does not survive a project reload, so re-seed it
      // from the project file; otherwise the next save would drop the path and
      // the raster would become unrestorable again.
      rememberLocalRasterPath(layer.id, path);
    } catch (error) {
      console.warn(
        `[GeoLibre] Could not re-read raster layer "${layer.name}" from "${path}".`,
        error,
      );
    }
  }
  return files;
}

async function ensureRasterControl(app: GeoLibreAppAPI): Promise<RasterControl | null> {
  const RasterControlClass = await getRasterControlClass();

  rasterControl ??= createRasterControl(RasterControlClass);

  if (!rasterControlMounted) {
    const added = app.addMapControl(rasterControl, rasterControlPosition);
    if (!added) {
      unwireRasterStoreSync();
      rasterControl = null;
      rasterHostApp = null;
      return null;
    }
    rasterControlMounted = true;
    rasterHostApp = app;
    // The control mounts hidden: project restore must not surface a map
    // button the user never asked for. openRasterLayerPanel shows it.
    await patchTauriRasterOverlayFactory(rasterControl);
    await warmTauriWasmEngine(rasterControl);
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
    wireRasterBrowseButton(rasterControl);
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
    engine: DEFAULT_RASTER_ENGINE,
    // Only consulted while the deck.gl engine is selected; kept accurate so
    // switching the panel back to maplibre-gl-raster still gets the overlay
    // mode the runtime supports.
    interleaved: rasterControlInterleaved,
    panelWidth: 380,
    title: "Add Raster Layer",
  });

  // deck.gl's COG tile traversal does not support MapLibre's globe view
  // ("TODO: implement getBoundingVolume in Globe view"), so adding a raster
  // switches the map to mercator, like the other deck.gl-backed plugins.
  // Only the deck.gl engine needs this: the WASM and TiTiler engines render
  // through a native MapLibre raster layer, which draws on the globe just like
  // any other raster source, so forcing mercator there would drop the user out
  // of globe view for no reason.
  // Also on rasterchange, which is what setEngine emits: switching the panel
  // from the WASM engine back to the deck.gl one has to force mercator for the
  // rasters already on the map, not just for the next one added.
  for (const event of ["rasteradd", "rasterchange"] as const) {
    control.on(event, () => {
      if (rendersNativeMapLibreLayer(control.getEngine())) return;
      if (control.getRasters().length === 0) return;
      ensureMercatorProjection(control.getMap());
    });
  }
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
    rememberLocalRasterPath(event.layerId, undefined);
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
  // _state.collapsed BEFORE emitting the event (re-verified against v0.12.0) --
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
    // Read live rather than captured: the user can switch the backend from the
    // panel at any time, and the store layer's native-layer bookkeeping differs
    // per engine (see createRasterStoreLayer).
    engine: control.getEngine(),
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
 * Initialize Tauri's raster GPU canvas once before starting the WASM backend.
 *
 * WebKitGTK on native Wayland can leave concurrent WebAssembly initialization
 * pending until an accelerated canvas has created its device. The visible
 * symptom is a fully loaded raster entry whose WASM source never opens; choosing
 * the GPU engine and then switching back immediately releases it. Perform that
 * same one-time initialization while the control is still hidden, then restore
 * the requested WASM default before any raster is added.
 */
async function warmTauriWasmEngine(control: RasterControl): Promise<void> {
  if (!isTauriRuntime() || control.getEngine() !== "cog-tiler-wasm") return;

  const manager = (control as unknown as RasterControlInternals)._layerManager;
  if (!manager) return;

  try {
    control.setEngine("maplibre-gl-raster");
    const deadline = performance.now() + 2_000;
    while (!manager._device && performance.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
  } finally {
    control.setEngine("cog-tiler-wasm");
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

  // maplibre-gl-raster (re-verified against v0.12.0) calls `_deps.removeOverlay(this._map, this._overlay)`
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
    rasterHostApp = null;
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
      wireRasterBrowseButton(control);
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

// The panel's "click to browse" drop zone opens a hidden <input type="file">,
// which in a webview yields a File with no filesystem path -- so a raster added
// that way could never be reloaded from a saved project (issue #1463). When the
// host registered a native picker (desktop), route the browse action through it
// instead so the path is recorded.
//
// Listens on the panel in the CAPTURE phase rather than on the drop zone: a
// capturing ancestor listener always runs before the target's own listeners,
// whereas at the target both phases run in registration order -- and upstream
// registered first. stopPropagation then keeps the event from reaching the drop
// zone's handler at all. The selectors mirror maplibre-gl-raster's rendered
// panel (re-verified against v0.14.0); if `.mlr-drop-zone` is renamed the
// listener simply never matches and the built-in input takes over again.
function wireRasterBrowseButton(control: RasterControl): void {
  const panel = (control as unknown as RasterControlInternals)._panel;
  if (!panel || panel.dataset.geolibreBrowseWired === "true") return;
  panel.dataset.geolibreBrowseWired = "true";

  const intercept = (event: Event): boolean => {
    if (!localRasterPicker) return false;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".mlr-drop-zone")) return false;
    event.preventDefault();
    event.stopPropagation();
    void openLocalRasterPicker();
    return true;
  };

  panel.addEventListener("click", intercept, true);
  // The drop zone is keyboard-operable (role="button"); Enter/Space go through
  // the same hidden input, so they need the same interception.
  panel.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      intercept(event);
    },
    true,
  );
}

/**
 * Opens the host's native raster picker and adds every pick, recording the
 * filesystem path each one came from. A cancelled dialog resolves to an empty
 * list and adds nothing.
 */
async function openLocalRasterPicker(): Promise<void> {
  const picker = localRasterPicker;
  const app = rasterHostApp;
  if (!picker || !app) return;
  try {
    for (const picked of await picker()) {
      // Sequential, matching the drag-and-drop path: each add awaits the
      // GeoTIFF header, and the control zooms to the raster it just added.
      // Each add is isolated so one unreadable pick does not silently discard
      // the rest of a multi-file selection.
      try {
        await addRasterToMap(app, picked.file, {
          name:
            picked.file instanceof File
              ? picked.file.name
              : picked.path.split(/[\\/]/).pop() || picked.path,
          localPath: picked.path,
        });
      } catch (error) {
        const name =
          picked.file instanceof File
            ? picked.file.name
            : picked.path.split(/[\\/]/).pop() || picked.path;
        console.error(`[GeoLibre] Failed to add the raster "${name}"`, error);
      }
    }
  } catch (error) {
    console.error("[GeoLibre] Failed to add a raster from the file picker", error);
  }
}
