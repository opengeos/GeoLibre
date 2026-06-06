import { useAppStore } from "@geolibre/core";
import type { RasterControl } from "maplibre-gl-raster";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";
import {
  isRasterControlStoreLayer,
  runWithRasterStoreSyncSuspended,
  savedRasterState,
  syncRasterLayersToStore,
  unwireRasterStoreSync,
  wireRasterStoreSync,
} from "./raster-layer-sync";

const rasterControlPosition: GeoLibreMapControlPosition = "top-left";
const RASTER_PANEL_CLASS = "geolibre-raster-panel";
const DEFAULT_RASTER_URL =
  "https://data.source.coop/giswqs/opengeos/nlcd_2021_land_cover_30m.tif";

// These types mirror undocumented private members of RasterControl from
// maplibre-gl-raster (verified against v0.1.1). All access is optional (?.)
// so a rename in a future release degrades to a no-op rather than a crash --
// re-verify these names when bumping the dependency.
type RasterControlInternals = {
  _clickOutsideHandler?: ((event: MouseEvent) => void) | null;
  _panel?: HTMLElement;
};

type RasterControlConstructor = typeof RasterControl;

let rasterControlClassPromise: Promise<RasterControlConstructor> | null = null;
let rasterControl: RasterControl | null = null;
let rasterControlMounted = false;

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
    window.setTimeout(() => {
      showRasterControl(control);
      control.expand();
    }, 0);
  })();
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
    runWithRasterStoreSyncSuspended(() => {
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
          console.info(
            `[GeoLibre] Raster layer "${layer.name}" came from a local file and cannot be restored from the saved project.`,
          );
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
      syncRasterLayersToStore(control);
    });
  })();
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
  );
  return rasterControlClassPromise;
}

function createRasterControl(
  RasterControlClass: RasterControlConstructor,
): RasterControl {
  const control = new RasterControlClass({
    className: "geolibre-raster-control",
    collapsed: true,
    defaultUrl: DEFAULT_RASTER_URL,
    panelWidth: 380,
    title: "Add Raster Layer",
  });

  // deck.gl's COG tile traversal does not support MapLibre's globe view
  // ("TODO: implement getBoundingVolume in Globe view"), so adding a raster
  // switches the map to mercator, like the other deck.gl-backed plugins.
  control.on("rasteradd", () => ensureMercatorProjection(control.getMap()));
  for (const event of ["rasteradd", "rasterchange", "rasterremove"] as const) {
    control.on(event, () => syncRasterLayersToStore(control));
  }
  wireRasterStoreSync(control);
  patchRasterControlOnRemove(control);

  return control;
}

function patchRasterControlOnRemove(control: RasterControl): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    if (rasterControl !== control) return;
    unwireRasterStoreSync();
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
  const closeButton = panel?.querySelector<HTMLElement>(
    ".plugin-control-close",
  );
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hideRasterControl(control));
}
