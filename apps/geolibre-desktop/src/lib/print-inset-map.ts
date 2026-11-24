/**
 * Render the Print Layout's overview / inset locator map (GH #3530).
 *
 * The inset is drawn by a short-lived, hidden MapLibre map with its own
 * basemap and camera, so composing it never moves the user's live map or
 * changes its basemap. The result is a plain canvas the layout composes like
 * the main capture; the main extent rectangle is drawn on top at layout time
 * (see `drawInsetMap` in `print-layout.ts`), so it stays crisp at any export
 * resolution.
 */

import { Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { OPENFREEMAP_BASEMAPS, type PrintLayoutInsetBasemap } from "@geolibre/core";
import type { MercatorView } from "./print-layout-cartography";

/** Maximum CSS side of the inset; its other side follows the frame's aspect. */
export const INSET_RENDER_MAX_DIMENSION = 480;
/** Device pixels per CSS pixel of the rendered inset, for print sharpness. */
const INSET_PIXEL_RATIO = 2;
/** Give up waiting for tiles after this long and keep whatever has drawn. */
const INSET_RENDER_TIMEOUT_MS = 15_000;

/** The OpenStreetMap raster basemap, for an inset without vector styling. */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

/**
 * The MapLibre style an inset basemap id draws with.
 *
 * @param basemap - The stored basemap id.
 * @returns A style URL, or an inline style for the raster OpenStreetMap one.
 */
export function insetBasemapStyle(basemap: PrintLayoutInsetBasemap): string | StyleSpecification {
  if (basemap === "osm") return OSM_STYLE;
  const match = OPENFREEMAP_BASEMAPS.find((b) => b.id === basemap);
  return match?.styleUrl ?? OPENFREEMAP_BASEMAPS[0].styleUrl;
}

/**
 * Render a Web Mercator view of a basemap into a canvas.
 *
 * @param basemap - Which basemap to draw.
 * @param view - The camera and CSS size to render.
 * @param signal - Aborts the render (the hidden map is torn down).
 * @returns A canvas of `view.width x view.height` CSS pixels at a 2x ratio.
 */
export async function renderInsetMap(
  basemap: PrintLayoutInsetBasemap,
  view: MercatorView,
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  if (signal?.aborted) throw new DOMException("Inset render aborted", "AbortError");
  const container = document.createElement("div");
  // Off screen but laid out, so MapLibre sizes its canvas from the container.
  Object.assign(container.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${Math.round(view.width)}px`,
    height: `${Math.round(view.height)}px`,
    pointerEvents: "none",
    visibility: "hidden",
  });
  document.body.appendChild(container);
  let map: MapLibreMap | null = null;
  try {
    map = new MapLibreMap({
      container,
      style: insetBasemapStyle(basemap),
      center: view.center,
      zoom: view.zoom,
      interactive: false,
      attributionControl: false,
      pixelRatio: INSET_PIXEL_RATIO,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    const live = map;
    await new Promise<void>((resolve, reject) => {
      let hasTile = false;
      const loaded = (event: import("maplibre-gl").MapSourceDataEvent) => {
        if (event.tile?.state === "loaded") hasTile = true;
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        live.off("idle", finish);
        live.off("sourcedata", loaded);
        live.off("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      const finish = () => {
        cleanup();
        if (hasTile) resolve();
        else reject(new Error("The overview basemap did not load any imagery."));
      };
      const aborted = () => {
        cleanup();
        reject(new DOMException("Inset render aborted", "AbortError"));
      };
      const failed = (
        event: import("maplibre-gl").ErrorEvent & { sourceId?: string; tile?: unknown },
      ) => {
        // Tile/source failures may leave usable imagery. A style-level
        // failure before style load cannot recover without another attempt.
        if (!live.isStyleLoaded() && !event.sourceId && !event.tile) {
          cleanup();
          reject(event.error);
        }
      };
      const timer = window.setTimeout(finish, INSET_RENDER_TIMEOUT_MS);
      live.on("sourcedata", loaded);
      live.on("error", failed);
      live.once("idle", finish);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    live.redraw();
    const source = live.getCanvas();
    const out = document.createElement("canvas");
    out.width = source.width;
    out.height = source.height;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("Could not create the inset canvas");
    ctx.drawImage(source, 0, 0);
    return out;
  } finally {
    map?.remove();
    container.remove();
  }
}
