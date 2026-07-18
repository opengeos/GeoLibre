import {
  featureSelectionId,
  type SelectionMode,
  useAppStore,
} from "@geolibre/core";
import {
  MAX_CLIENT_PAIRS,
  matchFeaturesByLocation,
  type SelectLocationPredicate,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
} from "@geolibre/ui";
import type { ParseKeys } from "i18next";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  SelectionModeField,
  applyMatchedSelection,
  selectableVectorLayers,
} from "./selection-dialog-shared";

/** Predicates in display order with their i18n label keys. */
const PREDICATES: Array<{ value: SelectLocationPredicate; labelKey: ParseKeys }> =
  [
    { value: "intersects", labelKey: "selection.predicateIntersects" },
    { value: "within", labelKey: "selection.predicateWithin" },
    { value: "contains", labelKey: "selection.predicateContains" },
    { value: "disjoint", labelKey: "selection.predicateDisjoint" },
  ];

/** Outcome of the last "Select features" run, shown inline. */
interface SelectionSummary {
  matched: number;
  selected: number;
  total: number;
  unevaluableDropped: number;
}

/**
 * Select by Location (#1314): turns features of one layer into the live
 * selection based on their spatial relationship to a second layer, using the
 * same Turf predicate engine as the Select by location processing tool — but
 * selecting in place instead of extracting a new layer. Like Select by
 * Expression, the dialog stays open after a run and the four modes combine
 * with the current selection.
 */
export function SelectByLocationDialog(): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.selectByLocationOpen);
  const setOpen = useAppStore((s) => s.setSelectByLocationOpen);
  const preselectedLayerId = useAppStore((s) => s.ui.selectByLocationLayerId);
  const layers = useAppStore((s) => s.layers);

  const eligibleLayers = useMemo(() => selectableVectorLayers(layers), [layers]);

  const [targetLayerId, setTargetLayerId] = useState<string | null>(null);
  const [referenceLayerId, setReferenceLayerId] = useState<string | null>(null);
  const [predicate, setPredicate] =
    useState<SelectLocationPredicate>("intersects");
  const [mode, setMode] = useState<SelectionMode>("new");
  const [summary, setSummary] = useState<SelectionSummary | null>(null);

  // Same seeding as Select by Expression: context-menu target, then previous
  // choice, then the active layer, then the first selectable one.
  useEffect(() => {
    if (!open) return;
    setSummary(null);
    setTargetLayerId((current) => {
      const eligible = selectableVectorLayers(useAppStore.getState().layers);
      const candidates = [
        preselectedLayerId,
        current,
        useAppStore.getState().selectedLayerId,
      ];
      for (const id of candidates) {
        if (id && eligible.some((layer) => layer.id === id)) return id;
      }
      return eligible[0]?.id ?? null;
    });
  }, [open, preselectedLayerId]);

  const targetLayer =
    eligibleLayers.find((layer) => layer.id === targetLayerId) ?? null;
  // Comparing a layer to itself is degenerate (every feature intersects
  // itself), so the reference list excludes the target.
  const referenceOptions = useMemo(
    () => eligibleLayers.filter((layer) => layer.id !== targetLayerId),
    [eligibleLayers, targetLayerId],
  );
  const referenceLayer =
    referenceOptions.find((layer) => layer.id === referenceLayerId) ??
    referenceOptions[0] ??
    null;

  const targetFeatures = targetLayer?.geojson?.features ?? [];
  const referenceFeatures = referenceLayer?.geojson?.features ?? [];
  // The pairwise Turf loop runs on the main thread; past the cap, point the
  // user at the processing tool's sidecar engine instead of freezing the tab.
  const pairs = targetFeatures.length * referenceFeatures.length;
  const tooManyPairs = pairs > MAX_CLIENT_PAIRS;
  const canSelect = Boolean(targetLayer && referenceLayer) && !tooManyPairs;

  const runSelection = () => {
    if (!targetLayer || !referenceLayer) return;
    const { matches, unevaluableDropped } = matchFeaturesByLocation(
      targetFeatures,
      referenceFeatures,
      predicate,
    );
    const ids: string[] = [];
    targetFeatures.forEach((feature, index) => {
      if (matches[index]) ids.push(featureSelectionId(feature, index));
    });
    const selected = applyMatchedSelection(targetLayer.id, ids, mode);
    setSummary({
      matched: ids.length,
      selected,
      total: targetFeatures.length,
      unevaluableDropped,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("selection.byLocationTitle")}</DialogTitle>
          <DialogDescription>
            {t("selection.byLocationDescription")}
          </DialogDescription>
        </DialogHeader>
        {eligibleLayers.length < 2 ? (
          <p className="text-sm text-muted-foreground">
            {t("selection.needTwoLayers")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="select-location-layer">
                {t("selection.targetLayer")}
              </Label>
              <Select
                id="select-location-layer"
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
              <Label htmlFor="select-location-predicate">
                {t("selection.predicate")}
              </Label>
              <Select
                id="select-location-predicate"
                value={predicate}
                onChange={(event) =>
                  setPredicate(event.target.value as SelectLocationPredicate)
                }
              >
                {PREDICATES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {t(entry.labelKey)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="select-location-reference">
                {t("selection.referenceLayer")}
              </Label>
              <Select
                id="select-location-reference"
                value={referenceLayer?.id ?? ""}
                onChange={(event) => {
                  setReferenceLayerId(event.target.value || null);
                  setSummary(null);
                }}
              >
                {referenceOptions.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </Select>
            </div>
            <SelectionModeField mode={mode} onChange={setMode} />
            {tooManyPairs && (
              <p className="text-xs text-destructive">
                {t("selection.tooManyPairs", {
                  pairs: pairs.toLocaleString(),
                  limit: MAX_CLIENT_PAIRS.toLocaleString(),
                })}
              </p>
            )}
            {summary && (
              <p
                className="text-sm text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {t("selection.summary", {
                  selected: summary.selected,
                  total: summary.total,
                  matched: summary.matched,
                })}
                {summary.unevaluableDropped > 0 && (
                  <>
                    {" "}
                    {t("selection.unevaluableDisjoint", {
                      count: summary.unevaluableDropped,
                    })}
                  </>
                )}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t("common.close")}
              </Button>
              <Button onClick={runSelection} disabled={!canSelect}>
                {t("selection.select")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
