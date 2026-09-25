import {
  LABEL_NUMBER_LOCALES,
  formatLabelNumberSample,
  type GeoLibreLayer,
  type LabelStyle,
} from "@geolibre/core";
import { Button, ColorField, Label, Select } from "@geolibre/ui";
import { SquareFunction, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LABEL_OVERRIDE_PROPERTIES, labelOverrideInvalid } from "./label-overrides";
import type { ExpressionBuilderTarget } from "./StyleExpressionBuilder";
import { NumericStyleInput } from "./style-inputs";

interface LabelsSectionProps {
  layer: GeoLibreLayer;
  labels: LabelStyle;
  updateLabels: (patch: Partial<LabelStyle>) => void;
  vectorStylePropertyOptions: string[];
  setExpressionBuilderTarget: (target: ExpressionBuilderTarget | null) => void;
}

/**
 * Attribute label controls: field, number format, placement, text styling,
 * label expression and the data-defined overrides.
 *
 * @param props - The layer, its resolved label style and writer, and the
 *   attribute options.
 * @returns The labels section.
 */
export function LabelsSection({
  layer,
  labels,
  updateLabels,
  vectorStylePropertyOptions,
  setExpressionBuilderTarget,
}: LabelsSectionProps) {
  const { t, i18n } = useTranslation();
  // The label expression must be a JSON array (a MapLibre expression). Flag a
  // non-empty value that does not round-trip as an array so the user sees that
  // it is ignored (layer-sync falls back to the field / no label) instead of
  // silently producing nothing.
  const labelExpressionInvalid = (() => {
    if (!labels.expression.trim()) return false;
    try {
      return !Array.isArray(JSON.parse(labels.expression));
    } catch {
      return true;
    }
  })();
  // One pass over the override fields for both the rows and the invalid
  // banner; the style-spec compile behind the invalid flag is memoized per
  // distinct expression (labelOverrideInvalid), so re-renders cost lookups,
  // not recompiles. The `|| ""` guards against a hand-edited project file
  // storing null for an expression field (the type says string, but the
  // value comes from untrusted JSON); the invalid flag surfaces the
  // renderer's fallback to the literal control (the builder's Apply is
  // disabled for invalid expressions, but a hand-edited file can still carry
  // one). Validation runs through the style spec with the row's expected
  // result type, mirroring the builder's own check, so a type mismatch
  // (e.g. a string-producing size expression) is flagged too, not just
  // malformed JSON.
  const labelOverrideStates = LABEL_OVERRIDE_PROPERTIES.map((property) => {
    const value = (labels[property.field] || "").trim();
    return {
      property,
      value,
      invalid: value !== "" && labelOverrideInvalid(value, property.expectedType),
    };
  });
  return (
    <div className="space-y-3">
      <label htmlFor="labelsEnabled" className="flex items-center gap-2 text-sm font-medium">
        <input
          id="labelsEnabled"
          type="checkbox"
          checked={labels.enabled}
          onChange={(event) => updateLabels({ enabled: event.target.checked })}
        />
        {t("style.labels.show")}
      </label>
      {labels.enabled ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="labelField">{t("style.labels.field")}</Label>
            <Select
              id="labelField"
              value={labels.field}
              disabled={vectorStylePropertyOptions.length === 0}
              onChange={(event) => updateLabels({ field: event.target.value })}
            >
              {vectorStylePropertyOptions.length === 0 ? (
                <option value="">{t("style.labels.noAttributes")}</option>
              ) : (
                <>
                  <option value="">{t("style.labels.selectField")}</option>
                  {vectorStylePropertyOptions.map((property) => (
                    <option key={property} value={property}>
                      {property}
                    </option>
                  ))}
                </>
              )}
            </Select>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="labelNumberFormat"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <input
                id="labelNumberFormat"
                type="checkbox"
                checked={labels.numberFormatEnabled}
                onChange={(event) => updateLabels({ numberFormatEnabled: event.target.checked })}
              />
              {t("style.labels.numberFormat")}
            </label>
            {labels.numberFormatEnabled ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <NumericStyleInput
                    id="labelNumberDecimals"
                    label={t("style.labels.numberDecimals")}
                    min={0}
                    max={10}
                    step={1}
                    value={labels.numberDecimals}
                    onChange={(numberDecimals) => updateLabels({ numberDecimals })}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="labelNumberLocale">{t("style.labels.numberLocale")}</Label>
                    <Select
                      id="labelNumberLocale"
                      value={labels.numberLocale}
                      onChange={(event) => updateLabels({ numberLocale: event.target.value })}
                    >
                      <option value="">{t("style.labels.numberLocaleApp")}</option>
                      {LABEL_NUMBER_LOCALES.map((locale) => (
                        <option key={locale} value={locale}>
                          {formatLabelNumberSample(locale, labels.numberDecimals)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("style.labels.numberFormatHint", {
                    sample: formatLabelNumberSample(
                      labels.numberLocale || i18n.language,
                      labels.numberDecimals,
                    ),
                  })}
                </p>
              </>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="labelPlacement">{t("style.labels.placement")}</Label>
            <Select
              id="labelPlacement"
              value={labels.placement}
              onChange={(event) =>
                updateLabels({
                  placement: event.target.value as "point" | "line",
                })
              }
            >
              <option value="point">{t("style.labels.placementPoint")}</option>
              <option value="line">{t("style.labels.placementLine")}</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelSize"
              label={t("style.labels.textSize")}
              min={6}
              max={48}
              step={1}
              value={labels.size}
              onChange={(size) => updateLabels({ size })}
            />
            <NumericStyleInput
              id="labelHaloWidth"
              label={t("style.labels.haloWidth")}
              min={0}
              max={8}
              step={0.5}
              value={labels.haloWidth}
              onChange={(haloWidth) => updateLabels({ haloWidth })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="labelColor">{t("style.labels.textColor")}</Label>
              <ColorField
                id="labelColor"
                value={labels.color}
                onChange={(color) => updateLabels({ color })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelHaloColor">{t("style.labels.haloColor")}</Label>
              <ColorField
                id="labelHaloColor"
                value={labels.haloColor}
                onChange={(haloColor) => updateLabels({ haloColor })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelMinZoom"
              label={t("style.labels.minZoom")}
              min={0}
              max={labels.maxZoom}
              step={1}
              value={labels.minZoom}
              onChange={(minZoom) => updateLabels({ minZoom: Math.min(minZoom, labels.maxZoom) })}
            />
            <NumericStyleInput
              id="labelMaxZoom"
              label={t("style.labels.maxZoom")}
              min={labels.minZoom}
              max={24}
              step={1}
              value={labels.maxZoom}
              onChange={(maxZoom) => updateLabels({ maxZoom: Math.max(maxZoom, labels.minZoom) })}
            />
          </div>
          <label
            htmlFor="labelAllowOverlap"
            className="flex items-center gap-2 text-sm font-medium"
          >
            <input
              id="labelAllowOverlap"
              type="checkbox"
              checked={labels.allowOverlap}
              onChange={(event) => updateLabels({ allowOverlap: event.target.checked })}
            />
            {t("style.labels.allowOverlap")}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="labelAnchor">{t("style.labels.anchor")}</Label>
              <Select
                id="labelAnchor"
                value={labels.anchor}
                onChange={(event) =>
                  updateLabels({
                    anchor: event.target.value as LabelStyle["anchor"],
                  })
                }
              >
                <option value="center">{t("style.labels.anchorCenter")}</option>
                <option value="left">{t("style.labels.anchorLeft")}</option>
                <option value="right">{t("style.labels.anchorRight")}</option>
                <option value="top">{t("style.labels.anchorTop")}</option>
                <option value="bottom">{t("style.labels.anchorBottom")}</option>
                <option value="top-left">{t("style.labels.anchorTopLeft")}</option>
                <option value="top-right">{t("style.labels.anchorTopRight")}</option>
                <option value="bottom-left">{t("style.labels.anchorBottomLeft")}</option>
                <option value="bottom-right">{t("style.labels.anchorBottomRight")}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="labelTransform">{t("style.labels.transform")}</Label>
              <Select
                id="labelTransform"
                value={labels.transform}
                onChange={(event) =>
                  updateLabels({
                    transform: event.target.value as LabelStyle["transform"],
                  })
                }
              >
                <option value="none">{t("style.labels.transformNone")}</option>
                <option value="uppercase">{t("style.labels.transformUppercase")}</option>
                <option value="lowercase">{t("style.labels.transformLowercase")}</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelOffsetX"
              label={t("style.labels.offsetX")}
              min={-10}
              max={10}
              step={0.25}
              value={labels.offsetX}
              onChange={(offsetX) => updateLabels({ offsetX })}
            />
            <NumericStyleInput
              id="labelOffsetY"
              label={t("style.labels.offsetY")}
              min={-10}
              max={10}
              step={0.25}
              value={labels.offsetY}
              onChange={(offsetY) => updateLabels({ offsetY })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumericStyleInput
              id="labelRotation"
              label={t("style.labels.rotation")}
              min={-180}
              max={180}
              step={5}
              value={labels.rotation}
              onChange={(rotation) => updateLabels({ rotation })}
            />
            <NumericStyleInput
              id="labelMaxWidth"
              label={t("style.labels.maxWidth")}
              min={1}
              max={40}
              step={1}
              value={labels.maxWidth}
              onChange={(maxWidth) => updateLabels({ maxWidth })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="labelDedupe">{t("style.labels.dedupe")}</Label>
            <Select
              id="labelDedupe"
              value={labels.dedupe}
              onChange={(event) =>
                updateLabels({
                  dedupe: event.target.value as LabelStyle["dedupe"],
                })
              }
            >
              <option value="off">{t("style.labels.dedupeOff")}</option>
              <option value="unique">{t("style.labels.dedupeUnique")}</option>
              <option value="concatenate">{t("style.labels.dedupeConcatenate")}</option>
            </Select>
            {labels.dedupe !== "off" ? (
              <p className="text-xs text-muted-foreground">{t("style.labels.dedupeHint")}</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="labelExpression">{t("style.labels.expression")}</Label>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-7 w-7"
                title={t("style.expressionBuilder.openBuilder")}
                aria-label={t("style.expressionBuilder.openBuilder")}
                onClick={() => setExpressionBuilderTarget({ kind: "label", layerId: layer.id })}
              >
                <SquareFunction className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              id="labelExpression"
              aria-invalid={labelExpressionInvalid}
              className={[
                "min-h-16 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0",
                labelExpressionInvalid ? "border-destructive" : "border-input",
              ].join(" ")}
              placeholder={'["concat", ["get", "name"], " (", ["get", "pop"], ")"]'}
              value={labels.expression}
              onChange={(event) => updateLabels({ expression: event.target.value })}
            />
            <p
              className={[
                "text-xs",
                labelExpressionInvalid ? "text-destructive" : "text-muted-foreground",
              ].join(" ")}
            >
              {labelExpressionInvalid
                ? t("style.labels.expressionInvalid")
                : t("style.labels.expressionHint")}
            </p>
          </div>
          <div className="space-y-2">
            <Label>{t("style.labels.dataDefined.heading")}</Label>
            {labelOverrideStates.map(({ property, value, invalid }) => {
              return (
                <div key={property.key} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs">
                    {t(`style.labels.dataDefined.${property.key}`)}
                  </span>
                  <code
                    className={[
                      "min-w-0 flex-1 truncate font-mono text-xs",
                      invalid ? "text-destructive" : "text-muted-foreground",
                    ].join(" ")}
                    title={invalid ? t("style.labels.expressionInvalid") : value || undefined}
                  >
                    {value || t("style.labels.dataDefined.notSet")}
                  </code>
                  <Button
                    type="button"
                    variant={value ? "secondary" : "outline"}
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    title={t(`style.labels.dataDefined.${property.key}Target`)}
                    aria-label={t(`style.labels.dataDefined.${property.key}Target`)}
                    onClick={() =>
                      setExpressionBuilderTarget({
                        kind: "labelOverride",
                        property,
                        layerId: layer.id,
                      })
                    }
                  >
                    <SquareFunction className="h-3.5 w-3.5" />
                  </Button>
                  {value ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      title={t("style.labels.dataDefined.clear")}
                      aria-label={t("style.labels.dataDefined.clear")}
                      onClick={() =>
                        updateLabels({
                          [property.field]: "",
                        } as Partial<LabelStyle>)
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {labelOverrideStates.some((state) => state.invalid) ? (
              <p className="text-xs text-destructive">{t("style.labels.expressionInvalid")}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t("style.labels.dataDefined.hint")}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
