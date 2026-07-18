import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { fetchMlStatus, mlSegment, type MlSegmentMode, type MlStatus } from "@geolibre/processing";
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
  Download,
  FolderOpen,
  Info,
  Loader2,
  Play,
  Server,
} from "lucide-react";
import type { FeatureCollection } from "geojson";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isTauri, openLocalDataFileWithFallback } from "../../lib/tauri-io";
import { reprojectFeatureCollectionToWgs84 } from "../../lib/duckdb-vector-loader";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import { UPDATE_URL } from "../../lib/updates";
import { SidecarHelpBanner, SIDECAR_PORT, SIDECAR_URL } from "./SidecarHelpBanner";

interface SegmentationDialogProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

const IMAGE_FILTERS = [{ name: "Imagery", extensions: ["tif", "tiff", "png", "jpg", "jpeg"] }];
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
export function SegmentationDialog({ mapControllerRef }: SegmentationDialogProps): ReactElement {
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
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed "Start server" attempt is tracked separately from validation/run
  // errors so it can surface as the interactive troubleshooting banner instead
  // of a dead-end static error line (issue #594).
  const [serverError, setServerError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);

  // Monotonic token so a stale probe (e.g. the dialog reopened, or the
  // post-boot probe in startServer) cannot clobber a newer probe's result or
  // drop the spinner out from under it.
  const checkGenRef = useRef(0);

  const checkStatus = useCallback(async () => {
    const gen = ++checkGenRef.current;
    setChecking(true);
    setStatus(null);
    try {
      const next = await fetchMlStatus();
      if (gen === checkGenRef.current) setStatus(next);
    } catch (err) {
      // A failed probe (sidecar not started, or no segmentation backend behind
      // the proxy) is an expected "not set up yet" state, not a system failure.
      // Show neutral guidance instead of surfacing the raw HTTP/connection
      // error, so a freshly opened, blank dialog never greets the user with
      // something like "HTTP 404" (issue #545). Log at debug (matching
      // sidecarConnectionError) so an unexpected failure stays discoverable in
      // production without warning-spam for the routine not-set-up case.
      console.debug("SegmentationDialog: ML status probe failed", err);
      if (gen === checkGenRef.current) {
        setStatus({
          available: false,
          // Desktop users get the "Start server" button below, so point them at
          // it; web users have no such button, so tell them the feature needs
          // the desktop app rather than an action they cannot take.
          message: isTauri()
            ? t("segmentation.status.unavailableDesktop")
            : t("segmentation.status.unavailableWeb"),
        });
      }
    } finally {
      if (gen === checkGenRef.current) setChecking(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    // Reset transient state so a re-opened dialog never shows a stale error,
    // result, or a `running` spinner left over from a previous session.
    setError(null);
    setServerError(null);
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
    setServerError(null);
    try {
      await startGeoLibreSidecar();
      await checkStatus();
    } catch (err) {
      // Route the failure into serverError so the bottom of the dialog renders
      // the interactive troubleshooting banner rather than a static error line.
      setServerError(err instanceof Error ? err.message : t("segmentation.error.startServer"));
    } finally {
      setStartingServer(false);
    }
  }, [checkStatus, t]);

  const handleRun = useCallback(async () => {
    setError(null);
    // Defensive: serverError is normally null by the time Segment is enabled;
    // clearing it keeps the success path from coexisting with a stale banner.
    setServerError(null);
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
      const raw: FeatureCollection = await mlSegment(mode, blob, imageName || "image.tif", {
        prompt: prompt.trim(),
        confidenceThreshold: confidence,
      });
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
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      setResultMessage(t("segmentation.added", { count: features.length, name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("segmentation.error.failed"));
    } finally {
      setRunning(false);
    }
  }, [imageBytes, imageName, mode, prompt, confidence, addGeoJsonLayer, mapControllerRef, t]);

  const available = status?.available === true;
  // In the browser the form is shown but disabled rather than hidden (issue
  // #777): web users still see the full capability they're missing, which
  // motivates the desktop download, but cannot interact with inputs that do
  // nothing. Gating on `available` (not on `status !== null`) keeps the form
  // disabled during the async probe too; `available` becomes true only when a
  // proxied sidecar is reachable, the rare web case where segmentation works.
  const webUnavailable = !isTauri() && !available;

  // Browser users cannot run segmentation here, so point them at the desktop
  // download instead of the unusable "Start server" action (issue #777). This
  // is rendered both in the resolved "unavailable" banner and while the status
  // probe is still in flight, so a slow or hanging probe (e.g. a silent packet
  // drop with no explicit fetch timeout) never leaves them without an action.
  const downloadDesktopButton = (
    <Button asChild variant="outline" className="gap-2">
      <a href={UPDATE_URL} target="_blank" rel="noopener noreferrer">
        <Download className="h-4 w-4" />
        {t("segmentation.downloadDesktop")}
      </a>
    </Button>
  );

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
          <DialogDescription>{t("segmentation.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {checking && (
            // For browser users the spinner shares the resolved banner's panel
            // framing so the download CTA below it keeps its frame instead of
            // jumping when the probe settles. Desktop has no CTA here, so it
            // keeps the plain inline spinner it had before.
            <div
              className={
                webUnavailable
                  ? "grid gap-2 rounded-md border border-border bg-muted/40 p-3"
                  : "grid gap-2"
              }
            >
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("segmentation.status.checking")}
              </p>
              {/* Keep a download CTA visible while the probe runs so browser
                  users always have an action, even if it never settles. During
                  the probe `webUnavailable` reduces to `!isTauri()`. */}
              {webUnavailable && downloadDesktopButton}
            </div>
          )}

          {!checking && status && !available && (
            <div className="grid gap-2 rounded-md border border-border bg-muted/40 p-3">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                {status.message}
              </p>
              {/* Launching the sidecar is a desktop-only (Tauri) capability;
                  in the browser build it cannot work, so offer the desktop
                  download instead. */}
              {isTauri() ? (
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
              ) : (
                downloadDesktopButton
              )}
            </div>
          )}

          {/* The configuration form is always rendered. In the browser it is
              shown but disabled (`webUnavailable`) so web users still see the
              full capability and are pointed to the desktop download above,
              without being able to interact with inputs that do nothing. */}
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
                disabled={webUnavailable}
                value={imageName}
                placeholder={t("segmentation.imagePlaceholder")}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title={t("segmentation.chooseImage")}
                onClick={() => void pickImage()}
                disabled={webUnavailable}
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
              disabled={webUnavailable}
              onChange={(e) => setMode(e.target.value as "text" | "automatic")}
            >
              <option value="text">{t("segmentation.modeText")}</option>
              <option value="automatic">{t("segmentation.modeAutomatic")}</option>
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
                  disabled={webUnavailable}
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
                  disabled={webUnavailable}
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

          {/* A failed "Start server" attempt becomes an interactive
              troubleshooting banner (issue #594). Segmentation has no WASM
              fallback, so the banner omits the "Run locally" switch and uses
              segmentation-specific copy (no Whitebox/WASM mentions). Validation
              and run errors keep the plain static line. */}
          {serverError ? (
            <SidecarHelpBanner
              isDesktop={isTauri()}
              error={serverError}
              title={t("segmentation.sidecar.title")}
              intro={t("segmentation.sidecar.intro", {
                sidecarUrl: SIDECAR_URL,
              })}
              troubleshootingTitle={t("segmentation.sidecar.troubleshootingTitle")}
              // The banner only renders after a failed "Start server", which is
              // desktop-only, so the start step is always the desktop one.
              // Install first: a missing segment-geospatial backend is the most
              // likely reason it failed, so leading with it (rather than
              // re-clicking Start, which would fail the same way) keeps the path
              // self-consistent.
              steps={[
                t("segmentation.sidecar.stepInstall"),
                t("segmentation.sidecar.stepStartServerDesktop"),
                t("processing.sidecar.stepCheckPort", { port: SIDECAR_PORT }),
                t("processing.sidecar.stepRestart"),
              ]}
            />
          ) : (
            error && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )
          )}
          {resultMessage && !error && !serverError && (
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
