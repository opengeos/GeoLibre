import type { Map as MapLibreMap } from "maplibre-gl";

/** Dispatched by the drag-resizable docked panels when a splitter drag begins. */
export const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
/** Dispatched by the drag-resizable docked panels when a splitter drag ends. */
export const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
/**
 * How long the container dimensions must stay still before the WebGL backing
 * store is resized. Long enough to swallow a continuous window drag, short
 * enough that the stretched previous frame is not perceived as lag.
 */
export const RESIZE_DEBOUNCE_MS = 100;

export interface MapResizeSchedulerOptions {
  /** The MapLibre map, read lazily so the scheduler survives style reloads. */
  getMap: () => MapLibreMap | null | undefined;
  /** The element the map is mounted in; observed for size changes. */
  container: HTMLElement;
}

/**
 * Own MapLibre canvas sizing for a map pane.
 *
 * MapLibre's own `trackResize` is disabled (see `createMapController`) because
 * the container also changes when app panels open, close, and are dragged;
 * letting both resize paths run causes competing framebuffer reallocations that
 * briefly expose a transparent canvas. This scheduler is the single owner:
 *
 * - discrete layout changes (toggling a sidebar) resize on the next frame,
 * - the rapid observer callbacks of a continuous window drag are debounced so
 *   the previously rendered bitmap stays on screen while dimensions move,
 * - a docked-panel splitter drag suppresses resizes until the drag ends.
 *
 * @param options Map accessor and the container element to observe.
 * @returns A dispose function that detaches every listener and pending timer.
 */
export function createMapResizeScheduler({
  getMap,
  container,
}: MapResizeSchedulerOptions): () => void {
  let resizeFrame: number | null = null;
  let resizeTimer: number | null = null;
  let windowResizeTimer: number | null = null;
  let windowResizeActive = false;
  let observedDevicePixelRatio = window.devicePixelRatio;
  let panelResizeActive = false;

  const cancelFrame = () => {
    if (resizeFrame === null) return;
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
  };
  const cancelTimer = () => {
    if (resizeTimer === null) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = null;
  };
  // MapLibre sizes the canvas from `clientWidth`/`clientHeight` and writes those
  // integers back as the canvas CSS size, so the comparison has to read the same
  // properties — `getBoundingClientRect()` returns sub-pixel floats that never
  // match on a fractionally sized container, which would make this guard a
  // no-op. `devicePixelRatio` is checked too because moving the window to a
  // display with a different scale factor changes the backing store without
  // changing the CSS box, so no ResizeObserver callback fires.
  const mapNeedsResize = () => {
    const map = getMap();
    if (!map) return false;
    const canvas = map.getCanvas();
    return (
      parseFloat(canvas.style.width) !== container.clientWidth ||
      parseFloat(canvas.style.height) !== container.clientHeight ||
      observedDevicePixelRatio !== window.devicePixelRatio
    );
  };
  const commitResize = () => {
    cancelFrame();
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = null;
      if (!mapNeedsResize()) return;
      getMap()?.resize();
      observedDevicePixelRatio = window.devicePixelRatio;
    });
  };
  const resizeMap = () => {
    if (panelResizeActive) return;
    // App layout changes such as toggling a sidebar are discrete and should
    // resize on the next frame. Only coalesce the rapid observer callbacks
    // produced while the browser window itself is being dragged.
    if (!windowResizeActive) {
      commitResize();
      return;
    }
    // Resizing a WebGL canvas reallocates and clears its framebuffer before
    // MapLibre's next render. During a continuous window drag that used to
    // reveal the transparent canvas for several frames. Keep the previous
    // bitmap in place while dimensions are changing, then resize the backing
    // store once the dimensions settle. A frame already queued by an earlier
    // discrete change has to be dropped, or it would resize mid-drag anyway.
    cancelFrame();
    cancelTimer();
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      commitResize();
    }, RESIZE_DEBOUNCE_MS);
  };
  const onWindowResize = () => {
    windowResizeActive = true;
    if (windowResizeTimer !== null) window.clearTimeout(windowResizeTimer);
    windowResizeTimer = window.setTimeout(() => {
      windowResizeTimer = null;
      windowResizeActive = false;
    }, RESIZE_DEBOUNCE_MS);
    resizeMap();
  };
  const clearWindowResizeState = () => {
    if (windowResizeTimer !== null) {
      window.clearTimeout(windowResizeTimer);
      windowResizeTimer = null;
    }
    windowResizeActive = false;
  };
  const onPanelResizeStart = () => {
    panelResizeActive = true;
    // A splitter drag cannot overlap a window drag, so any window-drag burst
    // still settling is over; clearing it keeps the two states independent.
    clearWindowResizeState();
    cancelFrame();
    cancelTimer();
  };
  const onPanelResizeEnd = () => {
    panelResizeActive = false;
    commitResize();
  };

  const resizeObserver = new ResizeObserver(resizeMap);
  resizeObserver.observe(container);
  window.addEventListener("resize", onWindowResize);
  window.addEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
  window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
  commitResize();

  return () => {
    resizeObserver.disconnect();
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
    window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
    cancelFrame();
    cancelTimer();
    clearWindowResizeState();
  };
}
