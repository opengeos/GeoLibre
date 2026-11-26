// Attribute table edit drafts: parsing, applying drafts to features and DuckDB rows, form validation and ArcGIS contingency notices.

import {
  coerceAttributeFormValue,
  mergeAttributeFormConfigs,
  stampFeaturePropertiesEditorTracking,
  validateAttributeFormValues,
  type AttributeTableDrafts as AttributeDrafts,
  type AttributeTableDraftTarget,
  type AttributeFormConfig,
  type AttributeFormFieldConfig,
  type AttributeFormFieldError,
  type EditorTrackingStampOptions,
} from "@geolibre/core";
import { arcGISAttributeConstraints } from "@geolibre/plugins/arcgis-layer";
import { blocksArcGISEdit } from "@geolibre/plugins/arcgis-contingent-values";
import type { ArcGISContingencyCheck, DuckDBAttributeRow } from "@geolibre/plugins";
import type { Feature } from "geojson";
import { inferColumnTypes } from "../../../lib/attribute-columns";

export type AttributeTableRow = {
  featureId: string;
  properties: Record<string, unknown>;
};

function parseAttributeDraft(draft: string, previousValue: unknown, columnType?: string): unknown {
  if (draft.trim() === "") return null;

  // An empty cell carries no type of its own, so fall back to what the rest of
  // the column holds; only a column with no values anywhere keeps the raw string.
  if (previousValue == null) {
    if (columnType === "number") {
      const nextValue = Number(draft);
      return Number.isFinite(nextValue) ? nextValue : draft;
    }
    if (columnType === "boolean") {
      const normalized = draft.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
      return draft;
    }
    return draft;
  }

  if (typeof previousValue === "number") {
    const nextValue = Number(draft);
    return Number.isFinite(nextValue) ? nextValue : draft;
  }

  if (typeof previousValue === "boolean") {
    const normalized = draft.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return draft;
  }

  if (typeof previousValue === "object") {
    try {
      return JSON.parse(draft);
    } catch {
      return draft;
    }
  }

  return draft;
}

export function isInvalidObjectDraft(draft: string, previousValue: unknown): boolean {
  if (typeof previousValue !== "object" || previousValue == null) return false;
  if (draft.trim() === "") return false;
  try {
    JSON.parse(draft);
    return false;
  } catch {
    return true;
  }
}

/**
 * Serialize a draft target for comparison. DuckDB BIGINT columns hold BigInts,
 * which JSON.stringify rejects. Encode them as an object under a NUL-prefixed
 * key no real column carries, so `1n` never matches the string "1n" or "1".
 */
export function draftTargetJson(target: AttributeTableDraftTarget): string {
  return JSON.stringify(target, (_key, value: unknown) =>
    typeof value === "bigint" ? { "\u0000bigint": value.toString() } : value,
  );
}

/** Look up a row by its literal feature ID without inheriting Object members. */
export function getAttributeDraftRow(drafts: AttributeDrafts, featureId: string) {
  return Object.hasOwn(drafts, featureId) ? drafts[featureId] : undefined;
}

export function hasDraftEdits(drafts: AttributeDrafts): boolean {
  return Object.values(drafts).some((columns) => Object.keys(columns).length > 0);
}

/**
 * The effective Attribute Form for one record: the layer's designer config
 * merged with the constraints its data service publishes for that record
 * (ArcGIS domains, which can depend on the record's type/subtype).
 */
interface RowForm {
  form?: AttributeFormConfig;
  fields: Map<string, AttributeFormFieldConfig>;
  /** Service-published constraints, enforced even on fields the form hides. */
  serviceForm?: AttributeFormConfig;
  /** Field whose value selects the record's service constraints. */
  selectorField?: string;
}

type RowFormResolver = (properties: Record<string, unknown>) => RowForm;

const EMPTY_ROW_FORM: RowForm = { fields: new Map() };

function toRowForm(
  form: AttributeFormConfig | undefined,
  serviceForm?: AttributeFormConfig,
  selectorField?: string,
): RowForm {
  if (!form?.fields.length) return EMPTY_ROW_FORM;
  return {
    form,
    fields: new Map(form.fields.map((entry) => [entry.field, entry])),
    serviceForm,
    selectorField,
  };
}

/**
 * Build the per-record form resolver. Without service constraints every row
 * shares the designer form. Otherwise rows are merged once per distinct
 * service form, which the ArcGIS adapter memoizes per type/subtype value.
 */
export function makeRowFormResolver(
  attributeForm: AttributeFormConfig | undefined,
  constraints: ReturnType<typeof arcGISAttributeConstraints>,
): RowFormResolver {
  const plain = toRowForm(attributeForm);
  if (!constraints) return () => plain;
  const merged = new Map<AttributeFormConfig | undefined, RowForm>();
  return (properties) => {
    const service = constraints.formFor(properties);
    let rowForm = merged.get(service);
    if (!rowForm) {
      rowForm = service
        ? toRowForm(
            mergeAttributeFormConfigs(attributeForm, service),
            service,
            constraints.subtypeField,
          )
        : plain;
      merged.set(service, rowForm);
    }
    return rowForm;
  };
}

/**
 * Apply one row's drafts to its properties. Coercion depends on the row's
 * form, which can depend on a drafted type/subtype, so a row whose drafts
 * select different constraints is coerced again under them.
 */
export function draftCandidate(
  properties: Record<string, unknown>,
  rowDrafts: Record<string, string>,
  formForRow: RowFormResolver,
  columnTypes?: ReturnType<typeof inferColumnTypes>,
): { candidate: Record<string, unknown>; rowForm: RowForm } {
  const coerce = (rowForm: RowForm) => {
    const candidate = { ...properties };
    for (const [column, draft] of Object.entries(rowDrafts)) {
      const previousValue = properties[column];
      // Skip drafts that are invalid JSON for an object-typed cell so we never
      // persist or export a type-corrupted value; the existing value is kept.
      if (isInvalidObjectDraft(draft, previousValue)) continue;
      // A column with an Attribute Form widget coerces by widget type (a
      // number widget stores a number even into a previously-null cell);
      // unconfigured columns keep the previous-value type inference.
      const config = rowForm.fields.get(column);
      candidate[column] = config
        ? coerceAttributeFormValue(config, draft)
        : parseAttributeDraft(draft, previousValue, columnTypes?.get(column));
    }
    return candidate;
  };
  let rowForm = formForRow(properties);
  let candidate = coerce(rowForm);
  const next = formForRow(candidate);
  if (next !== rowForm) {
    rowForm = next;
    candidate = coerce(rowForm);
  }
  return { candidate, rowForm };
}

export function applyDraftsToFeatures(
  features: Feature[],
  drafts: AttributeDrafts,
  formForRow: RowFormResolver,
  tracking?: EditorTrackingStampOptions,
): Feature[] {
  // Derived from the whole collection, so an edit to an empty cell adopts the
  // column's type rather than the cell's (absent) one.
  const columnTypes = inferColumnTypes(features.map((feature) => feature.properties));
  return features.map((feature, index) => {
    const featureId = String(feature.id ?? index);
    const rowDrafts = getAttributeDraftRow(drafts, featureId);
    if (!rowDrafts) return feature;

    let properties = draftCandidate(
      feature.properties ?? {},
      rowDrafts,
      formForRow,
      columnTypes,
    ).candidate;

    // Only the rows that carried a draft reach here, so this stamps exactly the
    // features the user edited. Passed only on save — the export preview runs
    // the same transform and must not record an edit that never happened.
    if (tracking) {
      properties = stampFeaturePropertiesEditorTracking(properties, "update", tracking);
    }

    return { ...feature, properties };
  });
}

/**
 * Validate drafted rows against the layer's Attribute Form config. Only edits
 * that introduce (or keep, on an edited field) a violation are reported —
 * pre-existing violations on untouched fields never block an unrelated edit.
 * Iterates the drafts (few rows), not the whole table; `featureById` is the
 * memoized feature index so no per-keystroke full scan happens here. Returns
 * featureId → field → error for every blocking violation.
 */
export function computeFormDraftErrors(
  formForRow: RowFormResolver,
  drafts: AttributeDrafts,
  featureById: Map<string, Feature> | null,
  contingencies?: ContingencyContext,
): Record<string, Record<string, AttributeFormFieldError>> {
  const result: Record<string, Record<string, AttributeFormFieldError>> = {};
  if (!featureById || !hasDraftEdits(drafts)) {
    return result;
  }

  for (const [featureId, rowDrafts] of Object.entries(drafts)) {
    if (Object.keys(rowDrafts).length === 0) continue;
    const feature = featureById.get(featureId);
    if (!feature) continue;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;

    const { candidate, rowForm } = draftCandidate(properties, rowDrafts, formForRow);
    // A restrictive field group the draft changed must hold an active
    // combination; the error marks every field of the group, since any of
    // them can be the one to correct.
    const groupErrors: Record<string, AttributeFormFieldError> = {};
    for (const check of contingencies?.checks(candidate, properties) ?? [])
      if (blocksArcGISEdit(check))
        for (const field of check.fields)
          groupErrors[field] ??= {
            code: "constraint",
            message: contingencies!.message(check),
          };
    if (Object.keys(groupErrors).length) result[featureId] = groupErrors;
    const validation = validateAttributeFormValues(rowForm.form, candidate, {
      feature,
      serviceForm: rowForm.serviceForm,
    });
    if (validation.ok) continue;

    const baselineForm = formForRow(properties);
    const baseline = validateAttributeFormValues(baselineForm.form, properties, {
      feature,
      serviceForm: baselineForm.serviceForm,
    });
    // A changed type/subtype revalidates every field whose service domain it
    // governs, even untouched ones: their values are kept but must fit.
    const selectorChanged =
      rowForm.selectorField !== undefined &&
      candidate[rowForm.selectorField] !== properties[rowForm.selectorField];
    const serviceFields = new Set(rowForm.serviceForm?.fields.map((entry) => entry.field));
    const rowErrors: Record<string, AttributeFormFieldError> = {};
    for (const [field, error] of Object.entries(validation.errors)) {
      if (
        rowDrafts[field] !== undefined ||
        !baseline.errors[field] ||
        (selectorChanged && serviceFields.has(field))
      ) {
        rowErrors[field] = error;
      }
    }
    if (Object.keys(rowErrors).length > 0)
      result[featureId] = { ...result[featureId], ...rowErrors };
  }
  return result;
}

/** The layer's contingent values, as the draft validation consumes them. */
export interface ContingencyContext {
  checks: NonNullable<ReturnType<typeof arcGISAttributeConstraints>>["contingencyChecks"];
  message: (check: ArcGISContingencyCheck) => string;
}

/**
 * Field groups the drafts leave outside their combinations without blocking
 * the save: advisory groups the drafts changed, and existing combinations of
 * the drafted rows that the drafts did not touch.
 */
export function contingencyNotices(
  drafts: AttributeDrafts,
  featureById: Map<string, Feature> | null,
  formForRow: RowFormResolver,
  checks: ContingencyContext["checks"],
): Array<{ featureId: string; check: ArcGISContingencyCheck }> {
  const notices: Array<{ featureId: string; check: ArcGISContingencyCheck }> = [];
  if (!featureById) return notices;
  for (const [featureId, rowDrafts] of Object.entries(drafts)) {
    const feature = featureById.get(featureId);
    if (!feature || Object.keys(rowDrafts).length === 0) continue;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const { candidate } = draftCandidate(properties, rowDrafts, formForRow);
    for (const check of checks(candidate, properties))
      if (check.status !== "ok" && !blocksArcGISEdit(check)) notices.push({ featureId, check });
  }
  return notices;
}

export function duckDBRowsToAttributeRows(rows: DuckDBAttributeRow[]): AttributeTableRow[] {
  return rows.map((row) => ({
    featureId: row.featureId,
    properties: row.properties,
  }));
}

export function applyDraftsToDuckDBRows(
  rows: AttributeTableRow[],
  drafts: AttributeDrafts,
): Record<string, Record<string, unknown>> {
  const rowById = new Map(rows.map((row) => [row.featureId, row]));
  const updates: Record<string, Record<string, unknown>> = {};
  // Same column-level inference as the GeoJSON path, over the query's rows.
  const columnTypes = inferColumnTypes(rows.map((row) => row.properties));

  for (const [featureId, rowDrafts] of Object.entries(drafts)) {
    const row = rowById.get(featureId);
    if (!row) continue;

    const properties: Record<string, unknown> = {};
    for (const [column, draft] of Object.entries(rowDrafts)) {
      const previousValue = row.properties[column];
      if (isInvalidObjectDraft(draft, previousValue)) continue;
      properties[column] = parseAttributeDraft(draft, previousValue, columnTypes.get(column));
    }

    if (Object.keys(properties).length > 0) updates[featureId] = properties;
  }

  return updates;
}
