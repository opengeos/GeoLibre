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

/** Class that gives a plugin panel's native `<select>` the app's own chevron (see `index.css`). */
export const SELECT_CHEVRON_CLASS = "geolibre-native-select";

/**
 * Swaps a native `<select>`'s disclosure arrow for the chevron the app's React
 * `Select` draws, and returns the select.
 *
 * The browser's own arrow has different insets and looks in Chromium and in
 * WebKit (the desktop webview on macOS), so plain-DOM panel selects never
 * matched the rest of the app. The rule behind the class sets `appearance`,
 * the chevron and the end padding with `!important`, so it holds even when
 * the panel styles the select inline (`style.cssText`, `background: …`). It
 * is a class rather than inline styles so the chevron can follow dark mode
 * and right-to-left layouts. Not for `multiple` or `size` list boxes, which
 * have no arrow.
 *
 * @param select Select to update.
 */
export function withSelectChevron<T extends HTMLSelectElement>(select: T): T {
  select.classList.add(SELECT_CHEVRON_CLASS);
  return select;
}
