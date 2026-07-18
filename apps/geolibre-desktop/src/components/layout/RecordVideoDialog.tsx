import type { MapController } from "@geolibre/map";
import { Button, cn, Input, Label, Select } from "@geolibre/ui";
import {
  Circle,
  Crop,
  Download,
  GripHorizontal,
  Maximize,
  Square,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import {
  CAPTION_POSITIONS,
  type CaptionPosition,
  DEFAULT_CAPTION_POSITION,
  DEFAULT_FPS,
  hasCaptionText,
  isMapRecordingSupported,
  MapRecordingUnsupportedError,
  MAX_FPS,
  MIN_FPS,
  type MapRecording,
  type RecordRegion,
  recordMapCanvas,
} from "../../lib/map-recorder";
import { RegionSelectOverlay } from "./RegionSelectOverlay";

interface RecordVideoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

// "ready" holds a finished recording in memory so saving is a deliberate second
// step (name + Save) rather than an automatic download the moment recording ends.
// "preparing" covers the brief async setup before capture starts (rasterizing
// the HTML panel overlay); the UI stays out of the live "recording" state until
// MediaRecorder is actually running.
type Status = "idle" | "preparing" | "recording" | "ready" | "saving";
// Which part of the map a recording captures.
type Mode = "whole" | "region";

const DEFAULT_FILE_NAME = "map-recording";
// The on-map info panels added via the Components plugin: the HTML control's
// display box, the legend, and the colorbar. These are the *rendered* overlays
// (`maplibre-gl-html-control` / `maplibre-gl-legend` / `maplibre-gl-colorbar`),
// NOT the `*-gui-control` authoring editors -- we burn the info in, not the
// editor chrome. These class names mirror maplibre-gl-components internals; see
// CLAUDE.md and re-check them when that package is bumped.
const MAP_PANEL_SELECTOR = ".maplibre-gl-html-control, .maplibre-gl-legend, .maplibre-gl-colorbar";
// Hoisted so the save path doesn't recompile it on every call (and to satisfy
// the e18e/prefer-static-regex lint rule).
const VIDEO_EXTENSION_RE = /\.(mp4|webm)$/i;

// Codec support is a static browser capability, so probe it once at module load
// rather than re-running the MediaRecorder.isTypeSupported() checks per render.
const RECORDING_SUPPORTED = isMapRecordingSupported();

/** Clamp a number into a range, returning the fallback when not finite. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Format an elapsed-seconds count as `m:ss` for the live recording timer. */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Records the live map to a video file (MP4 where the browser supports it, WebM
 * otherwise) by capturing the MapLibre canvas — either the whole viewport or a
 * fixed rectangle drawn on the map (see {@link recordMapCanvas}).
 *
 * Renders as a non-modal, draggable floating panel (mirroring
 * {@link RecordTourDialog}) so the map stays fully interactive while recording:
 * the user pans and zooms and the movement is captured. HTML overlays like this
 * panel and the selection frame are not part of the recorded canvas, but an
 * optional title/source caption is burned into every frame (see the caption
 * fields and {@link recordMapCanvas}), letting the user annotate the video
 * itself the way the on-map HTML control cannot be.
 */
export function RecordVideoDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: RecordVideoDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("whole");
  const [region, setRegion] = useState<RecordRegion | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [fpsText, setFpsText] = useState(String(DEFAULT_FPS));
  // Optional title/source caption burned into every frame (see recordMapCanvas).
  const [captionTitle, setCaptionTitle] = useState("");
  const [captionText, setCaptionText] = useState("");
  const [captionPosition, setCaptionPosition] = useState<CaptionPosition>(DEFAULT_CAPTION_POSITION);
  // Burn the on-map info panels (HTML control, legend, colorbar) into the video
  // (they are DOM, so they are rasterized and composited rather than captured
  // from the canvas). Offered only when at least one such panel is on the map.
  const [includePanels, setIncludePanels] = useState(false);
  const [panelsAvailable, setPanelsAvailable] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveCancelled, setSaveCancelled] = useState(false);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  // The finished recording, held until the user names it and clicks Save.
  const [pendingRec, setPendingRec] = useState<MapRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guards a second handleSave landing before "saving" has re-rendered (fast
  // double-click / Enter repeat), which would fire two save dialogs / downloads.
  const savingRef = useRef(false);

  // Drag-to-reposition. `pos` is null until first dragged, when the default
  // corner placement (CSS class) applies; afterwards it pins to explicit coords.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const busy = status === "preparing" || status === "recording" || status === "saving";
  // Also frozen in "ready": a finished take is held, so mode/region editing is
  // locked until it is saved or discarded, matching the tour recorder.
  const editingFrozen = busy || status === "ready";

  const clearResultMessages = () => {
    setSavedName(null);
    setSaveCancelled(false);
    setError(null);
  };

  const onDragStart = (event: React.PointerEvent) => {
    // Never begin a drag from an interactive control: the pointer capture would
    // swallow the ensuing click (e.g. the close button).
    if ((event.target as Element).closest("button, a, [role='button']")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setPos({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent) => {
    if (!dragOffset.current) return;
    const width = panelRef.current?.offsetWidth ?? 0;
    const height = panelRef.current?.offsetHeight ?? 0;
    // Keep the panel within the viewport so it can't be dragged off-screen.
    const x = Math.max(
      0,
      Math.min(event.clientX - dragOffset.current.x, window.innerWidth - width),
    );
    const y = Math.max(
      0,
      Math.min(event.clientY - dragOffset.current.y, window.innerHeight - height),
    );
    setPos({ x, y });
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const chooseMode = (next: Mode) => {
    if (editingFrozen) return;
    clearResultMessages();
    setMode(next);
    if (next === "whole") {
      setSelecting(false);
    }
  };

  // Enter draw mode for the selected-area rectangle.
  const startSelect = () => {
    if (editingFrozen) return;
    clearResultMessages();
    setMode("region");
    setSelecting(true);
  };

  const handleRegionSelected = (next: RecordRegion | null) => {
    // A too-small drag returns null; keep selecting so the user can retry rather
    // than silently dropping back with no region.
    if (!next) return;
    setRegion(next);
    setSelecting(false);
  };

  const startRecording = async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map || busy) return;
    if (mode === "region" && !region) {
      setError(t("recordVideo.needRegion"));
      return;
    }
    clearResultMessages();
    setElapsed(0);
    // "preparing" until MediaRecorder actually starts (onStarted below): the
    // HTML-panel overlay is rasterized first, so the red "recording" UI must not
    // claim capture is live before it is.
    setStatus("preparing");
    const controller = new AbortController();
    abortRef.current = controller;
    // Snapshot the caption text at record start; blank fields draw nothing.
    const captionOptions = {
      title: captionTitle,
      caption: captionText,
      position: captionPosition,
    };
    // Collect the on-map info panels (HTML, legend, colorbar) to burn in, if the
    // user opted in. Queried live so a panel added/removed since the dialog
    // opened is reflected (the checkbox availability tracks this too).
    const domOverlays = includePanels
      ? Array.from(map.getContainer().querySelectorAll<HTMLElement>(MAP_PANEL_SELECTOR))
      : null;
    try {
      const rec = await recordMapCanvas({
        map,
        region: mode === "region" ? region : null,
        caption: hasCaptionText(captionOptions) ? captionOptions : null,
        domOverlays,
        fps,
        signal: controller.signal,
        onStarted: () => setStatus("recording"),
        onElapsed: setElapsed,
      });
      // An empty clip (a stop before the first frame flushed) is treated as a
      // cancel rather than holding an unusable file.
      if (rec.blob.size === 0) {
        setSaveCancelled(true);
        setStatus("idle");
      } else {
        setPendingRec(rec);
        setStatus("ready");
      }
    } catch (err) {
      setError(
        err instanceof MapRecordingUnsupportedError
          ? t("recordVideo.unsupported")
          : t("recordVideo.recordError"),
      );
      setStatus("idle");
    } finally {
      abortRef.current = null;
      setStatus((current) =>
        current === "recording" || current === "preparing" ? "idle" : current,
      );
    }
  };

  const stopRecording = () => abortRef.current?.abort();

  // Abort any in-flight recording if the panel is closed or the component
  // unmounts (e.g. the toolbar/map is torn down), so recordMapCanvas can't keep
  // its RAF loop and MediaRecorder running after the dialog is gone. A finished
  // recording has already cleared abortRef in startRecording's finally, so this
  // only cancels a still-running take.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [open]);

  // Offer the "include map panels" option only when at least one such panel is
  // actually on the map. Kept live while the dialog is open by observing the
  // map's control container, so toggling a panel on/off from the toolbar between
  // recordings updates the checkbox without reopening the dialog.
  useEffect(() => {
    if (!open) return;
    const container = mapControllerRef.current?.getMap()?.getContainer();
    // Observe the control container specifically (not the whole map) to avoid
    // tile/marker churn. A control's own internal DOM updates (e.g. legend
    // swatches) can still fire the callback, but refresh() is a cheap querySelector
    // and React bails on an unchanged value, so the extra calls are harmless.
    const controlContainer = container?.querySelector(".maplibregl-control-container") ?? container;
    if (!controlContainer) {
      setPanelsAvailable(false);
      setIncludePanels(false);
      return;
    }
    const refresh = () => {
      const present = Boolean(controlContainer.querySelector(MAP_PANEL_SELECTOR));
      setPanelsAvailable(present);
      if (!present) setIncludePanels(false);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(controlContainer, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, mapControllerRef]);

  const handleSave = async () => {
    if (!pendingRec || savingRef.current) return;
    savingRef.current = true;
    setStatus("saving");
    clearResultMessages();
    try {
      const ext = pendingRec.extension;
      const base = fileName.trim().replace(VIDEO_EXTENSION_RE, "") || DEFAULT_FILE_NAME;
      const fileType = t("recordVideo.videoFileType");
      const name = await saveBinaryFileWithFallback(pendingRec.blob, {
        defaultName: `${base}.${ext}`,
        filters: [{ name: fileType, extensions: [ext] }],
        browserTypes: [
          {
            description: fileType,
            accept: { [pendingRec.mimeType.split(";")[0]]: [`.${ext}`] },
          },
        ],
        mimeType: pendingRec.mimeType,
      });
      if (name) {
        setSavedName(name);
        setPendingRec(null);
        setFileName(DEFAULT_FILE_NAME);
        setStatus("idle");
      } else {
        // Cancelled the save dialog: keep the take so it can be saved again.
        setSaveCancelled(true);
        setStatus("ready");
      }
    } catch (err) {
      console.warn("Map video save failed", err);
      setError(t("recordVideo.saveError"));
      setStatus("ready");
    } finally {
      savingRef.current = false;
    }
  };

  const discardRecording = () => {
    setPendingRec(null);
    clearResultMessages();
    setFileName(DEFAULT_FILE_NAME);
    setStatus("idle");
  };

  if (!open) return null;

  const ext = pendingRec?.extension ?? "";

  return (
    <>
      {/* The selection frame lives over the map, outside the panel, so it tracks
          the canvas rather than the draggable panel. Shown while drawing, while a
          region is chosen, and during a region recording. */}
      <RegionSelectOverlay
        mapControllerRef={mapControllerRef}
        mode={selecting ? "select" : mode === "region" && region ? "frame" : "hidden"}
        region={region}
        onSelect={handleRegionSelected}
        onCancel={() => setSelecting(false)}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-label={t("recordVideo.title")}
        style={pos ? { left: pos.x, top: pos.y } : undefined}
        className={cn(
          "fixed z-40 flex w-80 max-w-[95vw] flex-col rounded-lg border bg-card text-card-foreground shadow-xl",
          pos ? "" : "left-4 top-16",
        )}
      >
        {/* Drag handle / title bar. */}
        <div
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          className="flex cursor-move touch-none select-none items-center gap-2 border-b px-3 py-2"
        >
          <GripHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-sm font-semibold">{t("recordVideo.title")}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            disabled={editingFrozen}
            onClick={() => onOpenChange(false)}
            className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-3">
          <p className="text-xs text-muted-foreground">{t("recordVideo.hint")}</p>

          {!RECORDING_SUPPORTED && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-muted-foreground">
              {t("recordVideo.unsupported")}
            </p>
          )}

          {/* Capture-area toggle. */}
          <div className="flex flex-col gap-1.5">
            <Label>{t("recordVideo.area")}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "whole" ? "default" : "outline"}
                disabled={editingFrozen}
                onClick={() => chooseMode("whole")}
              >
                <Maximize className="me-1.5 h-3.5 w-3.5" />
                {t("recordVideo.wholeMap")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "region" ? "default" : "outline"}
                disabled={editingFrozen}
                onClick={startSelect}
              >
                <Crop className="me-1.5 h-3.5 w-3.5" />
                {region && mode === "region"
                  ? t("recordVideo.redrawArea")
                  : t("recordVideo.selectArea")}
              </Button>
            </div>
            {mode === "region" && (
              <p className="text-xs text-muted-foreground">
                {selecting
                  ? t("recordVideo.drawHint")
                  : region
                    ? t("recordVideo.regionChosen", {
                        width: Math.round(region.width),
                        height: Math.round(region.height),
                      })
                    : t("recordVideo.noRegion")}
              </p>
            )}
          </div>

          {/* Frame rate. */}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="record-video-fps">{t("recordVideo.fps")}</Label>
            <Input
              id="record-video-fps"
              type="number"
              inputMode="numeric"
              min={MIN_FPS}
              max={MAX_FPS}
              disabled={editingFrozen}
              className="w-24"
              value={fpsText}
              onChange={(e) => {
                setFpsText(e.target.value);
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next >= MIN_FPS && next <= MAX_FPS) {
                  setFps(next);
                }
              }}
              onBlur={() => {
                const next = clamp(Number(fpsText), MIN_FPS, MAX_FPS, fps);
                setFps(next);
                setFpsText(String(next));
              }}
            />
          </div>

          {/* Caption burned into the video. DOM overlays (the HTML control, this
              panel) can't be recorded, so this text is drawn onto the frames
              directly, letting the user annotate the video itself. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="record-video-caption-title">{t("recordVideo.caption")}</Label>
            <Input
              id="record-video-caption-title"
              disabled={editingFrozen}
              value={captionTitle}
              onChange={(e) => setCaptionTitle(e.target.value)}
              placeholder={t("recordVideo.captionTitlePlaceholder")}
            />
            <Input
              id="record-video-caption-text"
              aria-label={t("recordVideo.captionTextLabel")}
              disabled={editingFrozen}
              value={captionText}
              onChange={(e) => setCaptionText(e.target.value)}
              placeholder={t("recordVideo.captionTextPlaceholder")}
            />
            {hasCaptionText({
              title: captionTitle,
              caption: captionText,
              position: captionPosition,
            }) && (
              <Select
                aria-label={t("recordVideo.captionPosition")}
                disabled={editingFrozen}
                value={captionPosition}
                onChange={(e) => setCaptionPosition(e.target.value as CaptionPosition)}
              >
                {CAPTION_POSITIONS.map((position) => (
                  <option key={position} value={position}>
                    {t(`recordVideo.captionPos.${position}`)}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {/* Burn the on-map info panels (HTML control, legend, colorbar) into
              the video. Shown only when at least one exists; unlike the map
              canvas, these are DOM, so they are rasterized and composited into
              every frame. */}
          {panelsAvailable && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                disabled={editingFrozen}
                checked={includePanels}
                onChange={(e) => setIncludePanels(e.target.checked)}
              />
              {t("recordVideo.includePanels")}
            </label>
          )}

          {/* Record / Stop, then the save step. */}
          {status === "recording" || status === "preparing" ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                className="flex-1"
                onClick={stopRecording}
              >
                <Square className="me-1.5 h-3.5 w-3.5 fill-current" />
                {t("recordVideo.stop")}
              </Button>
              {status === "preparing" ? (
                <span className="text-xs font-medium text-muted-foreground">
                  {t("recordVideo.preparing")}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs font-medium text-red-500">
                  <Circle className="h-2.5 w-2.5 animate-pulse fill-current" />
                  {formatElapsed(elapsed)}
                </span>
              )}
            </div>
          ) : status === "ready" ? (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
              <p className="text-xs text-muted-foreground">{t("recordVideo.recordingReady")}</p>
              <div className="flex items-center gap-2">
                <Label htmlFor="record-video-name" className="sr-only">
                  {t("recordVideo.fileNameLabel")}
                </Label>
                <Input
                  id="record-video-name"
                  className="flex-1"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder={DEFAULT_FILE_NAME}
                />
                <span className="text-xs text-muted-foreground">.{ext}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" className="flex-1" onClick={handleSave}>
                  <Download className="me-1.5 h-3.5 w-3.5" />
                  {t("recordVideo.saveVideo")}
                </Button>
                <Button type="button" variant="outline" onClick={discardRecording}>
                  <Trash2 className="me-1.5 h-3.5 w-3.5" />
                  {t("recordVideo.discard")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              disabled={
                !RECORDING_SUPPORTED ||
                status === "saving" ||
                selecting ||
                (mode === "region" && !region)
              }
              onClick={startRecording}
            >
              <Video className="me-1.5 h-3.5 w-3.5" />
              {status === "saving" ? t("recordVideo.savingStatus") : t("recordVideo.record")}
            </Button>
          )}

          {/* Outcome banners. */}
          {savedName && (
            <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-muted-foreground">
              {t("recordVideo.saved", { name: savedName })}
            </p>
          )}
          {saveCancelled && (
            <p className="text-xs text-muted-foreground">{t("recordVideo.saveCancelled")}</p>
          )}
          {error && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-500">
              {error}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
