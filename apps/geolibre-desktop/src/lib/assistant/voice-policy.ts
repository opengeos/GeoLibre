/**
 * Pure input policy for the assistant's voice command mode.
 *
 * Ported from the voice control in `gods-eye-view` (`src/voice/
 * realtimeInputPolicy.js`), whose behavioral contract this mode adopts: a
 * 500 ms Space hold claims push-to-talk, while short control taps and text
 * entry stay native. Everything here is a pure function over the parts of a
 * DOM event it actually reads, so the arbitration can be tested without a
 * browser — the rules are subtle and a regression is silent (a swallowed
 * Space, or a hot microphone nobody asked for).
 */

/** How long Space must be held before voice claims it, in milliseconds. */
export const PUSH_TO_TALK_HOLD_DELAY_MS = 500;

/**
 * Noise floor for the microphone meter (0–1). Deliberately generous:
 * microphones carry room tone even after the browser's noise suppression, and
 * an idle meter that twitches reads as "it is hearing me" when it is not.
 */
export const MICROPHONE_VISUALIZER_GATE = 0.12;

/** The parts of a keyboard event the push-to-talk rules read. */
export interface VoiceKey {
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/** Whether a key press is the push-to-talk key (Space). */
export function isPushToTalkKey(event: VoiceKey | null | undefined): boolean {
  return event?.code === "Space" || event?.key === " ";
}

/**
 * Selectors for elements that own Space for their own activation. Space
 * pressed on any of these is the user pressing *that control*, not talking.
 */
export const SPACE_INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "a[href]",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(", ");

/** The DOM surface the rules probe, narrowed to the methods they call. */
type Probe = {
  tagName?: string;
  id?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
} | null;

/**
 * Whether Space began on a map surface, which is reserved for push-to-talk.
 *
 * Both engines give their canvas a tabindex so it can take keyboard camera
 * input, which would otherwise make the generic focus guard below read a click
 * on the map as a button activation.
 */
export function isPushToTalkSurface(target: EventTarget | null | undefined): boolean {
  const probe = target as Probe;
  if (probe?.tagName?.toUpperCase?.() !== "CANVAS") return false;
  return Boolean(probe?.closest?.(".maplibregl-canvas-container, .maplibregl-map, .cesium-viewer"));
}

/** Whether a focused target owns Space for UI interaction. */
export function isInteractiveSpaceTarget(target: EventTarget | null | undefined): boolean {
  const probe = target as Probe;
  if (!probe) return false;
  if (isPushToTalkSurface(target)) return false;
  if (probe.isContentEditable) return true;
  return Boolean(probe.closest?.(SPACE_INTERACTIVE_SELECTOR));
}

/** Text input types where Space types a space character. */
const TEXT_INPUT_TYPES = [
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
];

/** Whether Space belongs to a text-entry surface. */
export function isEditingSpaceTarget(target: EventTarget | null | undefined): boolean {
  const probe = target as Probe;
  if (!probe) return false;
  if (probe.isContentEditable || probe.closest?.("[contenteditable]")) return true;
  if (probe.closest?.('textarea, [role="textbox"], [role="searchbox"], [role="spinbutton"]')) {
    return true;
  }
  const input = probe.closest?.("input") as { type?: string } | null;
  if (!input) return false;
  return TEXT_INPUT_TYPES.includes(String(input.type || "text").toLowerCase());
}

/**
 * Whether a keydown may be arbitrated for push-to-talk at all.
 *
 * Text entry and modified shortcuts are never candidates: typing a space in the
 * composer must stay a space, and Ctrl/Cmd/Alt/Shift+Space belong to whatever
 * bound them.
 */
export function shouldHandlePushToTalkKeyDown(event: VoiceKey | null | undefined): boolean {
  if (!isPushToTalkKey(event) || event?.defaultPrevented) return false;
  if (event?.altKey || event?.ctrlKey || event?.metaKey || event?.shiftKey) return false;
  return !isEditingSpaceTarget(event?.target);
}

/**
 * Whether a click on the mic button should be ignored because Space is down.
 * Space activates a focused button natively, so without this the same physical
 * gesture would both claim push-to-talk and toggle the session off under it.
 */
export function shouldIgnoreVoiceButtonClick(spaceKeyHeld: boolean): boolean {
  return Boolean(spaceKeyHeld);
}

/**
 * Removes low-level room noise before it can animate the meter.
 *
 * @param level - Normalized frequency energy (0–1).
 * @param threshold - Noise-floor cutoff (0–1).
 * @returns The re-normalized audible level (0–1).
 */
export function gateVoiceVisualizerLevel(level: number, threshold: number): number {
  const cleanLevel = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const cleanThreshold = Number.isFinite(threshold) ? Math.min(0.95, Math.max(0, threshold)) : 0;
  if (cleanLevel <= cleanThreshold) return 0;
  return (cleanLevel - cleanThreshold) / (1 - cleanThreshold);
}

/**
 * Per-bar height fraction (0–1) for the meter, from one band's average energy.
 *
 * The 0.72 exponent lifts quiet speech into view without letting the loudest
 * syllable peg every bar, so the meter reads as speech rather than as a gate.
 *
 * @param energy - Summed byte energy across the band's frequency bins.
 * @param bins - How many bins the band covers.
 */
export function visualizerBarLevel(energy: number, bins: number): number {
  if (!Number.isFinite(energy) || !Number.isFinite(bins) || bins <= 0) return 0;
  const normalized = Math.min(1, energy / bins / 190);
  return Math.pow(gateVoiceVisualizerLevel(normalized, MICROPHONE_VISUALIZER_GATE), 0.72);
}
