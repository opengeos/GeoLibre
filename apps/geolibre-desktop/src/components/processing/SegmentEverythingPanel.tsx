import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  readRasterData,
  segmentEverything,
  type RasterData,
  type SegmentMask,
} from "@geolibre/processing";
import { Button, Input, Label } from "@geolibre/ui";
import {
  AlertCircle,
  CheckCircle2,
  FolderOpen,
  GripVertical,
  Info,
  Loader2,
  Play,
  Shapes,
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
import {
  fetchSegmentModel,
  SLIMSAM_DECODER_URL,
  SLIMSAM_ENCODER_URL,
} from "../../lib/segment-models";

interface SegmentEverythingPanelProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [{ name: "Imagery", extensions: ["tif", "tiff"] }];
const IMAGE_ACCEPT = ".tif,.tiff";
const PANEL_MARGIN = 12;

interface PanelPos {
  x: number;
  y: number;
}

/** Read the source EPSG code from a raster's GeoTIFF GeoKeys (see
 * ObjectDetectionDialog); null for user-defined/missing codes. */
function epsgFromGeoKeys(geoKeys: Record<string, unknown>): number | null {
  const proj = geoKeys?.ProjectedCSTypeGeoKey;
  const geog = geoKeys?.GeographicTypeGeoKey;
  return typeof proj === "number" && proj > 0 && proj !== 32767
    ? proj
    : typeof geog === "number" && geog > 0 && geog !== 32767
      ? geog
      : null;
}

/** Turn source-pixel mask polygons into a georeferenced FeatureCollection. */
function masksToFeatureCollection(masks: SegmentMask[], raster: RasterData): FeatureCollection {
  const { originX, originY, resX, resY, flipX, flipY } = raster;
  // Honour the raster's resolution sign (flipX = east-to-west, flipY = south-up)
  // so mirrored/flipped GeoTIFFs are georeferenced correctly, not mislocated.
  const worldX = (px: number) => (flipX ? originX - px * resX : originX + px * resX);
  const worldY = (py: number) => (flipY ? originY + py * resY : originY - py * resY);
  const features: Feature[] = masks.map((mask, index) => {
    const ring = mask.polygon.map(([px, py]) => [worldX(px), worldY(py)]);
    return {
      type: "Feature",
      properties: {
        id: index,
        score: Number(mask.score.toFixed(4)),
        area: Math.round(mask.area),
      },
      geometry: { type: "Polygon", coordinates: [ring] },
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
    console.warn(
      "segmentEverything: no recognised EPSG code in the raster GeoKeys — polygons will not be reprojected and may appear at the wrong location.",
    );
  }
  return fc;
}

/**
 * "Segment Everything" panel (issue #902). A floating, draggable panel that runs
 * SlimSAM automatically over a chosen GeoTIFF entirely in the browser
 * (onnxruntime-web): the encoder runs once, a grid of points is fed through the
 * mask decoder, and every surviving mask becomes a georeferenced polygon added
 * as a single GeoJSON layer. Classless (no labels), fully client-side, so it
 * works in both the web and desktop builds with no Python sidecar.
 */
export function SegmentEverythingPanel({
  mapControllerRef,
}: SegmentEverythingPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.segmentEverythingOpen);
  const setOpen = useAppStore((s) => s.setSegmentEverythingOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [imageName, setImageName] = useState("");
  const [pointsPerSide, setPointsPerSide] = useState(16);
  const [quality, setQuality] = useState(0.85);
  const [minSize, setMinSize] = useState(0.08); // percent of image area
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  // Real "is inference in flight" guard: survives the panel being closed and
  // re-opened so a run started, dismissed, then restarted cannot spawn a second
  // concurrent session that would add duplicate layers.
  const inferringRef = useRef(false);
  // Cancels an in-flight run (between decoder batches) when the panel closes.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Floating-panel drag state (mirrors RasterSubsetPanel / ObjectDetectionDialog).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
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

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    setOpen(false);
  }, [setOpen]);

  const handleRun = useCallback(async () => {
    if (inferringRef.current) return;
    setError(null);
    setResultMessage(null);
    if (!imageBytes) {
      setError(t("segmentEverything.error.chooseImage"));
      return;
    }
    inferringRef.current = true;
    setRunning(true);
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setDownloading(true);
      let encoder: ArrayBuffer;
      let decoder: ArrayBuffer;
      try {
        [encoder, decoder] = await Promise.all([
          fetchSegmentModel(SLIMSAM_ENCODER_URL),
          fetchSegmentModel(SLIMSAM_DECODER_URL),
        ]);
      } catch {
        setError(t("segmentEverything.error.downloadModel"));
        return;
      } finally {
        setDownloading(false);
      }

      const raster = await readRasterData(imageBytes);
      const masks = await segmentEverything(raster, encoder, decoder, {
        pointsPerSide,
        predIouThreshold: quality,
        minAreaFraction: minSize / 100,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (controller.signal.aborted) return;
      if (!masks.length) {
        setResultMessage(t("segmentEverything.noObjects"));
        return;
      }
      const tagged = masksToFeatureCollection(masks, raster);
      const fc = await reprojectFeatureCollectionToWgs84(tagged);
      const layerId = addGeoJsonLayer(t("segmentEverything.layerName"), fc);
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      setResultMessage(t("segmentEverything.added", { count: masks.length }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : t("segmentEverything.error.failed"));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inferringRef.current = false;
      setRunning(false);
      setProgress(null);
    }
  }, [imageBytes, pointsPerSide, quality, minSize, addGeoJsonLayer, mapControllerRef, t]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className={
        pos
          ? "pointer-events-auto absolute z-20 flex max-h-[calc(100%-2rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
          : "pointer-events-auto absolute right-3 top-16 z-20 flex max-h-[calc(100%-6rem)] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      }
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      role="region"
      aria-label={t("segmentEverything.title")}
      data-testid="segment-everything-panel"
    >
      <div
        className="flex cursor-move touch-none select-none items-center justify-between gap-2 border-b px-3 py-2"
        onPointerDown={handleDragStart}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Shapes className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate">{t("segmentEverything.title")}</span>
        </div>
        <button
          type="button"
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
          onClick={handleClose}
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col overflow-auto p-3">
        <p className="mb-2 text-xs text-muted-foreground">{t("segmentEverything.description")}</p>
        <div className="flex flex-col gap-3">
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            {t("segmentEverything.hint")}
          </p>

          {/* Image source */}
          <div className="grid gap-1.5">
            <Label htmlFor="seg-image" className="text-xs">
              {t("segmentEverything.imageLabel")}
              <span className="text-destructive"> *</span>
            </Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="seg-image"
                readOnly
                value={imageName}
                placeholder={t("segmentEverything.imagePlaceholder")}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={t("segmentEverything.chooseImage")}
                onClick={() => void pickImage()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="seg-grid" className="text-xs">
                {t("segmentEverything.gridLabel")}
              </Label>
              <Input
                id="seg-grid"
                type="number"
                min={4}
                max={48}
                step={4}
                value={String(pointsPerSide)}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed) || parsed < 4) return;
                  setPointsPerSide(Math.min(48, Math.round(parsed / 4) * 4));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="seg-quality" className="text-xs">
                {t("segmentEverything.qualityLabel")}
              </Label>
              <Input
                id="seg-quality"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={String(quality)}
                onChange={(e) => {
                  if (e.target.value === "") {
                    setQuality(0.85);
                    return;
                  }
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setQuality(Math.min(1, Math.max(0, parsed)));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="seg-minsize" className="text-xs">
                {t("segmentEverything.minSizeLabel")}
              </Label>
              <Input
                id="seg-minsize"
                type="number"
                min={0}
                max={100}
                step={0.05}
                value={String(minSize)}
                onChange={(e) => {
                  if (e.target.value === "") {
                    setMinSize(0.08);
                    return;
                  }
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setMinSize(Math.min(100, Math.max(0, parsed)));
                }}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => void handleRun()}
              disabled={running || !imageBytes}
              className="gap-2"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("segmentEverything.run")}
            </Button>
            {downloading && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("segmentEverything.downloadingModel")}
              </span>
            )}
            {running && !downloading && progress && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("segmentEverything.progress", {
                  done: progress.done,
                  total: progress.total,
                })}
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
