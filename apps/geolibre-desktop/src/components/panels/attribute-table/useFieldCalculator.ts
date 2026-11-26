import { useMemo } from "react";
import { calculateField } from "../../../lib/attribute-columns";
import { markAttributeEdit } from "../../../lib/edited-geometry-save";
import { coerceComputedValue, compileExpression } from "../../../lib/attribute-expression";
import {
  AREA_UNITS,
  detectGeometryFamilies,
  DISTANCE_UNITS,
  type GeometryMetric,
} from "../../../lib/geometry-measure";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { Geometry, GeoJsonProperties, Feature } from "geojson";
import type { TFunction } from "i18next";
import type { CalcOutputType } from "../../../lib/attribute-expression";
import type { GeoLibreLayer } from "@geolibre/core";
import type { AttributeTableRow } from "./attribute-drafts";

/** The field calculator's live preview of the expression against a sample row. */
export type CalcPreview =
  | { kind: "empty" }
  | { kind: "ok"; value: unknown }
  | { kind: "syntax"; message: string }
  | { kind: "runtime"; message: string };

/**
 * The attribute table's field calculator: target columns, geometry metrics and units, the expression preview against a sample row, and applying the calculation.
 */
export function useFieldCalculator({
  discoveredColumns,
  readOnlyColumns,
  setCalcMode,
  setCalcTargetField,
  setCalcNewName,
  setCalcOutputType,
  setCalcExpression,
  setCalcSelectedOnly,
  setCalcError,
  features,
  setCalcGeomMetric,
  setCalcGeomUnit,
  setCalcOpen,
  calcExpressionRef,
  layer,
  calcOpen,
  calcGeomMetric,
  calcGeomUnit,
  calcNewName,
  calcMode,
  mutationColumns,
  isReservedFieldName,
  calcTargetField,
  selectedFeatureIds,
  calcSelectedOnly,
  attributeRows,
  selectedFeatureId,
  calcExpression,
  calcOutputType,
  t,
  canManageColumns,
  updateLayer,
}: {
  discoveredColumns: string[];
  readOnlyColumns: Set<string>;
  setCalcMode: Dispatch<SetStateAction<"update" | "create">>;
  setCalcTargetField: Dispatch<SetStateAction<string>>;
  setCalcNewName: Dispatch<SetStateAction<string>>;
  setCalcOutputType: Dispatch<SetStateAction<CalcOutputType>>;
  setCalcExpression: Dispatch<SetStateAction<string>>;
  setCalcSelectedOnly: Dispatch<SetStateAction<boolean>>;
  setCalcError: Dispatch<SetStateAction<string | null>>;
  features: Feature<Geometry, GeoJsonProperties>[];
  setCalcGeomMetric: Dispatch<SetStateAction<GeometryMetric>>;
  setCalcGeomUnit: Dispatch<SetStateAction<string>>;
  setCalcOpen: Dispatch<SetStateAction<boolean>>;
  calcExpressionRef: RefObject<HTMLTextAreaElement | null>;
  layer: GeoLibreLayer | undefined;
  calcOpen: boolean;
  calcGeomMetric: GeometryMetric;
  calcGeomUnit: string;
  calcNewName: string;
  calcMode: "update" | "create";
  mutationColumns: string[];
  isReservedFieldName: (name: string) => boolean;
  calcTargetField: string;
  selectedFeatureIds: string[];
  calcSelectedOnly: boolean;
  attributeRows: AttributeTableRow[];
  selectedFeatureId: string | null;
  calcExpression: string;
  calcOutputType: CalcOutputType;
  t: TFunction<"translation", undefined>;
  canManageColumns: boolean;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
}) {
  // The Field Calculator must not target a derived column (joined or virtual)
  // either: the calculated value would be overwritten by the re-derivation in
  // the same store update.
  const calculatorTargetColumns = discoveredColumns.filter((col) => !readOnlyColumns.has(col));
  const openCalculator = () => {
    const hasColumns = calculatorTargetColumns.length > 0;
    setCalcMode(hasColumns ? "update" : "create");
    setCalcTargetField(hasColumns ? calculatorTargetColumns[0] : "");
    setCalcNewName("");
    setCalcOutputType("auto");
    setCalcExpression("");
    setCalcSelectedOnly(false);
    setCalcError(null);
    // Seed the geometry measurement to a metric that suits the layer; the
    // effective-metric fallback still corrects any mismatch on render.
    const families = detectGeometryFamilies(features);
    const lineOnly = families.has("line") && !families.has("polygon");
    setCalcGeomMetric(lineOnly ? "length" : "area");
    setCalcGeomUnit(lineOnly ? "meters" : "square-meters");
    setCalcOpen(true);
  };
  // Insert a field reference (or function call) into the expression at the
  // caret, then restore focus so chips can be clicked without losing position.
  // `caretOffset` overrides where the caret lands relative to the inserted text
  // (default: at its end) — function chips use it to land inside the parens.
  const insertExpressionSnippet = (snippet: string, caretOffset?: number) => {
    const el = calcExpressionRef.current;
    if (!el) {
      setCalcExpression((current) => current + snippet);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + snippet + el.value.slice(end);
    // Write the DOM value and caret synchronously, then sync React state. Doing
    // this in a deferred rAF let a rapid second chip click read a stale caret
    // (still 0) and splice at the wrong offset.
    el.value = next;
    const caret = start + (caretOffset ?? snippet.length);
    el.focus();
    el.setSelectionRange(caret, caret);
    setCalcExpression(next);
  };
  // Geometry family drives which measurements the calculator offers: a polygon
  // layer gets Area/Perimeter, a line layer gets Length, a mixed layer gets all
  // three, and point/geometry-less layers get none (the row is hidden).
  const calcGeometryFamilies = useMemo(
    () => detectGeometryFamilies(features),
    // Recompute when the layer or its feature count changes, and each time the
    // dialog opens, so a geometry-type edit made while it was closed is picked
    // up. The families are otherwise stable across renders (and the calc dialog
    // is modal, so geometry cannot be edited while it is open). eslint can't see
    // that the array identity of `features` alone is not a meaningful dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer?.id, features.length, calcOpen],
  );
  const calcAvailableMetrics = useMemo<GeometryMetric[]>(() => {
    // Offer only metrics the layer's geometry actually supports, so a mixed
    // point+line layer gets Length but not a no-op Area.
    const metrics: GeometryMetric[] = [];
    if (calcGeometryFamilies.has("polygon")) metrics.push("area", "perimeter");
    if (calcGeometryFamilies.has("line")) metrics.push("length");
    return metrics;
  }, [calcGeometryFamilies]);
  // Fall back to the first available metric/unit when the current selection is
  // not valid for this layer (e.g. an "area" choice carried over to a line layer).
  const calcEffectiveMetric = calcAvailableMetrics.includes(calcGeomMetric)
    ? calcGeomMetric
    : (calcAvailableMetrics[0] ?? "length");
  const calcGeomUnitOptions = calcEffectiveMetric === "area" ? AREA_UNITS : DISTANCE_UNITS;
  const calcEffectiveUnit = (calcGeomUnitOptions as readonly string[]).includes(calcGeomUnit)
    ? calcGeomUnit
    : calcGeomUnitOptions[0];
  const insertGeometrySnippet = () => {
    const snippet = `$${calcEffectiveMetric}(${JSON.stringify(calcEffectiveUnit)})`;
    insertExpressionSnippet(snippet);
  };
  const calcNewNameTrimmed = calcNewName.trim();
  const calcNameCollides =
    calcMode === "create" &&
    calcNewNameTrimmed !== "" &&
    mutationColumns.includes(calcNewNameTrimmed);
  const calcNameReserved = calcMode === "create" && isReservedFieldName(calcNewNameTrimmed);
  const calcHasTarget =
    calcMode === "create"
      ? calcNewNameTrimmed !== "" && !calcNameCollides && !calcNameReserved
      : calcTargetField !== "" && !isReservedFieldName(calcTargetField);
  const calcHasSelection = selectedFeatureIds.length > 0;
  // Live preview of the expression against a sample feature: the selected row
  // when present (and a single feature is targeted), else the first row. A
  // syntax error blocks submission; a runtime error on the sample does not,
  // since other features may still evaluate cleanly.
  const calcSampleRow =
    (calcSelectedOnly && calcHasSelection
      ? attributeRows.find((row) => row.featureId === selectedFeatureId)
      : undefined) ?? attributeRows[0];
  const calcSampleIndex = calcSampleRow ? attributeRows.indexOf(calcSampleRow) : -1;
  // Stable string keys so the memo skips recompiling the expression on renders
  // that don't change the inputs (discoveredColumns / the sample row are rebuilt
  // with fresh identities every render, so they can't be deps directly).
  // Only serialize while the dialog is open — these exist solely as stable memo
  // deps, and the memo short-circuits to "empty" when closed anyway.
  const calcColumnsKey = calcOpen ? JSON.stringify(discoveredColumns) : "";
  const calcSampleKey = calcOpen && calcSampleRow ? JSON.stringify(calcSampleRow.properties) : "";
  // The preview feeds the sample feature's geometry to $length/$perimeter/$area,
  // so key on the geometry too — a geometry change (not just a property change)
  // must recompute the preview. Only one feature is serialized, and only while
  // the dialog is open.
  const calcSampleGeomKey =
    calcOpen && calcSampleRow ? JSON.stringify(features[calcSampleIndex]?.geometry ?? null) : "";
  const calcPreview = useMemo<CalcPreview>(() => {
    if (!calcOpen || calcExpression.trim() === "") return { kind: "empty" };
    try {
      const compiled = compileExpression(calcExpression, discoveredColumns);
      if (!calcSampleRow) return { kind: "ok", value: null };
      try {
        // attributeRows map 1:1 to geojson features by index, so the sample
        // row's geometry drives the $length/$perimeter/$area helpers in the
        // preview (undefined for DuckDB layers, which the helpers treat as 0).
        const raw = compiled.evaluate(
          calcSampleRow.properties,
          calcSampleIndex,
          features[calcSampleIndex]?.geometry,
        );
        return { kind: "ok", value: coerceComputedValue(raw, calcOutputType) };
      } catch (error) {
        return {
          kind: "runtime",
          message: error instanceof Error ? error.message : t("attributeTable.evaluationFailed"),
        };
      }
    } catch (error) {
      return {
        kind: "syntax",
        message: error instanceof Error ? error.message : t("attributeTable.invalidExpression"),
      };
    }
    // Keyed on the stable strings above rather than the rebuilt arrays/objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    calcOpen,
    calcExpression,
    calcOutputType,
    calcColumnsKey,
    calcSampleKey,
    calcSampleGeomKey,
    calcSampleIndex,
  ]);
  const calcCanSubmit =
    features.length > 0 &&
    calcHasTarget &&
    calcExpression.trim() !== "" &&
    calcPreview.kind !== "syntax";
  const confirmCalculate = () => {
    if (!layer || !canManageColumns || !calcCanSubmit) return;
    const targetName = calcMode === "create" ? calcNewNameTrimmed : calcTargetField;
    const scope =
      calcSelectedOnly && selectedFeatureIds.length > 0 ? new Set(selectedFeatureIds) : undefined;
    const result = calculateField(
      layer,
      mutationColumns,
      targetName,
      calcMode === "create",
      calcExpression,
      calcOutputType,
      scope,
    );
    if (!result) {
      setCalcError(t("attributeTable.calcCouldNotApply"));
      return;
    }
    if ("error" in result) {
      setCalcError(result.error);
      return;
    }
    updateLayer(layer.id, markAttributeEdit(layer, result.patch));
    if (result.errors > 0) {
      // The calculation was applied, but some rows threw and were written as
      // null. If we just created the column, switch to update mode targeting it
      // so the user can refine the expression without hitting a name collision.
      if (calcMode === "create") {
        setCalcMode("update");
        setCalcTargetField(targetName);
      }
      setCalcError(
        t("attributeTable.calcAppliedWithErrors", {
          errors: result.errors,
          evaluated: result.evaluated,
        }),
      );
      return;
    }
    setCalcError(null);
    setCalcOpen(false);
  };
  return {
    calculatorTargetColumns,
    openCalculator,
    insertExpressionSnippet,
    calcAvailableMetrics,
    calcEffectiveMetric,
    calcGeomUnitOptions,
    calcEffectiveUnit,
    insertGeometrySnippet,
    calcNewNameTrimmed,
    calcNameCollides,
    calcNameReserved,
    calcHasSelection,
    calcPreview,
    calcCanSubmit,
    confirmCalculate,
  };
}
