/**
 * Which key press in the assistant's composer means "send".
 *
 * Kept out of the panel so the rule can be tested without mounting the whole
 * assistant (and the provider registry it pulls in).
 */

/** The parts of a keyboard event the rule reads. */
export interface ComposerKey {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  /** True while an IME is composing, where Enter confirms a candidate. */
  isComposing?: boolean;
  /**
   * Legacy keyCode. WebKit has historically reported the IME's confirming
   * Enter as 229 with `isComposing` already false, so it is read as a second
   * composition signal rather than for the key's identity.
   */
  keyCode?: number;
  /** Accepted but not read: Ctrl/Cmd+Enter sends exactly as a bare Enter does. */
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Enter sends. Shift+Enter and Alt+Enter insert a newline, as does Enter while
 * an IME is mid-composition — pressing it there picks a candidate and would
 * otherwise fire off a half-typed message on every CJK word. `isComposing`
 * covers that in Chrome and Firefox; WebKit has reported the same press as
 * keyCode 229 with `isComposing` already false, so both are checked.
 * Ctrl/Cmd+Enter still sends, so the shortcut this replaced keeps working.
 *
 * `sendable` is the panel's own send guard (a non-empty draft, no run in
 * flight): when it is false the press is left alone rather than swallowed, so
 * Enter still types a newline while the assistant is answering.
 */
export function isSendKey(event: ComposerKey, sendable: boolean): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return false;
  return sendable;
}
