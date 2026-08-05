import { VECTOR_COLOR_RAMPS, getVectorColorRamp, rgbToHex } from "@geolibre/core";
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
 * Always `#rrggbb`, whichever kind of ramp it came from. The renderer's sprite
 * sampler hands back `rgb(r, g, b)` strings, which read fine as CSS but parse to
 * black in every hex-based consumer (the custom-ramp editor, the NetCDF
 * colormapper); normalizing here keeps one contract for all of them.
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
          const hex = stops.map(normalizeRampColor);
          anchorCache.set(name, hex);
          return hex as readonly string[];
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

/**
 * Normalize one color stop to `#rrggbb`. The renderer's sprite sampler emits
 * `rgb(r, g, b)`; anything already hex (or unrecognized) is passed through.
 *
 * Exported so a caller holding colors from somewhere else (a saved project, a
 * plugin) can put them on the same footing before hex parsing.
 *
 * @param color - A sampled color stop.
 * @returns The color as `#rrggbb` when it could be read, else the input.
 */
export function normalizeRampColor(color: string): string {
  const match = /^rgba?\(\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)\s*,\s*([-+]?[\d.]+)/i.exec(color);
  if (!match) return color;
  // `[\d.]+` also matches junk like "." or "1..2", which `Number` reads as NaN
  // and `rgbToHex` would emit as "#NaN00…" — worse than leaving it alone, since
  // that then parses to black downstream.
  const channels = match.slice(1, 4).map(Number);
  if (!channels.every((value) => Number.isFinite(value))) return color;
  const channel = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));
  return rgbToHex({
    r: channel(channels[0]),
    g: channel(channels[1]),
    b: channel(channels[2]),
  });
}
