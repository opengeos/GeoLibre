import { useAppStore } from "@geolibre/core";
import {
  applyObjectFeatures,
  computeObjectFeatures,
  type ObiaFeatureTable,
  type ObiaIndexBands,
  type ObiaToolCall,
} from "@geolibre/processing";
import { Button, Label, Select } from "@geolibre/ui";
import { Loader2, Ruler } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { ensureObiaLabels, obiaRunEnv } from "../../../lib/obia/obia-persistence";
import {
  DEFAULT_OBIA_NATIVE_PARAMS,
  isNativeMethod,
  nativeSegmentation,
  obiaLocalPath,
  runNativeMeasure,
} from "../../../lib/obia/obia-native";
import { obiaSourceBands } from "../../../lib/obia/obia-source";
import {
  ObiaRunProgress,
  ObiaStatus,
  ObiaStepHeading,
  isObiaCancel,
  useObiaRun,
} from "./ObiaFields";

/**
 * Default band roles for the spectral indices: a 4-band image whose bands were
 * all segmented reads as red, green, blue, near-infrared (NAIP and most
 * 4-band aerial imagery). Anything else starts unassigned.
 */
export function defaultIndexBands(bandIndexes: readonly number[]): ObiaIndexBands {
  if (bandIndexes.length === 4 && bandIndexes.every((band, i) => band === i + 1)) {
    return { red: 1, green: 2, nir: 4 };
  }
  return {};
}

/**
 * Step 2: measure each object (spectral statistics, indices, shape, texture,
 * neighborhood) and write the values onto the objects layer, where the
 * attribute table, styling and the classifier can use them.
 */
export function ObiaMeasureStep(): ReactElement | null {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const segmentation = useObiaSession((s) => s.segmentation);
  const options = useObiaSession((s) => s.featureOptions);
  const setOptions = useObiaSession((s) => s.setFeatureOptions);
  const features = useObiaSession((s) => s.features);
  const setFeatures = useObiaSession((s) => s.setFeatures);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const progress = useObiaRun();

  const bands = segmentation?.bandIndexes ?? [];
  const bandKey = bands.join(",");
  // Re-seed the index roles and texture band whenever the segmented bands change.
  useEffect(() => {
    if (!bandKey) return;
    const segmented = bandKey.split(",").map(Number);
    const current = useObiaSession.getState().featureOptions;
    const rolesValid = Object.values(current.indices ?? {}).every(
      (band) => band == null || segmented.includes(band),
    );
    const textureValid = current.textureBand == null || segmented.includes(current.textureBand);
    if (current.indices && !rolesValid) setOptions({ indices: defaultIndexBands(segmented) });
    if (!textureValid) setOptions({ textureBand: undefined });
  }, [bandKey, setOptions]);

  const handleMeasure = useCallback(async () => {
    if (runningRef.current || !segmentation) return;
    const sourceLayer = layers.find((layer) => layer.id === segmentation.sourceLayerId);
    const objectsLayer = layers.find((layer) => layer.id === segmentation.objectsLayerId);
    if (!sourceLayer || !objectsLayer?.geojson) {
      setError(t("obia.measure.error.layersMissing"));
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const run = progress.begin();
    // GLCM texture has no native implementation; a native run measures without it.
    const measuredOptions = isNativeMethod(segmentation.method)
      ? { ...options, textureBand: undefined }
      : options;
    try {
      let table: ObiaFeatureTable;
      let calls: ObiaToolCall[];
      if (isNativeMethod(segmentation.method)) {
        // Natively segmented: measure in the sidecar too, on its labels.
        const path = obiaLocalPath(sourceLayer);
        if (!path) throw new Error(t("obia.measure.error.layersMissing"));
        const request = nativeSegmentation(
          path,
          segmentation.bandIndexes,
          segmentation.area,
          segmentation.method,
          segmentation.nativeParams ?? DEFAULT_OBIA_NATIVE_PARAMS,
        );
        const measured = await runNativeMeasure(
          request,
          measuredOptions,
          segmentation.nativeJobId ?? null,
          run,
        );
        table = measured.table;
        calls = [measured.call];
      } else {
        const image = await obiaSourceBands(
          sourceLayer,
          segmentation.bandIndexes,
          segmentation.area,
        );
        if (!image) throw new Error(t("obia.error.readImage"));
        // A reloaded project rebuilds the label raster it did not save.
        const labels = await ensureObiaLabels(run);
        ({ table, calls } = await computeObjectFeatures(labels, image, measuredOptions, run));
      }
      // A re-segmentation while the tools ran makes this table describe
      // objects that are gone; drop it rather than write it anywhere.
      if (useObiaSession.getState().segmentation?.finishedAt !== segmentation.finishedAt) {
        setError(t("obia.measure.error.resegmented"));
        return;
      }
      // Re-read the layer: the user may have edited it while the tools ran.
      const latest = useAppStore
        .getState()
        .layers.find((layer) => layer.id === segmentation.objectsLayerId);
      if (!latest?.geojson) throw new Error(t("obia.measure.error.layersMissing"));
      updateLayer(latest.id, {
        // Read the previous run at write time, not from the click's closure, so
        // the fields it wrote are always the ones removed.
        geojson: applyObjectFeatures(
          latest.geojson,
          table,
          useObiaSession.getState().features?.table.fields ?? [],
        ),
      });
      setFeatures({
        segmentationAt: segmentation.finishedAt,
        table,
        options: { ...measuredOptions },
        calls,
        env: obiaRunEnv(),
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(
        isObiaCancel(err)
          ? t("obia.progress.cancelled")
          : obiaErrorMessage(err, t, t("obia.measure.error.failed")),
      );
    } finally {
      progress.end();
      runningRef.current = false;
      setRunning(false);
    }
  }, [segmentation, layers, options, updateLayer, setFeatures, progress, t]);

  if (!segmentation) return null;
  const native = isNativeMethod(segmentation.method);

  const roles = options.indices;
  const roleSelect = (role: keyof ObiaIndexBands, label: string) => (
    <div className="grid gap-1">
      <Label htmlFor={`obia-role-${role}`} className="text-xs">
        {label}
      </Label>
      <Select
        id={`obia-role-${role}`}
        value={roles?.[role] != null ? String(roles[role]) : ""}
        onChange={(event) =>
          setOptions({
            indices: {
              ...roles,
              [role]: event.target.value ? Number(event.target.value) : undefined,
            },
          })
        }
      >
        <option value="">{t("obia.measure.none")}</option>
        {bands.map((band) => (
          <option key={band} value={band}>
            {t("obia.bandN", { index: band })}
          </option>
        ))}
      </Select>
    </div>
  );

  const checkbox = (
    id: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    label: string,
  ) => (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );

  return (
    <section className="flex flex-col gap-3 border-t pt-3">
      <ObiaStepHeading index={2} title={t("obia.steps.measure")} />
      <p className="text-xs text-muted-foreground">{t("obia.measure.hint")}</p>

      <div className="grid gap-2">
        {checkbox(
          "obia-feat-spectral",
          options.spectral,
          (spectral) => setOptions({ spectral, indices: spectral ? options.indices : undefined }),
          t("obia.measure.spectral"),
        )}
        {checkbox(
          "obia-feat-indices",
          Boolean(roles),
          (on) => setOptions({ indices: on ? defaultIndexBands(bands) : undefined }),
          t("obia.measure.indices"),
        )}
        {roles && (
          <div className="grid grid-cols-3 gap-2 ps-6">
            {roleSelect("red", t("obia.measure.red"))}
            {roleSelect("green", t("obia.measure.green"))}
            {roleSelect("nir", t("obia.measure.nir"))}
          </div>
        )}
        {roles && !options.spectral && (
          <p className="ps-6 text-xs text-muted-foreground">
            {t("obia.measure.indicesNeedSpectral")}
          </p>
        )}
        {checkbox(
          "obia-feat-shape",
          options.shape,
          (shape) => setOptions({ shape }),
          t("obia.measure.shape"),
        )}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <Label htmlFor="obia-feat-texture" className="text-sm font-normal">
            {t("obia.measure.texture")}
          </Label>
          <Select
            id="obia-feat-texture"
            disabled={native}
            value={!native && options.textureBand != null ? String(options.textureBand) : ""}
            onChange={(event) =>
              setOptions({
                textureBand: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          >
            <option value="">{t("obia.measure.none")}</option>
            {bands.map((band) => (
              <option key={band} value={band}>
                {t("obia.bandN", { index: band })}
              </option>
            ))}
          </Select>
        </div>
        {native && (
          <p className="-mt-1 text-xs text-muted-foreground">
            {t("obia.measure.textureBrowserOnly")}
          </p>
        )}
        {checkbox(
          "obia-feat-context",
          options.context,
          (context) => setOptions({ context }),
          t("obia.measure.context"),
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={() => void handleMeasure()}
          disabled={
            running ||
            (!options.spectral &&
              !options.shape &&
              (native || options.textureBand == null) &&
              !options.context)
          }
          className="gap-2"
          data-testid="obia-measure"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ruler className="h-4 w-4" />}
          {running ? t("obia.measure.running") : t("obia.measure.run")}
        </Button>
      </div>
      <ObiaRunProgress
        step={progress.step}
        startedAt={progress.startedAt}
        onCancel={progress.cancel}
      />

      <ObiaStatus
        error={error}
        testId="obia-measure-result"
        success={
          features && !running
            ? t("obia.measure.result", {
                fields: features.table.fields.length,
                count: features.table.rows.size,
              })
            : null
        }
      />
    </section>
  );
}
