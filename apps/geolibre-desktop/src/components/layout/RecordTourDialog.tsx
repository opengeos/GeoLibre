import type { MapController } from "@geolibre/map";
import { Button, cn, Input, Label } from "@geolibre/ui";
import {
  ArrowDown,
  ArrowUp,
  Camera,
  Circle,
  Download,
  FolderOpen,
  GripHorizontal,
  MapPin,
  Plus,
  Save,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  openLocalDataFileWithFallback,
  saveBinaryFileWithFallback,
  saveTextFileWithFallback,
} from "../../lib/tauri-io";
import {
  DEFAULT_FPS,
  DEFAULT_SEGMENT_SECONDS,
  estimateTourDurationMs,
  isTourRecordingSupported,
  MAX_FPS,
  MAX_SEGMENT_SECONDS,
  MIN_FPS,
  MIN_SEGMENT_SECONDS,
  parseTourConfig,
  recordTour,
  serializeTourConfig,
  type TourKeyframe,
  TourRecordingUnsupportedError,
} from "../../lib/tour-recorder";

interface RecordTourDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

// "ready" holds a finished recording in memory so saving is a deliberate second
// step (name + Save) rather than an automatic download the moment recording ends.
type Status = "idle" | "recording" | "ready" | "saving";

const DEFAULT_FILE_NAME = "map-tour";
// Default leaf name for the saved tour *configuration* (the editable JSON),
// distinct from the recorded video's name so the two exports are easy to tell
// apart in a downloads folder.
const DEFAULT_CONFIG_FILE_NAME = "map-tour-setup";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `keyframe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Round a camera number for compact display in the keyframe list. */
function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** Clamp a number into a range, returning the fallback when not finite. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Codec support is a static browser capability, so probe it once at module load
// rather than re-running the MediaRecorder.isTypeSupported() checks per render.
const RECORDING_SUPPORTED = isTourRecordingSupported();

/**
 * Builds an animated camera "tour" from a sequence of keyframes captured from
 * the live map and records it to a WebM video by capturing the MapLibre canvas
 * (see {@link recordTour}).
 *
 * Renders as a non-modal, draggable floating panel rather than a modal dialog:
 * the map stays fully interactive while the panel is open, so the user pans and
 * zooms and clicks "Add current view" repeatedly without ever closing it. HTML
 * overlays aren't part of the captured canvas, so the panel can stay open while
 * recording too. Keyframe state lives on this always-mounted component, so a
 * tour survives toggling the panel.
 */
export function RecordTourDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: RecordTourDialogProps) {
  const { t } = useTranslation();
  const [keyframes, setKeyframes] = useState<TourKeyframe[]>([]);
  const [fps, setFps] = useState(DEFAULT_FPS);
  // Mirror the FPS as editable text so the field can be cleared and retyped;
  // a bare controlled number input snaps an empty value to the min instead.
  const [fpsText, setFpsText] = useState(String(DEFAULT_FPS));
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [saveCancelled, setSaveCancelled] = useState(false);
  // Outcome banner for the configuration save/load actions (kept separate from
  // the video save banner so the two messages never clobber each other).
  const [configMessage, setConfigMessage] = useState<string | null>(null);
  // The finished recording, held until the user names it and clicks Save.
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const abortRef = useRef<AbortController | null>(null);
  // Guards against a second handleSave landing before the "saving" state has
  // re-rendered (fast double-click / keyboard repeat on Enter), which would
  // otherwise fire two save dialogs or two downloads.
  const savingRef = useRef(false);

  // Drag-to-reposition. `pos` is null until first dragged, when the default
  // corner placement (CSS class) applies; afterwards it pins to explicit coords.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // True while the camera is being captured or the file is being written; the
  // close button is blocked during these phases.
  const busy = status === "recording" || status === "saving";
  // Also true in "ready": a finished take is held in memory, so the keyframe
  // editing controls are frozen until it is saved or explicitly discarded. That
  // makes dropping the take a deliberate Discard click rather than a one-click
  // accident from an edit whose warning may have scrolled out of view.
  const editingFrozen = busy || status === "ready";

  // Clear the last save/record outcome banner. Called by every edit that
  // actually changes the tour (add, recapture, remove, an in-range reorder, a
  // real duration change), since the saved video no longer matches it. No-op
  // interactions leave it alone — an unchanged-value blur or an out-of-range
  // reorder must not make a "Saved …" note vanish on a non-edit. A pending take
  // is never dropped here: editing is frozen while one is held, so the only way
  // to drop it is the explicit Discard button.
  const clearResultMessages = () => {
    setSavedName(null);
    setSaveCancelled(false);
    setConfigMessage(null);
    setError(null);
  };

  const onDragStart = (event: React.PointerEvent) => {
    // Starting a drag captures the pointer, which would redirect the ensuing
    // click away from the close button and swallow it, so never begin a drag
    // from an interactive control. (event.target may be the SVG icon inside the
    // button, so cast to the Element ancestor type rather than HTMLElement.)
    if ((event.target as Element).closest("button, a, [role='button']")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
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

  // Also clears on pointercancel (e.g. an OS/browser gesture interrupts the
  // drag) so a stale offset can't snap the panel on the next move.
  const onDragEnd = (event: React.PointerEvent) => {
    dragOffset.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  /** Read the live map camera, rounded for compact display. */
  const captureView = () => {
    const view = mapControllerRef.current?.readView();
    if (!view) return null;
    return {
      center: [round(view.center[0], 6), round(view.center[1], 6)] as [
        number,
        number,
      ],
      zoom: round(view.zoom, 3),
      pitch: round(view.pitch, 1),
      bearing: round(view.bearing, 1),
    };
  };

  const addCurrentView = () => {
    const view = captureView();
    if (!view) return;
    clearResultMessages();
    setKeyframes((current) => [
      ...current,
      {
        id: createId(),
        ...view,
        durationMs: DEFAULT_SEGMENT_SECONDS * 1000,
      },
    ]);
  };

  // Overwrite an existing keyframe's camera with the live map view, so a single
  // stop can be re-framed in place instead of being deleted and re-added (which
  // would lose its position in the sequence and its segment duration).
  const recaptureKeyframe = (id: string) => {
    const view = captureView();
    if (!view) return;
    // Recapturing changes what the tour records, like adding a view, so a stale
    // "Saved …" banner shouldn't keep implying the modified tour was saved.
    clearResultMessages();
    setKeyframes((current) =>
      current.map((kf) => (kf.id === id ? { ...kf, ...view } : kf)),
    );
  };

  const removeKeyframe = (id: string) => {
    // Dropping a stop changes what the tour records, so invalidate the banner.
    clearResultMessages();
    setKeyframes((current) => current.filter((kf) => kf.id !== id));
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    // Guard the no-op (already at an end) so an inert reorder click can't clear
    // the banner; the buttons are disabled there anyway, this is belt-and-braces.
    if (target < 0 || target >= keyframes.length) return;
    clearResultMessages();
    setKeyframes((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const setSegmentSeconds = (id: string, seconds: number) => {
    const durationMs = Math.round(seconds * 1000);
    // Clear the banner only on a real change, so merely focusing and blurring a
    // duration field (which re-commits the same value) doesn't wipe it.
    const current = keyframes.find((kf) => kf.id === id);
    if (current && current.durationMs !== durationMs) clearResultMessages();
    setKeyframes((prev) =>
      prev.map((kf) => (kf.id === id ? { ...kf, durationMs } : kf)),
    );
  };

  const previewKeyframe = (kf: TourKeyframe) =>
    mapControllerRef.current?.flyTo({
      center: kf.center,
      zoom: kf.zoom,
      pitch: kf.pitch,
      bearing: kf.bearing,
    });

  const handleRecord = async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map || keyframes.length < 2) return;
    setError(null);
    setSavedName(null);
    setSaveCancelled(false);
    setProgress(0);
    setStatus("recording");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const blob = await recordTour({
        map,
        keyframes,
        fps,
        signal: controller.signal,
        onProgress: setProgress,
      });
      // An empty clip (a stop during the opening hold, or a degenerate
      // zero-byte encode) is treated as a cancel rather than holding an unusable
      // file; a non-empty partial tour (stopped midway) is still worth keeping.
      // Recording and saving are deliberately decoupled: a finished take is held
      // in "ready" so the user names it and saves it explicitly, instead of an
      // automatic download firing the instant capture ends.
      if (blob.size === 0) {
        setSaveCancelled(true);
        setStatus("idle");
      } else {
        setPendingBlob(blob);
        setStatus("ready");
      }
    } catch (err) {
      // Show a translated message rather than leaking the helper's raw English
      // string; aborts resolve cleanly above, so this only fires for real
      // failures.
      setError(
        err instanceof TourRecordingUnsupportedError
          ? t("recordTour.unsupported")
          : t("recordTour.recordError"),
      );
      setStatus("idle");
    } finally {
      abortRef.current = null;
      // Safety net: if neither the try nor the catch reached a terminal status
      // (e.g. t() itself threw in the catch), fall back to "idle" so the dialog
      // can't stay stuck on "recording" with a now-null abort controller.
      setStatus((current) => (current === "recording" ? "idle" : current));
      setProgress(0);
    }
  };

  const stopRecording = () => abortRef.current?.abort();

  // Second step of the record→save flow: write the held recording to disk under
  // the user-chosen name. On a browser without the File System Access picker
  // this still controls the downloaded filename (the helper falls back to an
  // anchor download using defaultName).
  const handleSave = async () => {
    if (!pendingBlob || savingRef.current) return;
    savingRef.current = true;
    setStatus("saving");
    // Clear any prior outcome so a fresh attempt can't leave both a "saved" and
    // a "cancelled" message on screen at once.
    setError(null);
    setSavedName(null);
    setSaveCancelled(false);
    try {
      const base = fileName.trim().replace(/\.webm$/i, "") || DEFAULT_FILE_NAME;
      const fileType = t("recordTour.videoFileType");
      // Pass the Blob straight through; the helper only materializes bytes on
      // the Tauri write path, so a cancel-and-retry never re-copies the video.
      const name = await saveBinaryFileWithFallback(pendingBlob, {
        defaultName: `${base}.webm`,
        filters: [{ name: fileType, extensions: ["webm"] }],
        browserTypes: [
          { description: fileType, accept: { "video/webm": [".webm"] } },
        ],
        mimeType: "video/webm",
      });
      if (name) {
        setSavedName(name);
        setPendingBlob(null);
        setFileName(DEFAULT_FILE_NAME);
        setStatus("idle");
      } else {
        // Cancelled the save dialog: keep the take so it can be saved again.
        setSaveCancelled(true);
        setStatus("ready");
      }
    } catch (err) {
      // This block runs when writing the file fails, not when recording fails,
      // so use the save-specific message rather than the record one. Log the
      // raw error too, since the user-facing string hides it.
      console.warn("Tour video save failed", err);
      setError(t("recordTour.saveError"));
      setStatus("ready");
    } finally {
      savingRef.current = false;
    }
  };

  const discardRecording = () => {
    setPendingBlob(null);
    setSavedName(null);
    setSaveCancelled(false);
    setError(null);
    setFileName(DEFAULT_FILE_NAME);
    setStatus("idle");
  };

  // Export the editable tour setup (keyframes, durations, FPS) as a JSON file so
  // it can be reloaded and refined later, independent of the recorded video.
  const handleSaveConfig = async () => {
    if (keyframes.length === 0) return;
    clearResultMessages();
    try {
      const content = serializeTourConfig(keyframes, fps);
      const fileType = t("recordTour.configFileType");
      const name = await saveTextFileWithFallback(content, {
        defaultName: `${DEFAULT_CONFIG_FILE_NAME}.json`,
        filters: [{ name: fileType, extensions: ["json"] }],
        browserTypes: [
          { description: fileType, accept: { "application/json": [".json"] } },
        ],
        mimeType: "application/json",
      });
      if (name) setConfigMessage(t("recordTour.configSaved", { name }));
    } catch (err) {
      console.warn("Tour configuration save failed", err);
      setError(t("recordTour.configSaveError"));
    }
  };

  // Load a previously saved tour setup, replacing the current keyframe list and
  // frame rate. Fresh ids are minted so reloaded rows never collide. A bad file
  // throws a parse error, surfaced as a translated message rather than a crash.
  const handleLoadConfig = async () => {
    // Loading replaces the whole tour, so confirm first when there is existing
    // work a misclick would otherwise wipe.
    if (keyframes.length > 0 && !window.confirm(t("recordTour.confirmLoad"))) {
      return;
    }
    try {
      const fileType = t("recordTour.configFileType");
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: fileType, extensions: ["json"] }],
        accept: ".json,application/json",
        readText: true,
      });
      // Cancelling the picker is a no-op, so only clear a prior result banner
      // once a file is actually chosen.
      if (!result?.text) return;
      clearResultMessages();
      const config = parseTourConfig(result.text);
      setKeyframes(config.keyframes.map((kf) => ({ ...kf, id: createId() })));
      setFps(config.fps);
      setFpsText(String(config.fps));
      setConfigMessage(
        t("recordTour.configLoaded", { count: config.keyframes.length }),
      );
    } catch (err) {
      console.warn("Tour configuration load failed", err);
      clearResultMessages();
      setError(t("recordTour.configLoadError"));
    }
  };

  const totalSeconds = estimateTourDurationMs(keyframes) / 1000;
  const canRecord =
    keyframes.length >= 2 && RECORDING_SUPPORTED && status === "idle";

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("recordTour.title")}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      className={cn(
        "fixed z-40 flex max-h-[calc(100dvh-6rem)] w-96 max-w-[95vw] flex-col rounded-lg border bg-card text-card-foreground shadow-xl",
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
        <span className="flex-1 text-sm font-semibold">
          {t("recordTour.title")}
        </span>
        <button
          type="button"
          aria-label={t("common.close")}
          // Blocked while busy (closing would hide the only Stop/progress
          // control) and while a finished take is held in the "ready" state, so
          // closing can't silently strand a recording in memory or drop the
          // user back into the save step on reopen. Save or discard first.
          disabled={editingFrozen}
          onClick={() => onOpenChange(false)}
          className="rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-30"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable body: hint, add-view, and the keyframe list. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
        <p className="text-xs text-muted-foreground">{t("recordTour.hint")}</p>

        {!RECORDING_SUPPORTED && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-muted-foreground">
            {t("recordTour.unsupported")}
          </p>
        )}

        {/* Save / load the editable tour setup so work can be paused, resumed,
            and reused across sessions (independent of the recorded video). */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={editingFrozen}
            onClick={handleLoadConfig}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t("recordTour.loadConfig")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={editingFrozen || keyframes.length === 0}
            onClick={handleSaveConfig}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t("recordTour.saveConfig")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editingFrozen}
            onClick={addCurrentView}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("recordTour.addView")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("recordTour.keyframeCount", { count: keyframes.length })}
          </span>
        </div>

        {keyframes.length === 0 ? (
          <p className="rounded-md border border-dashed border-input p-4 text-center text-sm text-muted-foreground">
            {t("recordTour.empty")}
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
            <ol className="space-y-2">
              {keyframes.map((kf, index) => (
                <KeyframeRow
                  key={kf.id}
                  keyframe={kf}
                  index={index}
                  isLast={index === keyframes.length - 1}
                  disabled={editingFrozen}
                  // Preview only flies the map camera, so it stays available in
                  // the "ready" state to verify the tour before saving; it is
                  // blocked only while the map is mid-capture/save.
                  previewDisabled={busy}
                  onPreview={() => previewKeyframe(kf)}
                  onRecapture={() => recaptureKeyframe(kf.id)}
                  onMove={(delta) => move(index, delta)}
                  onRemove={() => removeKeyframe(kf.id)}
                  onDurationSeconds={(seconds) =>
                    setSegmentSeconds(kf.id, seconds)
                  }
                />
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* Footer: FPS, estimated length, result messages, and the action row. */}
      <div className="space-y-3 border-t p-3">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="record-tour-fps">{t("recordTour.fps")}</Label>
            <Input
              id="record-tour-fps"
              type="number"
              inputMode="numeric"
              className="h-8 w-24"
              min={MIN_FPS}
              max={MAX_FPS}
              step="1"
              // Frozen while a take is held too: a held recording's frame rate
              // is already fixed, so editing FPS would only mislead.
              disabled={editingFrozen}
              value={fpsText}
              onChange={(event) => {
                const text = event.target.value;
                setFpsText(text);
                const next = Number(text);
                if (Number.isFinite(next) && next >= MIN_FPS && next <= MAX_FPS) {
                  setFps(Math.round(next));
                }
              }}
              onBlur={() => {
                const next = clamp(Number(fpsText), MIN_FPS, MAX_FPS, fps);
                setFps(Math.round(next));
                setFpsText(String(Math.round(next)));
              }}
            />
          </div>
          {keyframes.length >= 2 && (
            <p className="pb-1.5 text-xs text-muted-foreground">
              {t("recordTour.estimatedLength", {
                seconds: totalSeconds.toFixed(1),
              })}
            </p>
          )}
        </div>

        {savedName && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {t("recordTour.saved", { name: savedName })}
          </p>
        )}
        {saveCancelled && (
          <p className="text-sm text-muted-foreground">
            {t("recordTour.saveCancelled")}
          </p>
        )}
        {configMessage && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {configMessage}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {busy ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3"
          >
            {status === "recording" ? (
              <Circle className="h-3 w-3 shrink-0 animate-pulse fill-red-500 text-red-500" />
            ) : (
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-foreground" />
            )}
            <span className="flex-1 text-sm font-medium">
              {status === "saving"
                ? t("recordTour.savingStatus")
                : t("recordTour.recordingStatus", {
                    percent: Math.round(progress * 100),
                  })}
            </span>
            {status === "recording" && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={stopRecording}
              >
                {t("recordTour.stop")}
              </Button>
            )}
          </div>
        ) : status === "ready" ? (
          // Second step: the take is captured; let the user name it and save (or
          // discard and re-record) instead of an automatic download.
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t("recordTour.recordingReady")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="record-tour-filename">
                {t("recordTour.fileNameLabel")}
              </Label>
              <div className="flex items-center gap-1">
                <Input
                  id="record-tour-filename"
                  className="h-8 flex-1"
                  // Focus the name field the moment the panel switches to the
                  // save step, so keyboard users can type and press Enter to
                  // save without an extra tab.
                  autoFocus
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  onKeyDown={(event) => {
                    // Ignore key-repeat so holding Enter doesn't re-fire save.
                    if (event.key === "Enter" && !event.repeat) handleSave();
                  }}
                />
                <span className="shrink-0 text-sm text-muted-foreground">
                  .webm
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                className="flex-1"
                onClick={handleSave}
              >
                <Save className="mr-1.5 h-4 w-4" />
                {t("recordTour.saveVideo")}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={discardRecording}
              >
                {t("recordTour.discard")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            className="w-full"
            disabled={!canRecord}
            onClick={handleRecord}
          >
            <Video className="mr-1.5 h-4 w-4" />
            {t("recordTour.record")}
          </Button>
        )}
      </div>
    </div>
  );
}

interface KeyframeRowProps {
  keyframe: TourKeyframe;
  index: number;
  isLast: boolean;
  /** Disables the editing actions (recapture, reorder, remove, duration). */
  disabled: boolean;
  /** Disables only the fly-to preview (map is mid-capture/save). */
  previewDisabled: boolean;
  onPreview: () => void;
  onRecapture: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDurationSeconds: (seconds: number) => void;
}

/**
 * One keyframe in the tour list, laid out over two rows so the per-keyframe
 * actions and the transition-duration control each get their own line and never
 * clip in a narrow panel. The top row is the view (click to fly to it) plus the
 * recapture / reorder / remove actions; the bottom row is the transition
 * duration leading into this keyframe (omitted for the first, which the tour
 * simply starts parked on).
 *
 * The duration field keeps local text state so it can be cleared and retyped (a
 * controlled number input would snap an empty value straight to the minimum);
 * the parsed value commits to the store only while in range, and the text
 * normalizes to the committed value on blur.
 */
function KeyframeRow({
  keyframe,
  index,
  isLast,
  disabled,
  previewDisabled,
  onPreview,
  onRecapture,
  onMove,
  onRemove,
  onDurationSeconds,
}: KeyframeRowProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(keyframe.durationMs / 1000));
  const isFirst = index === 0;
  // Full camera, shown as a hover tooltip so the visible row stays uncluttered.
  const coords = `${keyframe.center[1].toFixed(4)}, ${keyframe.center[0].toFixed(
    4,
  )} · z${keyframe.zoom.toFixed(1)}`;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-input p-2 text-xs">
      {/* Top row: the view (click to preview) and the per-keyframe actions. */}
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium tabular-nums">
          {index + 1}
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground disabled:hover:text-current"
          title={`${t("recordTour.flyToKeyframe")} · ${coords}`}
          disabled={previewDisabled}
          onClick={onPreview}
        >
          <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate tabular-nums text-muted-foreground">
            {coords}
          </span>
        </button>
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("recordTour.recapture")}
            title={t("recordTour.recapture")}
            disabled={disabled}
            onClick={onRecapture}
          >
            <Camera className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("recordTour.moveUp")}
            disabled={isFirst || disabled}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("recordTour.moveDown")}
            disabled={isLast || disabled}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            aria-label={t("recordTour.removeKeyframe")}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Bottom row: transition into this keyframe (the first has none). */}
      {isFirst ? (
        <span className="pl-8 text-muted-foreground">
          {t("recordTour.startingView")}
        </span>
      ) : (
        <label className="flex items-center gap-2 pl-8">
          <span className="text-muted-foreground">
            {t("recordTour.transition")}
          </span>
          <Input
            type="number"
            inputMode="decimal"
            aria-label={t("recordTour.segmentSeconds")}
            className="h-7 w-16"
            min={MIN_SEGMENT_SECONDS}
            max={MAX_SEGMENT_SECONDS}
            step="0.5"
            disabled={disabled}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              const seconds = Number(event.target.value);
              if (
                Number.isFinite(seconds) &&
                seconds >= MIN_SEGMENT_SECONDS &&
                seconds <= MAX_SEGMENT_SECONDS
              ) {
                onDurationSeconds(seconds);
              }
            }}
            onBlur={() => {
              const seconds = clamp(
                Number(text),
                MIN_SEGMENT_SECONDS,
                MAX_SEGMENT_SECONDS,
                keyframe.durationMs / 1000,
              );
              onDurationSeconds(seconds);
              setText(String(seconds));
            }}
          />
          <span className="text-muted-foreground">
            {/* Pluralize against the value being typed (falling back to the
                committed one) so the unit tracks the input: "1 second", not
                "1 seconds", even mid-edit before blur commits. */}
            {t("recordTour.secondsLong", {
              count: Number.isFinite(Number(text))
                ? Number(text)
                : keyframe.durationMs / 1000,
            })}
          </span>
        </label>
      )}
    </li>
  );
}
