/**
 * Pure view-model logic for the Record Tour panel (`RecordTourDialog.tsx`):
 * panel drag/resize geometry, keyframe list edits and save-name cleanup.
 *
 * Kept free of React, the store and the DOM so it can be unit tested without
 * loading the panel and everything it imports (see "Coverage floors" in
 * docs/maintenance.md).
 */
import { DEFAULT_HOLD_SECONDS, DEFAULT_SEGMENT_SECONDS, type TourKeyframe } from "./tour-recorder";

/** Default leaf name for the recorded tour video. */
export const DEFAULT_TOUR_VIDEO_NAME = "map-tour";
/**
 * Default leaf name for the saved tour *configuration* (the editable JSON),
 * distinct from the recorded video's name so the two exports are easy to tell
 * apart in a downloads folder.
 */
export const DEFAULT_TOUR_CONFIG_NAME = "map-tour-setup";

/** Smallest width the panel may be resized to, so its controls never clip away. */
export const MIN_PANEL_WIDTH = 320;
/** Smallest height the panel may be resized to. */
export const MIN_PANEL_HEIGHT = 280;
/**
 * Pixels each arrow-key press grows or shrinks the panel when a resize handle is
 * focused (keyboard equivalent of dragging a corner).
 */
export const RESIZE_KEY_STEP = 16;

/** Which bottom corner a resize handle sits on. */
export type ResizeCorner = "sw" | "se";

/** A panel's on-screen rectangle in CSS pixels. */
export interface PanelRect {
  width: number;
  height: number;
  left: number;
  top: number;
}

/** The viewport size in CSS pixels. */
export interface ViewportSize {
  width: number;
  height: number;
}

/** The pinned position and size a resize resolves to. */
export interface PanelResize {
  pos: { x: number; y: number };
  size: { width: number; height: number };
}

/** A camera view as stored on a keyframe. */
export interface TourCameraView {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * Mints a unique keyframe id, preferring `crypto.randomUUID` when available.
 *
 * @returns A new id string.
 */
export function createKeyframeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `keyframe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Rounds a camera number for compact display in the keyframe list.
 *
 * @param value The number to round.
 * @param digits Decimal places to keep.
 * @returns The rounded number.
 */
export function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/**
 * Clamps a number into a range, returning the fallback when it is not finite.
 *
 * @param value The number to clamp (e.g. parsed from a text field).
 * @param min Lower bound.
 * @param max Upper bound.
 * @param fallback Returned when `value` is NaN or infinite.
 * @returns The clamped value or the fallback.
 */
export function clampOr(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Rounds a live map camera for storage on a keyframe: six decimals for the
 * center, three for zoom and one for pitch and bearing.
 *
 * @param view The camera as read from the map.
 * @returns The rounded camera.
 */
export function roundCameraView(view: TourCameraView): TourCameraView {
  return {
    center: [roundTo(view.center[0], 6), roundTo(view.center[1], 6)],
    zoom: roundTo(view.zoom, 3),
    pitch: roundTo(view.pitch, 1),
    bearing: roundTo(view.bearing, 1),
  };
}

/**
 * Builds a new keyframe for a captured view with the default hold and transition.
 *
 * A new keyframe lands as the last stop, so its own transition is unused for
 * now. Seeding it with the default means that once another keyframe is added
 * after it, the field activates already filled with the preset transition.
 *
 * @param view The (rounded) camera view.
 * @param id The keyframe id.
 * @returns The keyframe.
 */
export function newKeyframe(view: TourCameraView, id: string): TourKeyframe {
  return {
    id,
    ...view,
    holdMs: DEFAULT_HOLD_SECONDS * 1000,
    transitionMs: DEFAULT_SEGMENT_SECONDS * 1000,
  };
}

/**
 * Swaps the keyframe at `index` with the one `delta` places away.
 *
 * @param keyframes The current list.
 * @param index Index of the keyframe to move.
 * @param delta Offset to move it by (e.g. -1 for up, 1 for down).
 * @returns A new reordered list, or null when the target is out of range (a
 *   no-op the caller must not treat as an edit).
 */
export function moveKeyframe(
  keyframes: readonly TourKeyframe[],
  index: number,
  delta: number,
): TourKeyframe[] | null {
  const target = index + delta;
  if (index < 0 || index >= keyframes.length) return null;
  if (target < 0 || target >= keyframes.length) return null;
  const next = [...keyframes];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Converts a seconds value from a duration field to whole milliseconds.
 *
 * @param seconds Duration in seconds.
 * @returns Duration in milliseconds, rounded.
 */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Clamps a drag so the panel stays fully inside the viewport.
 *
 * @param client Pointer position in client coordinates.
 * @param offset Where inside the panel the drag was grabbed.
 * @param panel The panel's current size.
 * @param viewport The viewport size.
 * @returns The new top-left corner of the panel.
 */
export function clampDragPosition(
  client: { x: number; y: number },
  offset: { x: number; y: number },
  panel: { width: number; height: number },
  viewport: ViewportSize,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(client.x - offset.x, viewport.width - panel.width)),
    y: Math.max(0, Math.min(client.y - offset.y, viewport.height - panel.height)),
  };
}

/**
 * Applies a resize relative to a base rect, clamped to the viewport and the
 * minimum size. `dx`/`dy` are how far the dragged edge moves: the bottom edge
 * always moves by `dy`; for the "se" corner the right edge moves by `dx` (left
 * edge fixed), and for "sw" the left edge moves by `dx` while the right edge
 * stays put. Shared by pointer drag and keyboard resizing.
 *
 * @param corner The corner being dragged.
 * @param base The panel rect when the resize started.
 * @param dx Horizontal movement of the dragged edge.
 * @param dy Vertical movement of the bottom edge.
 * @param viewport The viewport size.
 * @returns The position and size to pin.
 */
export function computePanelResize(
  corner: ResizeCorner,
  base: PanelRect,
  dx: number,
  dy: number,
  viewport: ViewportSize,
): PanelResize {
  // Height grows downward from a fixed top for both corners.
  const maxHeight = viewport.height - base.top;
  const height = Math.max(MIN_PANEL_HEIGHT, Math.min(base.height + dy, maxHeight));
  if (corner === "se") {
    // Left edge fixed; the right edge follows, capped at the viewport edge.
    const maxWidth = viewport.width - base.left;
    const width = Math.max(MIN_PANEL_WIDTH, Math.min(base.width + dx, maxWidth));
    return { pos: { x: base.left, y: base.top }, size: { width, height } };
  }
  // Right edge fixed; the left edge follows. The width is capped at the panel's
  // right-edge x-coordinate (left + width) rather than the window width, since
  // that is what keeps the left edge from crossing x = 0 when `pos.x` is set to
  // `right - width`.
  const maxWidthBeforeEdge = base.left + base.width;
  const width = Math.max(MIN_PANEL_WIDTH, Math.min(base.width - dx, maxWidthBeforeEdge));
  return { pos: { x: maxWidthBeforeEdge - width, y: base.top }, size: { width, height } };
}

/**
 * Maps an arrow key on a resize handle to the edge movement it stands for.
 * Left/Right grow the side the handle is on; Up/Down adjust the bottom edge.
 * The corner argument keeps the handle-callback contract uniform; edge motion
 * is the same for both corners, and computePanelResize determines the width.
 *
 * @param _corner The corner the focused handle sits on.
 * @param key The `KeyboardEvent.key` value.
 * @returns The `dx`/`dy` to resize by, or null for keys that do not resize.
 */
export function resizeKeyDelta(
  _corner: ResizeCorner,
  key: string,
): { dx: number; dy: number } | null {
  switch (key) {
    case "ArrowDown":
      return { dx: 0, dy: RESIZE_KEY_STEP };
    case "ArrowUp":
      return { dx: 0, dy: -RESIZE_KEY_STEP };
    case "ArrowLeft":
      // For the left handle, pressing Left extends the panel leftward.
      return { dx: -RESIZE_KEY_STEP, dy: 0 };
    case "ArrowRight":
      return { dx: RESIZE_KEY_STEP, dy: 0 };
    default:
      return null;
  }
}

/**
 * The file name to save the recorded video under: the user's text, trimmed,
 * without a trailing `.webm` (re-appended here), or the default when blank.
 *
 * @param fileName The text in the file-name field.
 * @returns The `.webm` file name.
 */
export function tourVideoFileName(fileName: string): string {
  const base = fileName.trim().replace(/\.webm$/i, "") || DEFAULT_TOUR_VIDEO_NAME;
  return `${base}.webm`;
}

/**
 * Normalizes a typed tour-setup name to a safe `.json` file name.
 *
 * Trims, replaces characters that are illegal in common filesystems (path
 * separators, the null byte, etc.) so a pasted name cannot smuggle in a path,
 * drops trailing dots so "tour.json." does not keep its ".json", strips the
 * extension, and cleans up remaining trailing dots. This avoids a doubled
 * "tour.json.json" for inputs like "tour.json " or "tour.json.".
 *
 * @param chosen The name the user typed.
 * @returns The `.json` file name, falling back to the default base when empty.
 */
export function tourConfigFileName(chosen: string): string {
  const base = chosen
    .trim()
    .replace(/[/\\:*?"<>|\x00]/g, "_")
    .replace(/\.+$/, "")
    .replace(/\.json$/i, "")
    .replace(/\.+$/, "")
    .trim();
  return `${base || DEFAULT_TOUR_CONFIG_NAME}.json`;
}
