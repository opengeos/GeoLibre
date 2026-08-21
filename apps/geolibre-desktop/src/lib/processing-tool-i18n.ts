import type { AlgorithmParameter } from "@geolibre/processing";
import type { TFunction } from "i18next";

/**
 * Translation layer for the metadata the GeoLibre-native processing registries
 * carry: tool names, descriptions, grouping labels, parameter labels/help text
 * and select-option labels.
 *
 * Those strings live in `@geolibre/processing`, a package with no i18n access,
 * so the Processing *menu* entries were translated while the dialog they opened
 * stayed English (GeoLibre#2021). Every dialog now renders metadata through
 * these helpers, which look the string up in the app catalogs and fall back to
 * the registry's own English text.
 *
 * Because the fallback is the registry string itself, English is correct with no
 * catalog entries at all: a newly added tool reads correctly the moment it is
 * registered and becomes translatable once `scripts/gen-processing-i18n-catalog.mjs`
 * regenerates the English baseline that translators work from.
 */

/**
 * Which registry a tool id belongs to. Ids are unique *within* a registry but
 * not across them — `reproject` is both a vector tool (reproject a GeoJSON
 * layer) and a raster tool (warp a GeoTIFF) — so the catalog name is part of
 * every key.
 */
export type ProcessingToolCatalog = "vector" | "network" | "statistics" | "raster";

/**
 * A catalog, or `null` for tool metadata GeoLibre does not own and so cannot
 * translate — today that is the Whitebox WASM catalog, whose ~800 tool
 * descriptions come from the bundled binary. Passing `null` returns the
 * registry's own text unchanged, so a caller that mixes owned and unowned tools
 * (the Model Builder palette) needs no branch of its own.
 */
export type ProcessingToolCatalogOrNone = ProcessingToolCatalog | null;

/**
 * Catalog backing a Model Builder descriptor's `provider`, or `null` when the
 * provider's metadata is not GeoLibre's to translate.
 */
export function modelProviderCatalog(provider: string): ProcessingToolCatalogOrNone {
  return provider === "vector" ? "vector" : null;
}

/** Root of the generated tool-metadata namespace in the message catalogs. */
export const TOOL_META_KEY_PREFIX = "processing.toolMeta";
/** Root of the shared tool-group namespace (group labels repeat across catalogs). */
export const TOOL_GROUP_KEY_PREFIX = "processing.toolGroup";

/** Minimal shape the helpers read; satisfied by ProcessingAlgorithm and RasterTool. */
export interface ProcessingToolMeta {
  id: string;
  name: string;
  description?: string;
  group?: string;
}

/**
 * Stable catalog key for a free-text group label ("Raster to Vector" →
 * `rasterToVector`). Group labels are display text in the registries, not ids,
 * so they are slugged rather than used verbatim: a key must survive JSON
 * nesting (no dots) and stay readable for translators.
 */
export function toolGroupKey(group: string): string {
  const words = group
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "other";
  return words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
}

/** Key holding a tool's translated `name`. */
export function toolNameKey(catalog: ProcessingToolCatalog, toolId: string): string {
  return `${TOOL_META_KEY_PREFIX}.${catalog}.${toolId}.name`;
}

/** Key holding a tool's translated `description`. */
export function toolDescriptionKey(catalog: ProcessingToolCatalog, toolId: string): string {
  return `${TOOL_META_KEY_PREFIX}.${catalog}.${toolId}.description`;
}

/** Key holding a parameter's translated `label`. */
export function parameterLabelKey(
  catalog: ProcessingToolCatalog,
  toolId: string,
  paramId: string,
): string {
  return `${TOOL_META_KEY_PREFIX}.${catalog}.${toolId}.params.${paramId}.label`;
}

/** Key holding a parameter's translated help text. */
export function parameterDescriptionKey(
  catalog: ProcessingToolCatalog,
  toolId: string,
  paramId: string,
): string {
  return `${TOOL_META_KEY_PREFIX}.${catalog}.${toolId}.params.${paramId}.description`;
}

/** Key holding a select option's translated label. */
export function parameterOptionKey(
  catalog: ProcessingToolCatalog,
  toolId: string,
  paramId: string,
  optionValue: string,
): string {
  return `${TOOL_META_KEY_PREFIX}.${catalog}.${toolId}.params.${paramId}.options.${optionValue}`;
}

/** A tool's display name for the active locale. */
export function translateToolName(
  t: TFunction,
  catalog: ProcessingToolCatalogOrNone,
  tool: ProcessingToolMeta,
): string {
  if (!catalog) return tool.name;
  return t(toolNameKey(catalog, tool.id), { defaultValue: tool.name });
}

/** A tool's description for the active locale (empty when it has none). */
export function translateToolDescription(
  t: TFunction,
  catalog: ProcessingToolCatalogOrNone,
  tool: ProcessingToolMeta,
): string {
  if (!tool.description) return "";
  if (!catalog) return tool.description;
  return t(toolDescriptionKey(catalog, tool.id), { defaultValue: tool.description });
}

/** A grouping label for the active locale. */
export function translateToolGroup(t: TFunction, group: string): string {
  return t(`${TOOL_GROUP_KEY_PREFIX}.${toolGroupKey(group)}`, { defaultValue: group });
}

/**
 * A Model Builder palette heading for the active locale.
 *
 * Unlike the single-registry dialogs, the palette mixes owned tools with
 * Whitebox ones, and `groupModelTools` keys its groups on the raw label — so a
 * heading has no provider of its own. Translating every heading through the
 * shared namespace is wrong for a Whitebox-only group whose category text
 * happens to slug onto an owned key: the WASM catalog ships a `terrain`
 * category (lowercase) beside the raster registry's `Terrain`, and both reach
 * `processing.toolGroup.terrain`, which would render the palette with two
 * identically-labelled headings.
 *
 * So a heading is translated only when at least one of its tools comes from a
 * catalog GeoLibre owns. A group of purely Whitebox categories renders its
 * label verbatim, the way the rest of that catalog's metadata does; a mixed
 * group (none exist today, since no Whitebox category matches an owned label
 * exactly) counts as owned, because an owned tool sitting under the heading
 * means the label is ours to translate.
 */
export function translateModelToolGroup(
  t: TFunction,
  group: { group: string; tools: { provider: string }[] },
): string {
  const owned = group.tools.some((tool) => modelProviderCatalog(tool.provider) !== null);
  return owned ? translateToolGroup(t, group.group) : group.group;
}

/**
 * A parameter with its `label`, `description` and select-option labels resolved
 * for the active locale.
 *
 * Returns a shallow clone so the registry's own parameter object is never
 * mutated — the registries are module-level singletons shared by every dialog,
 * and a in-place rewrite would freeze the first-rendered language into them.
 * Call it at render time (the dialogs already re-render on `languageChanged`
 * through `useTranslation`).
 */
export function translateParameter<T extends AlgorithmParameter>(
  t: TFunction,
  catalog: ProcessingToolCatalogOrNone,
  toolId: string,
  param: T,
): T {
  if (!catalog) return param;
  const translated: T = {
    ...param,
    label: t(parameterLabelKey(catalog, toolId, param.id), { defaultValue: param.label }),
  };
  if (param.description) {
    translated.description = t(parameterDescriptionKey(catalog, toolId, param.id), {
      defaultValue: param.description,
    });
  }
  if (param.options) {
    translated.options = param.options.map((option) => ({
      ...option,
      label: t(parameterOptionKey(catalog, toolId, param.id, option.value), {
        defaultValue: option.label,
      }),
    }));
  }
  return translated;
}
