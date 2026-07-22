import type { GeoLibreLayer } from "@geolibre/core";
import { layerSwatch } from "../../lib/layer-swatch";

/**
 * The per-row symbology symbol in the Layers panel: a colored dot (point), line
 * (line), or square (polygon / raster / service) reflecting the layer's
 * geometry and its first symbology color. Dimmed for hidden layers so the panel
 * reads at a glance, matching the on-map legend's swatches.
 */
export function LayerSwatchIcon({ layer }: { layer: GeoLibreLayer }): React.ReactElement {
  const { color, shape } = layerSwatch(layer);
  const dim = layer.visible ? "" : "opacity-40";

  if (shape === "circle") {
    return (
      <span
        aria-hidden
        className={`h-3 w-3 shrink-0 rounded-full border border-black/25 dark:border-white/25 ${dim}`}
        style={{ backgroundColor: color }}
      />
    );
  }
  if (shape === "line") {
    return (
      <span aria-hidden className={`flex h-3 w-3 shrink-0 items-center justify-center ${dim}`}>
        <span className="h-[3px] w-3 rounded-full" style={{ backgroundColor: color }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`h-3 w-3 shrink-0 rounded-sm border border-black/25 dark:border-white/25 ${dim}`}
      style={{ backgroundColor: color }}
    />
  );
}
