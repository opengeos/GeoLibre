import { parseJsonExpression, styleValue, type GeoLibreLayer } from "@geolibre/core";
import { Button, ColorField, Input, Label } from "@geolibre/ui";
import { CornerDownRight, Plus, SquareFunction, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { effectiveRuleZoomRange, type VectorRuleActions } from "./rule-tree";
import type { ExpressionBuilderTarget } from "./StyleExpressionBuilder";
import { RuleNumberInput } from "./style-inputs";

interface RuleBasedRulesEditorProps {
  layer: GeoLibreLayer;
  ruleActions: VectorRuleActions;
  setExpressionBuilderTarget: (target: ExpressionBuilderTarget | null) => void;
}

/**
 * The rule-based renderer's rule list: nested rules with filters, per-rule
 * overrides and the catch-all else rule. Edits write straight to the store.
 *
 * @param props - The layer, its rule actions and the Expression Builder opener.
 * @returns The rule editor.
 */
export function RuleBasedRulesEditor({
  layer,
  ruleActions,
  setExpressionBuilderTarget,
}: RuleBasedRulesEditorProps) {
  const { t } = useTranslation();
  const { style } = layer;
  const strokeWidthUnit = styleValue(style, "strokeWidthUnit");
  const markerEnabled = styleValue(style, "markerEnabled");
  const {
    currentRules,
    concreteRules,
    ruleRows,
    elseRule,
    updateVectorRule,
    addChildVectorRule,
    addVectorRule,
    removeVectorRule,
    setElseRuleColor,
    setElseRuleEnabled,
  } = ruleActions;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label>{t("style.symbology.rules")}</Label>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          title={t("style.symbology.addRule")}
          aria-label={t("style.symbology.addRule")}
          onClick={addVectorRule}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {concreteRules.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("style.symbology.noRulesPrefix")}
          <code>{'["==", ["get", "TYPE"], "park"]'}</code>
          {t("style.symbology.noRulesSuffix")}
        </p>
      ) : null}
      {ruleRows.map(({ rule, depth, isGroup }, index) => (
        <div
          key={rule.id}
          className="space-y-2 rounded-md border border-input p-2"
          style={depth > 0 ? { marginInlineStart: `${Math.min(depth, 4) * 12}px` } : undefined}
        >
          <div className="grid grid-cols-[auto_auto_1fr_2rem_2rem] items-center gap-2">
            <input
              type="checkbox"
              checked={rule.enabled !== false}
              title={t("style.symbology.ruleEnabled", {
                index: index + 1,
              })}
              aria-label={t("style.symbology.ruleEnabled", {
                index: index + 1,
              })}
              onChange={(event) =>
                updateVectorRule(rule.id, {
                  enabled: event.target.checked ? undefined : false,
                })
              }
            />
            <ColorField
              fill={false}
              aria-label={t("style.symbology.ruleColor", {
                index: index + 1,
              })}
              eyedropperLabel={t("style.symbology.ruleColorPick", {
                index: index + 1,
              })}
              className="h-9 w-9 p-1"
              buttonClassName="h-9 w-9"
              value={rule.color}
              onChange={(color) => updateVectorRule(rule.id, { color })}
            />
            <Input
              aria-label={t("style.symbology.ruleLabel", {
                index: index + 1,
              })}
              placeholder={t("style.symbology.labelPlaceholder")}
              value={rule.label}
              onChange={(event) => updateVectorRule(rule.id, { label: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={t("style.symbology.ruleAddChild")}
              aria-label={t("style.symbology.ruleAddChild")}
              onClick={() => addChildVectorRule(rule.id)}
            >
              <CornerDownRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title={t("style.symbology.removeRule")}
              aria-label={t("style.symbology.removeRule")}
              onClick={() => removeVectorRule(rule.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-start gap-1">
            <textarea
              aria-label={t("style.symbology.ruleFilter", {
                index: index + 1,
              })}
              className="min-h-16 w-full flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
              placeholder='["==", ["get", "TYPE"], "park"]'
              value={rule.filter}
              onChange={(event) => updateVectorRule(rule.id, { filter: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              title={t("style.expressionBuilder.openBuilderForRule", {
                index: index + 1,
              })}
              aria-label={t("style.expressionBuilder.openBuilderForRule", {
                index: index + 1,
              })}
              onClick={() =>
                setExpressionBuilderTarget({
                  kind: "rule",
                  ruleId: rule.id,
                  index: index + 1,
                  layerId: layer.id,
                })
              }
            >
              <SquareFunction className="h-3.5 w-3.5" />
            </Button>
          </div>
          {rule.filter.trim() && !parseJsonExpression(rule.filter) ? (
            <p className="text-xs text-destructive">{t("style.symbology.filterInvalid")}</p>
          ) : null}
          {isGroup ? (
            <p className="text-xs text-muted-foreground">{t("style.symbology.ruleGroupNote")}</p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t("style.symbology.ruleOptions")}
            </summary>
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <RuleNumberInput
                  label={t("style.symbology.ruleMinZoom")}
                  value={rule.minZoom}
                  min={0}
                  max={24}
                  step={1}
                  placeholder={t("style.symbology.ruleInherit")}
                  onChange={(minZoom) => updateVectorRule(rule.id, { minZoom })}
                />
                <RuleNumberInput
                  label={t("style.symbology.ruleMaxZoom")}
                  value={rule.maxZoom}
                  min={0}
                  max={24}
                  step={1}
                  placeholder={t("style.symbology.ruleInherit")}
                  onChange={(maxZoom) => updateVectorRule(rule.id, { maxZoom })}
                />
              </div>
              {(() => {
                // Warn on the effective (ancestor-intersected) range, not
                // just the rule's own fields: a child's individually valid
                // range can still be emptied by a parent's narrower one.
                const effective = effectiveRuleZoomRange(currentRules, rule);
                return effective.minZoom !== undefined &&
                  effective.maxZoom !== undefined &&
                  effective.minZoom >= effective.maxZoom ? (
                  <p className="text-xs text-destructive">{t("style.symbology.ruleZoomInvalid")}</p>
                ) : null;
              })()}
              {!isGroup ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {strokeWidthUnit !== "meters" ? (
                      // Per-rule pixel widths do not apply in meters mode
                      // (the meters width is a zoom interpolation MapLibre
                      // cannot nest inside a per-rule case), so hide the
                      // field rather than accept a silent no-op.
                      <RuleNumberInput
                        label={t("style.symbology.ruleStrokeWidth")}
                        value={rule.strokeWidth}
                        min={0}
                        step={0.5}
                        placeholder={t("style.symbology.ruleInherit")}
                        onChange={(strokeWidth) => updateVectorRule(rule.id, { strokeWidth })}
                      />
                    ) : null}
                    <RuleNumberInput
                      label={t("style.symbology.ruleFillOpacity")}
                      value={rule.fillOpacity}
                      min={0}
                      max={1}
                      step={0.1}
                      placeholder={t("style.symbology.ruleInherit")}
                      onChange={(fillOpacity) => updateVectorRule(rule.id, { fillOpacity })}
                    />
                    {!markerEnabled ? (
                      <RuleNumberInput
                        label={t("style.symbology.ruleCircleSize")}
                        value={rule.circleRadius}
                        min={0}
                        step={1}
                        placeholder={t("style.symbology.ruleInherit")}
                        onChange={(circleRadius) => updateVectorRule(rule.id, { circleRadius })}
                      />
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={rule.strokeColor !== undefined}
                        onChange={(event) =>
                          updateVectorRule(rule.id, {
                            strokeColor: event.target.checked
                              ? styleValue(style, "strokeColor")
                              : undefined,
                          })
                        }
                      />
                      {t("style.symbology.ruleOutlineColor")}
                    </label>
                    {rule.strokeColor !== undefined ? (
                      <ColorField
                        fill={false}
                        aria-label={t("style.symbology.ruleOutlineColor")}
                        eyedropperLabel={t("style.symbology.ruleOutlineColorPick", {
                          index: index + 1,
                        })}
                        className="h-8 w-8 p-1"
                        buttonClassName="h-8 w-8"
                        value={rule.strokeColor}
                        onChange={(strokeColor) => updateVectorRule(rule.id, { strokeColor })}
                      />
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>
          </details>
        </div>
      ))}
      <div className="grid grid-cols-[auto_auto_1fr] items-center gap-2 rounded-md border border-dashed border-input p-2">
        {/* No else record yet means enabled; unchecking materializes a
                disabled record so features matching no rule are hidden
                (QGIS-style), not painted with the base style. */}
        <input
          type="checkbox"
          checked={elseRule ? elseRule.enabled !== false : true}
          title={t("style.symbology.elseRuleEnabled")}
          aria-label={t("style.symbology.elseRuleEnabled")}
          onChange={(event) => setElseRuleEnabled(event.target.checked)}
        />
        <ColorField
          fill={false}
          aria-label={t("style.symbology.elseRuleColor")}
          eyedropperLabel={t("style.symbology.elseRuleColorPick")}
          className="h-9 w-9 p-1"
          buttonClassName="h-9 w-9"
          value={elseRule?.color ?? style.fillColor}
          onChange={setElseRuleColor}
        />
        <span className="text-xs text-muted-foreground">
          {t("style.symbology.elseAllOtherFeatures")}
        </span>
      </div>
    </div>
  );
}
