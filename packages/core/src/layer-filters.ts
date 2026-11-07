import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { FeatureCollection } from "geojson";
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

/** MapLibre's feature type codes, which `featureFilter` reads for `$type`. */
const FEATURE_TYPE_CODES: Record<string, 1 | 2 | 3> = {
  Point: 1,
  MultiPoint: 1,
  LineString: 2,
  MultiLineString: 2,
  Polygon: 3,
  MultiPolygon: 3,
};

/** The last filtered result per collection, so an unchanged filter reuses it. */
const filteredCollections = new WeakMap<object, { key: string; result: FeatureCollection }>();

/**
 * A layer's features narrowed by its authored filters (an expression, Quick
 * Filters, the floor picker), for a renderer that draws GeoJSON itself rather
 * than through a MapLibre layer filter, such as the deck.gl 3D Z-value path.
 *
 * The same collection comes back while no filter is active, and the same
 * filtered collection while the filter is unchanged, so caches keyed on the
 * collection keep hitting. A filter that does not compile leaves every
 * feature in, as MapLibre would refuse it rather than hide the layer.
 *
 * @param layer - The layer whose filters apply.
 * @param geojson - The features to filter.
 * @param zoom - The zoom a `["zoom"]` expression sees.
 * @returns The matching features.
 */
export function applyLayerFilters(
  layer: LayerFilterSource,
  geojson: FeatureCollection,
  zoom = 0,
): FeatureCollection {
  const filter = compileLayerFilters(layer);
  if (!filter) return geojson;
  const key = `${zoom}|${JSON.stringify(filter)}`;
  const cached = filteredCollections.get(geojson);
  if (cached?.key === key) return cached.result;
  let compiled: ReturnType<typeof featureFilter>;
  try {
    compiled = featureFilter(filter as never, "layers[0].filter");
  } catch {
    return geojson;
  }
  const result: FeatureCollection = {
    ...geojson,
    features: geojson.features.filter((feature) =>
      compiled.filter(
        { zoom } as never,
        {
          type: FEATURE_TYPE_CODES[feature.geometry?.type ?? ""] ?? 1,
          properties: feature.properties ?? {},
          ...(feature.id !== undefined ? { id: feature.id } : {}),
        } as never,
      ),
    ),
  };
  filteredCollections.set(geojson, { key, result });
  return result;
}
