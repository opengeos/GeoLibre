import {
  useAppStore,
  type ExpressionVariable,
  type GeoLibreLayer,
  type LabelStyle,
  type VectorRule,
} from "@geolibre/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  getAttributePropertyNames,
  standardExpressionVariables,
} from "../../../lib/expression-inputs";
import { ExpressionBuilderDialog } from "../../expressions/ExpressionBuilderDialog";
import type { LabelOverrideProperty } from "./label-overrides";

/**
 * Which expression surface the shared Expression Builder is editing. Targets
 * carry the owning layer id so an edit can never be applied to a different
 * layer than the one it was opened for (GH #1306).
 */
export type ExpressionBuilderTarget =
  | { kind: "rule"; ruleId: string; index: number; layerId: string }
  | { kind: "style"; layerId: string }
  | { kind: "label"; layerId: string }
  | {
      kind: "labelOverride";
      property: LabelOverrideProperty;
      layerId: string;
    };

/**
 * The Expression Builder's layer-derived inputs, memoized for stable
 * identities while the dialog is open.
 *
 * @param layer - The selected layer, or undefined when none is selected.
 * @param expressionBuilderTarget - The open target; re-snapshots the camera on open.
 * @returns The sample features, field names, zoom and expression variables.
 */
export function useExpressionBuilderInputs(
  layer: GeoLibreLayer | undefined,
  expressionBuilderTarget: ExpressionBuilderTarget | null,
) {
  const projectName = useAppStore((s) => s.projectName);
  // Expression Builder inputs, memoized for stable identities: the dialog
  // memoizes its validation/preview/field-type work off these props, so fresh
  // arrays on every panel render would defeat that memoization while the
  // dialog is open (and, combined with the diagnostics console interceptor,
  // could re-render in a loop). Kept before the early returns below so the
  // hook order stays stable.
  const builderFeatures = useMemo(() => layer?.geojson?.features ?? [], [layer]);
  const builderFieldNames = useMemo(() => (layer ? getAttributePropertyNames(layer) : []), [layer]);
  // Zoom and variables snapshot the camera via getState() when the builder
  // opens instead of subscribing: the dialog is modal (the map cannot move
  // while it is open), and mapView subscriptions would re-render this whole
  // panel on every map move even with the builder closed.
  const { zoom: builderZoom, variables: builderVariables } = useMemo<{
    zoom: number;
    variables: ExpressionVariable[];
  }>(() => {
    const { zoom, center } = useAppStore.getState().mapView;
    return {
      zoom,
      variables: standardExpressionVariables({
        projectName,
        layerName: layer?.name ?? "",
        featureCount: builderFeatures.length,
        zoom,
        centerLat: center[1],
      }),
    };
    // expressionBuilderTarget is an intentional dep: it re-snapshots the
    // camera each time the builder opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, layer, builderFeatures, expressionBuilderTarget]);
  return { builderFeatures, builderFieldNames, builderZoom, builderVariables };
}

interface StyleExpressionBuilderProps {
  layer: GeoLibreLayer;
  expressionBuilderTarget: ExpressionBuilderTarget;
  setExpressionBuilderTarget: (target: ExpressionBuilderTarget | null) => void;
  builderInputs: ReturnType<typeof useExpressionBuilderInputs>;
  currentRules: VectorRule[];
  updateVectorRule: (id: string, patch: Partial<VectorRule>) => void;
  draftVectorStyleExpression: string;
  setDraftVectorStyleExpression: (expression: string) => void;
  setVectorStyleError: (error: string | null) => void;
  labels: LabelStyle;
  updateLabels: (patch: Partial<LabelStyle>) => void;
}

/**
 * The shared Expression Builder dialog, bound to whichever rule filter, color
 * expression or label field opened it.
 *
 * @param props - The open target, the layer, and the writers for each target kind.
 * @returns The open dialog.
 */
export function StyleExpressionBuilder({
  layer,
  expressionBuilderTarget,
  setExpressionBuilderTarget,
  builderInputs,
  currentRules,
  updateVectorRule,
  draftVectorStyleExpression,
  setDraftVectorStyleExpression,
  setVectorStyleError,
  labels,
  updateLabels,
}: StyleExpressionBuilderProps) {
  const { t } = useTranslation();
  const { builderFeatures, builderFieldNames, builderZoom, builderVariables } = builderInputs;
  // --- Shared Expression Builder (GH #1306) ---
  // builderFeatures / builderFieldNames / builderVariables are memoized above
  // the early returns so the dialog's props keep stable identities.
  const builderRule =
    expressionBuilderTarget?.kind === "rule"
      ? currentRules.find((rule) => rule.id === expressionBuilderTarget.ruleId)
      : undefined;
  const builderInitialExpression =
    expressionBuilderTarget?.kind === "rule"
      ? (builderRule?.filter ?? "")
      : expressionBuilderTarget?.kind === "style"
        ? draftVectorStyleExpression
        : expressionBuilderTarget?.kind === "labelOverride"
          ? labels[expressionBuilderTarget.property.field] || ""
          : labels.expression;
  const builderTargetLabel =
    expressionBuilderTarget?.kind === "rule"
      ? t("style.symbology.ruleFilter", { index: expressionBuilderTarget.index })
      : expressionBuilderTarget?.kind === "style"
        ? t("style.symbology.colorExpression")
        : expressionBuilderTarget?.kind === "labelOverride"
          ? t(`style.labels.dataDefined.${expressionBuilderTarget.property.key}Target`)
          : t("style.labels.expression");
  const applyBuilderExpression = (expression: string) => {
    if (!expressionBuilderTarget) return;
    // Never write through to a different layer than the builder was opened
    // for (the selection-change effect closes the dialog, this is the guard
    // against applying across a race).
    if (expressionBuilderTarget.layerId !== layer.id) return;
    if (expressionBuilderTarget.kind === "rule") {
      updateVectorRule(expressionBuilderTarget.ruleId, { filter: expression });
    } else if (expressionBuilderTarget.kind === "style") {
      setDraftVectorStyleExpression(expression);
      setVectorStyleError(null);
    } else if (expressionBuilderTarget.kind === "labelOverride") {
      updateLabels({
        [expressionBuilderTarget.property.field]: expression,
      } as Partial<LabelStyle>);
    } else {
      updateLabels({ expression });
    }
  };
  // Only mounted while open: the dialog memoizes validation/preview work off
  // props that this panel recreates each render, so keeping it mounted would
  // rescan the layer's features on every unrelated panel re-render.
  return (
    <ExpressionBuilderDialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setExpressionBuilderTarget(null);
      }}
      targetLabel={builderTargetLabel}
      context={
        expressionBuilderTarget.kind === "rule"
          ? "filter"
          : expressionBuilderTarget.kind === "style"
            ? "color"
            : expressionBuilderTarget.kind === "labelOverride"
              ? expressionBuilderTarget.property.context
              : "value"
      }
      initialExpression={builderInitialExpression}
      features={builderFeatures}
      fieldNames={builderFieldNames}
      zoom={builderZoom}
      variables={builderVariables}
      onApply={applyBuilderExpression}
    />
  );
}
