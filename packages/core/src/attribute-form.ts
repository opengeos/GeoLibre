/**
 * Pure helpers for the Attribute Form designer (#1322): coercing raw form
 * strings into widget-typed values, validating values against per-field rules
 * (required, numeric bounds, value maps, boolean constraint expressions), and
 * evaluating conditional field visibility.
 *
 * The designer UI (layer properties → Attributes Form) authors an
 * {@link AttributeFormConfig} stored on the layer; the attribute editing
 * surfaces (attribute table inline editor, Field Collection capture form) call
 * these helpers so both enforce the same rules. Everything here is side-effect
 * free so it can be unit tested without a DOM or the app store.
 *
 * Constraint and visibility expressions are MapLibre expressions compiled and
 * evaluated through `expressions.ts` (the same engine as the Expression
 * Builder), always with `expectedType: "boolean"`.
 */
import type { Feature } from "geojson";
import { evaluateMapExpression } from "./expressions";
import type {
  AttributeFormConfig,
  AttributeFormFieldConfig,
  AttributeFormValueMapEntry,
} from "./types";

/** Options threaded to expression evaluation (constraints, visibility). */
export interface AttributeFormEvalOptions {
  /** Map zoom for `["zoom"]` in expressions; defaults to 0. */
  zoom?: number;
  /**
   * Constraints a data service enforces regardless of the form's
   * presentation (ArcGIS domains). A field the form hides is still checked
   * against its entry here, so a visibility rule cannot let an invalid value
   * reach the service.
   */
  serviceForm?: AttributeFormConfig;
  /**
   * Real feature backing the properties, when the caller has one — its
   * geometry feeds `["geometry-type"]` and geometry-aware operators. Its
   * `properties` are ignored in favor of the candidate record being
   * validated.
   */
  feature?: Feature;
}

/** Why a field's value was rejected; codes map to localized messages. */
export interface AttributeFormFieldError {
  code: "required" | "number" | "integer" | "text" | "range" | "valueMap" | "constraint";
  /**
   * For `constraint`: the author's `constraintDescription`, or the
   * expression's own error text when it failed to evaluate.
   */
  message?: string;
  /** Bounds echoed back for `range` error messages. */
  min?: number;
  max?: number;
}

/** Outcome of validating a whole properties record against a form config. */
export interface AttributeFormValidation {
  ok: boolean;
  /** Field name → error for every failing, visible, configured field. */
  errors: Record<string, AttributeFormFieldError>;
}

/** Look up the configuration for a field, if any. */
export function getAttributeFormField(
  form: AttributeFormConfig | undefined,
  field: string,
): AttributeFormFieldConfig | undefined {
  return form?.fields.find((entry) => entry.field === field);
}

/** The label attribute forms should show for a configured field. */
export function attributeFormFieldLabel(config: AttributeFormFieldConfig): string {
  return config.alias?.trim() || config.field;
}

/**
 * Parse the designer's value-map text — one entry per line, `value=label` or
 * just `value` — into entries. Blank lines and duplicate values are dropped.
 */
export function parseValueMapText(text: string): AttributeFormValueMapEntry[] {
  const seen = new Set<string>();
  const entries: AttributeFormValueMapEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const value = (eq >= 0 ? trimmed.slice(0, eq) : trimmed).trim();
    const label = eq >= 0 ? trimmed.slice(eq + 1).trim() : "";
    if (!value || seen.has(value)) continue;
    seen.add(value);
    entries.push(label && label !== value ? { value, label } : { value });
  }
  return entries;
}

/** Serialize value-map entries back into the designer's editable text form. */
export function valueMapToText(entries: readonly AttributeFormValueMapEntry[] | undefined): string {
  return (entries ?? [])
    .map((entry) =>
      entry.label && entry.label !== entry.value ? `${entry.value}=${entry.label}` : entry.value,
    )
    .join("\n");
}

/** Display label for a stored value under a value-map widget. */
export function valueMapLabelFor(config: AttributeFormFieldConfig, value: unknown): string {
  const text = value == null ? "" : String(value);
  const entry = config.valueMap?.find((candidate) => candidate.value === text);
  return entry?.label ?? text;
}

/**
 * Coerce a raw form string into the typed value the widget stores on the
 * feature. An empty/blank string means "no value" (`null`). A `number`/`range`
 * string that does not parse is returned verbatim so validation can flag it
 * instead of silently dropping the input.
 */
export function coerceAttributeFormValue(config: AttributeFormFieldConfig, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (config.valueType) {
    // A declared type wins over the widget heuristics below. A value-map pick
    // is kept verbatim so a code with surrounding spaces still matches.
    const picked =
      config.widget === "valueMap" && config.valueMap?.some((entry) => entry.value === raw)
        ? raw
        : trimmed;
    if (config.valueType === "string") return picked;
    const parsed = Number(picked);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (config.widget === "number" || config.widget === "range") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (config.widget === "checkbox") {
    const normalized = trimmed.toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return raw;
  }
  // A value map whose entries are all canonical numeric codes stores numbers,
  // so an edited row keeps the same property type as untouched rows (strict-
  // equality style/filter expressions would otherwise silently miss edited
  // features). Canonical means the string round-trips through Number ("1",
  // "-2", "3.5") — zero-padded or exotic forms like "01" or "1e3" are
  // identifiers, not numbers, and stay strings so the membership check in
  // validateAttributeFormField keeps matching the entry verbatim.
  if (
    config.widget === "valueMap" &&
    config.valueMap?.length &&
    config.valueMap.every((entry) => String(Number(entry.value)) === entry.value)
  ) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  // text, date (ISO yyyy-mm-dd string), and valueMap store the string verbatim.
  return trimmed;
}

/**
 * Whether a configured field is currently shown, given the form's candidate
 * properties. An empty, invalid, or erroring visibility expression fails open
 * (visible) so a typo cannot hide data entry.
 */
export function isAttributeFormFieldVisible(
  config: AttributeFormFieldConfig,
  properties: Record<string, unknown>,
  options: AttributeFormEvalOptions = {},
): boolean {
  const source = config.visibilityExpression?.trim();
  if (!source) return true;
  const result = evaluateMapExpression(source, {
    feature: featureForEvaluation(properties, options.feature),
    zoom: options.zoom,
    expectedType: "boolean",
  });
  return result.kind === "value" ? result.value === true : true;
}

/**
 * Validate one configured field against the candidate properties record (the
 * field's own candidate value lives at `properties[config.field]`). Returns
 * `null` when the value passes. Checks run in order: required, widget typing,
 * numeric bounds, value-map membership, then the constraint expression — the
 * constraint sees the whole record, so cross-field rules work.
 */
export function validateAttributeFormField(
  config: AttributeFormFieldConfig,
  properties: Record<string, unknown>,
  options: AttributeFormEvalOptions = {},
): AttributeFormFieldError | null {
  const value = properties[config.field];
  const empty = value == null || value === "";

  if (empty) {
    // An unchecked checkbox is a valid false-like state, not a missing value —
    // requiring it would block every save with a confusing "value required".
    if (config.required && config.widget !== "checkbox") return { code: "required" };
  } else {
    if (config.valueType === "string" && typeof value !== "string") return { code: "text" };
    if (config.valueType === "number" || config.valueType === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) return { code: "number" };
      if (config.valueType === "integer" && !Number.isSafeInteger(value))
        return { code: "integer" };
    }
    if (config.widget === "number" || config.widget === "range") {
      const numeric = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numeric)) return { code: "number" };
      if (
        (config.min != null && numeric < config.min) ||
        (config.max != null && numeric > config.max)
      ) {
        return { code: "range", min: config.min, max: config.max };
      }
    }
    if (
      config.widget === "valueMap" &&
      config.valueMap?.length &&
      !config.valueMap.some((entry) => entry.value === String(value))
    ) {
      return { code: "valueMap" };
    }
  }

  const source = config.constraintExpression?.trim();
  if (source) {
    const result = evaluateMapExpression(source, {
      feature: featureForEvaluation(properties, options.feature),
      zoom: options.zoom,
      expectedType: "boolean",
    });
    if (result.kind === "error") {
      // An unevaluable constraint cannot be verified, so the value is
      // rejected — surfacing the compile/runtime message rather than
      // silently accepting data the author meant to gate.
      return { code: "constraint", message: (result.errors ?? []).join("; ") };
    }
    if (result.kind === "value" && result.value !== true) {
      return {
        code: "constraint",
        ...(config.constraintDescription ? { message: config.constraintDescription } : {}),
      };
    }
  }

  return null;
}

/**
 * Validate a whole candidate properties record against a form config. Hidden
 * fields (visibility expression currently false) skip the form's own rules —
 * a field the form does not show cannot block a save — but are still checked
 * against `options.serviceForm`, whose constraints the data service enforces.
 */
export function validateAttributeFormValues(
  form: AttributeFormConfig | undefined,
  properties: Record<string, unknown>,
  options: AttributeFormEvalOptions = {},
): AttributeFormValidation {
  const errors: Record<string, AttributeFormFieldError> = {};
  const checked = new Set<string>();
  for (const config of form?.fields ?? []) {
    if (!isAttributeFormFieldVisible(config, properties, options)) continue;
    checked.add(config.field);
    const error = validateAttributeFormField(config, properties, options);
    if (error) errors[config.field] = error;
  }
  for (const config of options.serviceForm?.fields ?? []) {
    if (checked.has(config.field)) continue;
    const error = validateAttributeFormField(config, properties, options);
    if (error) errors[config.field] = error;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Combine a layer's designer-authored form with the constraints its data
 * service publishes (for example ArcGIS coded-value and range domains) into
 * the form the editing surfaces use. The author's presentation choices
 * (alias, visibility, constraint expression, a narrower value map or bounds)
 * survive, but never widen what the service accepts: a service value map
 * forces the value-map widget and keeps only author entries the service also
 * lists (all service entries when none overlap), bounds take the tighter of
 * each side, and the service's declared value type always applies.
 *
 * @param form - The layer's designer-authored config, if any.
 * @param service - Service-derived configs, if the layer has any.
 * @returns The effective config, or `form` itself when there is no service form.
 */
export function mergeAttributeFormConfigs(
  form: AttributeFormConfig | undefined,
  service: AttributeFormConfig | undefined,
): AttributeFormConfig | undefined {
  if (!service?.fields.length) return form;
  const serviceFields = new Map(service.fields.map((entry) => [entry.field, entry]));
  const fields: AttributeFormFieldConfig[] = [];
  for (const own of form?.fields ?? []) {
    const constraint = serviceFields.get(own.field);
    serviceFields.delete(own.field);
    fields.push(constraint ? mergeAttributeFormField(own, constraint) : own);
  }
  fields.push(...serviceFields.values());
  return { fields };
}

function mergeAttributeFormField(
  own: AttributeFormFieldConfig,
  service: AttributeFormFieldConfig,
): AttributeFormFieldConfig {
  const merged: AttributeFormFieldConfig = { ...own, valueType: service.valueType };
  if (!own.alias?.trim() && service.alias) merged.alias = service.alias;
  if (service.required) merged.required = true;
  if (service.widget === "valueMap" && service.valueMap) {
    const allowed = new Map(service.valueMap.map((entry) => [entry.value, entry]));
    const narrowed =
      own.widget === "valueMap"
        ? (own.valueMap ?? [])
            .filter((entry) => allowed.has(entry.value))
            .map((entry) => ({
              value: entry.value,
              label: entry.label ?? allowed.get(entry.value)!.label,
            }))
        : [];
    merged.widget = "valueMap";
    merged.valueMap = narrowed.length ? narrowed : service.valueMap;
    delete merged.min;
    delete merged.max;
    delete merged.step;
    return merged;
  }
  if (own.widget !== "number" && own.widget !== "range") {
    merged.widget = service.widget;
    delete merged.valueMap;
  }
  merged.min = tighter(own.min, service.min, Math.max);
  merged.max = tighter(own.max, service.max, Math.min);
  if (merged.min === undefined) delete merged.min;
  if (merged.max === undefined) delete merged.max;
  return merged;
}

function tighter(
  a: number | undefined,
  b: number | undefined,
  pick: (a: number, b: number) => number,
): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return pick(a, b);
}

/**
 * Build the feature handed to expression evaluation: the caller's real
 * feature geometry when available (so `["geometry-type"]` works), always with
 * the candidate properties being validated.
 */
function featureForEvaluation(
  properties: Record<string, unknown>,
  feature: Feature | undefined,
): Feature {
  return {
    type: "Feature",
    geometry: feature?.geometry ?? { type: "Point", coordinates: [0, 0] },
    ...(feature?.id !== undefined ? { id: feature.id } : {}),
    properties: properties as Feature["properties"],
  };
}
