import { useAppStore } from "@geolibre/core";
import { applyObjectFeatures } from "@geolibre/processing";
import { Button } from "@geolibre/ui";
import { Layers3, Loader2, Network } from "lucide-react";
import { useCallback, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import { computeContextFeatures } from "../../../lib/obia/obia-context";
import { ObiaLevelError, addBuiltLevel, buildCoarserLevel } from "../../../lib/obia/obia-levels";
import { useObiaSession } from "../../../lib/obia/obia-session";
import {
  ObiaNumberField,
  ObiaRunProgress,
  ObiaStatus,
  ObiaStepHeading,
  isObiaCancel,
  useObiaRun,
} from "./ObiaFields";

const LEVEL_ERRORS = {
  "no-features": "obia.levels.error.noFeatures",
  "too-large": "obia.levels.error.tooLarge",
  "not-top": "obia.levels.error.notTop",
} as const;

/**
 * Step 3: the object hierarchy. Build coarser levels by merging the current
 * level's objects (so each object contains its children), and choose the level
 * the later steps work on.
 */
export function ObiaLevelsStep(): ReactElement | null {
  const { t } = useTranslation();
  const updateLayer = useAppStore((s) => s.updateLayer);
  const segmentation = useObiaSession((s) => s.segmentation);
  const features = useObiaSession((s) => s.features);
  const level = useObiaSession((s) => s.level);
  const levels = useObiaSession((s) => s.levels);
  const extendFeatures = useObiaSession((s) => s.extendFeatures);
  const [contextResult, setContextResult] = useState<string | null>(null);
  const switchLevel = useObiaSession((s) => s.switchLevel);
  const [scale, setScale] = useState(10);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const progress = useObiaRun();

  const handleBuild = useCallback(async () => {
    if (runningRef.current || !segmentation) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const run = progress.begin();
    try {
      const built = await buildCoarserLevel(scale, run);
      if (useObiaSession.getState().segmentation?.finishedAt !== segmentation.finishedAt) {
        setError(t("obia.measure.error.resegmented"));
        return;
      }
      addBuiltLevel(
        built,
        t("obia.levels.layerName", { name: segmentation.source.name, level: built.record.level }),
      );
    } catch (err) {
      setError(
        isObiaCancel(err)
          ? t("obia.progress.cancelled")
          : err instanceof ObiaLevelError
            ? t(LEVEL_ERRORS[err.code])
            : obiaErrorMessage(err, t, t("obia.levels.error.failed")),
      );
    } finally {
      progress.end();
      runningRef.current = false;
      setRunning(false);
    }
  }, [segmentation, scale, progress, t]);

  const handleContext = useCallback(async () => {
    if (runningRef.current || !segmentation) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setContextResult(null);
    const run = progress.begin();
    try {
      const { table, added, call } = await computeContextFeatures(run);
      const session = useObiaSession.getState();
      if (session.segmentation?.finishedAt !== segmentation.finishedAt) {
        setError(t("obia.measure.error.resegmented"));
        return;
      }
      const layer = useAppStore
        .getState()
        .layers.find((item) => item.id === segmentation.objectsLayerId);
      if (!layer?.geojson) throw new Error(t("obia.measure.error.layersMissing"));
      updateLayer(layer.id, {
        geojson: applyObjectFeatures(layer.geojson, table, session.features?.table.fields ?? []),
      });
      extendFeatures(table, call);
      setContextResult(t("obia.levels.context.result", { count: added.length }));
    } catch (err) {
      setError(
        isObiaCancel(err)
          ? t("obia.progress.cancelled")
          : obiaErrorMessage(err, t, t("obia.levels.context.failed")),
      );
    } finally {
      progress.end();
      runningRef.current = false;
      setRunning(false);
    }
  }, [segmentation, updateLayer, extendFeatures, progress, t]);

  if (!segmentation || !features) return null;

  const all = [
    ...levels.map((record) => ({
      level: record.level,
      count: record.segmentation.objectCount,
      scale: record.segmentation.merge?.scale,
      mapped: record.segmentation.merge?.mapped,
    })),
    {
      level,
      count: segmentation.objectCount,
      scale: segmentation.merge?.scale,
      mapped: segmentation.merge?.mapped,
    },
  ].sort((a, b) => a.level - b.level);
  const top = Math.max(...all.map((item) => item.level));

  return (
    <section className="flex flex-col gap-3 border-t pt-3" data-testid="obia-levels">
      <ObiaStepHeading index={3} title={t("obia.steps.levels")} />
      <p className="text-xs text-muted-foreground">{t("obia.levels.hint")}</p>
      <fieldset className="grid gap-1" data-testid="obia-level-list">
        <legend className="mb-1 text-xs font-medium">{t("obia.levels.workOn")}</legend>
        {all.map((item) => (
          <label key={item.level} className="flex min-w-0 items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="obia-level"
              checked={item.level === level}
              disabled={running}
              onChange={() => switchLevel(item.level)}
            />
            <span className="truncate">
              {item.mapped
                ? t("obia.levels.mapped", { level: item.level, count: item.count })
                : item.scale == null
                  ? t("obia.levels.base", { level: item.level, count: item.count })
                  : t("obia.levels.merged", {
                      level: item.level,
                      count: item.count,
                      scale: item.scale,
                    })}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-[minmax(0,8rem)_auto] items-end gap-2">
        <ObiaNumberField
          id="obia-level-scale"
          label={t("obia.levels.scale")}
          value={scale}
          onChange={setScale}
          min={0.1}
          step={1}
        />
        <Button
          onClick={() => void handleBuild()}
          disabled={running || level !== top}
          className="gap-2"
          data-testid="obia-level-build"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers3 className="h-4 w-4" />}
          {t("obia.levels.build")}
        </Button>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        {level === top ? t("obia.levels.scaleHint") : t("obia.levels.buildFromTop")}
      </p>
      <div className="grid gap-1.5">
        <span className="text-xs font-medium">{t("obia.levels.context.title")}</span>
        <p className="text-xs text-muted-foreground">{t("obia.levels.context.hint")}</p>
        <div>
          <Button
            variant="outline"
            onClick={() => void handleContext()}
            disabled={running}
            className="gap-2"
            data-testid="obia-context"
          >
            <Network className="h-4 w-4" />
            {t("obia.levels.context.run")}
          </Button>
        </div>
      </div>
      <ObiaRunProgress
        step={progress.step}
        startedAt={progress.startedAt}
        onCancel={progress.cancel}
      />
      <ObiaStatus error={error} success={contextResult} testId="obia-context-result" />
    </section>
  );
}
