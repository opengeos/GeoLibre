import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  detectObjects,
  readRasterData,
  type Detection,
  type RasterData,
} from "@geolibre/processing";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  Info,
  Loader2,
  Play,
} from "lucide-react";
import type { Feature, FeatureCollection } from "geojson";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { reprojectFeatureCollectionToWgs84 } from "../../lib/duckdb-vector-loader";
import {
  BUILTIN_DETECTION_MODELS,
  fetchDetectionModel,
} from "../../lib/detection-models";

interface ObjectDetectionDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [
  { name: "Imagery", extensions: ["tif", "tiff"] },
];
const IMAGE_ACCEPT = ".tif,.tiff";
const MODEL_FILTERS = [{ name: "ONNX model", extensions: ["onnx"] }];
const MODEL_ACCEPT = ".onnx";

/**
 * Read the source EPSG code from a raster's GeoTIFF GeoKeys.
 *
 * Prefers the projected CRS, falling back to the geographic one. The "user
 * defined" sentinel (32767) and missing/zero codes return null so the caller
 * can treat the detections as already in lon/lat.
 *
 * @param geoKeys The `geoKeys` carried on a {@link RasterData}.
 * @returns The EPSG code, or null when none is declared.
 */
function epsgFromGeoKeys(geoKeys: Record<string, unknown>): number | null {
  const proj = geoKeys?.ProjectedCSTypeGeoKey;
  const geog = geoKeys?.GeographicTypeGeoKey;
  const code =
    typeof proj === "number" && proj > 0 && proj !== 32767
      ? proj
      : typeof geog === "number" && geog > 0 && geog !== 32767
        ? geog
        : null;
  return code;
}

/**
 * Resolve a class label for a detection from a user-supplied name list,
 * falling back to `class_<index>` when the list is short or empty.
 */
function classLabel(names: string[], index: number): string {
  return names[index]?.trim() || `class_${index}`;
}

/**
 * Turn source-pixel detections into a georeferenced FeatureCollection.
 *
 * Each box becomes a rectangular polygon in the raster's CRS (via the
 * geotransform), tagged with its class label and score, and a legacy `crs`
 * member so {@link reprojectFeatureCollectionToWgs84} can lift it to WGS84.
 *
 * @param detections Boxes in source raster pixels.
 * @param raster The source raster (for the geotransform + CRS).
 * @param names Parsed class names.
 * @returns A FeatureCollection ready to reproject.
 */
function detectionsToFeatureCollection(
  detections: Detection[],
  raster: RasterData,
  names: string[],
): FeatureCollection {
  const { originX, originY, resX, resY } = raster;
  const features: Feature[] = detections.map((det) => {
    const [minPxX, minPxY, maxPxX, maxPxY] = det.bbox;
    // Pixel rows grow southward (top-left origin), so the min pixel row is the
    // northern (max world Y) edge.
    const west = originX + minPxX * resX;
    const east = originX + maxPxX * resX;
    const north = originY - minPxY * resY;
    const south = originY - maxPxY * resY;
    return {
      type: "Feature",
      properties: {
        class: classLabel(names, det.classIndex),
        class_index: det.classIndex,
        score: Number(det.score.toFixed(4)),
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
    } satisfies Feature;
  });
  const epsg = epsgFromGeoKeys(raster.geoKeys);
  const fc: FeatureCollection & { crs?: unknown } = {
    type: "FeatureCollection",
    features,
  };
  if (epsg && epsg !== 4326) {
    fc.crs = { type: "name", properties: { name: `EPSG:${epsg}` } };
  }
  return fc;
}

/**
 * Object detection dialog (issue #902). Runs a user-supplied YOLO model
 * exported to ONNX entirely in the browser (onnxruntime-web) against a chosen
 * GeoTIFF, georeferences the detected boxes, and adds one GeoJSON layer per
 * detected class.
 *
 * Unlike AI Segmentation, inference is client-side, so this works in both the
 * web and desktop builds with no Python sidecar.
 */
export function ObjectDetectionDialog({
  mapControllerRef,
}: ObjectDetectionDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.objectDetectionOpen);
  const setOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [imageName, setImageName] = useState("");
  // Default to a built-in model so detection works out of the box with no file.
  const [modelSource, setModelSource] = useState<"builtin" | "local">("builtin");
  const [builtinModelId, setBuiltinModelId] = useState(
    BUILTIN_DETECTION_MODELS[0].id,
  );
  const [modelBytes, setModelBytes] = useState<ArrayBuffer | null>(null);
  const [modelName, setModelName] = useState("");
  const [classNames, setClassNames] = useState(
    BUILTIN_DETECTION_MODELS[0].classNames.join(", "),
  );
  const [confidence, setConfidence] = useState(0.25);
  const [iou, setIou] = useState(0.45);
  const [inputSize, setInputSize] = useState(640);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset transient state so a re-opened dialog never shows a stale error,
    // result, or a `running` spinner left over from a previous session.
    setError(null);
    setResultMessage(null);
    setRunning(false);
  }, [open]);

  const pickImage = useCallback(async () => {
    const result = await openLocalDataFileWithFallback({
      filters: IMAGE_FILTERS,
      accept: IMAGE_ACCEPT,
      readBinary: true,
    });
    if (result?.data) {
      setImageBytes(result.data);
      const name = (result.path || "image.tif").split(/[/\\]/).pop();
      setImageName(name || "image.tif");
    }
  }, []);

  const pickModel = useCallback(async () => {
    const result = await openLocalDataFileWithFallback({
      filters: MODEL_FILTERS,
      accept: MODEL_ACCEPT,
      readBinary: true,
    });
    if (result?.data) {
      setModelBytes(result.data);
      const name = (result.path || "model.onnx").split(/[/\\]/).pop();
      setModelName(name || "model.onnx");
    }
  }, []);

  // Picking a built-in model prefills the class names with that model's labels
  // (in output order) so detections come out named without any typing.
  const selectBuiltinModel = useCallback((id: string) => {
    setBuiltinModelId(id);
    const model = BUILTIN_DETECTION_MODELS.find((m) => m.id === id);
    if (model) setClassNames(model.classNames.join(", "));
  }, []);

  const handleRun = useCallback(async () => {
    setError(null);
    setResultMessage(null);
    if (!imageBytes) {
      setError(t("objectDetection.error.chooseImage"));
      return;
    }
    if (modelSource === "local" && !modelBytes) {
      setError(t("objectDetection.error.chooseModel"));
      return;
    }
    setRunning(true);
    try {
      // Resolve the model bytes: download (and cache) the chosen built-in model,
      // or use the user-supplied file.
      let modelData = modelBytes;
      if (modelSource === "builtin") {
        const model = BUILTIN_DETECTION_MODELS.find(
          (m) => m.id === builtinModelId,
        );
        if (!model) {
          setError(t("objectDetection.error.chooseModel"));
          return;
        }
        setDownloading(true);
        try {
          modelData = await fetchDetectionModel(model.url);
        } catch {
          setError(t("objectDetection.error.downloadModel"));
          return;
        } finally {
          setDownloading(false);
        }
      }
      if (!modelData) {
        setError(t("objectDetection.error.chooseModel"));
        return;
      }
      const raster = await readRasterData(imageBytes);
      const detections = await detectObjects(raster, modelData, {
        inputSize,
        confidenceThreshold: confidence,
        iouThreshold: iou,
      });
      if (!detections.length) {
        setResultMessage(t("objectDetection.noObjects"));
        return;
      }
      const names = classNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tagged = detectionsToFeatureCollection(detections, raster, names);
      // Reproject once for the whole batch, then split by class so each class
      // becomes its own layer (issue #902: "classes can be created as layers").
      const fc = await reprojectFeatureCollectionToWgs84(tagged);
      const byClass = new Map<string, Feature[]>();
      for (const feature of fc.features) {
        const cls = String(feature.properties?.class ?? "detection");
        const list = byClass.get(cls);
        if (list) list.push(feature);
        else byClass.set(cls, [feature]);
      }

      let firstLayerId: string | null = null;
      for (const [cls, features] of byClass) {
        const layerId = addGeoJsonLayer(
          t("objectDetection.layerName", { class: cls }),
          { type: "FeatureCollection", features },
        );
        if (!firstLayerId) firstLayerId = layerId;
      }
      if (firstLayerId) {
        const layer = useAppStore
          .getState()
          .layers.find((item) => item.id === firstLayerId);
        if (layer) mapControllerRef.current?.fitLayer(layer);
      }
      setResultMessage(
        t("objectDetection.added", {
          count: detections.length,
          classes: byClass.size,
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("objectDetection.error.failed"),
      );
    } finally {
      setRunning(false);
    }
  }, [
    imageBytes,
    modelSource,
    modelBytes,
    builtinModelId,
    inputSize,
    confidence,
    iou,
    classNames,
    addGeoJsonLayer,
    mapControllerRef,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("objectDetection.title")}</DialogTitle>
          <DialogDescription>
            {t("objectDetection.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            {t("objectDetection.hint")}
          </p>

          {/* Image source */}
          <div className="grid gap-1.5">
            <Label htmlFor="det-image" className="text-xs">
              {t("objectDetection.imageLabel")}
              <span className="text-destructive"> *</span>
            </Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="det-image"
                readOnly
                value={imageName}
                placeholder={t("objectDetection.imagePlaceholder")}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={t("objectDetection.chooseImage")}
                onClick={() => void pickImage()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Model source: a built-in model that downloads on demand, or a
              user-supplied .onnx file. */}
          <div className="grid gap-1.5">
            <Label htmlFor="det-model-source" className="text-xs">
              {t("objectDetection.modelLabel")}
              <span className="text-destructive"> *</span>
            </Label>
            <Select
              id="det-model-source"
              value={modelSource}
              onChange={(e) =>
                setModelSource(e.target.value as "builtin" | "local")
              }
            >
              <option value="builtin">
                {t("objectDetection.modelSourceBuiltin")}
              </option>
              <option value="local">
                {t("objectDetection.modelSourceLocal")}
              </option>
            </Select>
          </div>

          {modelSource === "builtin" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="det-builtin-model" className="text-xs">
                {t("objectDetection.builtinModelLabel")}
              </Label>
              <Select
                id="det-builtin-model"
                value={builtinModelId}
                onChange={(e) => selectBuiltinModel(e.target.value)}
              >
                {BUILTIN_DETECTION_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="det-model" className="text-xs">
                {t("objectDetection.modelFileLabel")}
              </Label>
              <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
                <Input
                  id="det-model"
                  readOnly
                  value={modelName}
                  placeholder={t("objectDetection.modelPlaceholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title={t("objectDetection.chooseModel")}
                  onClick={() => void pickModel()}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Class names */}
          <div className="grid gap-1.5">
            <Label htmlFor="det-classes" className="text-xs">
              {t("objectDetection.classNamesLabel")}
            </Label>
            <Input
              id="det-classes"
              value={classNames}
              placeholder={t("objectDetection.classNamesPlaceholder")}
              onChange={(e) => setClassNames(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="det-confidence" className="text-xs">
                {t("objectDetection.confidenceLabel")}
              </Label>
              <Input
                id="det-confidence"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={String(confidence)}
                onChange={(e) => {
                  if (e.target.value === "") {
                    setConfidence(0.25);
                    return;
                  }
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setConfidence(Math.min(1, Math.max(0, parsed)));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="det-iou" className="text-xs">
                {t("objectDetection.iouLabel")}
              </Label>
              <Input
                id="det-iou"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={String(iou)}
                onChange={(e) => {
                  if (e.target.value === "") {
                    setIou(0.45);
                    return;
                  }
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setIou(Math.min(1, Math.max(0, parsed)));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="det-size" className="text-xs">
                {t("objectDetection.inputSizeLabel")}
              </Label>
              <Input
                id="det-size"
                type="number"
                min={32}
                max={4096}
                step={32}
                value={String(inputSize)}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed) || parsed < 32) return;
                  // Clamp to the upper bound too: the HTML `max` is advisory, but
                  // an oversized input would allocate a huge inference tensor.
                  setInputSize(Math.min(4096, Math.round(parsed)));
                }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => void handleRun()}
              disabled={
                running ||
                !imageBytes ||
                (modelSource === "local" && !modelBytes)
              }
              className="gap-2"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("objectDetection.detect")}
            </Button>
            {downloading && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("objectDetection.downloadingModel")}
              </span>
            )}
          </div>

          {error && (
            <p className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}
          {resultMessage && !error && (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              {resultMessage}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
