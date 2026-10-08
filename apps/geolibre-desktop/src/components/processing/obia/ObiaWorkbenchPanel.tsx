import { shouldZoomToNewLayers, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  readImageSummary,
  segmentImage,
  splitImageBands,
  type ObiaImageSummary,
} from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import {
  AlertCircle,
  CheckCircle2,
  GripVertical,
  Info,
  Loader2,
  Play,
  Shapes,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingPanelDrag } from "../../../hooks/useFloatingPanelDrag";
import { useObiaSession } from "../../../lib/obia/obia-session";
import { fetchLayerBytes } from "../../../lib/whitebox-layer-inputs";

interface ObiaWorkbenchPanelProps {
  mapControllerRef: React.RefObject<MapEngine | null>;
  /** Add GeoTIFF bytes to the map as a raster layer. */
  onAddRaster: (bytes: Uint8Array, name: string, fileName?: string) => Promise<void>;
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
 * Object-Based Analysis workbench (#3053). A floating panel that runs the OBIA
 * pipeline on the WASM tool runner: segment a raster layer into objects (added
 * to the map as one polygon per object, `id` = `segment_id`) that the later
 * steps measure, label and classify.
 */
export function ObiaWorkbenchPanel({
  mapControllerRef,
  onAddRaster,
}: ObiaWorkbenchPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.obiaWorkbenchOpen);
  const setOpen = useAppStore((s) => s.setObiaWorkbenchOpen);
  const layers = useAppStore((s) => s.layers);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const updateLayer = useAppStore((s) => s.updateLayer);

  const sourceLayerId = useObiaSession((s) => s.sourceLayerId);
  const setSourceLayerId = useObiaSession((s) => s.setSourceLayerId);
  const bandIndexes = useObiaSession((s) => s.bandIndexes);
  const setBandIndexes = useObiaSession((s) => s.setBandIndexes);
  const params = useObiaSession((s) => s.params);
  const setParams = useObiaSession((s) => s.setParams);
  const segmentation = useObiaSession((s) => s.segmentation);
  const setSegmentation = useObiaSession((s) => s.setSegmentation);

  const imageLayers = useMemo(() => layers.filter(isImageLayer), [layers]);
  const sourceLayer = imageLayers.find((layer) => layer.id === sourceLayerId) ?? null;

  const [summary, setSummary] = useState<ObiaImageSummary | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [addLabels, setAddLabels] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bytesRef = useRef<{ layerId: string; bytes: Uint8Array } | null>(null);
  const runningRef = useRef(false);
  const { panelRef, pos, onDragStart } = useFloatingPanelDrag();

  // Default to the first image layer so a single-raster project needs no pick.
  useEffect(() => {
    if (!open || sourceLayer || !imageLayers.length) return;
    setSourceLayerId(imageLayers[0].id);
  }, [open, sourceLayer, imageLayers, setSourceLayerId]);

  // Read the chosen layer's header to list its bands.
  useEffect(() => {
    if (!open || !sourceLayer) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoadingImage(true);
    setError(null);
    void (async () => {
      try {
        const bytes =
          bytesRef.current?.layerId === sourceLayer.id
            ? bytesRef.current.bytes
            : await fetchLayerBytes(sourceLayer);
        if (cancelled) return;
        if (!bytes) throw new Error(t("obia.error.readImage"));
        bytesRef.current = { layerId: sourceLayer.id, bytes };
        const info = await readImageSummary(bytes);
        if (cancelled) return;
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
  }, [open, sourceLayer, setBandIndexes, t]);

  const toggleBand = useCallback(
    (index: number, checked: boolean) => {
      const next = checked
        ? [...bandIndexes, index].sort((a, b) => a - b)
        : bandIndexes.filter((band) => band !== index);
      setBandIndexes(next);
    },
    [bandIndexes, setBandIndexes],
  );

  const handleSegment = useCallback(async () => {
    if (runningRef.current || !sourceLayer) return;
    if (!bandIndexes.length) {
      setError(t("obia.error.noBands"));
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const bytes =
        bytesRef.current?.layerId === sourceLayer.id
          ? bytesRef.current.bytes
          : await fetchLayerBytes(sourceLayer);
      if (!bytes) throw new Error(t("obia.error.readImage"));
      const image = await splitImageBands(bytes, bandIndexes);
      const result = await segmentImage(image, params);
      const name = t("obia.layerName", { name: sourceLayer.name });
      const objectsLayerId = addGeoJsonLayer(name, result.objects);
      const added = useAppStore.getState().layers.find((layer) => layer.id === objectsLayerId);
      if (added) {
        updateLayer(objectsLayerId, {
          style: { ...added.style, ...OBJECT_OUTLINE_STYLE },
          metadata: { ...added.metadata, obiaRole: "objects" },
        });
        if (shouldZoomToNewLayers()) mapControllerRef.current?.fitLayer(added);
      }
      if (addLabels) {
        await onAddRaster(
          result.labels,
          t("obia.labelsLayerName", { name: sourceLayer.name }),
          "segments.tif",
        );
      }
      setSegmentation({
        sourceLayerId: sourceLayer.id,
        sourceName: sourceLayer.name,
        bandIndexes: [...bandIndexes],
        width: image.width,
        height: image.height,
        labels: result.labels,
        objectsLayerId,
        objectCount: result.objectCount,
        meanObjectArea: result.meanObjectArea,
        tool: result.tool,
        args: result.args,
        params: { ...params },
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("obia.error.failed"));
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [
    sourceLayer,
    bandIndexes,
    params,
    addLabels,
    addGeoJsonLayer,
    updateLayer,
    onAddRaster,
    mapControllerRef,
    setSegmentation,
    t,
  ]);

  if (!open) return null;

  const numberField = (
    id: string,
    label: string,
    value: number,
    onChange: (value: number) => void,
    options: { min: number; max?: number; step: number },
  ) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={options.min}
        max={options.max}
        step={options.step}
        value={String(value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed) || parsed < options.min) return;
          onChange(options.max != null ? Math.min(options.max, parsed) : parsed);
        }}
      />
    </div>
  );

  return (
    <div
      ref={panelRef}
      className={
        pos
          ? "pointer-events-auto absolute z-20 flex max-h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute end-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="region"
      aria-label={t("obia.title")}
      data-testid="obia-workbench-panel"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={onDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Shapes className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{t("obia.title")}</span>
        </div>
        <button
          type="button"
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={() => setOpen(false)}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-auto p-3">
        <p className="text-xs text-muted-foreground">{t("obia.description")}</p>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          1. {t("obia.steps.segment")}
        </h3>

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
                    width: summary.width,
                    height: summary.height,
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

            <div className="grid gap-1.5">
              <span className="text-xs font-medium">{t("obia.method")}</span>
              <span className="text-sm">{t("obia.methodRegionGrowing")}</span>
              <p className="text-xs text-muted-foreground">{t("obia.methodNote")}</p>
            </div>

            <div className="grid grid-cols-3 items-end gap-2">
              {numberField(
                "obia-threshold",
                t("obia.threshold"),
                params.threshold,
                (threshold) => setParams({ threshold }),
                { min: 0.05, max: 5, step: 0.05 },
              )}
              {numberField(
                "obia-min-area",
                t("obia.minArea"),
                params.minArea,
                (minArea) => setParams({ minArea: Math.round(minArea) }),
                { min: 1, step: 1 },
              )}
              {numberField(
                "obia-steps",
                t("obia.seedSteps"),
                params.steps,
                (steps) => setParams({ steps: Math.round(steps) }),
                { min: 1, max: 50, step: 1 },
              )}
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">{t("obia.thresholdHint")}</p>

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
                disabled={running || loadingImage || !summary || !bandIndexes.length}
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
          </>
        )}

        {error && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </p>
        )}
        {segmentation && !error && !running && (
          <p
            className="flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400"
            data-testid="obia-segment-result"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            {t("obia.result", {
              count: segmentation.objectCount,
              area: Math.round(segmentation.meanObjectArea),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
