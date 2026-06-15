/**
 * Workarounds for Radix UI quirks shared across dialogs.
 */

/**
 * Radix locks `document.body { pointer-events: none }` while a modal dialog is
 * open and can leave it set briefly after a programmatic close. Dialogs that
 * temporarily hide themselves to let the user interact with the map (Field
 * Collection, Georeferencer) call this so the map receives the next click.
 *
 * Pair it with a `requestAnimationFrame` re-call at the use site, since Radix's
 * own cleanup may run a frame after the close.
 */
export function releaseBodyPointerEvents(): void {
  if (document.body.style.pointerEvents === "none") {
    document.body.style.pointerEvents = "";
  }
}
