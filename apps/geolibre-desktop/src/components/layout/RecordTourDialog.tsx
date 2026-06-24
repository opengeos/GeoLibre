import type { MapController } from "@geolibre/map";
import { Button, cn, Input, Label } from "@geolibre/ui";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  GripHorizontal,
  MapPin,
  Plus,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import {
  estimateTourDurationMs,
  isTourRecordingSupported,
  recordTour,
  type TourKeyframe,
  TourRecordingUnsupportedError,
} from "../../lib/tour-recorder";

interface RecordTourDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

type Status = "idle" | "recording" | "saving";

const DEFAULT_FPS = 30;
const MIN_FPS = 10;
const MAX_FPS = 60;
const DEFAULT_SEGMENT_SECONDS = 4;
const MIN_SEGMENT_SECONDS = 0.5;
const MAX_SEGMENT_SECONDS = 30;

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
  const abortRef = useRef<AbortController | null>(null);

  // Drag-to-reposition. `pos` is null until first dragged, when the default
  // corner placement (CSS class) applies; afterwards it pins to explicit coords.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const recording = status !== "idle";

  const onDragStart = (event: React.PointerEvent) => {
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

  const addCurrentView = () => {
    const view = mapControllerRef.current?.readView();
    if (!view) return;
    setSavedName(null);
    setSaveCancelled(false);
    setError(null);
    setKeyframes((current) => [
      ...current,
      {
        id: createId(),
        center: [round(view.center[0], 6), round(view.center[1], 6)],
        zoom: round(view.zoom, 3),
        pitch: round(view.pitch, 1),
        bearing: round(view.bearing, 1),
        durationMs: DEFAULT_SEGMENT_SECONDS * 1000,
      },
    ]);
  };

  const removeKeyframe = (id: string) =>
    setKeyframes((current) => current.filter((kf) => kf.id !== id));

  const move = (index: number, delta: number) =>
    setKeyframes((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const setSegmentSeconds = (id: string, seconds: number) =>
    setKeyframes((current) =>
      current.map((kf) =>
        kf.id === id ? { ...kf, durationMs: Math.round(seconds * 1000) } : kf,
      ),
    );

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
      // zero-byte encode) is treated as a cancel rather than saving an unusable
      // file; a non-empty partial tour (stopped midway) is still worth saving.
      if (blob.size === 0) {
        setSaveCancelled(true);
      } else {
        setStatus("saving");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const fileType = t("recordTour.videoFileType");
        const name = await saveBinaryFileWithFallback(bytes, {
          defaultName: "map-tour.webm",
          filters: [{ name: fileType, extensions: ["webm"] }],
          browserTypes: [
            { description: fileType, accept: { "video/webm": [".webm"] } },
          ],
          mimeType: "video/webm",
        });
        if (name) setSavedName(name);
        else setSaveCancelled(true);
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
    } finally {
      abortRef.current = null;
      setStatus("idle");
      setProgress(0);
    }
  };

  const stopRecording = () => abortRef.current?.abort();

  const totalSeconds = estimateTourDurationMs(keyframes) / 1000;
  const canRecord = keyframes.length >= 2 && RECORDING_SUPPORTED && !recording;

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
          // Closing while recording would hide the only Stop/progress control,
          // so block it until the recording finishes.
          disabled={recording}
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

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={recording}
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
                  recording={recording}
                  onPreview={() => previewKeyframe(kf)}
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
              disabled={recording}
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
        {error && <p className="text-sm text-destructive">{error}</p>}

        {recording ? (
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
  recording: boolean;
  onPreview: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onDurationSeconds: (seconds: number) => void;
}

/**
 * One keyframe in the tour list. The segment-duration field keeps local text
 * state so it can be cleared and retyped (a controlled number input would snap
 * an empty value straight to the minimum); the parsed value commits to the
 * store only while in range, and the text normalizes to the committed value on
 * blur.
 */
function KeyframeRow({
  keyframe,
  index,
  isLast,
  recording,
  onPreview,
  onMove,
  onRemove,
  onDurationSeconds,
}: KeyframeRowProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(keyframe.durationMs / 1000));
  const isFirst = index === 0;

  return (
    <li className="flex items-center gap-2 rounded-md border border-input p-2 text-xs">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium tabular-nums">
        {index + 1}
      </span>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground disabled:hover:text-current"
        title={t("recordTour.flyToKeyframe")}
        disabled={recording}
        onClick={onPreview}
      >
        <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate tabular-nums text-muted-foreground">
          {keyframe.center[1].toFixed(4)}, {keyframe.center[0].toFixed(4)} · z
          {keyframe.zoom.toFixed(1)}
        </span>
      </button>
      {isFirst ? (
        <span className="shrink-0 text-muted-foreground">
          {t("recordTour.start")}
        </span>
      ) : (
        <label className="flex shrink-0 items-center gap-1">
          <Input
            type="number"
            inputMode="decimal"
            aria-label={t("recordTour.segmentSeconds")}
            className="h-7 w-14"
            min={MIN_SEGMENT_SECONDS}
            max={MAX_SEGMENT_SECONDS}
            step="0.5"
            disabled={recording}
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
            {t("recordTour.secondsUnit")}
          </span>
        </label>
      )}
      <div className="flex shrink-0 items-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("recordTour.moveUp")}
          disabled={isFirst || recording}
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
          disabled={isLast || recording}
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
          disabled={recording}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}
