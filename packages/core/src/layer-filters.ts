import type { GeoLibreLayer } from "./types";
import { compileLevelFilter } from "./level-filter";
import { compileQuickFilters } from "./quick-filters";

/** The layer fields needed to inspect project-authored feature filters. */
type LayerFilterSource = Pick<GeoLibreLayer, "filterExpression" | "quickFilters"> &
  Partial<Pick<GeoLibreLayer, "levelFilter">>;

/**
 * Return a layer's persisted expression filter when it has a usable array
 * shape, otherwise return null.
 *
 * @param layer - The layer whose expression filter should be read.
 * @returns The active expression filter, or null when none is configured.
 */
export function activeLayerFilterExpression(layer: LayerFilterSource): unknown[] | null {
  const expression = layer.filterExpression;
  return Array.isArray(expression) && expression.length > 0 ? expression : null;
}

/**
 * Compile all project-authored filters for a layer into one MapLibre boolean
 * expression. An explicit expression, Quick Filter controls and the floor
 * picker's choice narrow the layer together.
 *
 * @param layer - The layer whose authored filters should be composed.
 * @returns A MapLibre filter expression, or null when no authored filter is active.
 */
export function compileLayerFilters(layer: LayerFilterSource): unknown[] | null {
  const filters = [
    activeLayerFilterExpression(layer),
    compileQuickFilters(layer.quickFilters),
    compileLevelFilter(layer.levelFilter),
  ].filter((filter): filter is unknown[] => filter !== null);
  if (filters.length === 0) return null;
  return filters.length === 1 ? filters[0] : ["all", ...filters];
}

/**
 * Whether a project-authored expression or Quick Filter currently narrows a
 * layer. This drives the filtered indicator and clear action in the layer UI.
 *
 * The floor picker's choice is left out on purpose: the picker is its own
 * on-map control that shows and resets the choice for every linked layer at
 * once, so a per-layer "clear filters" action must not desynchronize it.
 * Renderers still apply it through {@link compileLayerFilters}.
 *
 * @param layer - The layer to inspect.
 * @returns True when at least one persisted expression or Quick Filter is active.
 */
export function hasActiveLayerFilter(layer: LayerFilterSource): boolean {
  return (
    activeLayerFilterExpression(layer) !== null || compileQuickFilters(layer.quickFilters) !== null
  );
}
