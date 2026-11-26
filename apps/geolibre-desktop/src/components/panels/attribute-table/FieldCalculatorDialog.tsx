import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Label,
  Select,
  Input,
  Textarea,
  Button,
} from "@geolibre/ui";
import {
  type CalcOutputType,
  fieldReference,
  EXPRESSION_HELPERS,
} from "../../../lib/attribute-expression";
import {
  type AreaUnit,
  type DistanceUnit,
  type GeometryMetric,
  UNIT_SYMBOLS,
} from "../../../lib/geometry-measure";
import { formatAttributeValue } from "../../../lib/vector-export";
import type { TFunction } from "i18next";
import type { CalcPreview } from "./useFieldCalculator";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Dispatch, RefObject, SetStateAction } from "react";

interface FieldCalculatorDialogProps {
  calcOpen: boolean;
  setCalcOpen: Dispatch<SetStateAction<boolean>>;
  setCalcError: Dispatch<SetStateAction<string | null>>;
  t: TFunction<"translation", undefined>;
  layer: GeoLibreLayer | undefined;
  calcMode: "update" | "create";
  setCalcMode: Dispatch<SetStateAction<"update" | "create">>;
  discoveredColumns: string[];
  calcNewName: string;
  calcNameCollides: boolean;
  calcNameReserved: boolean;
  setCalcNewName: Dispatch<SetStateAction<string>>;
  calcTargetField: string;
  setCalcTargetField: Dispatch<SetStateAction<string>>;
  calculatorTargetColumns: string[];
  calcNewNameTrimmed: string;
  calcOutputType: CalcOutputType;
  setCalcOutputType: Dispatch<SetStateAction<CalcOutputType>>;
  calcExpressionRef: RefObject<HTMLTextAreaElement | null>;
  calcExpression: string;
  setCalcExpression: Dispatch<SetStateAction<string>>;
  insertExpressionSnippet: (snippet: string, caretOffset?: number) => void;
  calcAvailableMetrics: GeometryMetric[];
  calcEffectiveMetric: GeometryMetric;
  setCalcGeomMetric: Dispatch<SetStateAction<GeometryMetric>>;
  calcEffectiveUnit: string;
  setCalcGeomUnit: Dispatch<SetStateAction<string>>;
  calcGeomUnitOptions: readonly AreaUnit[] | readonly DistanceUnit[];
  insertGeometrySnippet: () => void;
  calcPreview: CalcPreview;
  calcSelectedOnly: boolean;
  calcHasSelection: boolean;
  setCalcSelectedOnly: Dispatch<SetStateAction<boolean>>;
  calcError: string | null;
  canManageColumns: boolean;
  calcCanSubmit: boolean;
  confirmCalculate: () => void;
}

/** The attribute table's field calculator dialog: expression or geometry mode, target field, preview and submit. */
export function FieldCalculatorDialog({
  calcOpen,
  setCalcOpen,
  setCalcError,
  t,
  layer,
  calcMode,
  setCalcMode,
  discoveredColumns,
  calcNewName,
  calcNameCollides,
  calcNameReserved,
  setCalcNewName,
  calcTargetField,
  setCalcTargetField,
  calculatorTargetColumns,
  calcNewNameTrimmed,
  calcOutputType,
  setCalcOutputType,
  calcExpressionRef,
  calcExpression,
  setCalcExpression,
  insertExpressionSnippet,
  calcAvailableMetrics,
  calcEffectiveMetric,
  setCalcGeomMetric,
  calcEffectiveUnit,
  setCalcGeomUnit,
  calcGeomUnitOptions,
  insertGeometrySnippet,
  calcPreview,
  calcSelectedOnly,
  calcHasSelection,
  setCalcSelectedOnly,
  calcError,
  canManageColumns,
  calcCanSubmit,
  confirmCalculate,
}: FieldCalculatorDialogProps) {
  return (
    <Dialog
      open={calcOpen}
      onOpenChange={(open: boolean) => {
        setCalcOpen(open);
        if (!open) setCalcError(null);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("attributeTable.fieldCalculator")}</DialogTitle>
          <DialogDescription>
            {t("attributeTable.calcDescription", {
              layer: layer?.name ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="calc-target">{t("attributeTable.targetField")}</Label>
            <div className="flex gap-2">
              <Select
                id="calc-target-mode"
                className="w-40 shrink-0"
                value={calcMode}
                onChange={(event) => setCalcMode(event.target.value as "update" | "create")}
              >
                <option value="update" disabled={discoveredColumns.length === 0}>
                  {t("attributeTable.updateField")}
                </option>
                <option value="create">{t("attributeTable.createField")}</option>
              </Select>
              {calcMode === "create" ? (
                <Input
                  id="calc-target"
                  className="flex-1"
                  value={calcNewName}
                  placeholder={t("attributeTable.newFieldNamePlaceholder")}
                  aria-invalid={calcNameCollides || calcNameReserved || undefined}
                  onChange={(event) => setCalcNewName(event.target.value)}
                />
              ) : (
                <Select
                  id="calc-target"
                  className="flex-1"
                  value={calcTargetField}
                  onChange={(event) => setCalcTargetField(event.target.value)}
                >
                  {calculatorTargetColumns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {calcNameReserved ? (
              <span className="text-xs text-destructive">{t("attributeTable.fieldReserved")}</span>
            ) : calcNameCollides ? (
              <span className="text-xs text-destructive">
                {t("attributeTable.fieldExists", {
                  name: calcNewNameTrimmed,
                })}
              </span>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="calc-output-type">{t("attributeTable.outputType")}</Label>
            <Select
              id="calc-output-type"
              value={calcOutputType}
              onChange={(event) => setCalcOutputType(event.target.value as CalcOutputType)}
            >
              <option value="auto">{t("attributeTable.outputAuto")}</option>
              <option value="text">{t("attributeTable.typeText")}</option>
              <option value="number">{t("attributeTable.typeNumber")}</option>
              <option value="boolean">{t("attributeTable.typeBoolean")}</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="calc-expression">{t("attributeTable.expression")}</Label>
            <Textarea
              id="calc-expression"
              ref={calcExpressionRef}
              className="min-h-20 font-mono text-xs"
              value={calcExpression}
              placeholder={t("attributeTable.calcExpressionPlaceholder")}
              onChange={(event) => setCalcExpression(event.target.value)}
            />
            {discoveredColumns.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {t("attributeTable.fieldsLabel")}
                </span>
                {discoveredColumns.map((col) => (
                  <button
                    key={col}
                    type="button"
                    className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                    title={t("attributeTable.insertField", { name: col })}
                    onClick={() => insertExpressionSnippet(fieldReference(col))}
                  >
                    {col}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {t("attributeTable.functionsLabel")}
              </span>
              {Object.keys(EXPRESSION_HELPERS).map((fn) => (
                <button
                  key={fn}
                  type="button"
                  className="rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                  title={t("attributeTable.insertFunction", { name: fn })}
                  onClick={() =>
                    // Land the caret between the parens so the user can type
                    // the argument straight away.
                    insertExpressionSnippet(`${fn}()`, fn.length + 1)
                  }
                >
                  {fn}
                </button>
              ))}
            </div>
            {calcAvailableMetrics.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  {t("attributeTable.geomMeasureLabel")}
                </span>
                <Select
                  id="calc-geom-metric"
                  className="h-7 w-28 py-0 text-xs"
                  value={calcEffectiveMetric}
                  onChange={(event) => setCalcGeomMetric(event.target.value as GeometryMetric)}
                >
                  {calcAvailableMetrics.map((metric) => (
                    <option key={metric} value={metric}>
                      {t(`attributeTable.geomMetric.${metric}`)}
                    </option>
                  ))}
                </Select>
                <Select
                  id="calc-geom-unit"
                  className="h-7 w-20 py-0 text-xs"
                  value={calcEffectiveUnit}
                  onChange={(event) => setCalcGeomUnit(event.target.value)}
                >
                  {calcGeomUnitOptions.map((unit) => (
                    <option key={unit} value={unit}>
                      {UNIT_SYMBOLS[unit]}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={insertGeometrySnippet}
                >
                  {t("attributeTable.geomInsert")}
                </Button>
              </div>
            ) : null}
          </div>
          {calcPreview.kind === "syntax" ? (
            <span className="text-xs text-destructive">{calcPreview.message}</span>
          ) : calcPreview.kind === "runtime" ? (
            <span className="text-xs text-amber-600 dark:text-amber-500">
              {t("attributeTable.sampleRowErrored", {
                message: calcPreview.message,
              })}
            </span>
          ) : calcPreview.kind === "ok" ? (
            <span className="truncate text-xs text-muted-foreground">
              {t("attributeTable.preview")}{" "}
              <span className="font-mono text-foreground">
                {formatAttributeValue(calcPreview.value)}
              </span>
            </span>
          ) : null}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={calcSelectedOnly}
              disabled={!calcHasSelection}
              onChange={(event) => setCalcSelectedOnly(event.target.checked)}
            />
            {t("attributeTable.onlySelectedFeature")}
          </label>
          {calcError ? <span className="text-xs text-destructive">{calcError}</span> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCalcOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canManageColumns || !calcCanSubmit} onClick={confirmCalculate}>
            {t("attributeTable.buttons.calculate")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
