import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  type MapController,
  pmtilesNativeLayerIds,
  readPMTilesArchiveInfo,
  registerPMTilesArchive,
} from "@geolibre/map";
import {
  extractPmtiles,
  type PmtilesExtractProgress,
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
} from "@geolibre/ui";
import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../../lib/offline-regions";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";

interface BasemapExtractDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** The four editable bounding-box fields, held as strings so partial edits
 * (a lone "-", an in-progress decimal) don't fight the controlled inputs. */
interface CoordFields {
  west: string;
  south: string;
  east: string;
  north: string;
}

const EMPTY_COORDS: CoordFields = { west: "", south: "", east: "", north: "" };

/** Remembered across sessions so repeat extracts don't retype the archive URL. */
const URL_STORAGE_KEY = "geolibre.basemapExtract.url";

/** Above this planned size the user must explicitly confirm the download. */
const CONFIRM_BYTES = 150 * 1024 * 1024;

type Phase = "idle" | "running" | "done";

/** Round a coordinate to a readable-but-precise 6 decimal places. */
function fmtCoord(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/** Parse the four coordinate fields into an ordered box, or `null` if any are
 * missing, out of the valid lng/lat range, or the box is degenerate. */
function parseBbox(
  coords: CoordFields,
): [number, number, number, number] | null {
  const west = Number(coords.west);
  const south = Number(coords.south);
  const east = Number(coords.east);
  const north = Number(coords.north);
  if (
    coords.west === "" ||
    coords.south === "" ||
    coords.east === "" ||
    coords.north === "" ||
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return null;
  }
  return [west, south, east, north];
}

/** A layer/file base name from the archive URL, e.g. "planet" for
 * `https://host/planet.pmtiles`. */
function baseNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").filter(Boolean).pop() ?? "basemap";
    return base.replace(/\.pmtiles$/i, "") || "basemap";
  } catch {
    return "basemap";
  }
}

/**
 * Extracts a bbox/zoom subset of a remote PMTiles archive (e.g. a Protomaps
 * planet build mirror) into a portable offline `.pmtiles` file, entirely in
 * the browser via geolibre-wasm range requests. The result is saved to disk
 * and added to the map as a PMTiles layer.
 *
 * Complements the Project-menu "Download offline area" (which warms the
 * service-worker tile cache for this device): an extracted archive is a single
 * shareable file that renders anywhere PMTiles do.
 */
export function BasemapExtractDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: BasemapExtractDialogProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((state) => state.addLayer);

  const [url, setUrl] = useState("");
  const [coords, setCoords] = useState<CoordFields>(EMPTY_COORDS);
  const [minZoom, setMinZoom] = useState("0");
  const [maxZoom, setMaxZoom] = useState("15");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<PmtilesExtractProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // A planned download awaiting the user's size confirmation. Resolving the
  // stored promise resumes (true) or cancels (false) the paused extraction.
  const [pendingPlan, setPendingPlan] = useState<{
    progress: PmtilesExtractProgress;
    resolve: (go: boolean) => void;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const seedFromView = useCallback(() => {
    const view = mapControllerRef.current?.readView();
    if (!view?.bbox) return;
    const [west, south, east, north] = view.bbox;
    setCoords({
      west: fmtCoord(Math.max(west, -180)),
      south: fmtCoord(Math.max(south, -90)),
      east: fmtCoord(Math.min(east, 180)),
      north: fmtCoord(Math.min(north, 90)),
    });
  }, [mapControllerRef]);

  // Reset transient state each time the dialog opens (seeding the bbox from
  // the current view and the URL from the last session), and abort any
  // in-flight extraction when it closes — Radix keeps the dialog mounted, so
  // closing would otherwise leave the download running in the background.
  useEffect(() => {
    if (open) {
      setPhase("idle");
      setProgress(null);
      setError(null);
      setSuccess(null);
      setPendingPlan(null);
      try {
        setUrl(localStorage.getItem(URL_STORAGE_KEY) ?? "");
      } catch {
        // Storage may be unavailable (private mode); keep the empty default.
      }
      seedFromView();
    } else {
      abortRef.current?.abort();
      // Unblock a paused extraction so its promise chain can settle.
      setPendingPlan((pending) => {
        pending?.resolve(false);
        return null;
      });
    }
  }, [open, seedFromView]);

  // Abort any in-flight extraction if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const clearStatus = useCallback(() => {
    setError(null);
    setSuccess(null);
  }, []);

  const setField = useCallback(
    (field: keyof CoordFields, value: string) => {
      setCoords((prev) => ({ ...prev, [field]: value }));
      clearStatus();
    },
    [clearStatus],
  );

  const bbox = parseBbox(coords);
  const bboxInvalid =
    bbox === null &&
    coords.west !== "" &&
    coords.south !== "" &&
    coords.east !== "" &&
    coords.north !== "";

  const minZoomValue = Number(minZoom);
  const maxZoomValue = Number(maxZoom);
  const zoomInvalid =
    minZoom === "" ||
    maxZoom === "" ||
    !Number.isInteger(minZoomValue) ||
    !Number.isInteger(maxZoomValue) ||
    minZoomValue < 0 ||
    maxZoomValue > 30 ||
    minZoomValue > maxZoomValue;

  const urlValue = url.trim();
  const canExtract =
    phase !== "running" && urlValue !== "" && bbox !== null && !zoomInvalid;

  const handleExtract = useCallback(async () => {
    if (!bbox || zoomInvalid || urlValue === "") return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setProgress(null);
    setError(null);
    setSuccess(null);
    try {
      localStorage.setItem(URL_STORAGE_KEY, urlValue);
    } catch {
      // Best-effort persistence only.
    }
    try {
      const { archive } = await extractPmtiles(urlValue, {
        bbox,
        minZoom: minZoomValue,
        maxZoom: maxZoomValue,
        signal: controller.signal,
        onProgress: setProgress,
        confirmDownload: (plan) => {
          if (plan.estimatedOutputBytes < CONFIRM_BYTES) return true;
          return new Promise<boolean>((resolve) => {
            setPendingPlan({ progress: plan, resolve });
          });
        },
      });
      if (controller.signal.aborted) return;

      const base = sanitizeExportFileName(baseNameFromUrl(urlValue));
      const info = await readPMTilesArchiveInfo(archive);
      const effectiveMax = Math.min(maxZoomValue, info.maxZoom);
      const fileName = `${base}-z${Math.max(minZoomValue, info.minZoom)}-${effectiveMax}`;

      // Render the extract immediately from memory: the archive is registered
      // under a synthetic pmtiles:// key that the layer references like any
      // remote URL. Done before saving so a disk-write failure below can't
      // discard a successful in-memory extraction.
      const layerId = `basemap-extract-${Date.now().toString(36)}`;
      const layerUrl = registerPMTilesArchive(
        `${layerId}.pmtiles`,
        archive,
      );
      const fillColor = DEFAULT_LAYER_STYLE.fillColor;
      const layer: GeoLibreLayer = {
        id: layerId,
        name: fileName,
        type: "pmtiles",
        source: {
          sourceId: layerId,
          sourceLayers: info.sourceLayers,
          tileType: info.tileType,
          type: info.tileType === "raster" ? "raster" : "vector",
          url: layerUrl,
        },
        visible: true,
        opacity: 1,
        style: {
          ...DEFAULT_LAYER_STYLE,
          fillOpacity: info.tileType === "raster" ? 0.6 : 1,
          fillColor,
          strokeColor: fillColor,
        },
        metadata: {
          externalNativeLayer: true,
          nativeLayerIds: pmtilesNativeLayerIds(
            layerId,
            info.tileType,
            info.sourceLayers,
          ),
          pickable: true,
          sourceId: layerId,
          sourceKind: "pmtiles-url",
          sourceLayers: info.sourceLayers,
          tileType: info.tileType,
        },
        sourcePath: layerUrl,
      };
      addLayer(layer);
      setPhase("done");

      // Persisting to disk is best-effort and independent of the layer that is
      // now on the map: a cancel returns null, a write error is reported but
      // does not undo the extraction.
      try {
        const savedPath = await saveBinaryFileWithFallback(archive, {
          defaultName: `${fileName}.pmtiles`,
          filters: [{ name: "PMTiles", extensions: ["pmtiles"] }],
          browserTypes: [
            {
              description: "PMTiles",
              accept: { "application/octet-stream": [".pmtiles"] },
            },
          ],
          mimeType: "application/octet-stream",
        });
        setSuccess(
          savedPath !== null
            ? t("basemapExtract.successSaved", { path: savedPath })
            : t("basemapExtract.successAdded"),
        );
      } catch (saveErr) {
        setSuccess(
          t("basemapExtract.successAddedSaveFailed", {
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          }),
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        // The user declined the size confirmation: back to idle, not an error.
        setPhase("idle");
        setProgress(null);
        return;
      }
      setPhase("idle");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingPlan(null);
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPhase((current) => (current === "running" ? "idle" : current));
      }
    }
  }, [
    bbox,
    zoomInvalid,
    urlValue,
    minZoomValue,
    maxZoomValue,
    addLayer,
    t,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingPlan((pending) => {
      pending?.resolve(false);
      return null;
    });
    setPhase("idle");
    setProgress(null);
  }, []);

  const running = phase === "running";
  const percent =
    progress && progress.dataBytesTotal > 0
      ? Math.round(
          (progress.dataBytesReceived / progress.dataBytesTotal) * 100,
        )
      : 0;
  const phaseLabel =
    progress?.phase === "data"
      ? t("basemapExtract.phaseData")
      : t("basemapExtract.phaseDirectories");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("basemapExtract.title")}</DialogTitle>
          <DialogDescription>
            {t("basemapExtract.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="basemap-extract-url" className="text-xs">
              {t("basemapExtract.url")}
            </Label>
            <Input
              id="basemap-extract-url"
              type="url"
              placeholder={t("basemapExtract.urlPlaceholder")}
              value={url}
              disabled={running}
              onChange={(e) => {
                setUrl(e.target.value);
                clearStatus();
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t("basemapExtract.urlHint")}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              {t("basemapExtract.area")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={running}
              onClick={() => {
                seedFromView();
                clearStatus();
              }}
            >
              {t("basemapExtract.useView")}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["north", t("basemapExtract.north")],
                ["south", t("basemapExtract.south")],
                ["west", t("basemapExtract.west")],
                ["east", t("basemapExtract.east")],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="space-y-1">
                <Label
                  htmlFor={`basemap-extract-${field}`}
                  className="text-xs"
                >
                  {label}
                </Label>
                <Input
                  id={`basemap-extract-${field}`}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={coords[field]}
                  disabled={running}
                  onChange={(e) => setField(field, e.target.value)}
                />
              </div>
            ))}
          </div>
          {bboxInvalid ? (
            <p className="text-xs text-destructive">
              {t("basemapExtract.bboxHint")}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="basemap-extract-minzoom" className="text-xs">
                {t("basemapExtract.minZoom")}
              </Label>
              <Input
                id="basemap-extract-minzoom"
                type="number"
                min={0}
                max={30}
                step={1}
                value={minZoom}
                disabled={running}
                onChange={(e) => {
                  setMinZoom(e.target.value);
                  clearStatus();
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="basemap-extract-maxzoom" className="text-xs">
                {t("basemapExtract.maxZoom")}
              </Label>
              <Input
                id="basemap-extract-maxzoom"
                type="number"
                min={0}
                max={30}
                step={1}
                value={maxZoom}
                disabled={running}
                onChange={(e) => {
                  setMaxZoom(e.target.value);
                  clearStatus();
                }}
              />
            </div>
          </div>
          {zoomInvalid && minZoom !== "" && maxZoom !== "" ? (
            <p className="text-xs text-destructive">
              {t("basemapExtract.zoomHint")}
            </p>
          ) : null}

          {pendingPlan ? (
            <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <p className="text-xs">
                {t("basemapExtract.planWarning", {
                  size: formatBytes(pendingPlan.progress.estimatedOutputBytes),
                  tiles: pendingPlan.progress.tilesSelected.toLocaleString(),
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    pendingPlan.resolve(true);
                    setPendingPlan(null);
                  }}
                >
                  {t("basemapExtract.planContinue")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    pendingPlan.resolve(false);
                    setPendingPlan(null);
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}

          {running && !pendingPlan ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{phaseLabel}</span>
                {progress && progress.dataBytesTotal > 0 ? (
                  <span>
                    {formatBytes(progress.dataBytesReceived)} /{" "}
                    {formatBytes(progress.dataBytesTotal)}
                  </span>
                ) : null}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {success ? (
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {success}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <Button type="button" variant="outline" onClick={handleCancel}>
              {t("common.cancel")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
          )}
          <Button
            type="button"
            disabled={!canExtract}
            onClick={() => void handleExtract()}
          >
            {running ? (
              <Loader2
                className="me-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Download className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {running
              ? t("basemapExtract.extracting")
              : t("basemapExtract.extract")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
