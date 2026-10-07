/**
 * Starting attributes for features created while editing an ArcGIS Feature
 * Service layer: creation defaults for drawn features, and dropping
 * server-managed values from copies (#3022 follow-up).
 *
 * Everything here reads the layer's own `?f=json` metadata. Defaults only fill
 * attributes that have no value; nothing here touches existing records.
 */
import type { ArcGISEditInfo } from "./arcgis-edits";
import type { ArcGISFeatureTemplate } from "./arcgis-domains";
import { arcGISSubtypeField } from "./arcgis-domains";

/** The source kind of a GeoLibre layer backed by an ArcGIS feature layer query. */
export const ARCGIS_FEATURE_SOURCE_KIND = "arcgis-feature-query";

const SERVER_MANAGED_TYPES = new Set([
  "esriFieldTypeOID",
  "esriFieldTypeGlobalID",
  "esriFieldTypeGeometry",
]);

/**
 * Fields whose values the service assigns (object ID, global ID, geometry,
 * and any field it marks read-only, such as editor tracking).
 *
 * @param info - The layer's `?f=json` metadata.
 * @returns The server-managed field names, lower-cased: ArcGIS field names are
 *   case-insensitive, so compare with `name.toLowerCase()`.
 */
export function arcGISServerManagedFields(info: ArcGISEditInfo): Set<string> {
  const managed = new Set<string>();
  for (const field of info.fields ?? []) {
    if (field.editable === false || SERVER_MANAGED_TYPES.has(field.type))
      managed.add(field.name.toLowerCase());
  }
  for (const name of [info.objectIdField, info.globalIdField])
    if (name) managed.add(name.toLowerCase());
  return managed;
}

/**
 * Attributes for a copy of an existing feature: everything the user copied,
 * minus values the service assigns. Keeping the source's object ID would make
 * the copy look like the original, so it could never be saved as a new feature.
 *
 * @param info - The layer's `?f=json` metadata.
 * @param properties - The attributes cloned from the source feature.
 * @returns The copy's attributes.
 */
export function arcGISCopiedFeatureProperties(
  info: ArcGISEditInfo,
  properties: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!properties) return properties;
  const managed = arcGISServerManagedFields(info);
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !managed.has(key.toLowerCase())),
  );
}

/** Re-key `values` by the field names as `fields[]` spells them (ArcGIS names are case-insensitive). */
function byFieldName(
  info: ArcGISEditInfo,
  values: Record<string, unknown> | null | undefined,
): Map<string, unknown> {
  const names = new Map((info.fields ?? []).map((field) => [field.name.toLowerCase(), field.name]));
  const result = new Map<string, unknown>();
  for (const [key, value] of Object.entries(values ?? {})) {
    const name = names.get(key.toLowerCase());
    if (name && value != null) result.set(name, value);
  }
  return result;
}

/**
 * Whether two type/subtype codes name the same type. Metadata can report a type
 * id as a number in one place and a string in another; this only selects which
 * template or subtype defaults apply, never a stored value's type.
 */
function sameCode(a: unknown, b: unknown): boolean {
  return a != null && b != null && String(a) === String(b);
}

interface TemplateChoice {
  template: ArcGISFeatureTemplate;
  /** The type the template belongs to, for templates listed under `types[]`. */
  typeId?: unknown;
}

function templateChoices(info: ArcGISEditInfo): TemplateChoice[] {
  return [
    ...(info.types ?? []).flatMap((type) =>
      (type.templates ?? []).map((template) => ({ template, typeId: type.id })),
    ),
    ...(info.templates ?? []).map((template) => ({ template })),
  ];
}

/**
 * The creation defaults a new feature gets, filling only attributes that are
 * empty. The order, most specific first:
 *
 * 1. A value already on the feature is never replaced.
 * 2. The type/subtype field takes the type of the only template the layer
 *    publishes, else `defaultSubtypeCode`, else the field's `defaultValue`.
 * 3. Other editable fields take the prototype value of the template chosen for
 *    that type, else the subtype's `defaultValues`, else the field's
 *    `defaultValue`.
 *
 * A template is used only when the choice is unambiguous: the layer (or the
 * feature's type) publishes exactly one. With several, none is picked
 * arbitrarily and only the subtype and field defaults apply. Server-managed
 * fields are never filled.
 *
 * @param info - The layer's `?f=json` metadata.
 * @param properties - The new feature's current attributes.
 * @returns The feature's attributes with defaults filled in.
 */
export function arcGISNewFeatureProperties(
  info: ArcGISEditInfo,
  properties: Record<string, unknown> | null,
): Record<string, unknown> {
  const managed = arcGISServerManagedFields(info);
  const result: Record<string, unknown> = {};
  // Drawn features start empty, but drop anything the service assigns anyway.
  for (const [key, value] of Object.entries(properties ?? {}))
    if (!managed.has(key.toLowerCase())) result[key] = value;

  const selector = arcGISSubtypeField(info);
  const fieldDefaults = new Map(
    (info.fields ?? [])
      .filter((field) => field.defaultValue != null)
      .map((field) => [field.name, field.defaultValue]),
  );
  const choices = templateChoices(info);
  let chosen: TemplateChoice | undefined;
  let typeValue = selector ? result[selector] : undefined;

  if (selector && typeValue == null) {
    if (choices.length === 1) {
      chosen = choices[0];
      typeValue =
        chosen.typeId ?? byFieldName(info, chosen.template.prototype?.attributes).get(selector);
    }
    if (typeValue == null && info.defaultSubtypeCode != null) typeValue = info.defaultSubtypeCode;
    if (typeValue == null) typeValue = fieldDefaults.get(selector);
    if (typeValue != null && !managed.has(selector.toLowerCase())) result[selector] = typeValue;
  }
  if (!chosen) {
    const candidates = !selector
      ? choices
      : typeValue == null
        ? []
        : choices.filter((choice) =>
            sameCode(
              choice.typeId !== undefined
                ? choice.typeId
                : byFieldName(info, choice.template.prototype?.attributes).get(selector),
              typeValue,
            ),
          );
    if (candidates.length === 1) chosen = candidates[0];
  }

  const prototype = byFieldName(info, chosen?.template.prototype?.attributes);
  const subtype =
    selector && typeValue != null
      ? info.subtypes?.find((entry) => sameCode(entry.code, typeValue))
      : undefined;
  const subtypeDefaults = byFieldName(info, subtype?.defaultValues);
  for (const field of info.fields ?? []) {
    const name = field.name;
    if (name === selector || managed.has(name.toLowerCase()) || result[name] != null) continue;
    const value = prototype.get(name) ?? subtypeDefaults.get(name) ?? fieldDefaults.get(name);
    if (value != null) result[name] = value;
  }
  return result;
}
