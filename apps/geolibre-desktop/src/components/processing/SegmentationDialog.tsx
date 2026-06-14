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
import { openLocalDataFileWithFallback } from "../../lib/tauri-io";
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
            : "Could not reach the GeoLibre sidecar.",
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResultMessage(null);
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
        err instanceof Error ? err.message : "Could not start GeoLibre sidecar.",
      );
    } finally {
      setStartingServer(false);
    }
  }, [checkStatus]);

  const handleRun = useCallback(async () => {
    setError(null);
    setResultMessage(null);
    if (!imageBytes) {
      setError("Choose an image (GeoTIFF) to segment.");
      return;
    }
    if (mode === "text" && !prompt.trim()) {
      setError("Enter a text prompt, e.g. “trees” or “buildings”.");
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
        setResultMessage("No objects found.");
        return;
      }
      const name =
        mode === "text" ? `Segmentation: ${prompt.trim()}` : "Segmentation";
      const layerId = addGeoJsonLayer(name, fc);
      const layer = useAppStore
        .getState()
        .layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      setResultMessage(`Added ${features.length} feature(s) as “${name}”.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Segmentation failed.");
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
          <DialogTitle>AI Segmentation</DialogTitle>
          <DialogDescription>
            Turn imagery into vector features with SAM3 (segment-geospatial).
            Choose a GeoTIFF, describe what to segment, and get polygons back as
            a new layer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {status && !available && (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {status.message}
              </p>
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
                Start server
              </Button>
            </div>
          )}

          {/* Image source */}
          <div className="grid gap-1.5">
            <Label htmlFor="seg-image" className="text-xs">
              Image (GeoTIFF)<span className="text-destructive"> *</span>
            </Label>
            <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
              <Input
                id="seg-image"
                readOnly
                value={imageName}
                placeholder="Choose a GeoTIFF…"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Choose image"
                onClick={() => void pickImage()}
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Mode */}
          <div className="grid gap-1.5">
            <Label htmlFor="seg-mode" className="text-xs">
              Mode
            </Label>
            <Select
              id="seg-mode"
              value={mode}
              onChange={(e) =>
                setMode(e.target.value as "text" | "automatic")
              }
            >
              <option value="text">Text prompt</option>
              <option value="automatic">Automatic (everything)</option>
            </Select>
          </div>

          {mode === "text" && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="seg-prompt" className="text-xs">
                  Prompt<span className="text-destructive"> *</span>
                </Label>
                <Input
                  id="seg-prompt"
                  value={prompt}
                  placeholder="e.g. trees, buildings, water"
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="seg-confidence" className="text-xs">
                  Confidence threshold
                </Label>
                <Input
                  id="seg-confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={String(confidence)}
                  onChange={(e) =>
                    setConfidence(
                      e.target.value === "" ? 0.4 : Number(e.target.value),
                    )
                  }
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
              Segment
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
