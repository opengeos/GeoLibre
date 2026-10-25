/**
 * Contingent values: the combinations of field values an ArcGIS Feature
 * Service layer allows within a field group (#3180).
 *
 * A layer that publishes them (`hasContingentValuesDefinition`) lists, per
 * field group and optionally per subtype, the permitted value tuples. This
 * module reads that definition from the layer's `contingentValues` resource
 * (or the service's `queryContingentValues` operation), normalizes it to
 * typed field codes, and evaluates candidate records against it, so the
 * editing surfaces and the save path share one model.
 *
 * The response is decoded strictly: value types come from the response's own
 * `typeCodes`, text codes are looked up in its `stringDicts` (a compact
 * response gives a text field's code as a position in that list, never the
 * code itself), and every decoded code must belong to the field's domain.
 * Anything that cannot be decoded with confidence makes the whole definition
 * `unsupported` instead of a guessed model.
 */
import type { ArcGISEditInfo } from "./arcgis-edits";
import { arcGISSubtypeField } from "./arcgis-domains";

/** One slot of a permitted combination. */
export type ArcGISContingentValue =
  /** Any value of the field's domain, null included. */
  | { kind: "any" }
  /** The field must be null. */
  | { kind: "null" }
  /** One stored code, typed as the field stores it. */
  | { kind: "code"; code: string | number }
  /** An inclusive numeric interval. */
  | { kind: "range"; min: number; max: number };

/** One permitted combination: a value per field of its group, in group order. */
export interface ArcGISContingency {
  id?: number;
  /** Still valid on existing records, but not to be introduced by an edit. */
  retired: boolean;
  values: ArcGISContingentValue[];
}

/** The combinations a field group permits for one subtype, or for the whole layer. */
export interface ArcGISContingencyList {
  /** The subtype code these combinations apply to; absent for the whole layer. */
  subtype?: string | number;
  contingencies: ArcGISContingency[];
}

/** A field group and its permitted combinations. */
export interface ArcGISFieldGroup {
  name: string;
  /** A restrictive group's combinations are enforced; others are advisory. */
  restrictive: boolean;
  /** The group's fields, as `fields[]` names them. */
  fields: string[];
  lists: ArcGISContingencyList[];
}

/**
 * What GeoLibre knows about a layer's contingent values. Absent on the
 * metadata when the layer publishes none.
 */
export type ArcGISContingentValues =
  | { status: "ready"; groups: ArcGISFieldGroup[] }
  /** The definition exists but could not be retrieved; retried on the next metadata load. */
  | { status: "unavailable"; reason: string }
  /** The definition was retrieved but GeoLibre cannot evaluate it. */
  | { status: "unsupported"; reason: ArcGISContingentValuesUnsupportedReason; detail?: string };

/** Why a retrieved definition cannot be evaluated. */
export type ArcGISContingentValuesUnsupportedReason =
  /** The response has no field groups (the format of nonhosted services). */
  | "noFieldGroups"
  /** The response does not follow the documented format. */
  | "format"
  /** More combinations than GeoLibre evaluates. */
  | "tooLarge";

/** How one field group judges a candidate record. */
export interface ArcGISContingencyCheck {
  group: string;
  fields: string[];
  restrictive: boolean;
  /**
   * `ok`: an active combination matches. `retired`: only a retired one does.
   * `violation`: none does.
   */
  status: "ok" | "retired" | "violation";
  /**
   * Whether the edit is responsible for the group's values: the record is
   * new, a value of the group changed, or the record's subtype changed. An
   * unaffected group only reports existing data.
   */
  affected: boolean;
}

/** More combinations than this make the definition `tooLarge`, rather than slow every edit. */
export const MAX_ARCGIS_CONTINGENCIES = 50_000;

const DEFAULT_TYPE_CODES = ["Unknown", "Any", "Null", "Code", "Range"];
const NUMERIC_FIELD_TYPES = new Set([
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeBigInteger",
  "esriFieldTypeSingle",
  "esriFieldTypeDouble",
]);
/** Numeric text a drafted numeric cell may still hold: plain decimals only. */
const DECIMAL_TEXT = /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/;

class UnsupportedDefinition extends Error {
  constructor(
    readonly reason: ArcGISContingentValuesUnsupportedReason,
    readonly detail?: string,
  ) {
    super(detail ?? reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-type key so the code 1 and the code "1" never collide. */
function codeKey(code: unknown): string {
  return `${typeof code}:${String(code)}`;
}

/** Every code the field's domains publish, at field level and per type/subtype. */
function publishedCodes(info: ArcGISEditInfo, field: string): Set<string> | undefined {
  const lower = field.toLowerCase();
  const codes = new Set<string>();
  let coded = false;
  const add = (domain: unknown) => {
    if (!isRecord(domain) || domain.type !== "codedValue" || !Array.isArray(domain.codedValues))
      return;
    coded = true;
    for (const entry of domain.codedValues) if (isRecord(entry)) codes.add(codeKey(entry.code));
  };
  add(info.fields?.find((entry) => entry.name.toLowerCase() === lower)?.domain);
  for (const entry of [...(info.types ?? []), ...(info.subtypes ?? [])])
    for (const [key, domain] of Object.entries(entry.domains ?? {}))
      if (key.toLowerCase() === lower) add(domain);
  return coded ? codes : undefined;
}

/** Pick this layer's definition from a layer resource or a service-wide query response. */
function layerDefinition(json: Record<string, unknown>, layerId?: number): unknown {
  if (json.contingentValuesDefinition !== undefined) return json.contingentValuesDefinition;
  const all = json.contingentValuesDefinitions;
  if (!Array.isArray(all)) return undefined;
  const matching = all.filter((entry) => isRecord(entry) && entry.layerID === layerId);
  if (matching.length === 1) return matching[0];
  return all.length === 1 && layerId === undefined ? all[0] : undefined;
}

/**
 * Decode a contingent values response into GeoLibre's model.
 *
 * @param json - The `contingentValues` resource or `queryContingentValues` response.
 * @param info - The layer's `?f=json` metadata, to resolve fields and check codes.
 * @param layerId - The layer's ID, to pick it from a service-wide response.
 * @returns The definition, or why it cannot be evaluated.
 */
export function normalizeArcGISContingentValues(
  json: unknown,
  info: ArcGISEditInfo,
  layerId?: number,
): ArcGISContingentValues {
  try {
    return { status: "ready", groups: decodeDefinition(json, info, layerId) };
  } catch (error) {
    if (error instanceof UnsupportedDefinition)
      return {
        status: "unsupported",
        reason: error.reason,
        ...(error.detail ? { detail: error.detail } : {}),
      };
    throw error;
  }
}

function decodeDefinition(
  json: unknown,
  info: ArcGISEditInfo,
  layerId: number | undefined,
): ArcGISFieldGroup[] {
  const format = (detail: string) => new UnsupportedDefinition("format", detail);
  if (!isRecord(json)) throw format("The response is not an object.");
  const definition = layerDefinition(json, layerId);
  if (!isRecord(definition)) throw format("The response has no definition for this layer.");
  if (!Array.isArray(definition.fieldGroups)) throw new UnsupportedDefinition("noFieldGroups");

  const typeCodes = Array.isArray(json.typeCodes) ? json.typeCodes : DEFAULT_TYPE_CODES;
  const dictionaries = new Map<string, unknown[]>();
  for (const entry of Array.isArray(json.stringDicts) ? json.stringDicts : [])
    if (isRecord(entry) && typeof entry.domain === "string" && Array.isArray(entry.entries))
      dictionaries.set(entry.domain, entry.entries);
  const fieldsByName = new Map(
    (info.fields ?? []).map((field) => [field.name.toLowerCase(), field]),
  );
  const codesByField = new Map<string, Set<string> | undefined>();
  let total = 0;

  return definition.fieldGroups.map((rawGroup): ArcGISFieldGroup => {
    if (!isRecord(rawGroup) || typeof rawGroup.name !== "string")
      throw format("A field group has no name.");
    const name = rawGroup.name;
    if (typeof rawGroup.restrictive !== "boolean")
      throw format(`Field group ${name} does not say whether it is restrictive.`);
    if (!Array.isArray(rawGroup.fields) || rawGroup.fields.length < 2)
      throw format(`Field group ${name} lists fewer than two fields.`);
    const fields = rawGroup.fields.map((entry) => {
      const fieldName =
        typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined;
      const field =
        typeof fieldName === "string" ? fieldsByName.get(fieldName.toLowerCase()) : undefined;
      if (!field) throw format(`Field group ${name} names a field the layer does not have.`);
      return field;
    });

    const rawLists = Array.isArray(rawGroup.subTypes)
      ? rawGroup.subTypes
      : [{ domains: rawGroup.domains, contingentValues: rawGroup.contingentValues }];
    const lists = rawLists.map((rawList): ArcGISContingencyList => {
      if (!isRecord(rawList) || !Array.isArray(rawList.contingentValues))
        throw format(`Field group ${name} has no combination list.`);
      const subtype = rawList.code;
      if (
        Array.isArray(rawGroup.subTypes) &&
        typeof subtype !== "number" &&
        typeof subtype !== "string"
      )
        throw format(`Field group ${name} lists combinations for an unnamed subtype.`);
      const domains = isRecord(rawList.domains) ? rawList.domains : {};
      const domainOf = (field: string) =>
        Object.entries(domains).find(([key]) => key.toLowerCase() === field.toLowerCase())?.[1];
      total += rawList.contingentValues.length;
      if (total > MAX_ARCGIS_CONTINGENCIES) throw new UnsupportedDefinition("tooLarge");
      const contingencies = rawList.contingentValues.map((raw): ArcGISContingency => {
        if (!isRecord(raw) || !Array.isArray(raw.types) || !Array.isArray(raw.values))
          throw format(`Field group ${name} has a malformed combination.`);
        if (raw.types.length !== fields.length)
          throw format(`A combination of field group ${name} does not cover every field.`);
        const rawValues: unknown[] = raw.values;
        let next = 0;
        const values = raw.types.map((type, index): ArcGISContingentValue => {
          const kind = typeof type === "number" ? typeCodes[type] : type;
          const field = fields[index];
          if (kind === "Any") return { kind: "any" };
          if (kind === "Null") return { kind: "null" };
          if (kind === "Range") {
            const value = rawValues[next++];
            const bounds = isRecord(value) ? value.range : value;
            if (
              !Array.isArray(bounds) ||
              bounds.length !== 2 ||
              !bounds.every((n) => typeof n === "number" && Number.isFinite(n)) ||
              bounds[0] > bounds[1]
            )
              throw format(`A range of field group ${name} is malformed.`);
            return { kind: "range", min: bounds[0], max: bounds[1] };
          }
          if (kind !== "Code") throw format(`Field group ${name} uses an unknown value type.`);
          let code = rawValues[next++];
          if (field.type === "esriFieldTypeString" && typeof code === "number") {
            // A compact response gives a text code as its position in the
            // domain's dictionary; the position is never the code itself.
            const domain = domainOf(field.name);
            const entries = typeof domain === "string" ? dictionaries.get(domain) : undefined;
            code = Number.isInteger(code) ? entries?.[code] : undefined;
            if (typeof code !== "string")
              throw format(`A text code of field ${field.name} cannot be looked up.`);
          }
          const numeric = NUMERIC_FIELD_TYPES.has(field.type);
          if (numeric ? typeof code !== "number" : typeof code !== "string")
            throw format(`A code of field ${field.name} does not have the field's type.`);
          if (!codesByField.has(field.name))
            codesByField.set(field.name, publishedCodes(info, field.name));
          const published = codesByField.get(field.name);
          if (published && !published.has(codeKey(code)))
            throw format(`A code of field ${field.name} is not in its domain.`);
          return { kind: "code", code: code as string | number };
        });
        if (next !== rawValues.length)
          throw format(`A combination of field group ${name} has unused values.`);
        return {
          ...(typeof raw.id === "number" ? { id: raw.id } : {}),
          retired: raw.retired === true || raw.retired === 1,
          values,
        };
      });
      return {
        ...(typeof subtype === "number" || typeof subtype === "string" ? { subtype } : {}),
        contingencies,
      };
    });
    return { name, restrictive: rawGroup.restrictive, fields: fields.map((f) => f.name), lists };
  });
}

/**
 * Retrieve and decode a layer's contingent values: the layer's
 * `contingentValues` resource, else the service's `queryContingentValues`
 * operation for servers without it.
 *
 * @param layerUrl - The layer's REST URL, ending in its numeric ID.
 * @param info - The layer's `?f=json` metadata.
 * @param fetchJson - Requests a URL as JSON through the layer's connection; rejects on errors.
 * @param signal - Aborts the retrieval; an aborted retrieval rejects rather than reporting `unavailable`.
 * @returns The definition, or why it is unavailable or unsupported.
 */
export async function loadArcGISContingentValues(
  layerUrl: string,
  info: ArcGISEditInfo,
  fetchJson: (url: string) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ArcGISContingentValues> {
  const url = layerUrl.replace(/\/+$/, "");
  const match = /^(.*)\/(\d+)$/.exec(url);
  const layerId = match ? Number(match[2]) : undefined;
  let json: unknown;
  try {
    json = await fetchJson(`${url}/contingentValues`);
  } catch (first) {
    if (signal?.aborted) throw first;
    if (!match) return { status: "unavailable", reason: messageOf(first) };
    try {
      json = await fetchJson(`${match[1]}/queryContingentValues?layers=${match[2]}`);
    } catch (second) {
      if (signal?.aborted) throw second;
      return { status: "unavailable", reason: messageOf(second) };
    }
  }
  return normalizeArcGISContingentValues(json, info, layerId);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A value as the field stores it: a drafted numeric field may still hold decimal text. */
function storedValue(info: ArcGISEditInfo, field: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const lower = field.toLowerCase();
  const type = info.fields?.find((entry) => entry.name.toLowerCase() === lower)?.type;
  if (
    type &&
    NUMERIC_FIELD_TYPES.has(type) &&
    typeof value === "string" &&
    DECIMAL_TEXT.test(value)
  )
    return Number(value);
  return value;
}

function slotMatches(slot: ArcGISContingentValue, value: unknown): boolean {
  switch (slot.kind) {
    case "any":
      return true;
    case "null":
      return value === null;
    case "code":
      return value !== null && codeKey(value) === codeKey(slot.code);
    case "range":
      return typeof value === "number" && value >= slot.min && value <= slot.max;
  }
}

/** Whether two subtype codes name the same subtype; metadata may report one as text. */
function sameSubtype(a: unknown, b: unknown): boolean {
  return a != null && b != null && String(a) === String(b);
}

/** The combinations of a group that govern a record of the given subtype, if any do. */
function listFor(group: ArcGISFieldGroup, subtype: unknown): ArcGISContingency[] | undefined {
  const whole = group.lists.find((list) => list.subtype === undefined);
  if (whole) return whole.contingencies;
  // Combinations defined per subtype leave other subtypes, and records with
  // no subtype, unconstrained by this group.
  return group.lists.find((list) => sameSubtype(list.subtype, subtype))?.contingencies;
}

function readyGroups(info: ArcGISEditInfo): ArcGISFieldGroup[] {
  return info.contingentValues?.status === "ready" ? info.contingentValues.groups : [];
}

/**
 * Judge a candidate record against every field group that governs it.
 *
 * A group whose fields are all empty is not evaluated: nothing has been
 * entered for it yet, and nullability is checked separately. Otherwise an
 * empty field must be matched by an `Any` or `Null` slot, and every other
 * field by its slot, all in one combination; values are never mixed across
 * combinations. A field in several groups must satisfy each of them.
 *
 * @param info - The layer's metadata, with its contingent values.
 * @param candidate - The record as edited, including unchanged fields.
 * @param baseline - The record as last read from the service, or `undefined` for a new record.
 * @returns One check per governing, populated group; empty when none applies.
 */
export function arcGISContingencyChecks(
  info: ArcGISEditInfo,
  candidate: Record<string, unknown>,
  baseline: Record<string, unknown> | null | undefined,
): ArcGISContingencyCheck[] {
  const groups = readyGroups(info);
  if (!groups.length) return [];
  const selector = arcGISSubtypeField(info);
  const subtype = selector ? storedValue(info, selector, candidate[selector]) : undefined;
  const subtypeChanged =
    baseline != null &&
    selector !== undefined &&
    codeKey(subtype) !== codeKey(storedValue(info, selector, baseline[selector]));
  const checks: ArcGISContingencyCheck[] = [];
  for (const group of groups) {
    const contingencies = listFor(group, subtype);
    if (!contingencies) continue;
    const values = group.fields.map((field) => storedValue(info, field, candidate[field]));
    if (values.every((value) => value === null)) continue;
    const affected =
      baseline == null ||
      subtypeChanged ||
      group.fields.some(
        (field, index) =>
          codeKey(values[index]) !== codeKey(storedValue(info, field, baseline[field])),
      );
    const matching = contingencies.filter((entry) =>
      entry.values.every((slot, index) => slotMatches(slot, values[index])),
    );
    checks.push({
      group: group.name,
      fields: group.fields,
      restrictive: group.restrictive,
      status: matching.some((entry) => !entry.retired)
        ? "ok"
        : matching.length
          ? "retired"
          : "violation",
      affected,
    });
  }
  return checks;
}

/**
 * Whether a check stops an edit from being saved: a restrictive group the
 * edit is responsible for that matches no active combination. A retired
 * combination stays valid on existing records but is not a new choice.
 *
 * @param check - One group's verdict.
 * @returns Whether the edit must be corrected first.
 */
export function blocksArcGISEdit(check: ArcGISContingencyCheck): boolean {
  return check.restrictive && check.affected && check.status !== "ok";
}

/**
 * Which values of a field fit the rest of a (possibly unfinished) record.
 * Empty fields of the record count as not yet entered, so this lists the
 * possible completions rather than claiming the record is valid. Only active
 * combinations are offered.
 *
 * @param info - The layer's metadata, with its contingent values.
 * @param candidate - The record as currently drafted.
 * @param field - The field whose choices are wanted.
 * @returns A predicate over stored values, or `undefined` when no field group governs the field.
 */
export function arcGISContingentChoices(
  info: ArcGISEditInfo,
  candidate: Record<string, unknown>,
  field: string,
): ((value: unknown) => boolean) | undefined {
  const groups = readyGroups(info);
  if (!groups.length) return undefined;
  const selector = arcGISSubtypeField(info);
  const subtype = selector ? storedValue(info, selector, candidate[selector]) : undefined;
  // The answer depends only on the subtype and the values of the governing
  // groups' fields, so cells that share them (every unedited row with the
  // same values, every re-render) share one scan of the combinations.
  const related = new Set(
    groups.filter((group) => group.fields.includes(field)).flatMap((g) => g.fields),
  );
  const key = JSON.stringify([
    field,
    codeKey(subtype),
    [...related].map((name) => codeKey(storedValue(info, name, candidate[name]))),
  ]);
  let cache = choiceCache.get(info);
  if (!cache) choiceCache.set(info, (cache = new Map()));
  if (cache.has(key)) return cache.get(key);
  // Bounded: a table with many distinct combinations must not grow it forever.
  if (cache.size >= MAX_CACHED_CHOICES) cache.clear();
  const choice = computeChoices(info, groups, candidate, field, subtype);
  cache.set(key, choice);
  return choice;
}

const MAX_CACHED_CHOICES = 2_000;
const choiceCache = new WeakMap<
  ArcGISEditInfo,
  Map<string, ((value: unknown) => boolean) | undefined>
>();

function computeChoices(
  info: ArcGISEditInfo,
  groups: ArcGISFieldGroup[],
  candidate: Record<string, unknown>,
  field: string,
  subtype: unknown,
): ((value: unknown) => boolean) | undefined {
  const governing: Array<{ index: number; rows: ArcGISContingency[] }> = [];
  for (const group of groups) {
    const index = group.fields.indexOf(field);
    const contingencies = index < 0 ? undefined : listFor(group, subtype);
    if (!contingencies) continue;
    const others = group.fields.map((name) => storedValue(info, name, candidate[name]));
    const rows = contingencies.filter(
      (entry) =>
        !entry.retired &&
        entry.values.every(
          (slot, slotIndex) =>
            slotIndex === index ||
            others[slotIndex] === null ||
            slotMatches(slot, others[slotIndex]),
        ),
    );
    governing.push({ index, rows });
  }
  if (!governing.length) return undefined;
  return (value) => {
    const stored = storedValue(info, field, value);
    return governing.every(({ index, rows }) =>
      rows.some((row) => slotMatches(row.values[index], stored)),
    );
  };
}

/**
 * The plain-language error for a check that blocks a save.
 *
 * @param check - A blocking check.
 * @returns The message.
 */
export function arcGISContingencyError(check: ArcGISContingencyCheck): string {
  const fields = check.fields.join(", ");
  return check.status === "retired"
    ? `The values of ${fields} are a retired combination in field group ${check.group}, which existing records may keep but edits cannot introduce.`
    : `The values of ${fields} are not an allowed combination in field group ${check.group}.`;
}
