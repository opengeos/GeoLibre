import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Records an animated camera "tour" across a sequence of keyframes to a video
 * file by capturing the live MapLibre canvas.
 *
 * The map canvas is created with `preserveDrawingBuffer: true` (see
 * `packages/map/src/map-controller.ts`), so `canvas.captureStream()` works
 * without any constructor change. Recording flies the camera from each keyframe
 * to the next with `map.flyTo` while a `MediaRecorder` samples the canvas; the
 * result is a WebM blob the caller saves to disk.
 */

/** A single camera stop in a tour. */
export interface TourKeyframe {
  /** Stable id for list keys and reordering. */
  id: string;
  /** Map center as `[lng, lat]`. */
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  /**
   * Milliseconds to animate FROM the previous keyframe TO this one. Ignored for
   * the first keyframe (the tour starts parked there).
   */
  durationMs: number;
}

/** A short still hold at the start of the tour so the opening frame is steady. */
export const START_HOLD_MS = 400;
/** A short still hold at the end so the closing frame is not cut off abruptly. */
export const END_HOLD_MS = 600;
/** How long to wait for the encoder's final `onstop` before giving up. */
export const STOP_TIMEOUT_MS = 10_000;

/** WebM codecs tried in order; the first the browser supports is used. */
export const TOUR_MIME_CANDIDATES = [
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

/**
 * Total wall-clock duration of a tour in milliseconds: the start/end holds plus
 * the segment duration leading into every keyframe after the first.
 */
export function estimateTourDurationMs(
  keyframes: readonly Pick<TourKeyframe, "durationMs">[],
): number {
  if (keyframes.length < 2) return 0;
  const segments = keyframes
    .slice(1)
    .reduce((sum, kf) => sum + Math.max(0, kf.durationMs), 0);
  return START_HOLD_MS + segments + END_HOLD_MS;
}

/** Raised when the browser cannot record the canvas (no MediaRecorder / codec). */
export class TourRecordingUnsupportedError extends Error {
  constructor(message = "Canvas recording is not supported in this browser.") {
    super(message);
    this.name = "TourRecordingUnsupportedError";
  }
}

/** True when the current browser can record a canvas to WebM. */
export function isTourRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickSupportedMimeType(TOUR_MIME_CANDIDATES, (t) =>
      MediaRecorder.isTypeSupported(t),
    ) !== null
  );
}

export interface RecordTourOptions {
  map: MapLibreMap;
  keyframes: TourKeyframe[];
  /** Frames per second sampled from the canvas. */
  fps: number;
  /** Aborts the tour early; the partial recording up to that point is kept. */
  signal?: AbortSignal;
  /** Reports progress in `[0, 1]` as each segment completes. */
  onProgress?: (fraction: number) => void;
}

/** Resolve after `ms`, but immediately if the signal is already aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Fly to one keyframe and resolve when the camera settles. Resolves on the
 * map's `moveend`, with a timeout fallback in case it does not fire, and early
 * if the tour is aborted (the abort handler calls `map.stop()`).
 */
function flyToKeyframe(
  map: MapLibreMap,
  kf: TourKeyframe,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    // Already aborted on entry (a stop between the loop's check and here): the
    // map.stop() moveend has already fired, so resolve now rather than waiting
    // out the timeout fallback.
    if (signal?.aborted) {
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off("moveend", finish);
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    // moveend can fail to fire if the move is interrupted; the timeout
    // guarantees the segment always completes. The buffer scales with the
    // duration so a throttled tab whose move settles slightly late doesn't trip
    // the fallback before moveend fires (which would blend two animations).
    const duration = Math.max(0, kf.durationMs);
    const timer = setTimeout(finish, duration + Math.max(500, duration * 0.25));
    map.once("moveend", finish);
    signal?.addEventListener("abort", finish, { once: true });
    map.flyTo({
      center: kf.center,
      zoom: kf.zoom,
      pitch: kf.pitch,
      bearing: kf.bearing,
      duration: Math.max(0, kf.durationMs),
      // Run the animation even when the OS requests reduced motion, otherwise
      // flyTo would jump instantly and the recording would be a slideshow.
      essential: true,
    });
  });
}

/** MapLibre interaction handlers disabled for the duration of a recording. */
const INTERACTION_HANDLERS = [
  "dragPan",
  "scrollZoom",
  "boxZoom",
  "dragRotate",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
] as const;

/**
 * Disable user map interaction while recording so a stray scroll or drag cannot
 * interrupt the flyTo animation. Returns a function that restores each handler
 * to the enabled state it had before.
 */
function freezeMapInteractions(map: MapLibreMap): () => void {
  const handlers = INTERACTION_HANDLERS.map((key) => map[key]);
  const wasEnabled = handlers.map((handler) => handler.isEnabled());
  for (const handler of handlers) handler.disable();
  return () => {
    handlers.forEach((handler, i) => {
      if (wasEnabled[i]) handler.enable();
    });
  };
}

/**
 * Record an animated camera tour and resolve with a WebM blob.
 *
 * Throws {@link TourRecordingUnsupportedError} when the browser cannot record
 * the canvas, or a plain `Error` when fewer than two keyframes are supplied.
 */
export async function recordTour({
  map,
  keyframes,
  fps,
  signal,
  onProgress,
}: RecordTourOptions): Promise<Blob> {
  if (keyframes.length < 2) {
    throw new Error("A tour needs at least two keyframes.");
  }
  const mimeType = pickSupportedMimeType(TOUR_MIME_CANDIDATES, (t) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  );
  // mimeType is null when MediaRecorder is undefined (the callback returns false
  // for every candidate), so this also covers the no-MediaRecorder case.
  if (!mimeType) {
    throw new TourRecordingUnsupportedError();
  }

  const canvas = map.getCanvas();
  if (typeof canvas.captureStream !== "function") {
    throw new TourRecordingUnsupportedError();
  }

  const stream = canvas.captureStream(fps);
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch {
    // The constructor can still reject a codec that isTypeSupported accepted;
    // stop the capture so it isn't leaked when we never reach the finally below,
    // and report it as unsupported so the dialog shows the right message.
    for (const track of stream.getTracks()) track.stop();
    throw new TourRecordingUnsupportedError();
  }

  // Aborting interrupts the in-flight camera move so the tour stops promptly
  // instead of finishing the current segment. Registered only after the
  // recorder is constructed, so a setup failure above does not leave a stale
  // map.stop() listener attached to the signal.
  const stopOnAbort = () => map.stop();
  signal?.addEventListener("abort", stopOnAbort, { once: true });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  // Set when the recorder errors mid-tour so the animation loop breaks early
  // instead of flying through the rest of the keyframes after the recording has
  // already failed.
  let recorderFailed = false;
  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => {
      // Surface the browser's own diagnosis (e.g. SecurityError) rather than a
      // generic message, so a field failure is debuggable.
      const cause = (event as Event & { error?: DOMException }).error;
      recorderFailed = true;
      map.stop(); // halt the in-flight move so the loop stops promptly
      reject(
        new Error(`Recording failed: ${cause?.message ?? "unknown error"}`, {
          cause,
        }),
      );
    };
  });

  // Pump repaints for the whole recording so the captured stream keeps getting
  // fresh frames even during the still holds (a paused canvas emits nothing).
  // The same loop drives progress from elapsed wall-clock against the planned
  // tour length, so it advances smoothly (including the lone segment of a
  // two-keyframe tour) rather than jumping at segment boundaries. Progress is
  // throttled to whole-percent changes to avoid a re-render every frame.
  const totalMs = estimateTourDurationMs(keyframes);
  let startedAt = 0;
  let lastPercent = -1;
  let rafId = 0;
  const pump = () => {
    map.triggerRepaint();
    if (startedAt && totalMs > 0) {
      const percent = Math.min(
        100,
        Math.round(((performance.now() - startedAt) / totalMs) * 100),
      );
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress?.(percent / 100);
      }
    }
    rafId = requestAnimationFrame(pump);
  };

  // Freeze user interaction so a stray scroll or drag can't interrupt the flyTo
  // (which would fire an early moveend and start the next segment from the wrong
  // camera). Restored in the finally below.
  let restoreInteractions = () => {};
  try {
    restoreInteractions = freezeMapInteractions(map);
    // Park on the first keyframe before the recorder starts so the opening
    // frame is the intended view, not wherever the user left the map.
    const first = keyframes[0];
    map.jumpTo({
      center: first.center,
      zoom: first.zoom,
      pitch: first.pitch,
      bearing: first.bearing,
    });

    // Flush encoded chunks every second so memory stays flat over long tours
    // instead of buffering the whole video until stop(). Start the recorder
    // before the progress pump so the elapsed clock tracks actual capture.
    recorder.start(1000);
    startedAt = performance.now();
    rafId = requestAnimationFrame(pump);
    await delay(START_HOLD_MS, signal);

    for (let i = 1; i < keyframes.length; i++) {
      if (signal?.aborted || recorderFailed) break;
      await flyToKeyframe(map, keyframes[i], signal);
    }

    if (!signal?.aborted && !recorderFailed) {
      await delay(END_HOLD_MS, signal);
      onProgress?.(1);
    }
  } finally {
    restoreInteractions();
    cancelAnimationFrame(rafId);
    if (recorder.state !== "inactive") recorder.stop();
    signal?.removeEventListener("abort", stopOnAbort);
    // recorder.stop() finalizes the file but does not stop the canvas capture,
    // so end the stream's tracks to release it.
    for (const track of stream.getTracks()) track.stop();
  }

  // Guard against a browser that never fires onstop (a page-unload race, a
  // torn-down stream) leaving this await hung and the dialog stuck "saving".
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Recording timed out waiting for the encoder.")),
      STOP_TIMEOUT_MS,
    );
    void finished.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  return await Promise.race([finished, timeout]);
}
