/**
 * DOM helpers for plugin panels, which are built by hand: this package is framework-agnostic and
 * cannot render with React.
 */

/** Creates an element, optionally with its text content set. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Toggles a button's disabled state *and* its appearance.
 *
 * Panels style their buttons with inline `background`/`color`/`cursor:pointer`,
 * which overrides the browser's own disabled rendering, so setting `.disabled`
 * alone leaves the control looking exactly like an enabled one (GeoLibre#1970: a
 * STAC item whose only asset is GeoParquet has Add disabled, and it was
 * indistinguishable from the Zoom and Download buttons beside it). Dimming it
 * and dropping the pointer cursor makes an unusable control read as unusable
 * before it is clicked.
 *
 * Call this *after* any `style.cssText` assignment on the same element: cssText
 * replaces the whole inline declaration and would wipe these two properties.
 *
 * @param button Button to update.
 * @param disabled Whether the button should be disabled.
 */
export function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.5" : "1";
  button.style.cursor = disabled ? "not-allowed" : "pointer";
}
