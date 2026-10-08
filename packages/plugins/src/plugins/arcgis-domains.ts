/**
 * Resolve the attribute domains an ArcGIS Feature Service layer publishes
 * (field-level coded-value and range domains, overridden per type or subtype)
 * into generic Attribute Form constraints and save-time checks (#3022).
 *
 * Everything here reads the layer's own `?f=json` metadata, which GeoLibre
 * already holds as `ArcGISEditInfo`, so no extra request is made. The editing
 * surfaces consume plain {@link AttributeFormConfig}s and never see ArcGIS
 * response objects. The server stays authoritative: when the metadata cannot
 * be resolved with confidence the field is left unconstrained client-side
 * rather than guessed.
 */
import type { AttributeFormConfig, AttributeFormFieldConfig } from "@geolibre/core";
import type { ArcGISEditInfo } from "./arcgis-edits";

/** One stored code and its published display name. */
export interface ArcGISCodedValue {
  name?: string;
  code: unknown;
}

/** A domain as published on a field, type, or subtype. */
export interface ArcGISDomain {
  type: string;
  name?: string;
  codedValues?: ArcGISCodedValue[];
  range?: number[];
}

/** A feature template: a named starting point for new features. */
export interface ArcGISFeatureTemplate {
  name?: string;
  prototype?: { attributes?: Record<string, unknown> | null } | null;
}

/** One entry of a layer's `types[]` (keyed by `typeIdField`). */
export interface ArcGISFeatureType {
  id: unknown;
  name?: string;
  domains?: Record<string, ArcGISDomain | null>;
  templates?: ArcGISFeatureTemplate[];
}

/** One entry of a layer's `subtypes[]` (keyed by `subtypeField`). */
export interface ArcGISSubtype {
  code: unknown;
  name?: string;
  domains?: Record<string, ArcGISDomain | null>;
  defaultValues?: Record<string, unknown>;
}

/** The domain that governs one field for one candidate record. */
export type ArcGISEffectiveDomain =
  | { kind: "none" }
  | { kind: "codedValue"; codedValues: ArcGISCodedValue[] }
  | { kind: "range"; min: number; max: number }
  /** The service constrains the field but the metadata does not say how, so only the server can check it. */
  | { kind: "unresolved" };

/** A layer-level metadata problem that leaves some constraints to the server. */
export type ArcGISDomainDiagnostic =
  /** `types[]` and `subtypes[]` disagree, so subtype-specific domains are not applied. */
  | { code: "subtypeConflict"; field: string }
  /** The advertised type/subtype field is not one of the layer's fields. */
  | { code: "subtypeFieldMissing"; field: string }
  /** A domain is referenced by name only, without its codes or range. */
  | { code: "unresolvedDomain"; field: string; domain?: string };

interface SubtypeEntry {
  code: unknown;
  name: string;
  domains: Record<string, ArcGISDomain | null>;
}

interface DomainModel {
  /** The type/subtype field as named in `fields[]`, when one applies. */
  selector?: string;
  entries: SubtypeEntry[];
  /** Fields whose domain varies by subtype but cannot be resolved (conflicting metadata). */
  unresolvedFields: Set<string>;
  diagnostics: ArcGISDomainDiagnostic[];
}

const INTEGER_TYPES = new Set([
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeBigInteger",
]);
const NUMBER_TYPES = new Set(["esriFieldTypeSingle", "esriFieldTypeDouble"]);

const models = new WeakMap<ArcGISEditInfo, DomainModel>();
const forms = new WeakMap<ArcGISEditInfo, Map<string, AttributeFormConfig | undefined>>();

function fieldNamed(info: ArcGISEditInfo, name: string | undefined) {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return info.fields?.find((field) => field.name.toLowerCase() === lower);
}

/**
 * Whether two type/subtype domain entries for a field mean the same thing.
 * An absent entry and `inherited` both fall back to the field-level domain;
 * an explicit `null` stays distinct.
 */
function sameDomain(
  a: ArcGISDomain | null | undefined,
  b: ArcGISDomain | null | undefined,
): boolean {
  const canonical = (d: ArcGISDomain | null | undefined) =>
    d === undefined || d?.type === "inherited" ? "inherited" : JSON.stringify(d);
  return canonical(a) === canonical(b);
}

/** Key domain overrides by the field's name as `fields[]` spells it (ArcGIS names are case-insensitive). */
function canonicalDomains(
  info: ArcGISEditInfo,
  domains: Record<string, ArcGISDomain | null> | undefined,
): Record<string, ArcGISDomain | null> {
  return Object.fromEntries(
    Object.entries(domains ?? {}).map(([key, domain]) => [
      fieldNamed(info, key)?.name ?? key,
      domain,
    ]),
  );
}

/** Exact-type key so the code 1 and the code "1" never collide. */
function codeKey(code: unknown): string {
  return `${typeof code}:${String(code)}`;
}

function isReference(domain: ArcGISDomain | null | undefined): boolean {
  if (!domain) return false;
  if (domain.type === "codedValue") return !Array.isArray(domain.codedValues);
  if (domain.type === "range")
    return !(
      Array.isArray(domain.range) &&
      domain.range.length === 2 &&
      domain.range.every((n) => typeof n === "number" && Number.isFinite(n))
    );
  return false;
}

/** Build (once per metadata object) the type/subtype model and its diagnostics. */
function domainModel(info: ArcGISEditInfo): DomainModel {
  const cached = models.get(info);
  if (cached) return cached;
  const model: DomainModel = { entries: [], unresolvedFields: new Set(), diagnostics: [] };
  const fromTypes = info.typeIdField?.trim() && info.types?.length ? info.typeIdField : undefined;
  const fromSubtypes =
    info.subtypeField?.trim() && info.subtypes?.length ? info.subtypeField : undefined;
  const typeEntries: SubtypeEntry[] = (fromTypes ? (info.types ?? []) : []).map((type) => ({
    code: type.id,
    name: type.name ?? String(type.id),
    domains: canonicalDomains(info, type.domains),
  }));
  const subtypeEntries: SubtypeEntry[] = (fromSubtypes ? (info.subtypes ?? []) : []).map(
    (subtype) => ({
      code: subtype.code,
      name: subtype.name ?? String(subtype.code),
      domains: canonicalDomains(info, subtype.domains),
    }),
  );
  const overridden = new Set(
    [...typeEntries, ...subtypeEntries].flatMap((entry) => Object.keys(entry.domains)),
  );
  const conflict = (field: string) => {
    model.diagnostics.push({ code: "subtypeConflict", field });
    for (const name of overridden) model.unresolvedFields.add(name);
  };

  let selector = fromSubtypes ?? fromTypes;
  let entries = subtypeEntries.length ? subtypeEntries : typeEntries;
  if (fromTypes && fromSubtypes) {
    if (fromTypes.toLowerCase() !== fromSubtypes.toLowerCase()) {
      conflict(fromSubtypes);
      selector = undefined;
    } else {
      // Both describe the same field: they must agree wherever they overlap.
      const byCode = new Map(typeEntries.map((entry) => [codeKey(entry.code), entry]));
      entries = [...subtypeEntries];
      for (const entry of subtypeEntries) {
        const twin = byCode.get(codeKey(entry.code));
        byCode.delete(codeKey(entry.code));
        if (!twin) continue;
        for (const field of new Set([
          ...Object.keys(entry.domains),
          ...Object.keys(twin.domains),
        ])) {
          if (!sameDomain(entry.domains[field], twin.domains[field])) {
            conflict(fromSubtypes);
            selector = undefined;
            break;
          }
        }
        if (!selector) break;
      }
      if (selector) entries.push(...byCode.values());
    }
  }
  if (selector) {
    const field = fieldNamed(info, selector);
    if (!field) {
      model.diagnostics.push({ code: "subtypeFieldMissing", field: selector });
      for (const name of overridden) model.unresolvedFields.add(name);
    } else {
      model.selector = field.name;
      model.entries = entries;
    }
  }

  const references = new Map<string, string | undefined>();
  for (const field of info.fields ?? [])
    if (isReference(field.domain)) references.set(field.name, field.domain?.name);
  for (const entry of model.entries)
    for (const [field, domain] of Object.entries(entry.domains))
      if (isReference(domain)) references.set(field, domain?.name);
  for (const [field, domain] of references)
    model.diagnostics.push({ code: "unresolvedDomain", field, domain });

  models.set(info, model);
  return model;
}

function normalize(domain: ArcGISDomain | null | undefined): ArcGISEffectiveDomain {
  if (!domain || domain.type === "inherited") return { kind: "none" };
  if (isReference(domain)) return { kind: "unresolved" };
  if (domain.type === "codedValue") return { kind: "codedValue", codedValues: domain.codedValues! };
  if (domain.type === "range")
    return { kind: "range", min: domain.range![0], max: domain.range![1] };
  return { kind: "unresolved" };
}

/** The type/subtype field the layer advertises (as named in `fields[]`), if usable. */
export function arcGISSubtypeField(info: ArcGISEditInfo): string | undefined {
  return domainModel(info).selector;
}

/** Layer-level metadata problems that leave some domain checks to the server. */
export function arcGISDomainDiagnostics(info: ArcGISEditInfo): ArcGISDomainDiagnostic[] {
  return domainModel(info).diagnostics;
}

/**
 * Resolve the domain that governs `fieldName` for a candidate record,
 * following the record's (possibly unsaved) type/subtype value.
 *
 * The type/subtype field itself is constrained to the published codes. For
 * other fields, a type/subtype entry's explicit domain overrides the field's,
 * `inherited` or an absent entry falls back to the field-level domain, and an
 * explicit `null` (whose meaning varies across services) or an unknown
 * type/subtype code leaves the field to the server.
 *
 * @param info - The layer's `?f=json` metadata.
 * @param fieldName - The field to resolve.
 * @param properties - The candidate record, including unsaved edits.
 * @returns The effective domain.
 */
export function resolveArcGISFieldDomain(
  info: ArcGISEditInfo,
  fieldName: string,
  properties: Record<string, unknown> | null | undefined,
): ArcGISEffectiveDomain {
  const field = info.fields?.find((entry) => entry.name === fieldName);
  if (!field) return { kind: "none" };
  const model = domainModel(info);
  if (model.selector === fieldName)
    return {
      kind: "codedValue",
      codedValues: model.entries.map((entry) => ({ code: entry.code, name: entry.name })),
    };
  if (model.unresolvedFields.has(fieldName)) return { kind: "unresolved" };
  if (model.selector) {
    const selected = properties?.[model.selector];
    if (selected != null) {
      const entry = model.entries.find((candidate) => candidate.code === selected);
      if (!entry) return { kind: "unresolved" };
      if (Object.hasOwn(entry.domains, fieldName)) {
        const domain = entry.domains[fieldName];
        if (domain === null) return { kind: "unresolved" };
        if (domain?.type !== "inherited") return normalize(domain);
      }
    }
  }
  return normalize(field.domain);
}

/**
 * Check one value against an effective domain, returning an error message or
 * `null`. Null values are the nullability check's concern, not the domain's.
 */
export function arcGISDomainError(
  fieldName: string,
  value: unknown,
  domain: ArcGISEffectiveDomain,
): string | null {
  if (value == null) return null;
  if (domain.kind === "codedValue" && !domain.codedValues.some((entry) => entry.code === value))
    return `Field ${fieldName} is outside its coded value domain.`;
  if (
    domain.kind === "range" &&
    typeof value === "number" &&
    (value < domain.min || value > domain.max)
  )
    return `Field ${fieldName} is outside its allowed range.`;
  return null;
}

function valueTypeOf(type: string): AttributeFormFieldConfig["valueType"] {
  if (INTEGER_TYPES.has(type)) return "integer";
  if (NUMBER_TYPES.has(type)) return "number";
  if (type === "esriFieldTypeString") return "string";
  return undefined;
}

function buildServiceForm(
  info: ArcGISEditInfo,
  properties: Record<string, unknown> | null | undefined,
): AttributeFormConfig | undefined {
  const fields: AttributeFormFieldConfig[] = [];
  for (const field of info.fields ?? []) {
    if (field.editable === false || field.name === info.objectIdField) continue;
    const valueType = valueTypeOf(field.type);
    if (!valueType) continue; // Dates, GUIDs and blobs keep the generic editor.
    const domain = resolveArcGISFieldDomain(info, field.name, properties);
    const base = {
      field: field.name,
      valueType,
      ...(field.alias?.trim() && field.alias !== field.name ? { alias: field.alias } : {}),
      ...(field.nullable === false ? { required: true } : {}),
    };
    if (domain.kind === "codedValue") {
      const seen = new Set<string>();
      const valueMap = domain.codedValues.flatMap((entry) => {
        const value = String(entry.code);
        if (entry.code == null || seen.has(value)) return [];
        seen.add(value);
        const label = entry.name?.trim();
        return [label && label !== value ? { value, label } : { value }];
      });
      fields.push({ ...base, widget: "valueMap", valueMap });
    } else if (domain.kind === "range" && valueType !== "string") {
      fields.push({ ...base, widget: "number", min: domain.min, max: domain.max });
    } else if (valueType !== "string") {
      // No domain still means a numeric column: a value typed into a cell must
      // be stored as a number even when no record holds one yet.
      fields.push({ ...base, widget: "number" });
    }
  }
  return fields.length ? { fields } : undefined;
}

/**
 * The Attribute Form constraints a record's ArcGIS domains impose: a labeled
 * value map (stored codes keep the field's declared type) for coded-value
 * domains and inclusive bounds for numeric range domains, resolved for the
 * record's type/subtype. Numeric fields without a resolvable domain get an
 * unbounded number editor; other fields without one are omitted so they keep
 * the existing editor. Results are memoized per metadata object
 * and type/subtype value, so callers may ask per row or per cell.
 *
 * @param info - The layer's `?f=json` metadata.
 * @param properties - The candidate record, including unsaved edits.
 * @returns The constraints, or `undefined` when the layer publishes none.
 */
export function arcGISServiceAttributeForm(
  info: ArcGISEditInfo,
  properties: Record<string, unknown> | null | undefined,
): AttributeFormConfig | undefined {
  const model = domainModel(info);
  // Key by the matched entry, so unpublished codes share one cache entry
  // (they all resolve the same way) instead of growing the cache.
  const selected = model.selector ? properties?.[model.selector] : undefined;
  const key = !model.selector
    ? ""
    : selected == null
      ? "null"
      : model.entries.some((entry) => entry.code === selected)
        ? codeKey(selected)
        : "unknown";
  let byKey = forms.get(info);
  if (!byKey) forms.set(info, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, buildServiceForm(info, properties));
  return byKey.get(key);
}
