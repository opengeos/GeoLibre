import type { Feature, GeoJsonProperties } from "geojson";
import {
  compileFeatureExpression,
  formatExpressionPreviewValue,
  isStyleSpecColor,
} from "./expressions";
import type { LayerVirtualField } from "./types";

/**
 * Virtual fields (QGIS Field Calculator → "Create virtual field", issue
 * #1321): expression-backed columns that recompute live instead of being
 * written once as static values.
 *
 * The engine mirrors the persistent-joins engine (`joins.ts`): computed
 * values are materialized into feature properties, so every consumer of
 * attributes — the attribute table, Expression Builder, data-driven styling,
 * labels, selection, export — sees the column with no further wiring.
 * Idempotency uses the same bookkeeping: each applied field records the
 * column it actually added (`addedField`), applying always strips those
 * first, and an existing column always wins a name collision (the virtual
 * field is skipped entirely), so stripping exactly restores the pre-apply
 * properties.
 *
 * Expressions are declarative MapLibre expressions compiled through the
 * style spec — never arbitrary code — so persisting them in `.geolibre.json`
 * and re-evaluating them on project load is safe (unlike the attribute
 * table's Field Calculator, whose JavaScript evaluator must never run
 * persisted expressions). Fields apply in list order and each sees the
 * columns materialized by earlier fields, so a virtual field can build on
 * another. Zoom-dependent expressions evaluate at zoom 0 and `@` variables
 * are not substituted: a virtual field is a property of the data, not of the
 * current view.
 *
 * Known trade-off, shared with the joins engine (see `joins.ts`): when a
 * layer's data is replaced wholesale, the replacement is stripped with the
 * *previous* bookkeeping. That is required because a replacement can also be
 * a write-back of the derived output (the attribute table round-trips
 * `layer.geojson`), which must not freeze a stale computed value into base
 * data — but it means a replacement dataset's own column whose name matches a
 * previously-materialized virtual column is replaced by the expression's
 * value for that column. Renaming or removing the virtual field first keeps
 * such collisions from arising.
 */

/**
 * Remove every column previously added by `fields` (per their `addedField`
 * bookkeeping) from a copy of `features`, restoring the pre-apply properties.
 * Features without any tracked column are returned unchanged (same
 * reference).
 */
export function stripVirtualFieldColumns(
  features: Feature[],
  fields: LayerVirtualField[] | undefined,
): Feature[] {
  const tracked = new Set<string>();
  for (const field of fields ?? []) {
    if (field.addedField) tracked.add(field.addedField);
  }
  if (tracked.size === 0) return features;
  return features.map((feature) => {
    const props = feature.properties;
    if (!props) return feature;
    let hasTracked = false;
    for (const key of tracked) {
      if (key in props) {
        hasTracked = true;
        break;
      }
    }
    if (!hasTracked) return feature;
    const next: GeoJsonProperties = {};
    for (const [key, value] of Object.entries(props)) {
      if (!tracked.has(key)) next[key] = value;
    }
    return { ...feature, properties: next };
  });
}

/** Result of {@link applyLayerVirtualFields}: features plus refreshed bookkeeping. */
export interface ApplyVirtualFieldsResult {
  features: Feature[];
  /** Input fields with `addedField`/`error`/`errorCount` recomputed for this run. */
  fields: LayerVirtualField[];
}

/**
 * Normalize an evaluated expression value into a property value: `undefined`
 * and non-finite numbers become null (a clean empty cell), style-spec Color
 * instances become their rgba() string (a Color object would neither
 * serialize nor display usefully), everything else passes through.
 */
function normalizeComputedValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (isStyleSpecColor(value)) return formatExpressionPreviewValue(value);
  return value;
}

/**
 * Apply `fields` in order to base (already-stripped) `features`, returning
 * new feature objects with each computed column merged into their properties.
 *
 * Semantics per field: a disabled field, an empty/colliding output name, or
 * an expression that fails to compile contributes nothing (with the compile
 * error recorded on the field); a runtime evaluation failure nulls that one
 * feature's cell and increments the field's `errorCount` instead of aborting
 * the column. Fields evaluate sequentially, so a later field's expression
 * can `["get", ...]` an earlier field's column.
 */
export function applyLayerVirtualFields(
  features: Feature[],
  fields: LayerVirtualField[] | undefined,
): ApplyVirtualFieldsResult {
  const fieldList = fields ?? [];
  const clearBookkeeping = (field: LayerVirtualField): LayerVirtualField => ({
    ...field,
    addedField: undefined,
    error: undefined,
    errorCount: undefined,
  });
  // Only bail out when no field is active. A zero-feature layer still runs
  // the per-field pass below: compiling validates the expression (so a real
  // compile error is surfaced, not swallowed) and a free name is still
  // recorded as `addedField` — otherwise an empty dataset would be
  // indistinguishable from a name collision in the UI.
  const active = fieldList.filter((field) => field.enabled !== false);
  if (active.length === 0) {
    return { features, fields: fieldList.map(clearBookkeeping) };
  }

  // Existing columns always win a name collision: a virtual field never
  // shadows a base column, a joined column, or an earlier virtual field.
  const usedNames = new Set<string>();
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) usedNames.add(key);
  }

  // One clone up front; per-field application then mutates our own copies.
  const out = features.map((feature) => ({
    ...feature,
    properties: { ...(feature.properties ?? {}) },
  }));

  const outFields = fieldList.map((field): LayerVirtualField => {
    if (field.enabled === false) return clearBookkeeping(field);
    const name = field.name.trim();
    if (!name || usedNames.has(name)) return clearBookkeeping(field);

    const compiled = compileFeatureExpression(field.expression);
    if (!compiled.ok || !compiled.evaluate) {
      return {
        ...clearBookkeeping(field),
        error: compiled.errors[0] ?? "Invalid expression",
      };
    }

    usedNames.add(name);
    let errorCount = 0;
    for (const feature of out) {
      let value: unknown = null;
      try {
        value = normalizeComputedValue(compiled.evaluate(feature));
      } catch {
        errorCount += 1;
      }
      feature.properties[name] = value;
    }
    return {
      ...clearBookkeeping(field),
      addedField: name,
      ...(errorCount > 0 ? { errorCount } : {}),
    };
  });

  return { features: out, fields: outFields };
}
