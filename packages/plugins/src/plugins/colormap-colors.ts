import { VECTOR_COLOR_RAMPS, getVectorColorRamp } from "@geolibre/core";
import { sampleColormapStops } from "maplibre-gl-raster";

// Anchor stops sampled from the renderer's colormap sprite -- enough to
// interpolate down to any class count or a smooth preview gradient.
const ANCHOR_STOPS = 32;

const anchorCache = new Map<string, readonly string[]>();
const inflight = new Map<string, Promise<readonly string[] | null>>();

const BUILT_IN_RAMP_NAMES = new Set(VECTOR_COLOR_RAMPS.map((ramp) => ramp.value));

/** Whether GeoLibre ships exact JS anchor colors for this ramp (its curated set). */
function isBuiltInRamp(name: string): boolean {
  return BUILT_IN_RAMP_NAMES.has(name);
}

/**
 * Anchor colors for a colormap, used to build the classified stepped texture
 * and the Style-panel preview. Built-in GeoLibre ramps return their exact JS
 * colors synchronously; any other (sprite) colormap returns its cached sampled
 * colors, or null until {@link warmColormapColors} has sampled it.
 *
 * @param name - The colormap name (a `VECTOR_COLOR_RAMPS` value or sprite key).
 * @returns The anchor colors, or null when a sprite colormap is not yet sampled.
 */
export function colormapColors(name: string): readonly string[] | null {
  if (isBuiltInRamp(name)) return getVectorColorRamp(name).colors;
  return anchorCache.get(name) ?? null;
}

/**
 * Samples (once, then caches) a sprite colormap's colors so a later
 * {@link colormapColors} call resolves synchronously. Resolves immediately for
 * built-in ramps, and yields null when sampling is unavailable (e.g. headless)
 * or the name is unknown.
 *
 * @param name - The colormap name.
 * @returns The resolved colors, or null on failure.
 */
export function warmColormapColors(name: string): Promise<readonly string[] | null> {
  const known = colormapColors(name);
  if (known) return Promise.resolve(known);
  let pending = inflight.get(name);
  if (!pending) {
    pending = sampleColormapStops(name, ANCHOR_STOPS, false)
      .then((stops) => {
        // Clear the in-flight marker only after the cache is written, so a
        // re-entrant call in the same microtask can't miss both.
        inflight.delete(name);
        if (stops.length >= 2) {
          anchorCache.set(name, stops);
          return stops as readonly string[];
        }
        return null;
      })
      .catch(() => {
        inflight.delete(name);
        return null;
      });
    inflight.set(name, pending);
  }
  return pending;
}
