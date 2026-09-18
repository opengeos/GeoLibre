import { activeLayerFilterExpression, compileQuickFilters } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ParseKeys } from "i18next";

/**
 * Pick the tooltip text for a filtered layer's funnel icon. A persistent
 * expression and Quick Filters can narrow the same layer at once, so name both
 * rather than letting the expression wording hide the controls doing half the
 * work. Shared by the authoring Layers panel and the read-only viewer rail,
 * which need the same wording for the same icon.
 */
export function layerFilteredHintKey(
  layer: Pick<GeoLibreLayer, "filterExpression" | "quickFilters">,
): ParseKeys {
  const hasExpression = activeLayerFilterExpression(layer) !== null;
  const hasQuickFilters = compileQuickFilters(layer.quickFilters) !== null;
  if (hasExpression && hasQuickFilters) return "selection.layerFilteredBothHint";
  return hasExpression ? "selection.layerFilteredHint" : "quickFilters.layerFilteredHint";
}
