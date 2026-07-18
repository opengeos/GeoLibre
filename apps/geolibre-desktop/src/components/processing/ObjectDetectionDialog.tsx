import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  detectObjects,
  readRasterData,
  type Detection,
  type RasterData,
} from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  GripVertical,
  Info,
  Loader2,
  Play,
  ScanSearch,
  X,
} from "lucide-react";
import type { Feature, FeatureCollection } from "geojson";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { reprojectFeatureCollectionToWgs84 } from "../../lib/duckdb-vector-loader";
import { BUILTIN_DETECTION_MODELS, fetchDetectionModel } from "../../lib/detection-models";

interface ObjectDetectionDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [{ name: "Imagery", extensions: ["tif", "tiff"] }];
const IMAGE_ACCEPT = ".tif,.tiff";
const MODEL_FILTERS = [{ name: "ONNX model", extensions: ["onnx"] }];
const MODEL_ACCEPT = ".onnx";

/** Default panel geometry (px); the user can drag it around the map area. */
const PANEL_MARGIN = 12;

interface PanelPos {
  x: number;
  y: number;
}

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
  const { originX, originY, resX, resY, flipX, flipY } = raster;
  // Map a source pixel to world coords, honouring the raster's resolution sign
  // (flipX = east-to-west, flipY = south-up) so mirrored/flipped GeoTIFFs are
  // georeferenced correctly instead of silently mislocated.
  const worldX = (px: number) => (flipX ? originX - px * resX : originX + px * resX);
  const worldY = (py: number) => (flipY ? originY + py * resY : originY - py * resY);
  const features: Feature[] = detections.map((det) => {
    const [minPxX, minPxY, maxPxX, maxPxY] = det.bbox;
    const x1 = worldX(minPxX);
    const x2 = worldX(maxPxX);
    const y1 = worldY(minPxY);
    const y2 = worldY(maxPxY);
    const west = Math.min(x1, x2);
    const east = Math.max(x1, x2);
    const south = Math.min(y1, y2);
    const north = Math.max(y1, y2);
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
  } else if (!epsg && (raster.originX !== 0 || raster.originY !== 0)) {
    // No recognised EPSG (user-defined CRS, or WKT-only georeferencing): the
    // boxes stay in the raster's native coordinates and are not reprojected, so
    // a projected raster's detections can land far from their true location.
    console.warn(
      "objectDetection: no recognised EPSG code in the raster GeoKeys — detections will not be reprojected and may appear at the wrong location.",
    );
  }
  return fc;
}

/**
 * Object detection panel (issue #902). A floating, draggable panel (not a modal)
 * that runs a user-supplied YOLO model exported to ONNX entirely in the browser
 * (onnxruntime-web) against a chosen GeoTIFF, georeferences the detected boxes,
 * and adds one GeoJSON layer per detected class. The map stays interactive while
 * the panel is open, matching the Raster Subset / Pixel Time Series panels.
 *
 * Unlike AI Segmentation, inference is client-side, so this works in both the
 * web and desktop builds with no Python sidecar.
 */
export function ObjectDetectionDialog({
  mapControllerRef,
}: ObjectDetectionDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.objectDetectionOpen);
  const setOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [imageName, setImageName] = useState("");
  // Default to a built-in model so detection works out of the box with no file.
  const [modelSource, setModelSource] = useState<"builtin" | "local">("builtin");
  const [builtinModelId, setBuiltinModelId] = useState(BUILTIN_DETECTION_MODELS[0].id);
  const [modelBytes, setModelBytes] = useState<ArrayBuffer | null>(null);
  const [modelName, setModelName] = useState("");
  const [classNames, setClassNames] = useState(BUILTIN_DETECTION_MODELS[0].classNames.join(", "));
  const [confidence, setConfidence] = useState(0.25);
  const [iou, setIou] = useState(0.45);
  const [inputSize, setInputSize] = useState(640);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  // The real "is inference in flight" guard. It survives the dialog being
  // closed and re-opened (the `running` state is only for the spinner), so a
  // run started, dismissed, then restarted cannot spawn a second concurrent
  // session that would add duplicate layers.
  const inferringRef = useRef(false);

  // Floating-panel drag state: `pos` is null until the user first drags, so the
  // panel opens anchored to its default corner and only switches to absolute
  // coordinates once moved (mirrors RasterSubsetPanel).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Let clicks on the header's close button through without starting a drag.
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent = (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el?.getBoundingClientRect();
      const start: PanelPos = pos ?? {
        x: (eb?.left ?? 0) - (pb?.left ?? 0),
        y: (eb?.top ?? 0) - (pb?.top ?? 0),
      };
      if (!pos) setPos(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const w = eb?.width ?? 0;
      const h = eb?.height ?? 0;
      const move = (m: PointerEvent) => {
        if (!panelRef.current) return;
        const bounds = parent?.getBoundingClientRect();
        const maxX = bounds ? bounds.width - w - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxY = bounds ? bounds.height - h - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setPos({
          x: clamp(start.x + (m.clientX - startX), 0, Math.max(0, maxX)),
          y: clamp(start.y + (m.clientY - startY), 0, Math.max(0, maxY)),
        });
      };
      const end = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [pos],
  );

  useEffect(() => {
    if (!open) return;
    // Reset transient display state so a re-opened dialog never shows a stale
    // error or result. `running` is intentionally not reset here: while real
    // work is still in flight (tracked by inferringRef) the spinner must stay.
    setError(null);
    setResultMessage(null);
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
      // Clear the built-in model's leftover class names so a custom model does
      // not mislabel its detections by indexing into an unrelated COCO list;
      // the field falls back to class_<index> until the user fills it in.
      setClassNames("");
    }
  }, []);

  // Picking a built-in model prefills the class names with that model's labels
  // (in output order) so detections come out named without any typing.
  const selectBuiltinModel = useCallback((id: string) => {
    setBuiltinModelId(id);
    const model = BUILTIN_DETECTION_MODELS.find((m) => m.id === id);
    if (model) {
      setClassNames(model.classNames.join(", "));
      // Also apply the model's native input edge so a built-in exported at a
      // non-640 size runs at its documented resolution rather than whatever the
      // user last set.
      setInputSize(model.inputSize);
    }
  }, []);

  const handleRun = useCallback(async () => {
    // Never start a second run while one is still in flight (e.g. the dialog was
    // closed and re-opened mid-inference), which would add duplicate layers.
    if (inferringRef.current) return;
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
    inferringRef.current = true;
    setRunning(true);
    try {
      // Resolve the model bytes: download (and cache) the chosen built-in model,
      // or use the user-supplied file.
      let modelData = modelBytes;
      if (modelSource === "builtin") {
        const model = BUILTIN_DETECTION_MODELS.find((m) => m.id === builtinModelId);
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

      for (const [cls, features] of byClass) {
        addGeoJsonLayer(t("objectDetection.layerName", { class: cls }), {
          type: "FeatureCollection",
          features,
        });
      }
      // Fit to the union of every detected box across all classes, not just the
      // first class's layer, so no class's detections end up off-screen.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const feature of fc.features) {
        if (feature.geometry?.type !== "Polygon") continue;
        for (const ring of feature.geometry.coordinates) {
          for (const [x, y] of ring) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (Number.isFinite(minX)) {
        mapControllerRef.current?.fitBounds([minX, minY, maxX, maxY]);
      }
      setResultMessage(
        t("objectDetection.added", {
          count: detections.length,
          classes: byClass.size,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("objectDetection.error.failed"));
    } finally {
      inferringRef.current = false;
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

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={
        pos
          ? "pointer-events-auto absolute z-20 flex max-h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute right-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(24rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="region"
      aria-label={t("objectDetection.title")}
      data-testid="object-detection-panel"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <ScanSearch className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{t("objectDetection.title")}</span>
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

      <div className="flex flex-col overflow-auto p-3">
        <p className="mb-2 text-xs text-muted-foreground">{t("objectDetection.description")}</p>
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
              onChange={(e) => {
                const next = e.target.value as "builtin" | "local";
                setModelSource(next);
                // Switching back to a built-in repopulates its class names (and
                // input size); pickModel clears them for a local file, and the
                // built-in dropdown's own onChange doesn't fire on this switch.
                if (next === "builtin") selectBuiltinModel(builtinModelId);
              }}
            >
              <option value="builtin">{t("objectDetection.modelSourceBuiltin")}</option>
              <option value="local">{t("objectDetection.modelSourceLocal")}</option>
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
                  // Accept any in-range intermediate value while typing (e.g.
                  // "3" on the way to "320"); a controlled input that rejected
                  // <32 would revert the keystroke and make the field untypable.
                  const parsed = Number(e.target.value);
                  if (e.target.value !== "" && !Number.isFinite(parsed)) return;
                  setInputSize(e.target.value === "" ? 0 : parsed);
                }}
                onBlur={() =>
                  // Snap to a valid multiple of 32 (YOLO stride) in [32, 4096]:
                  // the HTML step/max are advisory, and a non-multiple or
                  // oversized input yields a misaligned or huge inference tensor.
                  setInputSize((prev) => Math.min(4096, Math.max(32, Math.round(prev / 32) * 32)))
                }
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => void handleRun()}
              disabled={running || !imageBytes || (modelSource === "local" && !modelBytes)}
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
      </div>
    </div>
  );
}
