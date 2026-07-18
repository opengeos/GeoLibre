import {
  matchFeaturesByExpression,
  type SelectionMode,
  useAppStore,
  validateMapExpression,
} from "@geolibre/core";
import { Button, Label, Select, Textarea } from "@geolibre/ui";
import { SquareFunction } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  getAttributePropertyNames,
  standardExpressionVariables,
} from "../../lib/expression-inputs";
import { applyMatchedSelection } from "../../lib/selection-actions";
import { ExpressionBuilderDialog } from "../expressions/ExpressionBuilderDialog";
import {
  SelectionFloatingPanel,
  SelectionModeField,
  selectableVectorLayers,
} from "./selection-dialog-shared";

/** Outcome of the last "Select features" run, shown inline. */
interface SelectionSummary {
  matched: number;
  selected: number;
  total: number;
  errorCount: number;
}

/**
 * Select by Expression (#1314): evaluates a boolean MapLibre expression
 * against every feature of a vector layer and turns the matches into the
 * live selection (highlighted on the map, rows in the attribute table).
 * Rendered as a floating, non-modal panel so the map and attribute table
 * stay interactive: run a selection, pan to inspect it, refine, re-run —
 * QGIS style. The four modes combine each run with the current selection.
 */
export function SelectByExpressionDialog(): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.selectByExpressionOpen);
  const setOpen = useAppStore((s) => s.setSelectByExpressionOpen);
  const preselectedLayerId = useAppStore((s) => s.ui.selectByExpressionLayerId);
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectionCount = useAppStore((s) => s.selectedFeatureIds.length);
  const projectName = useAppStore((s) => s.projectName);

  const eligibleLayers = useMemo(() => selectableVectorLayers(layers), [layers]);

  const [targetLayerId, setTargetLayerId] = useState<string | null>(null);
  const [mode, setMode] = useState<SelectionMode>("new");
  const [source, setSource] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [summary, setSummary] = useState<SelectionSummary | null>(null);

  // Re-seed the target each time the dialog opens: an explicit context-menu
  // target wins, then the active layer (when selectable), then the first
  // selectable layer. The expression is kept across opens so a refined
  // selection can be re-run without retyping.
  useEffect(() => {
    if (!open) return;
    setSummary(null);
    setTargetLayerId((current) => {
      const eligible = selectableVectorLayers(useAppStore.getState().layers);
      const candidates = [preselectedLayerId, current, useAppStore.getState().selectedLayerId];
      for (const id of candidates) {
        if (id && eligible.some((layer) => layer.id === id)) return id;
      }
      return eligible[0]?.id ?? null;
    });
  }, [open, preselectedLayerId]);

  const targetLayer = eligibleLayers.find((layer) => layer.id === targetLayerId) ?? null;

  // Stable identities for the Expression Builder's memoization (see the
  // equivalent comment in StylePanel): fresh arrays every render would defeat
  // the dialog's validation/preview caching while it is open.
  const features = useMemo(() => targetLayer?.geojson?.features ?? [], [targetLayer]);
  const fieldNames = useMemo(
    () => (targetLayer ? getAttributePropertyNames(targetLayer) : []),
    [targetLayer],
  );
  // Camera snapshot for the (modal) Expression Builder's props and for
  // validation, taken at open instead of subscribing — a mapView
  // subscription would re-render on every pan and thrash the builder's
  // prop-identity memoization. The panel itself is non-modal, so
  // runSelection re-snapshots fresh values per run (below).
  const { zoom, variables } = useMemo(() => {
    const { zoom: mapZoom, center } = useAppStore.getState().mapView;
    return {
      zoom: mapZoom,
      variables: standardExpressionVariables({
        projectName,
        layerName: targetLayer?.name ?? "",
        featureCount: features.length,
        zoom: mapZoom,
        centerLat: center[1],
      }),
    };
    // `open` is an intentional dep: it re-snapshots the camera per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName, targetLayer, features, open]);

  const validation = useMemo(
    () => validateMapExpression(source, { variables, expectedType: "boolean" }),
    [source, variables],
  );
  const canSelect = Boolean(targetLayer) && source.trim().length > 0 && validation.ok;
  // The combine modes only make sense when the target layer holds the live
  // selection; otherwise remove/intersect would always yield an empty
  // selection, so the mode dropdown falls back to "new".
  const targetHoldsSelection = targetLayerId === selectedLayerId && selectionCount > 0;
  const effectiveMode = targetHoldsSelection ? mode : "new";

  const runSelection = () => {
    if (!targetLayer) return;
    // The panel is non-modal, so the camera may have moved since open:
    // evaluate ["zoom"] and the @map_* variables against the live view.
    const { zoom: liveZoom, center } = useAppStore.getState().mapView;
    const result = matchFeaturesByExpression(features, source, {
      zoom: liveZoom,
      variables: standardExpressionVariables({
        projectName,
        layerName: targetLayer.name,
        featureCount: features.length,
        zoom: liveZoom,
        centerLat: center[1],
      }),
    });
    if (!result.ok) return;
    const selected = applyMatchedSelection(targetLayer.id, result.ids, effectiveMode);
    setSummary({
      matched: result.ids.length,
      selected,
      total: features.length,
      errorCount: result.errorCount,
    });
  };

  return (
    <>
      <SelectionFloatingPanel
        open={open}
        title={t("selection.byExpressionTitle")}
        onClose={() => setOpen(false)}
        defaultPositionClass="start-3 top-3"
      >
        <div>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("selection.byExpressionDescription")}
          </p>
          {eligibleLayers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("selection.noLayers")}</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="select-expression-layer">{t("selection.targetLayer")}</Label>
                <Select
                  id="select-expression-layer"
                  value={targetLayerId ?? ""}
                  onChange={(event) => {
                    setTargetLayerId(event.target.value || null);
                    setSummary(null);
                  }}
                >
                  {eligibleLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="select-expression-source">{t("selection.expression")}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBuilderOpen(true)}
                    disabled={!targetLayer}
                  >
                    <SquareFunction className="me-2 h-3.5 w-3.5" />
                    {t("selection.openBuilder")}
                  </Button>
                </div>
                <Textarea
                  id="select-expression-source"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder={t("selection.expressionPlaceholder")}
                  spellCheck={false}
                  className="min-h-20 font-mono text-xs"
                />
                {source.trim().length > 0 && !validation.ok && (
                  <p className="text-xs text-destructive">
                    {validation.errors[0] ?? t("selection.invalidExpression")}
                  </p>
                )}
              </div>
              <SelectionModeField
                mode={effectiveMode}
                onChange={setMode}
                disableCombineModes={!targetHoldsSelection}
              />
              {summary && (
                <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                  {t("selection.summary", {
                    selected: summary.selected,
                    total: summary.total,
                    matched: summary.matched,
                  })}
                  {summary.errorCount > 0 && (
                    <>
                      {" "}
                      {t("selection.evaluationErrors", {
                        count: summary.errorCount,
                      })}
                    </>
                  )}
                </p>
              )}
              <div className="flex justify-end">
                <Button onClick={runSelection} disabled={!canSelect}>
                  {t("selection.select")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SelectionFloatingPanel>
      {builderOpen && targetLayer && (
        <ExpressionBuilderDialog
          open
          onOpenChange={(next) => setBuilderOpen(next)}
          targetLabel={t("selection.expressionTarget")}
          context="filter"
          initialExpression={source}
          features={features}
          fieldNames={fieldNames}
          zoom={zoom}
          variables={variables}
          onApply={(expression) => setSource(expression)}
        />
      )}
    </>
  );
}
