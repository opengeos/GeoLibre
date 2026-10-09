import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  applyPredictions,
  classifyByRules,
  classifyRandomForestTransfer,
  collectSamples,
  computeObjectFeatures,
  segmentImage,
  tableForAllObjects,
  type ObiaFeatureTable,
  type ObiaReadArea,
  type ObiaToolCall,
} from "@geolibre/processing";
import { Button } from "@geolibre/ui";
import { Layers, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { FeatureCollection } from "geojson";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import {
  DEFAULT_OBIA_NATIVE_PARAMS,
  isNativeMethod,
  nativeSegmentation,
  obiaLocalPath,
  obiaNativeStatus,
  runNativeMeasure,
  runNativeSegmentation,
} from "../../../lib/obia/obia-native";
import { obiaLayerLocation, obiaRunEnv } from "../../../lib/obia/obia-persistence";
import { useObiaSession, type ObiaBatchRun } from "../../../lib/obia/obia-session";
import {
  obiaSourceBands,
  obiaSourceInfo,
  planObiaArea,
  wholeImageWindow,
} from "../../../lib/obia/obia-source";
import { predictionStylePatch } from "./ObiaClassifyStep";
import {
  ObiaRunProgress,
  ObiaStatus,
  ObiaStepHeading,
  isObiaCancel,
  useObiaRun,
} from "./ObiaFields";

/** Raster layers the workbench can read in the browser (GeoTIFF/COG). */
function isImageLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "raster" || layer.type === "cog";
}

/**
 * Step 7: apply the current workflow to other images. Each chosen image is
 * segmented with the same bands and parameters, measured the same way, and
 * classified with the current classifier: the same rules, or a random forest
 * trained on this image's training samples. Each image gets its own objects
 * layer, and the run is recorded for provenance.
 */
export function ObiaBatchStep(): ReactElement | null {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const segmentation = useObiaSession((s) => s.segmentation);
  const features = useObiaSession((s) => s.features);
  const classification = useObiaSession((s) => s.classification);
  const classes = useObiaSession((s) => s.classes);
  const batches = useObiaSession((s) => s.batches);
  const addBatch = useObiaSession((s) => s.addBatch);

  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<{ index: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const progress = useObiaRun();

  const targets = useMemo(
    () => layers.filter((layer) => isImageLayer(layer) && layer.id !== segmentation?.sourceLayerId),
    [layers, segmentation?.sourceLayerId],
  );

  const handleRun = useCallback(async () => {
    if (runningRef.current || !segmentation || !features || !classification) return;
    const sourceObjects = useAppStore
      .getState()
      .layers.find((layer) => layer.id === segmentation.objectsLayerId)?.geojson;
    if (!sourceObjects) {
      setError(t("obia.measure.error.layersMissing"));
      return;
    }
    const chosen = targets.filter((layer) => selected.includes(layer.id));
    if (!chosen.length) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const run = progress.begin();
    const samples = collectSamples(sourceObjects);
    const settings = classification.settings;
    let failedOn: string | null = null;
    // Re-segmenting while the batch runs clears the batch records and makes
    // this workflow stale, so stop rather than record runs against it.
    const stale = () =>
      useObiaSession.getState().segmentation?.finishedAt !== segmentation.finishedAt;
    try {
      for (const [index, target] of chosen.entries()) {
        if (stale()) throw new Error(t("obia.batch.error.changed"));
        failedOn = target.name;
        setCurrent({ index: index + 1, total: chosen.length });
        const calls: ObiaToolCall[] = [];
        // The whole image, at the finest level that fits the pixel limit.
        const info = await obiaSourceInfo(target);
        if (!info) throw new Error(t("obia.batch.error.readImage"));
        let segmented: { objects: FeatureCollection; objectCount: number };
        let measuredTable: ObiaFeatureTable;
        let area: ObiaReadArea;
        let pixelSize: number;
        if (isNativeMethod(segmentation.method)) {
          // Segmented natively: the other images are too, in the sidecar.
          const path = obiaLocalPath(target);
          if (!path) throw new Error(t("obia.native.needsLocalFile"));
          const status = await obiaNativeStatus();
          if (!status?.available) throw new Error(t("obia.native.unavailable"));
          ({ area, pixelSize } = planObiaArea(
            info,
            wholeImageWindow(info),
            status.maxPixels[segmentation.method],
          ));
          const request = nativeSegmentation(
            path,
            segmentation.bandIndexes,
            area,
            segmentation.method,
            segmentation.nativeParams ?? DEFAULT_OBIA_NATIVE_PARAMS,
          );
          const native = await runNativeSegmentation(request, run);
          calls.push(native.call);
          const measured = await runNativeMeasure(request, features.options, native.jobId, run);
          calls.push(measured.call);
          segmented = native;
          measuredTable = measured.table;
        } else {
          ({ area, pixelSize } = planObiaArea(info, wholeImageWindow(info)));
          const image = await obiaSourceBands(target, segmentation.bandIndexes, area);
          if (!image) throw new Error(t("obia.batch.error.readImage"));
          // Reading the image takes no signal, so honour a Cancel made meanwhile.
          if (run.signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
          const browser = await segmentImage(image, segmentation.params, run);
          calls.push({ tool: browser.tool, args: browser.args });
          const measured = await computeObjectFeatures(
            browser.labels,
            image,
            features.options,
            run,
          );
          calls.push(...measured.calls);
          segmented = browser;
          measuredTable = measured.table;
        }
        const table = tableForAllObjects(measuredTable, segmented.objects);
        const result =
          settings.method === "random-forest"
            ? await classifyRandomForestTransfer(
                features.table,
                samples,
                table,
                { fields: classification.fields, trees: settings.trees },
                run,
              )
            : await classifyByRules(
                table,
                settings.rules,
                settings.defaultClass.trim() || "unclassified",
                run,
              );
        calls.push(result.call);
        // Checked before adding anything: past here nothing awaits, so the
        // layer and its batch record are added together or not at all.
        if (stale()) throw new Error(t("obia.batch.error.changed"));
        const objectsLayerId = addGeoJsonLayer(
          t("obia.layerName", { name: target.name }),
          applyPredictions(segmented.objects, result.predictions),
        );
        const added = useAppStore.getState().layers.find((layer) => layer.id === objectsLayerId);
        if (added) {
          updateLayer(objectsLayerId, {
            style: predictionStylePatch(added, classes, result.predictions.values()),
            metadata: { ...added.metadata, obiaRole: "objects" },
          });
        }
        const classCounts: Record<string, number> = {};
        for (const name of result.predictions.values()) {
          classCounts[name] = (classCounts[name] ?? 0) + 1;
        }
        const location = obiaLayerLocation(target);
        addBatch({
          targetLayerId: target.id,
          source: { name: target.name, ...(location ? { location } : {}) },
          area,
          pixelSize,
          objectsLayerId,
          objectCount: segmented.objectCount,
          classCounts,
          calls,
          env: obiaRunEnv(),
          finishedAt: new Date().toISOString(),
        });
      }
      failedOn = null;
      setSelected([]);
    } catch (err) {
      const message = obiaErrorMessage(err, t, t("obia.batch.error.failed"));
      setError(
        isObiaCancel(err)
          ? t("obia.progress.cancelled")
          : failedOn
            ? t("obia.batch.error.onImage", { name: failedOn, message })
            : message,
      );
    } finally {
      progress.end();
      setCurrent(null);
      runningRef.current = false;
      setRunning(false);
    }
  }, [
    segmentation,
    features,
    classification,
    classes,
    targets,
    selected,
    addGeoJsonLayer,
    updateLayer,
    addBatch,
    progress,
    t,
  ]);

  if (!segmentation || !features || !classification) return null;

  const summarize = (run: ObiaBatchRun) =>
    Object.entries(run.classCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${count}`)
      .join(", ");

  return (
    <section className="flex flex-col gap-3 border-t pt-3" data-testid="obia-batch">
      <ObiaStepHeading index={7} title={t("obia.steps.batch")} />
      <p className="text-xs text-muted-foreground">
        {t(
          classification.settings.method === "random-forest"
            ? "obia.batch.hintForest"
            : "obia.batch.hintRules",
        )}
      </p>
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("obia.batch.noTargets")}</p>
      ) : (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-xs font-medium">{t("obia.batch.images")}</legend>
          {targets.map((layer) => (
            <label key={layer.id} className="flex min-w-0 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(layer.id)}
                disabled={running}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked ? [...ids, layer.id] : ids.filter((id) => id !== layer.id),
                  )
                }
              />
              <span className="truncate">{layer.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <Button
          onClick={() => void handleRun()}
          disabled={running || !selected.length}
          className="gap-2"
          data-testid="obia-batch-run"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
          {running && current
            ? t("obia.batch.running", { index: current.index, total: current.total })
            : selected.length
              ? t("obia.batch.run", { count: selected.length })
              : t("obia.batch.runNone")}
        </Button>
      </div>
      <ObiaRunProgress
        step={progress.step}
        startedAt={progress.startedAt}
        onCancel={progress.cancel}
      />
      <ObiaStatus error={error} />
      {batches.length > 0 && (
        <ul className="grid gap-1 text-xs" data-testid="obia-batch-results">
          {batches.map((run) => (
            <li key={run.objectsLayerId} className="min-w-0">
              <span className="font-medium">{run.source.name}</span>
              {": "}
              {t("obia.batch.result", { count: run.objectCount, summary: summarize(run) })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
