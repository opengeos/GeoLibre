/**
 * Hand-off channel for opening the AI assistant with a drafted prompt (the
 * SQL Workspace's "Fix" and "Explain" buttons). The mirror image of
 * `sql-workspace-prefill.ts`, and built the same way for the same reason: the
 * assistant panel is lazy-mounted only while open, so the prompt is parked here
 * and either consumed by the panel's mount effect (panel was closed) or applied
 * in response to the event (panel already open). Kept out of the Zustand store
 * because the value is transient UI hand-off state, not app state worth
 * persisting or observing.
 *
 * The prompt lands in the composer as a draft. Nothing is sent until the user
 * presses Send: a run spends their provider credits and may call tools, so it
 * stays their decision.
 */

/** Window event fired when a drafted prompt is requested. */
export const ASSISTANT_PROMPT_EVENT = "geolibre:assistant-prompt";

let pendingPrompt: string | null = null;

/**
 * Park a prompt for the assistant's composer and notify a mounted panel. The
 * caller should open the assistant (setAssistantOpen) after calling this so a
 * closed panel consumes the prompt on mount.
 *
 * @param prompt The text to place in the composer.
 */
export function requestAssistantPrompt(prompt: string): void {
  pendingPrompt = prompt;
  window.dispatchEvent(new Event(ASSISTANT_PROMPT_EVENT));
}

/**
 * Take the parked prompt, clearing it so it is applied exactly once.
 *
 * @returns The pending prompt, or null when none is parked.
 */
export function consumePendingAssistantPrompt(): string | null {
  const value = pendingPrompt;
  pendingPrompt = null;
  return value;
}
