import type { AlgorithmParameter, WhiteboxToolParameter } from "@geolibre/processing";
import type { TFunction } from "i18next";

/**
 * Translation layer for processing registry metadata: tool names, descriptions,
 * grouping labels, parameter labels/help text and select-option labels.
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
export type ProcessingToolCatalog = "vector" | "network" | "statistics" | "raster" | "whitebox";

/**
 * A catalog, or `null` for tool metadata the host cannot translate. Passing
 * `null` returns the registry's own text unchanged, so a caller that mixes
 * supported and unsupported providers needs no branch of its own.
 */
export type ProcessingToolCatalogOrNone = ProcessingToolCatalog | null;

/**
 * Catalog backing a Model Builder descriptor's `provider`, or `null` when the
 * provider's metadata the host cannot translate.
 */
export function modelProviderCatalog(provider: string): ProcessingToolCatalogOrNone {
  if (provider === "vector") return "vector";
  if (provider === "whitebox") return "whitebox";
  return null;
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

/** Key holding a translated raw Whitebox category label. */
export function whiteboxCategoryKey(category: string): string {
  return `processing.whitebox.categories.${toolGroupKey(category)}`;
}

/** Key fragment for a translated Whitebox Processing menu subcategory. */
export function whiteboxMenuSubcategorySlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+$/, "");
}

function localizedText(
  t: TFunction,
  key: string,
  fallback: string,
): { value: string; resolved: boolean } {
  const missingValue = "\u0000geolibre-i18n-missing\u0000";
  const translated = t(key, { defaultValue: missingValue });
  return translated === missingValue
    ? { value: fallback, resolved: false }
    : { value: String(translated), resolved: true };
}

function text(t: TFunction, key: string, fallback: string): string {
  return localizedText(t, key, fallback).value;
}

function isEnglishLocale(language: string | null | undefined): boolean {
  return typeof language === "string" && language.toLowerCase().startsWith("en");
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
  return text(t, toolNameKey(catalog, tool.id), tool.name);
}

/** A tool's description for the active locale (empty when it has none). */
export function translateToolDescription(
  t: TFunction,
  catalog: ProcessingToolCatalogOrNone,
  tool: ProcessingToolMeta,
): string {
  if (!tool.description) return "";
  if (!catalog) return tool.description;
  return text(t, toolDescriptionKey(catalog, tool.id), tool.description);
}

/** A grouping label for the active locale. */
export function translateToolGroup(t: TFunction, group: string): string {
  return text(t, `${TOOL_GROUP_KEY_PREFIX}.${toolGroupKey(group)}`, group);
}

/** A raw Whitebox category label for the active locale. */
export function translateWhiteboxCategory(t: TFunction, category?: string): string {
  if (!category) return t("processing.whitebox.categoryGeneral");
  return text(t, whiteboxCategoryKey(category), category);
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
 * So a heading is translated only when at least one of its tools comes from the
 * vector registry, whose labels share the generated tool-group namespace.
 * Whitebox categories still render verbatim: they key on raw category text and
 * can collide with an owned label after slugging.
 */
export function translateModelToolGroup(
  t: TFunction,
  group: { group: string; tools: { provider: string }[] },
): string {
  const owned = group.tools.some((tool) => tool.provider === "vector");
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
    label: text(t, parameterLabelKey(catalog, toolId, param.id), param.label),
  };
  if (param.description) {
    translated.description = text(
      t,
      parameterDescriptionKey(catalog, toolId, param.id),
      param.description,
    );
  }
  if (param.options) {
    translated.options = param.options.map((option) => ({
      ...option,
      label: text(t, parameterOptionKey(catalog, toolId, param.id, option.value), option.label),
    }));
  }
  return translated;
}

/**
 * Humanize a snake_case identifier into a Title Case display string, falling
 * back to `fallback` when the identifier is empty or punctuation-only.
 */
export function humanizeIdentifier(value: string, fallback: string): string {
  return (
    value
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || fallback
  );
}

/** Humanize a parameter name into a Title Case display string. */
export function humanizeParameterName(value: string): string {
  return humanizeIdentifier(value, "Parameter");
}

/**
 * A Whitebox manifest parameter label (humanized name) for the active locale.
 */
export function translateWhiteboxParameterLabel(
  t: TFunction,
  toolId: string,
  param: WhiteboxToolParameter,
): string {
  return text(
    t,
    parameterLabelKey("whitebox", toolId, param.name),
    humanizeParameterName(param.name),
  );
}

/** A Whitebox parameter's combined form label and localized help text. */
export function whiteboxParameterLabel(
  t: TFunction,
  language: string | null | undefined,
  toolId: string,
  param: WhiteboxToolParameter,
): string {
  const fallbackLabel = humanizeParameterName(param.name);
  const label = localizedText(t, parameterLabelKey("whitebox", toolId, param.name), fallbackLabel);
  const desc = localizedText(
    t,
    parameterDescriptionKey("whitebox", toolId, param.name),
    param.description ?? "",
  );
  // A catalog entry is present even when a technical description intentionally
  // equals the English manifest text. Suppress only a genuinely missing entry,
  // except in English where the manifest help is already locale-appropriate.
  const showDescription = desc.resolved || isEnglishLocale(language);
  return desc.value && showDescription ? `${label.value}: ${desc.value}` : label.value;
}

/**
 * A Whitebox manifest parameter help text for the active locale.
 *
 * The Processing toolbox uses the raw manifest for control selection as well as
 * display: heuristics such as path, CRS, field, and extent detection read the
 * English description. Translating the whole object would make those choices
 * depend on the active locale, so callers should use this text for display and
 * keep passing the original parameter to behavior-bearing code.
 *
 * Untranslated help is suppressed outside English for the same reason
 * {@link whiteboxParameterLabel} suppresses it: the two render the same
 * underlying text (inline label vs. hover tooltip), so falling back to the raw
 * English manifest string here would show on hover exactly what the inline
 * label deliberately leaves out.
 */
export function translateWhiteboxParameterDescription(
  t: TFunction,
  language: string | null | undefined,
  toolId: string,
  param: WhiteboxToolParameter,
): string | undefined {
  if (!param.description) return param.description;
  const desc = localizedText(
    t,
    parameterDescriptionKey("whitebox", toolId, param.name),
    param.description,
  );
  if (!desc.resolved && !isEnglishLocale(language)) return undefined;
  return desc.value;
}
