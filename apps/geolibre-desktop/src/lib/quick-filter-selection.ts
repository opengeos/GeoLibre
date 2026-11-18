import type { LayerQuickFilter } from "@geolibre/core";

/**
 * Selection edits for a categorical quick filter's value list (issue #3455).
 *
 * The list holds the profile's values plus one "(blank)" option, and the
 * blank option is stored apart from `values` as `includeBlank`. These helpers
 * keep the two in step, so "Select all", "Select none" and the selected count
 * treat "(blank)" as one more option.
 */

/** A value a categorical quick filter can select. */
export type QuickFilterValue = string | number | boolean;

/**
 * Add the options the list is showing to the selection, keeping the rest.
 * With a search active, "Select all" adds only the matches rather than
 * dropping the values scrolled out of view.
 *
 * @param filter - The filter being edited.
 * @param shown - The values the list is showing.
 * @param blankShown - Whether the "(blank)" option is showing.
 * @returns The edited filter.
 */
export function selectShownValues(
  filter: LayerQuickFilter,
  shown: readonly QuickFilterValue[],
  blankShown: boolean,
): LayerQuickFilter {
  return {
    ...filter,
    values: [...new Set([...(filter.values ?? []), ...shown])],
    includeBlank: blankShown || filter.includeBlank === true || undefined,
  };
}

/**
 * Remove the options the list is showing from the selection, keeping the rest.
 *
 * @param filter - The filter being edited.
 * @param shown - The values the list is showing.
 * @param blankShown - Whether the "(blank)" option is showing.
 * @returns The edited filter.
 */
export function deselectShownValues(
  filter: LayerQuickFilter,
  shown: readonly QuickFilterValue[],
  blankShown: boolean,
): LayerQuickFilter {
  const hidden = new Set(shown);
  return {
    ...filter,
    values: (filter.values ?? []).filter((value) => !hidden.has(value)),
    includeBlank: (!blankShown && filter.includeBlank === true) || undefined,
  };
}

/**
 * How many options are selected, counting "(blank)" as one.
 *
 * @param filter - The filter to count.
 * @returns The number of selected options.
 */
export function selectedOptionCount(filter: LayerQuickFilter): number {
  return new Set(filter.values ?? []).size + (filter.includeBlank === true ? 1 : 0);
}
