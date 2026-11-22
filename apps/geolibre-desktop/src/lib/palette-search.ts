/**
 * The command palette's search results beyond commands: the layers whose names
 * match the query, the features whose attribute values do (through the same
 * capped scan as the Layers panel search box, `feature-search.ts`), and a last
 * "Search places" row that geocodes the query only when it is picked.
 *
 * Each result is a {@link RankedCommand}, so the palette lists, ranks and runs
 * it the same way as a command. Kept out of the React component so the
 * matching and the ranking can be unit tested.
 */

import type { GeoLibreLayer, LayerGroup } from "@geolibre/core";
import type { LucideIcon } from "lucide-react";
import type { Command, CommandRank, RankedCommand } from "./commands";
import { sortRanked } from "./commands";
import {
  type FeatureSearchMatch,
  type FeatureSearchOptions,
  searchLayerFeatures,
} from "./feature-search";
import { groupRankedCommands } from "./palette-rows";

/** Layers listed at most, so a broad query cannot push everything else away. */
export const MAX_LAYER_RESULTS = 8;

/** Don't offer a place search for a query shorter than this. */
export const MIN_PLACE_QUERY_LENGTH = 2;

/** What picking each kind of result does. */
export interface PaletteSearchActions {
  /** Select the layer and frame it. */
  openLayer: (layerId: string) => void;
  /** Select the feature and frame it. */
  openFeature: (match: FeatureSearchMatch) => void;
  /** Geocode the query and move the map to the closest match. */
  searchPlace: (query: string) => void;
}

/** The translated labels the results carry. */
export interface PaletteSearchLabels {
  /** Group heading over the matching layers. */
  layersGroup: string;
  /** Group heading over one layer's matching features. */
  featuresGroup: (layerName: string, partial: boolean) => string;
  /** Group heading over the place search row. */
  placesGroup: string;
  /** Title of the place search row. */
  searchPlace: (query: string) => string;
}

/** Icons for the result rows, injected so this module stays free of React. */
export interface PaletteSearchIcons {
  layer?: LucideIcon;
  feature?: LucideIcon;
  place?: LucideIcon;
}

export interface PaletteSearchOptions {
  actions: PaletteSearchActions;
  labels: PaletteSearchLabels;
  icons?: PaletteSearchIcons;
  /** The project's layer groups, so a layer in a hidden group is not searched. */
  groups?: LayerGroup[];
  /** Whether to offer the place search row (false when there is no map to move). */
  places?: boolean;
  /** Cost caps for the feature scan; see `searchLayerFeatures`. */
  featureOptions?: Omit<FeatureSearchOptions, "groups">;
}

/** Feature match kinds on the palette's rank scale. */
const FEATURE_RANK: Record<FeatureSearchMatch["kind"], CommandRank> = {
  exact: 0,
  prefix: 1,
  contains: 2,
};

/**
 * Match layer names against the query the way commands are matched: every
 * whitespace-separated token must appear in the name, an exact name ranks 0, a
 * name prefix 1, and anything else 2. Layers keep the order given (the store's
 * order) within a rank, and at most {@link MAX_LAYER_RESULTS} are kept, best
 * first.
 *
 * Every layer is matched, hidden ones and tile layers included: picking one only
 * selects and frames it, which is useful whether or not it is drawn.
 */
export function paletteLayerResults(
  layers: readonly GeoLibreLayer[],
  query: string,
  options: PaletteSearchOptions,
): RankedCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const tokens = needle.split(/\s+/);
  const matches: RankedCommand[] = [];
  for (const layer of layers) {
    const name = layer.name.toLowerCase();
    if (!tokens.every((token) => name.includes(token))) continue;
    const rank: CommandRank = name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
    matches.push({
      rank,
      command: {
        id: `palette-layer:${layer.id}`,
        title: layer.name,
        group: options.labels.layersGroup,
        icon: options.icons?.layer,
        run: () => options.actions.openLayer(layer.id),
      },
    });
  }
  return [...matches].sort((a, b) => a.rank - b.rank).slice(0, MAX_LAYER_RESULTS);
}

/**
 * The features whose attribute values match the query, one group per layer,
 * from the Layers panel's capped scan. A row's title is the matched value and
 * its detail the field it came from. A layer whose scan stopped early says so
 * in its heading rather than passing the rows off as all of them.
 */
export function paletteFeatureResults(
  layers: readonly GeoLibreLayer[],
  query: string,
  options: PaletteSearchOptions,
): RankedCommand[] {
  // `searchLayerFeatures` returns nothing below MIN_FEATURE_QUERY_LENGTH.
  const groups = searchLayerFeatures(layers, query, {
    ...options.featureOptions,
    groups: options.groups,
  });
  return groups.flatMap((group) => {
    const heading = options.labels.featuresGroup(group.layerName, group.truncated);
    return group.matches.map(
      (match): RankedCommand => ({
        rank: FEATURE_RANK[match.kind],
        command: {
          id: `palette-feature:${match.layerId}:${match.featureId}`,
          title: match.value,
          detail: match.field,
          group: heading,
          icon: options.icons?.feature,
          run: () => options.actions.openFeature(match),
        },
      }),
    );
  });
}

/**
 * Carry feature results over to a query the scan has not run for yet: keep the
 * rows whose value still contains the query and rank them against it.
 *
 * The palette scans after a pause in typing, so between a keystroke and the
 * next scan it still holds the previous query's rows. Shown as they are, a row
 * that no longer matches could be the one `Enter` picks. Filtered here, every
 * row on screen matches what is typed, and the rows that still do stay put
 * instead of flickering out until the scan lands.
 *
 * @param results - Rows from {@link paletteFeatureResults} for an earlier query.
 * @param query - The query as typed now.
 * @returns The rows that match `query`, ranked against it.
 */
export function refineFeatureResults(
  results: readonly RankedCommand[],
  query: string,
): RankedCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return results.flatMap((result): RankedCommand[] => {
    const value = result.command.title.toLowerCase();
    if (!value.includes(needle)) return [];
    const rank: CommandRank = value === needle ? 0 : value.startsWith(needle) ? 1 : 2;
    return [{ command: result.command, rank }];
  });
}

/**
 * The place search row: "Search places for …", always ranked last (3) because
 * it is a fallback. The query is only sent to the geocoder when the row is
 * picked, never while typing, so a query meant for a command never leaves the
 * machine.
 *
 * @param query - The raw typed query.
 * @param options - The action, label and icon for the row.
 * @returns The row, or none when places are off or the query is too short.
 */
export function palettePlaceResult(
  query: string,
  options: Pick<PaletteSearchOptions, "actions" | "labels" | "icons" | "places">,
): RankedCommand[] {
  const trimmed = query.trim();
  if (options.places === false || trimmed.length < MIN_PLACE_QUERY_LENGTH) return [];
  return [
    {
      rank: 3,
      command: {
        id: "palette-place-search",
        title: options.labels.searchPlace(trimmed),
        group: options.labels.placesGroup,
        icon: options.icons?.place,
        run: () => options.actions.searchPlace(trimmed),
      },
    },
  ];
}

/**
 * Merge the palette's three sources into the list it shows: one ranking across
 * all of them, then gathered into contiguous groups (`groupRankedCommands`).
 *
 * Within a rank, the order is commands, then search results, then the per-tool
 * entries. A command that matches as well as a layer or a feature therefore
 * stays the default Enter target, and a broad query's hundred-odd tool matches
 * cannot bury a matching layer or feature. A better rank still wins across
 * sources: an exact tool name ("Slope") comes before a feature value that only
 * starts with the query.
 *
 * @param commands - The fixed commands matched against the query.
 * @param results - The layer, feature and place results.
 * @param tools - The per-tool entries matched against the query.
 * @returns The commands to list, ranked and grouped.
 */
export function mergePaletteResults(
  commands: readonly RankedCommand[],
  results: readonly RankedCommand[],
  tools: readonly RankedCommand[],
): Command[] {
  return groupRankedCommands(sortRanked([...commands, ...results, ...tools]));
}
