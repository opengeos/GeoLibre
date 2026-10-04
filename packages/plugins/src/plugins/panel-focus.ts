// Keyboard focus for the Add Data map panels (Vector Layer, Raster Layer).
//
// These panels are map controls, not dialogs, so nothing moves focus into them:
// opened from the Add Data menu, focus went back to the menu's trigger and a
// keyboard user had to tab through the whole toolbar to reach the panel
// (#2895). `focusPanel` moves focus to the panel's first control and remembers
// where it came from; `restorePanelFocus` hands it back when the panel closes.

const FOCUSABLE = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const returnTargets = new WeakMap<HTMLElement, HTMLElement>();

function isShown(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

/**
 * The first focusable, rendered element inside `panel`.
 *
 * @param panel - The panel to search.
 * @param skip - Elements matching this selector are passed over (for example a
 *   header close button, which is a poor first stop).
 * @returns The element, or null when the panel has none.
 */
export function firstFocusable(panel: HTMLElement, skip?: string): HTMLElement | null {
  for (const element of panel.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (skip && element.matches(skip)) continue;
    if (isShown(element)) return element;
  }
  return null;
}

/**
 * Moves focus into a just-opened panel, remembering the element it came from.
 *
 * Runs on the next animation frame so a closing menu has already returned focus
 * to its trigger; that trigger is then what `restorePanelFocus` goes back to.
 *
 * @param panel - The panel element, or nothing when the control has no panel.
 * @param skip - Selector for elements not to land on first.
 */
export function focusPanel(panel: HTMLElement | null | undefined, skip?: string): void {
  if (!panel || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    if (!panel.isConnected) return;
    const target = firstFocusable(panel, skip) ?? firstFocusable(panel);
    if (!target) return;
    const previous = document.activeElement;
    if (previous instanceof HTMLElement && !panel.contains(previous)) {
      returnTargets.set(panel, previous);
    }
    target.focus();
  });
}

/**
 * Returns focus to where it was before `focusPanel`, when the panel closes.
 *
 * Only acts while focus is still inside the panel (or was dropped to the body
 * as the panel hid), so closing a panel the user has already left never yanks
 * focus back.
 *
 * @param panel - The panel being closed.
 */
export function restorePanelFocus(panel: HTMLElement | null | undefined): void {
  if (!panel) return;
  const target = returnTargets.get(panel);
  returnTargets.delete(panel);
  if (!target?.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body && !panel.contains(active)) return;
  target.focus();
}
