import {
  DEFAULT_LAYER_STYLE,
  VECTOR_COLOR_RAMPS,
  styleValue,
  useAppStore,
  type GeoLibreLayer,
  type VectorStyleMode,
  type VectorStyleStop,
} from "@geolibre/core";
import { Button, ColorField, ColorRampSelect, Label, Select } from "@geolibre/ui";
import { Plus, Sparkles, SquareFunction, Trash2, X } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { StyleSuggestion } from "../../../lib/style-suggestions";
import {
  CATEGORIZED_CLASSIFICATION_SCHEMES,
  GRADUATED_CLASSIFICATION_SCHEMES,
  VECTOR_STYLE_CLASS_COUNTS,
  chooseDefaultStyleProperty,
  createDefaultStops,
  defaultClassificationScheme,
  nextStopColor,
  normalizeClassificationScheme,
  normalizeVectorStyleClassCount,
  normalizeVectorStyleStops,
  validateExpressionJson,
} from "./classification-helpers";
import { RuleBasedRulesEditor } from "./RuleBasedRulesEditor";
import type { VectorRuleActions } from "./rule-tree";
import type { ExpressionBuilderTarget } from "./StyleExpressionBuilder";
import { StopValueInput } from "./style-inputs";
import type { StylePanelDrafts } from "./useStylePanelDrafts";

interface VectorSymbologySectionProps {
  layer: GeoLibreLayer;
  drafts: StylePanelDrafts;
  vectorStylePropertyOptions: string[];
  matchingPropertyValues: (property: string) => unknown[] | undefined;
  visibleSuggestions: StyleSuggestion[];
  setDismissedSuggestions: Dispatch<SetStateAction<Set<string>>>;
  ruleActions: VectorRuleActions;
  setExpressionBuilderTarget: (target: ExpressionBuilderTarget | null) => void;
}

/**
 * The vector renderer picker (single / graduated / categorized / rule-based /
 * expression) with its drafted settings, style suggestions and Apply button.
 *
 * @param props - The layer, its draft state, attribute options and rule actions.
 * @returns The symbology section.
 */
export function VectorSymbologySection({
  layer,
  drafts,
  vectorStylePropertyOptions,
  matchingPropertyValues,
  visibleSuggestions,
  setDismissedSuggestions,
  ruleActions,
  setExpressionBuilderTarget,
}: VectorSymbologySectionProps) {
  const { t } = useTranslation();
  const setLayerStyle = useAppStore((s) => s.setLayerStyle);
  const { style } = layer;
  const {
    draftVectorStyleMode,
    setDraftVectorStyleMode,
    draftVectorStyleProperty,
    setDraftVectorStyleProperty,
    draftVectorStyleClassCount,
    setDraftVectorStyleClassCount,
    draftVectorStyleAllCategories,
    setDraftVectorStyleAllCategories,
    draftVectorStyleColorRamp,
    setDraftVectorStyleColorRamp,
    draftVectorStyleClassificationScheme,
    setDraftVectorStyleClassificationScheme,
    draftVectorStyleStops,
    setDraftVectorStyleStops,
    draftVectorStyleExpression,
    setDraftVectorStyleExpression,
    vectorStyleError,
    setVectorStyleError,
    vectorPropertyValuesLoading,
    vectorPropertyValuesUnavailable,
    countCompleteCategorizedValues,
    categorizedValueCount,
  } = drafts;
  const currentVectorStops = styleValue(style, "vectorStyleStops");
  const vectorStyleSettingsChanged =
    draftVectorStyleMode !== styleValue(style, "vectorStyleMode") ||
    draftVectorStyleProperty !== styleValue(style, "vectorStyleProperty") ||
    draftVectorStyleClassCount !== styleValue(style, "vectorStyleClassCount") ||
    draftVectorStyleColorRamp !== styleValue(style, "vectorStyleColorRamp") ||
    draftVectorStyleClassificationScheme !== styleValue(style, "vectorStyleClassificationScheme") ||
    draftVectorStyleExpression !== styleValue(style, "vectorStyleExpression") ||
    JSON.stringify(draftVectorStyleStops) !== JSON.stringify(currentVectorStops);
  const draftVectorPropertyValues = matchingPropertyValues(draftVectorStyleProperty);
  const regenerateDraftVectorStyleStops = (
    mode: VectorStyleMode,
    property: string,
    classCount: number,
    colorRamp: string,
    classificationScheme: string,
  ) => {
    setDraftVectorStyleStops(
      createDefaultStops(
        layer,
        mode,
        property,
        classCount,
        colorRamp,
        classificationScheme,
        property === draftVectorStyleProperty ? draftVectorPropertyValues : undefined,
      ),
    );
  };
  const updateDraftVectorStyleMode = (mode: VectorStyleMode) => {
    setDraftVectorStyleMode(mode);
    setDraftVectorStyleAllCategories(false);
    setVectorStyleError(null);
    if (mode === "graduated" || mode === "categorized") {
      const classCount = normalizeVectorStyleClassCount(mode, draftVectorStyleClassCount);
      const classificationScheme = normalizeClassificationScheme(
        mode,
        draftVectorStyleClassificationScheme,
      );
      const property = chooseDefaultStyleProperty(
        layer,
        mode,
        vectorStylePropertyOptions,
        draftVectorStyleProperty,
      );
      setDraftVectorStyleProperty(property);
      setDraftVectorStyleClassCount(classCount);
      setDraftVectorStyleClassificationScheme(classificationScheme);
      regenerateDraftVectorStyleStops(
        mode,
        property,
        classCount,
        draftVectorStyleColorRamp,
        classificationScheme,
      );
    }
  };
  const updateDraftVectorStyleProperty = (property: string) => {
    // The new attribute's count is 0 when its values have yet to load; keep the
    // count within the plain options until then and let the reconcile effect
    // above re-apply "All" once the real count arrives.
    const nextCategoryCount =
      draftVectorStyleMode === "categorized" ? countCompleteCategorizedValues(property) : 0;
    const classCount =
      nextCategoryCount > 0
        ? draftVectorStyleAllCategories
          ? nextCategoryCount
          : Math.min(draftVectorStyleClassCount, nextCategoryCount)
        : Math.min(draftVectorStyleClassCount, 12);
    setDraftVectorStyleProperty(property);
    setDraftVectorStyleClassCount(classCount);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      property,
      classCount,
      draftVectorStyleColorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleClassCount = (value: number, allCategories = false) => {
    const classCount = normalizeVectorStyleClassCount(draftVectorStyleMode, value);
    setDraftVectorStyleClassCount(classCount);
    setDraftVectorStyleAllCategories(allCategories);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      classCount,
      draftVectorStyleColorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleColorRamp = (colorRamp: string) => {
    setDraftVectorStyleColorRamp(colorRamp);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      draftVectorStyleClassCount,
      colorRamp,
      draftVectorStyleClassificationScheme,
    );
  };
  const updateDraftVectorStyleClassificationScheme = (scheme: string) => {
    const classificationScheme = normalizeClassificationScheme(draftVectorStyleMode, scheme);
    setDraftVectorStyleClassificationScheme(classificationScheme);
    regenerateDraftVectorStyleStops(
      draftVectorStyleMode,
      draftVectorStyleProperty,
      draftVectorStyleClassCount,
      draftVectorStyleColorRamp,
      classificationScheme,
    );
  };
  const updateDraftVectorStyleStop = (index: number, patch: Partial<VectorStyleStop>) => {
    setDraftVectorStyleStops((stops) =>
      stops.map((stop, stopIndex) => (stopIndex === index ? { ...stop, ...patch } : stop)),
    );
  };
  const addDraftVectorStyleStop = () => {
    setDraftVectorStyleStops((stops) => [
      ...stops,
      {
        value: draftVectorStyleMode === "graduated" ? stops.length : "",
        color: nextStopColor(stops.length),
      },
    ]);
  };
  const removeDraftVectorStyleStop = (index: number) => {
    setDraftVectorStyleStops((stops) => stops.filter((_, stopIndex) => stopIndex !== index));
  };
  const applyVectorStyleSettings = () => {
    if (draftVectorStyleMode === "expression") {
      const expressionError = validateExpressionJson(
        draftVectorStyleExpression,
        t("style.expressionLabels.style"),
        t,
      );
      if (expressionError) {
        setVectorStyleError(expressionError);
        return;
      }
    }

    const stops = normalizeVectorStyleStops(draftVectorStyleMode, draftVectorStyleStops);
    if (
      (draftVectorStyleMode === "graduated" || draftVectorStyleMode === "categorized") &&
      !draftVectorStyleProperty
    ) {
      setVectorStyleError(t("style.symbology.errorChooseAttribute"));
      return;
    }
    if (draftVectorStyleMode === "graduated" && stops.length < 2) {
      setVectorStyleError(t("style.symbology.errorGraduatedStops"));
      return;
    }
    if (draftVectorStyleMode === "categorized" && stops.length === 0) {
      setVectorStyleError(t("style.symbology.errorCategorizedStops"));
      return;
    }

    setVectorStyleError(null);
    setLayerStyle(layer.id, {
      vectorStyleMode: draftVectorStyleMode,
      vectorStyleProperty: draftVectorStyleProperty,
      vectorStyleClassCount: draftVectorStyleClassCount,
      vectorStyleColorRamp: draftVectorStyleColorRamp,
      vectorStyleClassificationScheme: draftVectorStyleClassificationScheme,
      vectorStyleStops: stops,
      vectorStyleExpression: draftVectorStyleExpression.trim(),
    });
  };
  const usesAttributeSymbology =
    draftVectorStyleMode === "graduated" || draftVectorStyleMode === "categorized";
  const vectorClassificationSchemeOptions =
    draftVectorStyleMode === "categorized"
      ? CATEGORIZED_CLASSIFICATION_SCHEMES
      : GRADUATED_CLASSIFICATION_SCHEMES;
  const vectorClassCountOptions = VECTOR_STYLE_CLASS_COUNTS.filter((classCount) =>
    draftVectorStyleMode === "categorized" ? true : classCount >= 2,
  );
  // The "All (N)" option only renders while a complete count is known, so the
  // selection falls back to the plain class count whenever it is not — keeping
  // the controlled <select> value on an option that actually exists.
  const allCategoriesSelected = draftVectorStyleAllCategories && categorizedValueCount > 0;

  const applyStyleSuggestion = (suggestion: StyleSuggestion) => {
    if (suggestion.kind === "heatmap") {
      setLayerStyle(layer.id, { pointRenderer: "heatmap" });
      return;
    }
    const mode = suggestion.kind;
    const property = suggestion.property ?? "";
    const classCount = normalizeVectorStyleClassCount(
      mode,
      DEFAULT_LAYER_STYLE.vectorStyleClassCount,
    );
    const classificationScheme = defaultClassificationScheme(mode);
    // The layer's committed ramp, not the draft dropdown: a suggestion should
    // start from the same baseline every time, not from a ramp someone left
    // selected in the editor without applying it.
    const colorRamp = styleValue(style, "vectorStyleColorRamp");
    const stops = normalizeVectorStyleStops(
      mode,
      createDefaultStops(layer, mode, property, classCount, colorRamp, classificationScheme),
    );
    // A suggestion that classifies to nothing (all-null column, one distinct
    // value) would apply an empty renderer and blank the layer — the same
    // guard applyVectorStyleSettings uses, just silent here.
    if (mode === "graduated" ? stops.length < 2 : stops.length === 0) return;

    setDraftVectorStyleMode(mode);
    setDraftVectorStyleProperty(property);
    setDraftVectorStyleClassCount(classCount);
    setDraftVectorStyleAllCategories(false);
    setDraftVectorStyleClassificationScheme(classificationScheme);
    setDraftVectorStyleStops(stops);
    setVectorStyleError(null);
    setLayerStyle(layer.id, {
      vectorStyleMode: mode,
      vectorStyleProperty: property,
      vectorStyleClassCount: classCount,
      vectorStyleColorRamp: colorRamp,
      vectorStyleClassificationScheme: classificationScheme,
      vectorStyleStops: stops,
    });
  };

  const suggestionLabel = (suggestion: StyleSuggestion): string =>
    suggestion.kind === "heatmap"
      ? t("style.suggestions.heatmap")
      : t(
          suggestion.kind === "categorized"
            ? "style.suggestions.categorize"
            : "style.suggestions.graduate",
          { field: suggestion.property },
        );

  return (
    <div className="space-y-3">
      {visibleSuggestions.length > 0 && (
        <div className="space-y-2 rounded-md border border-dashed bg-muted/40 p-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium">{t("style.suggestions.title")}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ms-auto h-5 w-5"
              aria-label={t("style.suggestions.dismiss")}
              title={t("style.suggestions.dismiss")}
              onClick={() => setDismissedSuggestions((current) => new Set(current).add(layer.id))}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {visibleSuggestions.map((suggestion) => (
              <Button
                key={`${suggestion.kind}-${suggestion.property ?? ""}`}
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => applyStyleSuggestion(suggestion)}
              >
                {suggestionLabel(suggestion)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="vectorStyleMode">{t("style.symbology.styleType")}</Label>
        <Select
          id="vectorStyleMode"
          value={draftVectorStyleMode}
          onChange={(event) => updateDraftVectorStyleMode(event.target.value as VectorStyleMode)}
        >
          <option value="single">{t("style.symbology.modeSingle")}</option>
          <option value="graduated">{t("style.symbology.modeGraduated")}</option>
          <option value="categorized">{t("style.symbology.modeCategorized")}</option>
          <option value="rule-based">{t("style.symbology.modeRuleBased")}</option>
          <option value="expression">{t("style.symbology.modeExpression")}</option>
        </Select>
      </div>
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleProperty">{t("style.symbology.attribute")}</Label>
          <Select
            id="vectorStyleProperty"
            value={draftVectorStyleProperty}
            onChange={(event) => updateDraftVectorStyleProperty(event.target.value)}
            disabled={vectorStylePropertyOptions.length === 0}
          >
            {vectorStylePropertyOptions.length === 0 ? (
              <option value="">{t("style.labels.noAttributes")}</option>
            ) : (
              vectorStylePropertyOptions.map((property) => (
                <option key={property} value={property}>
                  {property}
                </option>
              ))
            )}
          </Select>
          {vectorPropertyValuesLoading && (
            <p className="text-xs text-muted-foreground">{t("attributeTable.loadingAttributes")}</p>
          )}
          {vectorPropertyValuesUnavailable && (
            <p className="text-xs text-destructive">
              {t("style.symbology.errorAttributesUnavailable")}
            </p>
          )}
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="vectorStyleClassCount">{t("style.symbology.classes")}</Label>
            <Select
              id="vectorStyleClassCount"
              value={allCategoriesSelected ? "all" : String(draftVectorStyleClassCount)}
              onChange={(event) =>
                updateDraftVectorStyleClassCount(
                  event.target.value === "all" ? categorizedValueCount : Number(event.target.value),
                  event.target.value === "all",
                )
              }
            >
              {vectorClassCountOptions
                .filter(
                  (classCount) => !(allCategoriesSelected && classCount === categorizedValueCount),
                )
                .map((classCount) => (
                  <option key={classCount} value={classCount}>
                    {classCount}
                  </option>
                ))}
              {draftVectorStyleClassCount > 12 && !allCategoriesSelected && (
                <option value={draftVectorStyleClassCount}>{draftVectorStyleClassCount}</option>
              )}
              {draftVectorStyleMode === "categorized" && categorizedValueCount > 0 && (
                <option value="all">
                  {t("style.symbology.allClasses", {
                    total: categorizedValueCount,
                  })}
                </option>
              )}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vectorStyleClassificationScheme">{t("style.symbology.scheme")}</Label>
            <Select
              id="vectorStyleClassificationScheme"
              value={draftVectorStyleClassificationScheme}
              onChange={(event) => updateDraftVectorStyleClassificationScheme(event.target.value)}
            >
              {vectorClassificationSchemeOptions.map((scheme) => (
                <option key={scheme.value} value={scheme.value}>
                  {t(scheme.labelKey)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <Label htmlFor="vectorStyleColorRamp">{t("style.symbology.colormap")}</Label>
          <ColorRampSelect
            id="vectorStyleColorRamp"
            aria-label={t("style.symbology.colormap")}
            value={draftVectorStyleColorRamp}
            onValueChange={updateDraftVectorStyleColorRamp}
            ramps={VECTOR_COLOR_RAMPS}
          />
        </div>
      )}
      {usesAttributeSymbology && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>
              {draftVectorStyleMode === "graduated"
                ? t("style.symbology.stops")
                : t("style.symbology.categories")}
            </Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("style.addClass")}
              aria-label={t("style.addClass")}
              onClick={addDraftVectorStyleStop}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="space-y-2">
            {draftVectorStyleStops.map((stop, index) => (
              <div key={index} className="grid grid-cols-[auto_1fr_2rem] items-center gap-2">
                <ColorField
                  fill={false}
                  aria-label={t("style.symbology.classColor", {
                    index: index + 1,
                  })}
                  eyedropperLabel={t("style.symbology.classColorPick", {
                    index: index + 1,
                  })}
                  className="h-9 w-9 p-1"
                  buttonClassName="h-9 w-9"
                  value={stop.color}
                  onChange={(color) =>
                    updateDraftVectorStyleStop(index, {
                      color,
                    })
                  }
                />
                <StopValueInput
                  index={index}
                  isNumeric={draftVectorStyleMode === "graduated"}
                  value={stop.value}
                  onChange={(value) =>
                    updateDraftVectorStyleStop(index, {
                      value,
                    })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  title={t("style.removeClass")}
                  aria-label={t("style.removeClass")}
                  onClick={() => removeDraftVectorStyleStop(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {draftVectorStyleMode === "expression" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="vectorStyleExpression">{t("style.symbology.colorExpression")}</Label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-7 w-7"
              title={t("style.expressionBuilder.openBuilder")}
              aria-label={t("style.expressionBuilder.openBuilder")}
              onClick={() => setExpressionBuilderTarget({ kind: "style", layerId: layer.id })}
            >
              <SquareFunction className="h-3.5 w-3.5" />
            </Button>
          </div>
          <textarea
            id="vectorStyleExpression"
            className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0"
            placeholder='["match", ["get", "CONTINENT"], "Asia", "#2563eb", "#94a3b8"]'
            value={draftVectorStyleExpression}
            onChange={(event) => {
              setDraftVectorStyleExpression(event.target.value);
              setVectorStyleError(null);
            }}
          />
        </div>
      )}
      {draftVectorStyleMode === "rule-based" && (
        <RuleBasedRulesEditor
          layer={layer}
          ruleActions={ruleActions}
          setExpressionBuilderTarget={setExpressionBuilderTarget}
        />
      )}
      {/* With rule-based already active, rule edits write straight to the
          store and render live, so the Apply button would never enable again —
          a permanently disabled button reads as "your edits are not applied".
          Replace it with a hint saying edits are live; the button returns as
          soon as the user drafts a different style type. */}
      {draftVectorStyleMode === "rule-based" &&
      draftVectorStyleMode === styleValue(style, "vectorStyleMode") ? (
        <p className="text-xs text-muted-foreground">{t("style.symbology.rulesApplyLive")}</p>
      ) : (
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={
            !vectorStyleSettingsChanged ||
            vectorPropertyValuesLoading ||
            vectorPropertyValuesUnavailable
          }
          onClick={applyVectorStyleSettings}
        >
          {t("style.symbology.applyStyleType")}
        </Button>
      )}
      {draftVectorStyleMode === "rule-based" &&
        draftVectorStyleMode !== styleValue(style, "vectorStyleMode") && (
          <p className="text-xs text-muted-foreground">{t("style.symbology.applyHint")}</p>
        )}
      {vectorStyleError && <p className="text-xs text-destructive">{vectorStyleError}</p>}
    </div>
  );
}
