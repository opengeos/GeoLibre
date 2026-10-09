import { useAppStore } from "@geolibre/core";
import { OBIA_SEGMENT_ID_FIELD, applyObjectFeatures } from "@geolibre/processing";
import { Button } from "@geolibre/ui";
import { Layers3, Loader2 } from "lucide-react";
import { useCallback, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import { ObiaLevelError, buildCoarserLevel } from "../../../lib/obia/obia-levels";
import { OBIA_PARENT_FIELD } from "../../../lib/obia/obia-persistence";
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

/** Outline colors by level, so nested levels read apart on the map. */
const LEVEL_COLORS = ["#facc15", "#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

/**
 * Step 3: the object hierarchy. Build coarser levels by merging the current
 * level's objects (so each object contains its children), and choose the level
 * the later steps work on.
 */
export function ObiaLevelsStep(): ReactElement | null {
  const { t } = useTranslation();
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const segmentation = useObiaSession((s) => s.segmentation);
  const features = useObiaSession((s) => s.features);
  const level = useObiaSession((s) => s.level);
  const levels = useObiaSession((s) => s.levels);
  const addLevel = useObiaSession((s) => s.addLevel);
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
      const childLayer = useAppStore
        .getState()
        .layers.find((layer) => layer.id === segmentation.objectsLayerId);
      if (!childLayer?.geojson) throw new Error(t("obia.measure.error.layersMissing"));
      const next = built.record.level;
      const objectsLayerId = addGeoJsonLayer(
        t("obia.levels.layerName", { name: segmentation.source.name, level: next }),
        applyObjectFeatures(built.objects, built.table),
      );
      const added = useAppStore.getState().layers.find((layer) => layer.id === objectsLayerId);
      if (added) {
        updateLayer(objectsLayerId, {
          style: {
            ...added.style,
            fillOpacity: 0,
            strokeColor: LEVEL_COLORS[(next - 1) % LEVEL_COLORS.length],
            strokeWidth: 2,
          },
          metadata: { ...added.metadata, obiaRole: "objects", obiaLevel: next },
        });
      }
      // Link each child to its parent on the level below's objects.
      updateLayer(childLayer.id, {
        geojson: {
          ...childLayer.geojson,
          features: childLayer.geojson.features.map((feature) => {
            const id = Number(feature.properties?.[OBIA_SEGMENT_ID_FIELD] ?? feature.id);
            return {
              ...feature,
              properties: { ...feature.properties, [OBIA_PARENT_FIELD]: built.parentOf.get(id) ?? null },
            };
          }),
        },
      });
      addLevel({
        ...built.record,
        segmentation: { ...built.record.segmentation, objectsLayerId },
      });
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
  }, [segmentation, scale, addGeoJsonLayer, updateLayer, addLevel, progress, t]);

  if (!segmentation || !features) return null;

  const all = [
    ...levels.map((record) => ({
      level: record.level,
      count: record.segmentation.objectCount,
      scale: record.segmentation.merge?.scale,
    })),
    { level, count: segmentation.objectCount, scale: segmentation.merge?.scale },
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
              {item.scale == null
                ? t("obia.levels.base", { level: item.level, count: item.count })
                : t("obia.levels.merged", { level: item.level, count: item.count, scale: item.scale })}
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
      <ObiaRunProgress step={progress.step} startedAt={progress.startedAt} onCancel={progress.cancel} />
      <ObiaStatus error={error} />
    </section>
  );
}
