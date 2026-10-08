import { useAppStore } from "@geolibre/core";
import {
  applyObjectFeatures,
  computeObjectFeatures,
  type ObiaIndexBands,
} from "@geolibre/processing";
import { Button, Label, Select } from "@geolibre/ui";
import { Loader2, Ruler } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { obiaSourceBands } from "../../../lib/obia/obia-source";
import { ObiaStatus, ObiaStepHeading } from "./ObiaFields";

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
    try {
      const image = await obiaSourceBands(sourceLayer, segmentation.bandIndexes);
      if (!image) throw new Error(t("obia.error.readImage"));
      const { table, calls } = await computeObjectFeatures(segmentation.labels, image, options);
      // Re-read the layer: the user may have edited it while the tools ran.
      const latest = useAppStore
        .getState()
        .layers.find((layer) => layer.id === segmentation.objectsLayerId);
      if (!latest?.geojson) throw new Error(t("obia.measure.error.layersMissing"));
      updateLayer(latest.id, {
        geojson: applyObjectFeatures(latest.geojson, table, features?.table.fields ?? []),
      });
      setFeatures({
        segmentationAt: segmentation.finishedAt,
        table,
        options: { ...options },
        calls,
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("obia.measure.error.failed"));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [segmentation, layers, options, features, updateLayer, setFeatures, t]);

  if (!segmentation) return null;

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
            value={options.textureBand != null ? String(options.textureBand) : ""}
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
            (!options.spectral && !options.shape && options.textureBand == null && !options.context)
          }
          className="gap-2"
          data-testid="obia-measure"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ruler className="h-4 w-4" />}
          {running ? t("obia.measure.running") : t("obia.measure.run")}
        </Button>
      </div>

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
