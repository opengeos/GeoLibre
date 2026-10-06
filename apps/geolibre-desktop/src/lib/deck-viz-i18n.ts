/**
 * Translated labels for the Deck.gl Layer dialog. The layer registry
 * (`@geolibre/plugins` `deckgl-viz/registry.ts`) has no i18n access, so its
 * English labels are the fallback and the catalog keys are derived from the
 * registry's stable ids: `addData.deckViz.kinds.<kind>.label|description`,
 * `addData.deckViz.categories.<category>` and `addData.deckViz.roles.<roleKey>`.
 * `tests/deck-viz-i18n.test.ts` keeps `en.json` in step with the registry.
 */
import type { DeckVizCategory, DeckVizLayerDef, DeckVizRole } from "@geolibre/plugins";
import type { TFunction } from "i18next";

/** Catalog key for a layer kind's label. */
export function deckVizKindLabelKey(kind: string): string {
  return `addData.deckViz.kinds.${kind}.label`;
}

/** Catalog key for a layer kind's description. */
export function deckVizKindDescriptionKey(kind: string): string {
  return `addData.deckViz.kinds.${kind}.description`;
}

/** Catalog key for a category heading. */
export function deckVizCategoryKey(category: string): string {
  return `addData.deckViz.categories.${category}`;
}

/** Catalog key for a field role label. */
export function deckVizRoleKey(roleKey: string): string {
  return `addData.deckViz.roles.${roleKey}`;
}

// The typed `t()` only accepts literal catalog keys; these keys are built from
// registry ids, so resolve them through the untyped signature.
function translate(t: TFunction, key: string, fallback: string): string {
  return (t as (key: string, options: { defaultValue: string }) => string)(key, {
    defaultValue: fallback,
  });
}

/**
 * The translated name of a layer kind.
 *
 * @param t - The translation function.
 * @param def - The registry definition.
 * @returns The label in the active language, or the registry's English.
 */
export function deckVizKindLabel(
  t: TFunction,
  def: Pick<DeckVizLayerDef, "kind" | "label">,
): string {
  return translate(t, deckVizKindLabelKey(def.kind), def.label);
}

/**
 * The translated description of a layer kind.
 *
 * @param t - The translation function.
 * @param def - The registry definition.
 * @returns The description in the active language, or the registry's English.
 */
export function deckVizKindDescription(
  t: TFunction,
  def: Pick<DeckVizLayerDef, "kind" | "description">,
): string {
  return translate(t, deckVizKindDescriptionKey(def.kind), def.description);
}

/**
 * The translated heading of a layer category.
 *
 * @param t - The translation function.
 * @param category - The category id.
 * @param fallback - The registry's English heading.
 * @returns The heading in the active language, or the English fallback.
 */
export function deckVizCategoryLabel(
  t: TFunction,
  category: DeckVizCategory,
  fallback: string,
): string {
  return translate(t, deckVizCategoryKey(category), fallback);
}

/**
 * The translated label of a field role.
 *
 * @param t - The translation function.
 * @param role - The registry role.
 * @returns The label in the active language, or the registry's English.
 */
export function deckVizRoleLabel(t: TFunction, role: Pick<DeckVizRole, "key" | "label">): string {
  return translate(t, deckVizRoleKey(role.key), role.label);
}
