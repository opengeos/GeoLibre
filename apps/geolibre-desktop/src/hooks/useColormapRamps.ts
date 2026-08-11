import { colormapColors, warmColormapColors } from "@geolibre/plugins";
import type { ColorRampOption } from "@geolibre/ui";
import { COLORMAP_OPTIONS } from "maplibre-gl-raster";
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
 * @returns One option per colormap, sorted by label.
 */
export function useColormapRamps(): ColorRampOption[] {
  const [rampColors, setRampColors] = useState<Record<string, readonly string[]>>(() => {
    const seed: Record<string, readonly string[]> = {};
    for (const colormap of SORTED_COLORMAPS) {
      const known = colormapColors(colormap.name);
      if (known) seed[colormap.name] = known;
    }
    return seed;
  });

  useEffect(() => {
    let cancelled = false;
    for (const colormap of SORTED_COLORMAPS) {
      // Built-in ramps were already seeded synchronously above.
      if (colormapColors(colormap.name)) continue;
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
  }, []);

  return SORTED_COLORMAPS.map((colormap) => ({
    value: colormap.name,
    label: colormap.label,
    colors: rampColors[colormap.name] ?? [],
  }));
}
