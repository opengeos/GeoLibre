import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  OBIA_PREDICTED_FIELD,
  OBIA_RULE_OPS,
  applyPredictions,
  classifyByRules,
  classifyRandomForest,
  collectSamples,
  type ObiaClass,
  type ObiaRule,
  type ObiaRuleOp,
} from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ObiaNumberField, ObiaNumberInput, ObiaStatus, ObiaStepHeading } from "./ObiaFields";

/** Color of objects no rule matched. */
const UNCLASSIFIED_COLOR = "#9ca3af";

/** Style the objects layer by predicted class, in the class colors. */
export function predictionStylePatch(
  layer: GeoLibreLayer,
  classes: readonly ObiaClass[],
  defaultClass?: string,
) {
  const stops = classes.map((cls) => ({ value: cls.name, color: cls.color, label: cls.name }));
  if (defaultClass && !classes.some((cls) => cls.name === defaultClass)) {
    stops.push({ value: defaultClass, color: UNCLASSIFIED_COLOR, label: defaultClass });
  }
  return {
    ...layer.style,
    vectorStyleMode: "categorized" as const,
    vectorStyleProperty: OBIA_PREDICTED_FIELD,
    vectorStyleStops: stops,
    fillColor: "rgba(0, 0, 0, 0)",
    fillOpacity: 0.6,
  };
}

/**
 * Step 4: classify every object, either with a random forest trained on the
 * training samples or with ordered threshold rules, and write the predicted
 * class onto the objects layer.
 */
export function ObiaClassifyStep(): ReactElement | null {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const segmentation = useObiaSession((s) => s.segmentation);
  const features = useObiaSession((s) => s.features);
  const classes = useObiaSession((s) => s.classes);
  const settings = useObiaSession((s) => s.classifier);
  const setSettings = useObiaSession((s) => s.setClassifier);
  const classification = useObiaSession((s) => s.classification);
  const setClassification = useObiaSession((s) => s.setClassification);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const measured = features?.table.fields ?? [];
  // A re-measure can drop columns a saved selection still names.
  const chosen = settings.fields ? settings.fields.filter((f) => measured.includes(f)) : measured;

  const objectsLayer = layers.find((layer) => layer.id === segmentation?.objectsLayerId) ?? null;
  const trainingCount = useMemo(
    () =>
      objectsLayer?.geojson
        ? collectSamples(objectsLayer.geojson).filter((s) => s.role === "training").length
        : 0,
    [objectsLayer],
  );

  const toggleField = (field: string, on: boolean) => {
    const next = on
      ? measured.filter((f) => f === field || chosen.includes(f))
      : chosen.filter((f) => f !== field);
    setSettings({ fields: next.length === measured.length ? null : next });
  };

  const updateRule = (index: number, patch: Partial<ObiaRule>) =>
    setSettings({
      rules: settings.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    });

  const addRule = () =>
    setSettings({
      rules: [
        ...settings.rules,
        {
          field: measured.includes("ndvi") ? "ndvi" : (measured[0] ?? ""),
          op: ">",
          value: 0,
          className: classes[0]?.name ?? "",
        },
      ],
    });

  // The class objects matching no rule get, used for both the predictions and
  // the legend so the two always agree.
  const defaultClass = settings.defaultClass.trim() || "unclassified";

  const handleClassify = useCallback(async () => {
    if (runningRef.current || !segmentation || !features) return;
    const layer = useAppStore
      .getState()
      .layers.find((item) => item.id === segmentation.objectsLayerId);
    if (!layer?.geojson) {
      setError(t("obia.measure.error.layersMissing"));
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const result =
        settings.method === "random-forest"
          ? await classifyRandomForest(features.table, collectSamples(layer.geojson), {
              fields: chosen,
              trees: settings.trees,
            })
          : await classifyByRules(
              features.table,
              settings.rules.filter((rule) => rule.field && rule.className),
              defaultClass,
            );
      const latest = useAppStore
        .getState()
        .layers.find((item) => item.id === segmentation.objectsLayerId);
      if (!latest?.geojson) throw new Error(t("obia.measure.error.layersMissing"));
      updateLayer(latest.id, {
        geojson: applyPredictions(latest.geojson, result.predictions),
        style: predictionStylePatch(
          latest,
          classes,
          settings.method === "rules" ? defaultClass : undefined,
        ),
      });
      setClassification({
        ...result,
        settings: { ...settings, fields: settings.fields ? [...settings.fields] : null },
        featuresAt: features.finishedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("obia.classify.error.failed"));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [
    segmentation,
    features,
    settings,
    chosen,
    classes,
    defaultClass,
    updateLayer,
    setClassification,
    t,
  ]);

  const summary = useMemo(() => {
    if (!classification) return null;
    const counts = new Map<string, number>();
    for (const name of classification.predictions.values()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");
  }, [classification]);

  if (!segmentation || !features) return null;

  return (
    <section className="flex flex-col gap-3 border-t pt-3">
      <ObiaStepHeading index={4} title={t("obia.steps.classify")} />

      <div
        className="flex items-center gap-4 text-sm"
        role="radiogroup"
        aria-label={t("obia.classify.method")}
      >
        <span className="text-xs font-medium">{t("obia.classify.method")}</span>
        {(["random-forest", "rules"] as const).map((method) => (
          <label key={method} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="obia-classifier"
              value={method}
              checked={settings.method === method}
              onChange={() => setSettings({ method })}
            />
            {t(`obia.classify.methods.${method}`)}
          </label>
        ))}
      </div>

      {settings.method === "random-forest" ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t("obia.classify.rfHint", { count: trainingCount })}
          </p>
          <div className="w-32">
            <ObiaNumberField
              id="obia-trees"
              label={t("obia.classify.trees")}
              value={settings.trees}
              onChange={(trees) => setSettings({ trees: Math.round(trees) })}
              min={10}
              max={1000}
              step={10}
            />
          </div>
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs font-medium">
              {t("obia.classify.features", { count: chosen.length, total: measured.length })}
            </legend>
            <div className="grid max-h-32 grid-cols-2 gap-x-3 gap-y-0.5 overflow-auto rounded-md border p-2">
              {measured.map((field) => (
                <label key={field} className="flex min-w-0 items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={chosen.includes(field)}
                    onChange={(event) => toggleField(field, event.target.checked)}
                  />
                  <span className="truncate font-mono">{field}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t("obia.classify.rulesHint")}</p>
          <ol className="flex flex-col gap-1.5">
            {settings.rules.map((rule, index) => (
              <li
                key={index}
                className="grid grid-cols-[minmax(0,1.2fr)_3.5rem_4.5rem_minmax(0,1.5fr)_auto] items-center gap-1"
                data-testid="obia-rule-row"
              >
                <Select
                  aria-label={t("obia.classify.ruleField")}
                  value={rule.field}
                  onChange={(event) => updateRule(index, { field: event.target.value })}
                >
                  {measured.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t("obia.classify.ruleOp")}
                  value={rule.op}
                  onChange={(event) => updateRule(index, { op: event.target.value as ObiaRuleOp })}
                >
                  {OBIA_RULE_OPS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </Select>
                <ObiaNumberInput
                  aria-label={t("obia.classify.ruleValue")}
                  value={rule.value}
                  step="any"
                  onChange={(value) => updateRule(index, { value })}
                />
                <Select
                  aria-label={t("obia.classify.ruleClass")}
                  value={rule.className}
                  onChange={(event) => updateRule(index, { className: event.target.value })}
                >
                  {classes.map((cls) => (
                    <option key={cls.name} value={cls.name}>
                      {cls.name}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  aria-label={t("obia.classify.removeRule")}
                  onClick={() =>
                    setSettings({ rules: settings.rules.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={!classes.length || !measured.length}
              onClick={addRule}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("obia.classify.addRule")}
            </Button>
            <div className="grid gap-1">
              <Label htmlFor="obia-default-class" className="text-xs">
                {t("obia.classify.defaultClass")}
              </Label>
              <Input
                id="obia-default-class"
                className="h-8 w-40"
                value={settings.defaultClass}
                onChange={(event) => setSettings({ defaultClass: event.target.value })}
              />
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={() => void handleClassify()}
          disabled={
            running ||
            (settings.method === "random-forest" ? !chosen.length : !settings.rules.length)
          }
          className="gap-2"
          data-testid="obia-classify"
        >
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {running ? t("obia.classify.running") : t("obia.classify.run")}
        </Button>
      </div>

      <ObiaStatus
        error={error}
        testId="obia-classify-result"
        success={
          classification && !running
            ? t("obia.classify.result", {
                count: classification.predictions.size,
                summary,
              })
            : null
        }
      />
      {classification && !running && Object.keys(classification.imputed).length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("obia.classify.imputed", {
            fields: Object.entries(classification.imputed)
              .map(([field, n]) => `${field} (${n})`)
              .join(", "),
          })}
        </p>
      )}
    </section>
  );
}
