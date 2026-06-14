import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  fetchMlStatus,
  mlSegment,
  type MlSegmentMode,
  type MlStatus,
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
  Loader2,
  Play,
  Server,
} from "lucide-react";
import type { FeatureCollection } from "geojson";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isTauri, openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { reprojectFeatureCollectionToWgs84 } from "../../lib/duckdb-vector-loader";
import { startGeoLibreSidecar } from "../../lib/sidecar";

interface SegmentationDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [
  { name: "Imagery", extensions: ["tif", "tiff", "png", "jpg", "jpeg"] },
];
const IMAGE_ACCEPT = ".tif,.tiff,.png,.jpg,.jpeg";

/**
 * AI segmentation dialog (issue #301). Sends a georeferenced raster to the
 * sidecar's `/ml/segment/*` proxy (which forwards to segment-geospatial's
 * SAM3 REST API) and adds the resulting polygons as a GeoJSON layer.
 *
 * MVP scope: text-prompt ("segment all trees") and automatic ("everything")
 * segmentation over a chosen GeoTIFF. Box/point prompts drawn on the map are a
 * follow-up.
 */
export function SegmentationDialog({
  mapControllerRef,
}: SegmentationDialogProps): ReactElement {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.ui.segmentationOpen);
  const setOpen = useAppStore((s) => s.setSegmentationOpen);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);

  const [mode, setMode] = useState<Exclude<MlSegmentMode, "predict">>("text");
  const [prompt, setPrompt] = useState("trees");
  const [confidence, setConfidence] = useState(0.4);
  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [imageName, setImageName] = useState("");
  const [status, setStatus] = useState<MlStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);

  const checkStatus = useCallback(async () => {
    setStatus(null);
    try {
      setStatus(await fetchMlStatus());
    } catch (err) {
      setStatus({
        available: false,
        message:
          err instanceof Error
            ? err.message
            : t("segmentation.error.sidecarUnreachable"),
      });
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    // Reset transient state so a re-opened dialog never shows a stale error,
    // result, or a `running` spinner left over from a previous session.
    setError(null);
    setResultMessage(null);
    setRunning(false);
    setImageBytes(null);
    setImageName("");
    void checkStatus();
  }, [open, checkStatus]);

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

  const startServer = useCallback(async () => {
    setStartingServer(true);
    setError(null);
    try {
      await startGeoLibreSidecar();
      await checkStatus();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("segmentation.error.startServer"),
      );
    } finally {
      setStartingServer(false);
    }
  }, [checkStatus, t]);

  const handleRun = useCallback(async () => {
    setError(null);
    setResultMessage(null);
    if (!imageBytes) {
      setError(t("segmentation.error.chooseImage"));
      return;
    }
    if (mode === "text" && !prompt.trim()) {
      setError(t("segmentation.error.enterPrompt"));
      return;
    }
    setRunning(true);
    try {
      const blob = new Blob([imageBytes]);
      const raw: FeatureCollection = await mlSegment(
        mode,
        blob,
        imageName || "image.tif",
        { prompt: prompt.trim(), confidenceThreshold: confidence },
      );
      // samgeo-api returns polygons in the source raster's CRS (e.g. EPSG:3857)
      // tagged with a GeoJSON `crs` member; the map and store need WGS84.
      const fc = await reprojectFeatureCollectionToWgs84(raw);
      const features = Array.isArray(fc?.features) ? fc.features : [];
      if (!features.length) {
        setResultMessage(t("segmentation.noObjects"));
        return;
      }
      const name =
        mode === "text"
          ? t("segmentation.layerName", { prompt: prompt.trim() })
          : t("segmentation.layerNameDefault");
      const layerId = addGeoJsonLayer(name, fc);
      const layer = useAppStore
        .getState()
        .layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      setResultMessage(
        t("segmentation.added", { count: features.length, name }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("segmentation.error.failed"),
      );
    } finally {
      setRunning(false);
    }
  }, [
    imageBytes,
    imageName,
    mode,
    prompt,
    confidence,
    addGeoJsonLayer,
    mapControllerRef,
    t,
  ]);

  const available = status?.available === true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("segmentation.title")}</DialogTitle>
          <DialogDescription>
            {t("segmentation.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {status && !available && (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {status.message}
              </p>
              {/* Launching the sidecar is a desktop-only (Tauri) capability;
                  hide the action in the browser build where it cannot work. */}
              {isTauri() && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void startServer()}
                  disabled={startingServer}
                  className="gap-2"
                >
                  {startingServer ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Server className="h-4 w-4" />
                  )}
                  {t("segmentation.startServer")}
                </Button>
              )}
            </div>
          )}

          {/* Image source */}
          <div className="grid gap-1.5">
            <Label htmlFor="seg-image" className="text-xs">
              {t("segmentation.imageLabel")}
              <span className="text-destructive"> *</span>
            </Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="seg-image"
                readOnly
                value={imageName}
                placeholder={t("segmentation.imagePlaceholder")}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={t("segmentation.chooseImage")}
                onClick={() => void pickImage()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Mode */}
          <div className="grid gap-1.5">
            <Label htmlFor="seg-mode" className="text-xs">
              {t("segmentation.modeLabel")}
            </Label>
            <Select
              id="seg-mode"
              value={mode}
              onChange={(e) =>
                setMode(e.target.value as "text" | "automatic")
              }
            >
              <option value="text">{t("segmentation.modeText")}</option>
              <option value="automatic">
                {t("segmentation.modeAutomatic")}
              </option>
            </Select>
          </div>

          {mode === "text" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="seg-prompt" className="text-xs">
                  {t("segmentation.promptLabel")}
                  <span className="text-destructive"> *</span>
                </Label>
                <Input
                  id="seg-prompt"
                  value={prompt}
                  placeholder={t("segmentation.promptPlaceholder")}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="seg-confidence" className="text-xs">
                  {t("segmentation.confidenceLabel")}
                </Label>
                <Input
                  id="seg-confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={String(confidence)}
                  onChange={(e) => {
                    if (e.target.value === "") {
                      setConfidence(0.4);
                      return;
                    }
                    const parsed = Number(e.target.value);
                    // Ignore non-numeric input and clamp to [0, 1] so a NaN or
                    // out-of-range confidence is never sent to the backend.
                    if (!Number.isFinite(parsed)) return;
                    setConfidence(Math.min(1, Math.max(0, parsed)));
                  }}
                />
              </div>
            </>
          )}

          <div>
            <Button
              onClick={() => void handleRun()}
              disabled={running || !available || !imageBytes}
              className="gap-2"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {t("segmentation.segment")}
            </Button>
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
