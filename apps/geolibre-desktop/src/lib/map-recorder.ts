import type { Map as MapLibreMap } from "maplibre-gl";
import { isFullViewportMapCanvas } from "./print-capture";

/**
 * Records the live map to a video file by capturing the MapLibre canvas.
 *
 * Two modes share one engine:
 *
 * - **Whole map** — the entire viewport is recorded. The user keeps panning and
 *   zooming while recording; every interaction is captured.
 * - **Selected area** — only a fixed rectangle of the viewport is recorded. The
 *   frame stays put on screen while the map moves underneath it (a *screen*
 *   region, not a geographic one), so the user can pan/zoom the world through a
 *   fixed window.
 *
 * The map canvas is created with `preserveDrawingBuffer: true` (see
 * `packages/map/src/map-controller.ts`), so it can be read with `drawImage`
 * outside a render callback. Every frame the base canvas — plus any full-viewport
 * deck.gl overlay, matching {@link captureMapImage} — is composited (and cropped,
 * for a selected area) into an offscreen canvas, and `MediaRecorder` samples that
 * offscreen canvas via `captureStream`. Compositing into an intermediate canvas
 * is what makes the crop and the overlay possible: `captureStream` on the raw
 * WebGL canvas can neither crop nor pick up the deck.gl layer.
 */

/**
 * A screen-space capture rectangle in CSS pixels, measured from the map canvas's
 * top-left corner. It is fixed for the duration of a recording — the map moves
 * under it, the rectangle does not.
 */
export interface RecordRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default frames per second sampled from the canvas. */
export const DEFAULT_FPS = 30;
/** Lowest selectable frame rate. */
export const MIN_FPS = 10;
/** Highest selectable frame rate. */
export const MAX_FPS = 60;
/**
 * Target video bitrate (bits per second). MediaRecorder's implicit default is
 * conservative (~2.5 Mbps), which visibly blurs detailed map imagery and text;
 * ~12 Mbps keeps the recording crisp while staying a reasonable file size.
 * Browsers clamp this to their supported range, so an over-ambitious value is
 * capped rather than rejected. Matches the tour and route-animation recorders.
 */
const DEFAULT_VIDEO_BITS_PER_SECOND = 12_000_000;
/** How long to wait for the encoder's final `onstop` before giving up. */
export const STOP_TIMEOUT_MS = 10_000;
/** Smallest usable selected area, in CSS pixels, on either axis. */
export const MIN_REGION_SIZE = 16;

/**
 * Recording MIME types tried in order. MP4/H.264 is preferred (Chrome, Edge,
 * Safari) so the saved file plays everywhere; WebM/VP9/VP8 is the fallback for
 * browsers whose `MediaRecorder` cannot encode MP4 (notably Firefox). Mirrors
 * the route-animation recorder's list.
 */
export const MAP_RECORD_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Pick the first supported recording MIME type from a candidate list. Returns
 * `null` when none are supported. Kept pure (the support check is injected) so
 * it can be unit tested without a DOM.
 */
export function pickSupportedMimeType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return null;
}

/** File extension matching a recording MIME type (`mp4` for MP4, else `webm`). */
export function videoExtensionForMime(mimeType: string): "mp4" | "webm" {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

/** True when the current browser can record a canvas to a supported format. */
export function isMapRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickSupportedMimeType(MAP_RECORD_MIME_CANDIDATES, (t) =>
      MediaRecorder.isTypeSupported(t),
    ) !== null
  );
}

/** Raised when the browser cannot record the canvas (no MediaRecorder / codec). */
export class MapRecordingUnsupportedError extends Error {
  constructor(message = "Canvas recording is not supported in this browser.") {
    super(message);
    this.name = "MapRecordingUnsupportedError";
  }
}

/** The source rectangle to read from the canvas and the output frame size. */
export interface CaptureRect {
  /** Source rectangle in device pixels, read from the base canvas. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Output frame size in device pixels (source size forced to be even). */
  outW: number;
  outH: number;
}

/** Round down to the nearest even integer &ge; 2 (H.264 needs even dimensions). */
function toEven(value: number): number {
  const floored = Math.floor(value);
  return Math.max(2, floored - (floored % 2));
}

/**
 * Convert a CSS-pixel screen {@link RecordRegion} (or the whole canvas when
 * `region` is null) into a device-pixel source rectangle plus an even-sized
 * output frame. The region is clamped to the canvas so a selection that runs off
 * an edge (or a canvas that shrank mid-recording) still yields a valid rect.
 *
 * Kept pure so the device-pixel math and even-dimension rule can be unit tested
 * without a real canvas.
 *
 * @param region - Screen rectangle in CSS pixels, or null for the full canvas.
 * @param baseWidth - Canvas drawing-buffer width in device pixels.
 * @param baseHeight - Canvas drawing-buffer height in device pixels.
 * @param cssWidth - Canvas layout width in CSS pixels (for the device scale).
 * @returns The clamped source rectangle and even output size, or null when the
 *   result would be degenerate (e.g. a zero-area canvas or region).
 */
export function computeCaptureRect(
  region: RecordRegion | null,
  baseWidth: number,
  baseHeight: number,
  cssWidth: number,
): CaptureRect | null {
  if (baseWidth < 2 || baseHeight < 2) return null;
  if (!region) {
    return {
      sx: 0,
      sy: 0,
      sw: baseWidth,
      sh: baseHeight,
      outW: toEven(baseWidth),
      outH: toEven(baseHeight),
    };
  }
  // Device pixels per CSS pixel. clientWidth can be 0 during teardown; fall back
  // to 1:1 so the region is at least read at CSS resolution rather than dropped.
  const scale = cssWidth > 0 ? baseWidth / cssWidth : 1;
  const rawX = region.x * scale;
  const rawY = region.y * scale;
  // Clamp the rectangle's edges into the canvas, then derive width/height from
  // the clamped edges so an off-canvas selection contributes only its visible
  // part instead of reading past the buffer (which draws transparent pixels).
  const left = Math.min(Math.max(rawX, 0), baseWidth);
  const top = Math.min(Math.max(rawY, 0), baseHeight);
  const right = Math.min(Math.max(rawX + region.width * scale, 0), baseWidth);
  const bottom = Math.min(
    Math.max(rawY + region.height * scale, 0),
    baseHeight,
  );
  const sw = right - left;
  const sh = bottom - top;
  if (sw < 2 || sh < 2) return null;
  return {
    sx: left,
    sy: top,
    sw,
    sh,
    outW: toEven(sw),
    outH: toEven(sh),
  };
}

export interface RecordMapOptions {
  map: MapLibreMap;
  /** Screen rectangle to capture, or null/omitted for the whole viewport. */
  region?: RecordRegion | null;
  /** Frames per second sampled from the canvas. */
  fps: number;
  /**
   * Stops the recording; the take up to that point is kept. Required — a healthy
   * recording only ends when this aborts, so without it the returned promise
   * would never settle and the RAF loop / MediaRecorder would run forever.
   */
  signal: AbortSignal;
  /** Reports elapsed seconds while recording, for a live timer. */
  onElapsed?: (seconds: number) => void;
}

/** A finished recording: the encoded blob plus its container type/extension. */
export interface MapRecording {
  blob: Blob;
  mimeType: string;
  extension: "mp4" | "webm";
}

/**
 * Record the live map (whole viewport or a fixed screen rectangle) and resolve
 * with the encoded video.
 *
 * The map stays fully interactive throughout — panning and zooming are captured.
 * Recording ends when the caller aborts `signal`; the take up to that point is
 * returned.
 *
 * Throws {@link MapRecordingUnsupportedError} when the browser cannot record the
 * canvas, or a plain `Error` when the map canvas is unreadable / the region is
 * degenerate.
 */
export async function recordMapCanvas({
  map,
  region,
  fps,
  signal,
  onElapsed,
}: RecordMapOptions): Promise<MapRecording> {
  const mimeType = pickSupportedMimeType(
    MAP_RECORD_MIME_CANDIDATES,
    (t) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  );
  // mimeType is null when MediaRecorder is undefined (the callback returns false
  // for every candidate), so this also covers the no-MediaRecorder case.
  if (!mimeType) throw new MapRecordingUnsupportedError();
  const extension = videoExtensionForMime(mimeType);

  const base = map.getCanvas();
  const cssWidth = base.clientWidth || base.width;
  const rect = computeCaptureRect(
    region ?? null,
    base.width,
    base.height,
    cssWidth,
  );
  if (!rect) {
    throw new Error("The recording area is empty or the map is not ready.");
  }

  // Fixed-size offscreen canvas: MediaRecorder does not tolerate a mid-stream
  // resize, so the output dimensions are locked here from the initial rect even
  // if the map is later resized (the per-frame source rect is re-clamped below).
  const out = document.createElement("canvas");
  out.width = rect.outW;
  out.height = rect.outH;
  const ctx = out.getContext("2d");
  if (!ctx || typeof out.captureStream !== "function") {
    throw new MapRecordingUnsupportedError();
  }

  const stream = out.captureStream(fps);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
    });
  } catch {
    // The constructor can still reject a codec that isTypeSupported accepted;
    // stop the capture so it isn't leaked, and report it as unsupported.
    for (const track of stream.getTracks()) track.stop();
    throw new MapRecordingUnsupportedError();
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  let recorderFailed = false;
  // Captured so the compositor loop can fail the recording if the *base* map
  // canvas becomes unreadable mid-capture (see drawFrame).
  let failRecording: (error: Error) => void = () => {};
  const finished = new Promise<Blob>((resolve, reject) => {
    failRecording = reject;
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => {
      const cause = (event as Event & { error?: DOMException }).error;
      recorderFailed = true;
      reject(
        new Error(`Recording failed: ${cause?.message ?? "unknown error"}`, {
          cause,
        }),
      );
    };
  });

  // The compositor pulls a fresh crop from the live canvas every animation
  // frame. The map repaints itself on interaction and tile loads, so we do not
  // force a repaint here; drawImage simply copies whatever is currently in the
  // preserved buffer. The source rect is re-derived each frame so a mid-recording
  // resize (free interaction allows it) keeps the crop clamped to the canvas.
  let startedAt = 0;
  let lastSeconds = -1;
  let rafId = 0;
  const drawFrame = () => {
    const liveCssWidth = base.clientWidth || base.width;
    const frameRect = computeCaptureRect(
      region ?? null,
      base.width,
      base.height,
      liveCssWidth,
    );
    if (frameRect) {
      ctx.clearRect(0, 0, out.width, out.height);
      // Composite the base canvas plus any full-viewport deck.gl overlay, in DOM
      // order, so raster/point-cloud/3D layers are recorded too — matching what
      // captureMapImage does for a still snapshot. Skip the decorative effects
      // canvas (it sits behind the map and would blank it).
      const canvases = map.getContainer().querySelectorAll("canvas");
      canvases.forEach((c) => {
        if (c.classList.contains("geolibre-effects-canvas")) return;
        if (!isFullViewportMapCanvas(c, base)) return;
        try {
          ctx.drawImage(
            c,
            frameRect.sx,
            frameRect.sy,
            frameRect.sw,
            frameRect.sh,
            0,
            0,
            out.width,
            out.height,
          );
        } catch (err) {
          // A tainted or zero-size overlay (e.g. cross-origin deck.gl) is only
          // cosmetic; keep the base-map frame rather than aborting the capture.
          // But if the *base* map canvas itself is unreadable (e.g. cross-origin
          // tiles tainted it), fail the recording instead of silently producing
          // a blank/partial video the dialog would report as a success — matching
          // captureMapImage, which rethrows for the base canvas.
          if (c === base && !recorderFailed) {
            recorderFailed = true;
            failRecording(
              new Error("Recording failed: the map canvas is unreadable.", {
                cause: err,
              }),
            );
          }
        }
      });
    }
    // Stop scheduling frames once the recording has failed; the finally below
    // cancels the last pending frame and stops the recorder.
    if (recorderFailed) return;
    if (startedAt) {
      const seconds = Math.floor((performance.now() - startedAt) / 1000);
      if (seconds !== lastSeconds) {
        lastSeconds = seconds;
        onElapsed?.(seconds);
      }
    }
    rafId = requestAnimationFrame(drawFrame);
  };

  const stopRecorder = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  signal.addEventListener("abort", stopRecorder, { once: true });

  try {
    // Flush encoded chunks every second so memory stays flat over long
    // recordings instead of buffering the whole video until stop().
    recorder.start(1000);
    startedAt = performance.now();
    rafId = requestAnimationFrame(drawFrame);
    // Recording runs until the caller aborts (Stop button) or the recorder
    // errors; both settle the promise below.
    await new Promise<void>((resolve) => {
      if (signal.aborted || recorderFailed) return resolve();
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      signal.addEventListener("abort", done, { once: true });
      // The recorder's onerror rejects `finished`; observe it so a mid-recording
      // encoder failure ends the wait instead of hanging until the user stops.
      void finished.catch(done);
    });
  } finally {
    cancelAnimationFrame(rafId);
    stopRecorder();
    signal.removeEventListener("abort", stopRecorder);
    // recorder.stop() finalizes the file but does not stop the canvas capture,
    // so end the stream's tracks to release it.
    for (const track of stream.getTracks()) track.stop();
  }

  // Guard against a browser that never fires onstop (a page-unload race, a
  // torn-down stream) leaving this await hung and the dialog stuck "saving".
  // Rather than discard the whole take, resolve with whatever chunks were
  // already flushed (recorder.start(1000) flushes every second), so a long
  // recording that hangs only on the final flush yields a slightly-truncated
  // video instead of nothing.
  const timeout = new Promise<Blob>((resolve) => {
    const timer = setTimeout(
      () => resolve(new Blob(chunks, { type: mimeType })),
      STOP_TIMEOUT_MS,
    );
    void finished.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  const blob = await Promise.race([finished, timeout]);
  return { blob, mimeType, extension };
}
