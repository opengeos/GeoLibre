/**
 * Keeps a leftover text selection from hijacking map panning.
 *
 * The map canvas counts as part of a page-wide text selection. When one is
 * active, WebKit (the Tauri webview on Linux and macOS) treats a press on the
 * canvas as a press on selected content and starts a native drag of the
 * selection: the drag ghost shows whatever text was selected (for example the
 * Earth Engine control's globe emoji) and MapLibre/Mapbox stop receiving the
 * pointer moves, so the pan dies after a few pixels. Clicking any text field
 * "fixed" it only because that collapses the selection.
 *
 * The guard does what a click on a plain page area does anyway, collapsing the
 * selection when the press lands on the map, and cancels any native drag that
 * still starts from the canvas. Popups live outside the canvas container, so
 * selecting and copying their text keeps working.
 */

/** Minimal shape the guard needs from `Selection`. */
export interface SelectionLike {
  readonly isCollapsed: boolean;
  removeAllRanges(): void;
}

/**
 * Installs the guard on a map's canvas container (`map.getCanvasContainer()`
 * on both MapLibre and Mapbox).
 *
 * @param container - The element wrapping the map canvas and markers.
 * @param getSelection - Returns the active selection; defaults to the
 *   container document's selection. Injectable for tests.
 * @returns A function that removes the listeners.
 */
export function installSelectionDragGuard(
  container: EventTarget & { ownerDocument?: Document | null },
  getSelection: () => SelectionLike | null = () => container.ownerDocument?.getSelection() ?? null,
): () => void {
  const onMouseDown = (event: Event) => {
    if ((event as MouseEvent).button !== 0) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  };
  const onDragStart = (event: Event) => {
    // Honour an element that explicitly opted into HTML5 drag and drop (for
    // example a custom marker); cancel the implicit canvas/image/selection drag.
    const target = event.target as { getAttribute?: (name: string) => string | null } | null;
    if (target?.getAttribute?.("draggable") === "true") return;
    event.preventDefault();
  };
  // Capture phase, so the selection is gone before the webview decides the
  // press is the start of a drag and before MapLibre's own handlers run.
  container.addEventListener("mousedown", onMouseDown, { capture: true });
  container.addEventListener("dragstart", onDragStart);
  return () => {
    container.removeEventListener("mousedown", onMouseDown, { capture: true });
    container.removeEventListener("dragstart", onDragStart);
  };
}
