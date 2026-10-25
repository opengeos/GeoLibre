/**
 * Starting attributes for features created while editing an ArcGIS Feature
 * Service layer: creation defaults for drawn features, and dropping
 * server-managed values from copies (#3022 follow-up).
 *
 * Everything here reads the layer's own `?f=json` metadata. Defaults only fill
 * attributes that have no value; nothing here touches existing records.
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { arcGISEditCapabilities, type ArcGISEditInfo } from "./arcgis-edits";
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
  /** The owning type's display name. */
  typeName?: string;
}

function templateChoices(info: ArcGISEditInfo): TemplateChoice[] {
  return [
    ...(info.types ?? []).flatMap((type) =>
      (type.templates ?? []).map((template) => ({
        template,
        typeId: type.id,
        typeName: type.name,
      })),
    ),
    ...(info.templates ?? []).map((template) => ({ template })),
  ];
}

/**
 * The type/subtype value a template creates: its owning type, else the
 * selector value its prototype carries.
 */
function templateTypeValue(
  info: ArcGISEditInfo,
  choice: TemplateChoice,
  selector: string | undefined,
): unknown {
  if (choice.typeId !== undefined) return choice.typeId;
  return selector
    ? byFieldName(info, choice.template.prototype?.attributes).get(selector)
    : undefined;
}

/**
 * Whether a template contradicts itself: it is listed under one type while its
 * prototype sets the type/subtype field to another. GeoLibre cannot tell which
 * one the publisher meant, so such a template is never offered for selection.
 */
function contradictoryTemplate(
  info: ArcGISEditInfo,
  choice: TemplateChoice,
  selector: string | undefined,
): boolean {
  if (choice.typeId === undefined || !selector) return false;
  const prototypeType = byFieldName(info, choice.template.prototype?.attributes).get(selector);
  return prototypeType != null && !sameCode(prototypeType, choice.typeId);
}

/** Identity of a template within any metadata snapshot: everything it publishes. */
function templateFingerprint(choice: TemplateChoice): string {
  return JSON.stringify([choice.typeId ?? null, choice.template]);
}

/**
 * A published feature template the user can pick for new features (#3179).
 * Names and descriptions are untrusted service text: render them as text.
 */
export interface ArcGISCreationTemplate {
  /** Identifies the template across metadata reloads; pass it back as the selection. */
  selection: ArcGISCreationTemplateSelection;
  /** The published name, possibly empty or shared with another template. */
  name: string;
  description?: string;
  /** The owning type's display name, for templates listed under `types[]`. */
  typeName?: string;
  /** The type/subtype value new features get from this template, when it sets one. */
  typeValue?: unknown;
}

/**
 * A pinned template choice. `index` is the template's position in one metadata
 * snapshot and `fingerprint` its full published content, so a selection made
 * against stale metadata never silently resolves to a different template.
 */
export interface ArcGISCreationTemplateSelection {
  index: number;
  fingerprint: string;
}

/** Trimmed text from service JSON, or "" when the service published something else. */
function serviceText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The feature templates a layer publishes that can be chosen for new
 * features: layer-level `templates[]` and every `types[].templates[]`, in
 * metadata order, minus templates whose type and prototype contradict each
 * other.
 *
 * @param info - The layer's `?f=json` metadata.
 * @returns The selectable templates.
 */
export function arcGISCreationTemplates(info: ArcGISEditInfo): ArcGISCreationTemplate[] {
  const selector = arcGISSubtypeField(info);
  return templateChoices(info).flatMap((choice, index) => {
    if (contradictoryTemplate(info, choice, selector)) return [];
    const typeValue = templateTypeValue(info, choice, selector);
    const description = serviceText(choice.template.description);
    const typeName = serviceText(choice.typeName);
    return [
      {
        selection: { index, fingerprint: templateFingerprint(choice) },
        name: serviceText(choice.template.name),
        ...(description ? { description } : {}),
        ...(typeName ? { typeName } : {}),
        ...(typeValue != null ? { typeValue } : {}),
      },
    ];
  });
}

/**
 * The templates to offer before drawing on a layer: only for an ArcGIS feature
 * layer that accepts new features and publishes more than one selectable
 * template. With none or one, the automatic defaults already do the right
 * thing, so no choice is asked for.
 *
 * @param layer - The layer about to be edited.
 * @returns The templates to choose from, or an empty list when no choice is needed.
 */
export function arcGISLayerCreationTemplates(layer: GeoLibreLayer): ArcGISCreationTemplate[] {
  if (layer.metadata.sourceKind !== ARCGIS_FEATURE_SOURCE_KIND) return [];
  const info = layer.metadata.arcgisEditInfo as ArcGISEditInfo | undefined;
  if (!info?.fields?.length || !arcGISEditCapabilities(info).create) return [];
  const templates = arcGISCreationTemplates(info);
  return templates.length > 1 ? templates : [];
}

/**
 * Find a pinned template in (possibly reloaded) metadata: at its recorded
 * position when the template there is unchanged, else the one template with
 * the same published content. A template that changed, vanished, or now
 * appears twice resolves to nothing, so its features get only the defaults.
 */
function resolveTemplateSelection(
  info: ArcGISEditInfo,
  selection: ArcGISCreationTemplateSelection,
): TemplateChoice | undefined {
  const selector = arcGISSubtypeField(info);
  const choices = templateChoices(info);
  const usable = (choice: TemplateChoice | undefined): choice is TemplateChoice =>
    choice !== undefined &&
    templateFingerprint(choice) === selection.fingerprint &&
    !contradictoryTemplate(info, choice, selector);
  const atIndex = choices[selection.index];
  if (usable(atIndex)) return atIndex;
  const matches = choices.filter(usable);
  return matches.length === 1 ? matches[0] : undefined;
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
 * Without `template`, a template is used only when the choice is unambiguous:
 * the layer (or the feature's type) publishes exactly one. With several, none
 * is picked arbitrarily and only the subtype and field defaults apply. A
 * `template` the user picked (#3179) takes the place of that automatic choice,
 * including the type it creates, unless the feature already carries a
 * different type value of its own; a selection that no longer matches the
 * metadata is ignored. Server-managed fields are never filled.
 *
 * By default an attribute counts as empty when its value is null or missing,
 * since drawn features can carry placeholder nulls. With `keepGiven`, every
 * attribute present on `properties` is the user's own value, a null included:
 * a field the user cleared on purpose must reach validation as null rather than
 * be refilled from a template (#3122).
 *
 * @param info - The layer's `?f=json` metadata.
 * @param properties - The new feature's current attributes.
 * @param options - `keepGiven`: never fill an attribute present on `properties`.
 *   `template`: the template the user picked for new features.
 * @returns The feature's attributes with defaults filled in.
 */
export function arcGISNewFeatureProperties(
  info: ArcGISEditInfo,
  properties: Record<string, unknown> | null,
  options: { keepGiven?: boolean; template?: ArcGISCreationTemplateSelection } = {},
): Record<string, unknown> {
  const managed = arcGISServerManagedFields(info);
  const result: Record<string, unknown> = {};
  // Drawn features start empty, but drop anything the service assigns anyway.
  for (const [key, value] of Object.entries(properties ?? {}))
    if (!managed.has(key.toLowerCase())) result[key] = value;
  const given = new Set(
    options.keepGiven ? Object.keys(result).map((key) => key.toLowerCase()) : [],
  );
  const supplied = (name: string) => result[name] != null || given.has(name.toLowerCase());

  const selector = arcGISSubtypeField(info);
  const fieldDefaults = new Map(
    (info.fields ?? [])
      // Hosted services publish `""` for a field without a default, date and
      // numeric fields included; it is no default, not an empty value to store.
      .filter((field) => field.defaultValue != null && field.defaultValue !== "")
      .map((field) => [field.name, field.defaultValue]),
  );
  const choices = templateChoices(info);
  let chosen: TemplateChoice | undefined;
  let typeValue = selector ? result[selector] : undefined;

  const pinned = options.template ? resolveTemplateSelection(info, options.template) : undefined;
  // A picked template that no longer matches the metadata means "defaults only":
  // never fall back to whichever template happens to be left.
  const stale = options.template !== undefined && !pinned;
  if (pinned) {
    const pinnedType = templateTypeValue(info, pinned, selector);
    // A type the feature already has wins; a template for another type does not apply.
    const conflicts =
      selector && supplied(selector) && pinnedType != null && !sameCode(typeValue, pinnedType);
    if (!conflicts) chosen = pinned;
  }
  if (selector && !supplied(selector)) {
    if (!chosen && !stale && choices.length === 1) chosen = choices[0];
    if (chosen) typeValue = templateTypeValue(info, chosen, selector);
    if (typeValue == null && info.defaultSubtypeCode != null) typeValue = info.defaultSubtypeCode;
    if (typeValue == null) typeValue = fieldDefaults.get(selector);
    if (typeValue != null && !managed.has(selector.toLowerCase())) result[selector] = typeValue;
  }
  if (!chosen && !stale) {
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
    if (name === selector || managed.has(name.toLowerCase()) || supplied(name)) continue;
    const value = prototype.get(name) ?? subtypeDefaults.get(name) ?? fieldDefaults.get(name);
    if (value != null) result[name] = value;
  }
  return result;
}
