import { shouldZoomToNewLayers, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { OBIA_MAX_PIXELS, fingerprintSegmentLabels, segmentImage } from "@geolibre/processing";
import { Button, Label, Select } from "@geolibre/ui";
import type { FeatureCollection } from "geojson";
import { Info, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useObiaSession, type ObiaAddRaster } from "../../../lib/obia/obia-session";
import {
  isNativeMethod,
  nativeSegmentation,
  obiaLocalPath,
  obiaNativeStatus,
  runNativeSegmentation,
  type ObiaNativeStatus,
} from "../../../lib/obia/obia-native";
import { obiaErrorMessage } from "../../../lib/obia/obia-errors";
import { obiaLayerLocation, obiaRunEnv } from "../../../lib/obia/obia-persistence";
import {
  boundsWindow,
  obiaSourceBands,
  obiaSourceInfo,
  obiaSourceKey,
  planObiaArea,
  wholeImageWindow,
  type ObiaSourceInfo,
} from "../../../lib/obia/obia-source";
import { ObiaAreaNote, ObiaMethodFields } from "./ObiaMethodFields";
import {
  ObiaRunProgress,
  ObiaStatus,
  ObiaStepHeading,
  isObiaCancel,
  useObiaRun,
} from "./ObiaFields";

interface ObiaSegmentStepProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  onAddRaster: ObiaAddRaster;
}

/** Raster layers the workbench can read in the browser (GeoTIFF/COG). */
function isImageLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "raster" || layer.type === "cog";
}

/** Objects outlined over the imagery: no fill, a bright 1px outline. */
const OBJECT_OUTLINE_STYLE = {
  fillOpacity: 0,
  strokeColor: "#facc15",
  strokeWidth: 1,
} as const;

/**
 * Step 1: segment a raster layer into objects, added to the map as one polygon
 * per object whose id and `segment_id` are the object's label.
 */
export function ObiaSegmentStep({
  mapControllerRef,
  onAddRaster,
}: ObiaSegmentStepProps): ReactElement {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const sourceLayerId = useObiaSession((s) => s.sourceLayerId);
  const setSourceLayerId = useObiaSession((s) => s.setSourceLayerId);
  const bandIndexes = useObiaSession((s) => s.bandIndexes);
  const setBandIndexes = useObiaSession((s) => s.setBandIndexes);
  const areaMode = useObiaSession((s) => s.areaMode);
  const method = useObiaSession((s) => s.method);
  const nativeParams = useObiaSession((s) => s.nativeParams);
  const setAreaMode = useObiaSession((s) => s.setAreaMode);
  const viewBounds = useAppStore((s) => s.mapView.bbox);
  const params = useObiaSession((s) => s.params);
  const segmentation = useObiaSession((s) => s.segmentation);
  const setSegmentation = useObiaSession((s) => s.setSegmentation);

  const imageLayers = useMemo(() => layers.filter(isImageLayer), [layers]);
  const sourceLayer = imageLayers.find((layer) => layer.id === sourceLayerId) ?? null;

  const [summary, setSummary] = useState<ObiaSourceInfo | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [addLabels, setAddLabels] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const progress = useObiaRun();

  // Default to the first image layer so a single-raster project needs no pick.
  useEffect(() => {
    if (sourceLayer || !imageLayers.length) return;
    setSourceLayerId(imageLayers[0].id);
  }, [sourceLayer, imageLayers, setSourceLayerId]);

  // Read the chosen layer's header to list its bands. Keyed on the layer's
  // data source, not the layer object, so restyling or renaming it does not
  // re-read the header or clear an error the user has not read yet.
  const sourceKey = sourceLayer ? obiaSourceKey(sourceLayer) : "";
  useEffect(() => {
    const layer = useAppStore.getState().layers.find((item) => item.id === sourceLayerId);
    if (!sourceKey || !layer) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    // Drop the previous image's band list while the new header is read.
    setSummary(null);
    setLoadingImage(true);
    setError(null);
    void (async () => {
      try {
        // Only the header: a remote COG is read by byte ranges, not downloaded.
        const info = await obiaSourceInfo(layer);
        if (cancelled) return;
        if (!info) throw new Error(t("obia.error.readImage"));
        setSummary(info);
        const current = useObiaSession.getState().bandIndexes;
        if (!current.length || current.some((band) => band > info.bandCount)) {
          setBandIndexes(Array.from({ length: info.bandCount }, (_, index) => index + 1));
        }
      } catch (err) {
        if (cancelled) return;
        setSummary(null);
        setError(err instanceof Error ? err.message : t("obia.error.readImage"));
      } finally {
        if (!cancelled) setLoadingImage(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // sourceLayerId is folded into sourceKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, setBandIndexes, t]);

  const toggleBand = useCallback(
    (index: number, checked: boolean) => {
      const next = checked
        ? [...bandIndexes, index].sort((a, b) => a - b)
        : bandIndexes.filter((band) => band !== index);
      setBandIndexes(next);
    },
    [bandIndexes, setBandIndexes],
  );

  // What a run would read: the whole image or the map view's part of it, at
  // the finest resolution level that fits the workbench's pixel limit.
  // Native segmentation: the desktop sidecar, on an image from a local file.
  const [nativeStatus, setNativeStatus] = useState<ObiaNativeStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void obiaNativeStatus().then((status) => {
      if (!cancelled) setNativeStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const localPath = sourceLayer ? obiaLocalPath(sourceLayer) : null;
  const nativeUsable = Boolean(nativeStatus?.available && localPath);
  const native = isNativeMethod(method);
  const maxPixels = native && nativeStatus ? nativeStatus.maxPixels[method] : OBIA_MAX_PIXELS;

  const plan = useMemo(() => {
    if (!summary) return null;
    const window =
      areaMode === "view"
        ? viewBounds
          ? boundsWindow(summary, viewBounds)
          : null
        : wholeImageWindow(summary);
    return window ? planObiaArea(summary, window, maxPixels) : null;
  }, [summary, areaMode, viewBounds, maxPixels]);

  const handleSegment = useCallback(async () => {
    if (runningRef.current || !sourceLayer || !summary) return;
    if (!plan) {
      setError(t("obia.error.emptyArea"));
      return;
    }
    if (!bandIndexes.length) {
      setError(t("obia.error.noBands"));
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const run = progress.begin();
    try {
      const { area } = plan;
      let result: {
        labels: Uint8Array;
        objects: FeatureCollection;
        objectCount: number;
        meanObjectArea: number;
        tool: string;
        args: string[];
      };
      let size: { width: number; height: number };
      let nativeJobId: string | undefined;
      if (isNativeMethod(method)) {
        if (!localPath) throw new Error(t("obia.native.needsLocalFile"));
        const request = nativeSegmentation(localPath, bandIndexes, area, method, nativeParams);
        const out = await runNativeSegmentation(request, run);
        result = {
          labels: out.labels,
          objects: out.objects,
          objectCount: out.objectCount,
          meanObjectArea: out.objectCount ? (out.width * out.height) / out.objectCount : 0,
          tool: out.call.tool,
          args: out.call.args,
        };
        size = { width: out.width, height: out.height };
        nativeJobId = out.jobId;
      } else {
        const image = await obiaSourceBands(sourceLayer, bandIndexes, area);
        if (!image) throw new Error(t("obia.error.readImage"));
        result = await segmentImage(image, params, run);
        size = { width: image.width, height: image.height };
      }
      const name = t("obia.layerName", { name: sourceLayer.name });
      // Fingerprint before adding the layer, so a failure here leaves nothing behind.
      const { hash: labelsHash } = await fingerprintSegmentLabels(result.labels);
      const objectsLayerId = addGeoJsonLayer(name, result.objects);
      const added = useAppStore.getState().layers.find((layer) => layer.id === objectsLayerId);
      if (added) {
        updateLayer(objectsLayerId, {
          style: { ...added.style, ...OBJECT_OUTLINE_STYLE },
          metadata: { ...added.metadata, obiaRole: "objects" },
        });
        if (shouldZoomToNewLayers()) mapControllerRef.current?.fitLayer(added);
      }
      // Record the run as soon as its objects layer exists, so a failure in
      // the optional label raster below cannot leave a layer the session does
      // not know about.
      setSegmentation({
        sourceLayerId: sourceLayer.id,
        sourceName: sourceLayer.name,
        source: {
          name: sourceLayer.name,
          ...(obiaLayerLocation(sourceLayer) ? { location: obiaLayerLocation(sourceLayer) } : {}),
        },
        bandIndexes: [...bandIndexes],
        ...size,
        area,
        pixelSize: plan.pixelSize,
        labels: result.labels,
        objectsLayerId,
        objectCount: result.objectCount,
        labelsHash,
        meanObjectArea: result.meanObjectArea,
        tool: result.tool,
        args: result.args,
        params: { ...params },
        method,
        ...(isNativeMethod(method)
          ? {
              nativeParams: {
                slic: { ...nativeParams.slic },
                felzenszwalb: { ...nativeParams.felzenszwalb },
              },
              nativeJobId,
            }
          : {}),
        env: obiaRunEnv(),
        finishedAt: new Date().toISOString(),
      });
      if (addLabels) {
        await onAddRaster(
          result.labels,
          t("obia.labelsLayerName", { name: sourceLayer.name }),
          "segments.tif",
        );
      }
    } catch (err) {
      setError(
        isObiaCancel(err)
          ? t("obia.progress.cancelled")
          : obiaErrorMessage(err, t, t("obia.error.failed")),
      );
    } finally {
      progress.end();
      runningRef.current = false;
      setRunning(false);
    }
  }, [
    sourceLayer,
    summary,
    plan,
    method,
    nativeParams,
    localPath,
    bandIndexes,
    params,
    addLabels,
    addGeoJsonLayer,
    updateLayer,
    onAddRaster,
    mapControllerRef,
    setSegmentation,
    progress,
    t,
  ]);

  // The last run's summary describes its own image, not one picked since.
  const currentRun = segmentation && segmentation.sourceLayerId === sourceLayer?.id;

  return (
    <section className="flex flex-col gap-3">
      <ObiaStepHeading index={1} title={t("obia.steps.segment")} />

      {imageLayers.length === 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {t("obia.noRasterLayers")}
        </p>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="obia-image" className="text-xs">
              {t("obia.image")}
            </Label>
            <Select
              id="obia-image"
              value={sourceLayer?.id ?? ""}
              onChange={(event) => setSourceLayerId(event.target.value)}
            >
              {!sourceLayer && <option value="">{t("obia.imagePlaceholder")}</option>}
              {imageLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </Select>
            {loadingImage ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("obia.loadingImage")}
              </span>
            ) : summary ? (
              <span className="text-xs text-muted-foreground">
                {t("obia.imageSummary", {
                  width: summary.levels[0].width,
                  height: summary.levels[0].height,
                  bands: summary.bandCount,
                })}
              </span>
            ) : null}
          </div>

          {summary && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-xs font-medium">{t("obia.bands")}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Array.from({ length: summary.bandCount }, (_, i) => i + 1).map((index) => (
                  <label key={index} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={bandIndexes.includes(index)}
                      onChange={(event) => toggleBand(index, event.target.checked)}
                    />
                    {t("obia.bandN", { index })}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t("obia.bandsHint")}</p>
            </fieldset>
          )}

          {summary && (
            <div className="grid gap-1.5">
              <Label htmlFor="obia-area" className="text-xs">
                {t("obia.area.label")}
              </Label>
              <Select
                id="obia-area"
                value={areaMode}
                onChange={(event) => setAreaMode(event.target.value === "view" ? "view" : "image")}
              >
                <option value="image">{t("obia.area.image")}</option>
                <option value="view" disabled={!summary.toPixel}>
                  {t("obia.area.view")}
                </option>
              </Select>
              <ObiaAreaNote info={summary} plan={plan} mode={areaMode} maxPixels={maxPixels} />
            </div>
          )}

          <ObiaMethodFields nativeStatus={nativeStatus} nativeUsable={nativeUsable} />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={addLabels}
              onChange={(event) => setAddLabels(event.target.checked)}
            />
            {t("obia.addLabels")}
          </label>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => void handleSegment()}
              disabled={
                running ||
                loadingImage ||
                !summary ||
                !bandIndexes.length ||
                !plan?.fits ||
                (native && !nativeUsable)
              }
              className="gap-2"
              data-testid="obia-segment"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {running ? t("obia.running") : t("obia.run")}
            </Button>
          </div>
          <ObiaRunProgress
            step={progress.step}
            startedAt={progress.startedAt}
            onCancel={progress.cancel}
          />
        </>
      )}

      <ObiaStatus
        error={error}
        testId="obia-segment-result"
        success={
          currentRun && !running
            ? t("obia.result", {
                count: segmentation.objectCount,
                area: Math.round(segmentation.meanObjectArea),
              })
            : null
        }
      />
    </section>
  );
}
