// Project-state shape, normalizer and sizing rules for the Image control.
// Pure (no DOM) so they can be unit-tested; the control itself is in ./image.

import type { GeoLibreMapControlPosition } from "../../types";

/**
 * How the image is sized on the map.
 * - `auto`: a fixed width; the height follows the image's own aspect ratio.
 * - `fixed`: an explicit width and height; the image is fitted inside the box.
 * - `ratio`: a width and an aspect ratio (width / height); the image is fitted
 *   inside the resulting box.
 */
export type ImageSizeMode = "auto" | "fixed" | "ratio";

/** Project state of the Image control. */
export interface ComponentImageState {
  /** Absolute http(s) URL of the image; empty until the user sets one. */
  url: string;
  sizeMode: ImageSizeMode;
  /** Width in CSS pixels (all modes). */
  width: number;
  /** Height in CSS pixels (`fixed` mode). */
  height: number;
  /** Width / height (`ratio` mode). */
  ratio: number;
  /** Map corner the image is docked to. */
  position: GeoLibreMapControlPosition;
  /** Whether the image is on the map. */
  visible: boolean;
}

export const IMAGE_SIZE_MIN = 16;
export const IMAGE_SIZE_MAX = 2000;
export const IMAGE_RATIO_MIN = 0.1;
export const IMAGE_RATIO_MAX = 10;

export const DEFAULT_IMAGE_STATE: ComponentImageState = Object.freeze({
  url: "",
  sizeMode: "auto",
  width: 200,
  height: 150,
  ratio: 4 / 3,
  position: "bottom-left",
  visible: true,
});

const POSITIONS = new Set<GeoLibreMapControlPosition>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

const SIZE_MODES = new Set<ImageSizeMode>(["auto", "fixed", "ratio"]);

/**
 * Validates an image URL: trimmed, absolute, http(s) only, so a saved project
 * cannot make the control load a `javascript:`, `data:` or `file:` address.
 *
 * @param input - The URL text.
 * @returns The normalized URL, or an empty string when it is not usable.
 */
export function normalizeImageUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return "";
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Normalizes untrusted (project-file) Image control state, replacing anything
 * invalid with the defaults.
 *
 * @param state - The raw value.
 * @returns The normalized state, or undefined when `state` is not an object.
 */
export function normalizeImageState(state: unknown): ComponentImageState | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Partial<ComponentImageState>;
  const defaults = DEFAULT_IMAGE_STATE;
  return {
    url: normalizeImageUrl(candidate.url),
    sizeMode: SIZE_MODES.has(candidate.sizeMode as ImageSizeMode)
      ? (candidate.sizeMode as ImageSizeMode)
      : defaults.sizeMode,
    width: clampNumber(candidate.width, IMAGE_SIZE_MIN, IMAGE_SIZE_MAX, defaults.width),
    height: clampNumber(candidate.height, IMAGE_SIZE_MIN, IMAGE_SIZE_MAX, defaults.height),
    ratio: clampNumber(candidate.ratio, IMAGE_RATIO_MIN, IMAGE_RATIO_MAX, defaults.ratio),
    position: POSITIONS.has(candidate.position as GeoLibreMapControlPosition)
      ? (candidate.position as GeoLibreMapControlPosition)
      : defaults.position,
    visible: typeof candidate.visible === "boolean" ? candidate.visible : defaults.visible,
  };
}

/**
 * Parses an aspect ratio typed as `16:9`, `16/9`, `16x9` or a decimal such as
 * `1.78`, into width / height.
 *
 * @param text - The text the user typed.
 * @returns The ratio, or null when it is not a positive number in range.
 */
export function parseAspectRatio(text: string): number | null {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*(?:[:/xX]\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = match[2] === undefined ? 1 : Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  const ratio = width / height;
  return ratio >= IMAGE_RATIO_MIN && ratio <= IMAGE_RATIO_MAX ? ratio : null;
}

/** Formats a ratio for the text field: `16:9` for common ratios, else a decimal. */
export function formatAspectRatio(ratio: number): string {
  for (const [w, h] of [
    [1, 1],
    [4, 3],
    [3, 2],
    [16, 9],
    [21, 9],
    [3, 4],
    [2, 3],
    [9, 16],
    [2, 1],
    [1, 2],
  ] as const) {
    if (Math.abs(ratio - w / h) < 0.005) return `${w}:${h}`;
  }
  return String(Math.round(ratio * 100) / 100);
}

/** Inline CSS (as a property map) that sizes the `<img>` for a state. */
export interface ImageLayout {
  width: string;
  height: string;
  objectFit: "contain";
}

/**
 * The size the image is drawn at for a state.
 *
 * @param state - The control state.
 * @returns CSS width/height strings; `height: auto` keeps the image's own ratio.
 */
export function imageLayout(
  state: Pick<ComponentImageState, "sizeMode" | "width" | "height" | "ratio">,
): ImageLayout {
  const width = `${Math.round(state.width)}px`;
  if (state.sizeMode === "fixed") {
    return { width, height: `${Math.round(state.height)}px`, objectFit: "contain" };
  }
  if (state.sizeMode === "ratio") {
    return { width, height: `${Math.round(state.width / state.ratio)}px`, objectFit: "contain" };
  }
  return { width, height: "auto", objectFit: "contain" };
}
