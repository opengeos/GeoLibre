// Helpers shared by several of the Components plugin's sub-controls.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type { CogLayerControlOptions, PrintTheme } from "maplibre-gl-components";
import type { GeoLibreMapControlPosition } from "../../types";

// Shared by the COG control (./cog) and the generic GeoTIFF overlay (./geotiff),
// which docks in the same corner.
export const cogRasterControlPosition: GeoLibreMapControlPosition = "top-left";

const GUI_PANEL_VIEWPORT_MARGIN = 16;
// Poll interval / cap for re-measuring a just-expanded GUI panel while its
// layout settles (see constrainGuiPanelToViewport).
const GUI_PANEL_SETTLE_INTERVAL_MS = 100;
const GUI_PANEL_SETTLE_MAX_TICKS = 20;

export function constrainGuiPanelToViewport(panelSelector: string): void {
  const apply = () => {
    const panel = document.querySelector<HTMLElement>(panelSelector);
    if (!panel) return;

    // Clear previously-applied inline constraints before re-measuring so
    // they don't suppress the overflow check on subsequent opens.
    panel.style.maxHeight = "";
    panel.style.maxWidth = "";

    const rect = panel.getBoundingClientRect();
    // Constrain to the map container, not the window: the status bar is a
    // sibling below the map, so the map's bottom edge already excludes it.
    // Measuring against window.innerHeight would let a tall panel (e.g. a
    // many-class legend) run under the status bar. Fall back to the window if
    // the panel isn't inside a map for some reason.
    const mapEl = panel.closest<HTMLElement>(".maplibregl-map");
    const mapRect = mapEl?.getBoundingClientRect();
    const viewportBottom = mapRect ? mapRect.bottom : window.innerHeight;
    const viewportRight = mapRect ? mapRect.right : window.innerWidth;

    const availableHeight = Math.floor(viewportBottom - rect.top - GUI_PANEL_VIEWPORT_MARGIN);
    if (availableHeight > 160 && rect.bottom > viewportBottom) {
      panel.style.maxHeight = `${availableHeight}px`;
    }

    const availableWidth = Math.floor(viewportRight - rect.left - GUI_PANEL_VIEWPORT_MARGIN);
    if (availableWidth > 220 && rect.right > viewportRight) {
      panel.style.maxWidth = `${availableWidth}px`;
    }
  };

  // Opening + populating + expanding a control in the same tick (as the "Create
  // legend from palette" flow does) leaves both the map container's bottom and
  // the panel's own top offset shifting for a few hundred ms -- the map sits at
  // the full window height and the panel starts higher until the status bar row
  // and control stack claim their space, sometimes plateauing at an
  // intermediate value before the final one. Measuring only on the first frame
  // would cap the panel too tall and let it slip under the status bar. Poll the
  // input geometry (panel top + map bottom) over a bounded window and re-cap
  // each time it actually changes, so the last change -- the real settle --
  // lands the cap on the final layout. Applying only on change keeps it from
  // flickering the scroll position while idle.
  let previousKey = "";
  let ticks = 0;
  const settle = () => {
    const panel = document.querySelector<HTMLElement>(panelSelector);
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const mapRect = panel.closest<HTMLElement>(".maplibregl-map")?.getBoundingClientRect();
    // apply() constrains width as well as height, so the settle key tracks both
    // axes: the panel's top-left corner and the map's bottom-right edge. A shift
    // on either axis re-caps.
    const key = [
      Math.round(rect.top),
      Math.round(rect.left),
      Math.round(mapRect?.bottom ?? window.innerHeight),
      Math.round(mapRect?.right ?? window.innerWidth),
    ].join(":");
    if (key !== previousKey) {
      previousKey = key;
      apply();
    }
    ticks += 1;
    if (ticks < GUI_PANEL_SETTLE_MAX_TICKS) {
      setTimeout(settle, GUI_PANEL_SETTLE_INTERVAL_MS);
    }
  };
  requestAnimationFrame(settle);
}

// The options of a COG/GeoTIFF raster add. Lives here because both the COG
// control (./cog) and its GeoTIFF fallback (./geotiff) take them.
export interface CogRasterLayerOptions {
  url: string;
  data?: ArrayBuffer;
  name?: string;
  bands?: string;
  colormap?: CogLayerControlOptions["defaultColormap"];
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number;
  opacity?: number;
  beforeLayerId?: string | null;
}

export type RasterBandValues =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

/**
 * Read the current GeoLibre theme from the `dark` class that the desktop app
 * toggles on the document element so the PrintControl panel can be forced to
 * match it (rather than following the system `prefers-color-scheme`, which may
 * differ from the in-app theme).
 */
export function resolveDocumentTheme(): PrintTheme {
  if (typeof document === "undefined") return "auto";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function isRemoteHttpUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

export function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const fileName = new URL(url).pathname.split("/").pop() ?? fallback;
    const base = fileName.replace(/\.[^.]+$/, "") || fallback;
    // Decode percent-encoding for display, so a name like `air%20temperature`
    // (e.g. a `local:` URL built from a file name with spaces/reserved chars)
    // shows as `air temperature`. Guard against malformed escapes.
    try {
      return decodeURIComponent(base);
    } catch {
      return base;
    }
  } catch {
    return fallback;
  }
}
