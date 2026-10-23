import { colormapColors, warmColormapColors } from "@geolibre/plugins";
import type { ColorRampOption } from "@geolibre/ui";
import { COLORMAP_OPTIONS } from "../lib/raster-picker-mirror";
import { useEffect, useState } from "react";

/**
 * Every renderer colormap (the same list the maplibre-gl-raster panel offers),
 * sorted by display label for a dropdown. Labels use matplotlib casing
 * (RdBu, YlOrBr, ...); the value is the lowercase colormap key. A fixed "en"
 * locale keeps the order identical across browsers.
 */
export const SORTED_COLORMAPS = [...COLORMAP_OPTIONS].sort((a, b) =>
  a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
);

/**
 * The full colormap catalogue as {@link ColorRampOption}s, each carrying its own
 * colors so a picker can show a gradient swatch beside every name.
 *
 * GeoLibre's own curated ramps resolve synchronously; the rest are sampled once
 * from the renderer's colormap sprite and fill in as they arrive. The sampled
 * colors live in a module-level cache inside `colormapColors`, so a remount
 * seeds straight from it rather than re-sampling.
 *
 * Shared so every colormap picker offers the *same* list. The Add NetCDF dialog
 * previously carried its own short list, which left it offering a fraction of
 * what the Style panel's Raster symbology did for the same kind of data.
 *
 * Sampling imports maplibre-gl-raster and decodes its colormap sprite, so a
 * picker that is mounted while hidden (a closed dialog) passes `enabled: false`
 * and samples only once it is shown. That keeps the raster library off the
 * startup path.
 *
 * @param enabled - Whether to sample the non-built-in ramps now. Defaults to true.
 * @returns One option per colormap, sorted by label.
 */
export function useColormapRamps(enabled = true): ColorRampOption[] {
  const [rampColors, setRampColors] = useState<Record<string, readonly string[]>>(() => {
    const seed: Record<string, readonly string[]> = {};
    for (const colormap of SORTED_COLORMAPS) {
      const known = colormapColors(colormap.name);
      if (known) seed[colormap.name] = known;
    }
    return seed;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    for (const colormap of SORTED_COLORMAPS) {
      // Already known: a built-in ramp, or one another picker sampled into the
      // shared cache after this hook's state was seeded (it may have stayed
      // disabled until now). Sync it into state rather than skipping it.
      const known = colormapColors(colormap.name);
      if (known) {
        setRampColors((prev) => (prev[colormap.name] ? prev : { ...prev, [colormap.name]: known }));
        continue;
      }
      void warmColormapColors(colormap.name).then((colors) => {
        if (cancelled || !colors) return;
        setRampColors((prev) =>
          prev[colormap.name] ? prev : { ...prev, [colormap.name]: colors },
        );
      });
    }
    return () => {
      // Only guards state: in-flight warmColormapColors fetches keep populating
      // the module-level cache, so a remount picks them up synchronously via the
      // colormapColors() seed above instead of re-fetching.
      cancelled = true;
    };
  }, [enabled]);

  return SORTED_COLORMAPS.map((colormap) => ({
    value: colormap.name,
    label: colormap.label,
    colors: rampColors[colormap.name] ?? [],
  }));
}
