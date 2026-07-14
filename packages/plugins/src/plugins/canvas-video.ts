/**
 * Shared canvas→video recording helpers.
 *
 * The Route Animation plugin (`maplibre-route-animation.ts`) and the app's map
 * recorder (`apps/geolibre-desktop/src/lib/map-recorder.ts`) each grew their
 * own copy of these MIME/extension utilities; this module is the shared home
 * for new recorders (currently the Timelapse plugin). Folding the older two
 * onto it is a separate cleanup.
 */

/**
 * Recording container/codecs tried in order; the first the browser's
 * MediaRecorder supports is used. MP4/H.264 is preferred, with WebM as a
 * fallback for browsers (notably Firefox) whose MediaRecorder cannot encode
 * MP4, so the saved file is always a playable video.
 */
export const CANVAS_VIDEO_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Target video bitrate (bits per second). MediaRecorder's implicit default is
 * conservative (~2.5 Mbps), which visibly blurs detailed map imagery; ~12 Mbps
 * keeps exports crisp at typical canvas sizes. Browsers clamp this to their
 * supported range, so an over-ambitious value is capped rather than rejected.
 */
export const CANVAS_VIDEO_BITS_PER_SECOND = 12_000_000;

/** How long to wait for the encoder's final `onstop` before giving up (ms). */
export const CANVAS_VIDEO_STOP_TIMEOUT_MS = 10_000;

/** File extension matching a recording MIME type (`mp4` for MP4, else `webm`). */
export function canvasVideoExtensionForMime(mimeType: string): "mp4" | "webm" {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

/**
 * Pick the first supported recording MIME type from a candidate list. Returns
 * `null` when none are supported. Kept pure (the support check is injected) so
 * it can be unit tested without a DOM.
 */
export function pickCanvasVideoMimeType(
  candidates: readonly string[],
  isSupported: (type: string) => boolean,
): string | null {
  for (const type of candidates) {
    if (isSupported(type)) return type;
  }
  return null;
}

/** The recording MIME type this browser will use, or `null` when unsupported. */
export function pickSupportedCanvasVideoMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return pickCanvasVideoMimeType(CANVAS_VIDEO_MIME_CANDIDATES, (type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/** True when the current browser can record a canvas to a video file. */
export function isCanvasVideoSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickSupportedCanvasVideoMimeType() !== null
  );
}
