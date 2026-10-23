import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";
import { isTauri } from "../../lib/tauri-io";
import type { LayoutOptions } from "../useLayoutOptions";

const DEFAULT_SIDE_PANEL_WIDTH = 320;
const MIN_SIDE_PANEL_WIDTH = 180;
const MAX_SIDE_PANEL_WIDTH = 560;
// Width of a side panel's collapsed rail (`md:w-11` = 2.75rem). The Style panel
// stays mounted (collapsed) beside the notebook, so its rail still occupies this
// much of the row when computing the map/notebook 50/50 split.
const COLLAPSED_PANEL_RAIL_WIDTH = 44;
// The notebook panel hosts a full Jupyter UI, so it needs far more room than
// the layer/style side panels.
const DEFAULT_NOTEBOOK_PANEL_WIDTH = 480;
const MIN_NOTEBOOK_PANEL_WIDTH = 320;
const MAX_NOTEBOOK_PANEL_WIDTH = 1100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Seed width for the Layers/Style side panels. The full default would let two
// open panels crowd out the map on narrow desktop windows (two 320px panels
// leave only 128px at the 768px `md` breakpoint), so cap the initial width at
// ~30% of the viewport. The cap only lowers the width below ~1067px (where 30%
// of the viewport drops under the default); wider windows get the full default.
// Users can still drag up to MAX_SIDE_PANEL_WIDTH either way.
function initialSidePanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL_WIDTH;
  const cap = Math.round(window.innerWidth * 0.3);
  return clamp(cap, MIN_SIDE_PANEL_WIDTH, DEFAULT_SIDE_PANEL_WIDTH);
}

type ShellStyle = CSSProperties &
  Record<"--layer-panel-width" | "--style-panel-width" | "--notebook-panel-width", string>;

interface PanelResizeOptions {
  shellRef: RefObject<HTMLDivElement | null>;
  verticalResizeGuideRef: RefObject<HTMLDivElement | null>;
  layoutOptions: LayoutOptions;
  notebookOpen: boolean;
}

/**
 * Widths of the Layers, Style and notebook panels and their drag-resize handlers.
 *
 * @param options - The shell elements the resize writes to, plus the layout state
 *   the notebook's initial 50/50 split depends on.
 * @returns The shell's width CSS variables and one resize handler per panel.
 */
export function usePanelResize({
  shellRef,
  verticalResizeGuideRef,
  layoutOptions,
  notebookOpen,
}: PanelResizeOptions) {
  // Teardown for an in-progress panel resize, so a pointercancel or an unmount
  // mid-drag still detaches the global listeners and restores document.body.
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => activeResizeCleanupRef.current?.(), []);
  const [layerPanelWidth, setLayerPanelWidth] = useState(initialSidePanelWidth);
  const [stylePanelWidth, setStylePanelWidth] = useState(initialSidePanelWidth);
  const [notebookPanelWidth, setNotebookPanelWidth] = useState(DEFAULT_NOTEBOOK_PANEL_WIDTH);
  // Opening the notebook (Processing → Jupyter Notebook) splits the workspace
  // 50/50 between the map and the notebook: we size the notebook to half of the
  // space it shares with the map (the row width minus the layer panel and the
  // Style panel's collapsed rail, when shown), while the Style panel collapses
  // to that rail (see `autoCollapse` below). Fire only on the closed→open
  // transition so a later manual resize is preserved.
  const notebookWasOpenRef = useRef(notebookOpen);
  useEffect(() => {
    const wasOpen = notebookWasOpenRef.current;
    notebookWasOpenRef.current = notebookOpen;
    if (!notebookOpen || wasOpen) return;
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? 0;
    if (shellWidth <= 0) return;
    const layerWidth = layoutOptions.layerPanelVisible ? layerPanelWidth : 0;
    const styleRailWidth = layoutOptions.stylePanelVisible ? COLLAPSED_PANEL_RAIL_WIDTH : 0;
    const half = Math.round((shellWidth - layerWidth - styleRailWidth) / 2);
    // Honor the same min/max bounds as the drag-resize handler so the auto-size
    // and manual-resize paths cannot diverge (an ultrawide shell would otherwise
    // initialize past MAX, a width the user could never drag back to).
    setNotebookPanelWidth(clamp(half, MIN_NOTEBOOK_PANEL_WIDTH, MAX_NOTEBOOK_PANEL_WIDTH));
  }, [
    notebookOpen,
    layoutOptions.layerPanelVisible,
    layoutOptions.stylePanelVisible,
    layerPanelWidth,
    shellRef,
  ]);
  const deferPanelResize = isTauri();
  const shellStyle: ShellStyle = {
    "--layer-panel-width": `${layerPanelWidth}px`,
    "--style-panel-width": `${stylePanelWidth}px`,
    "--notebook-panel-width": `${notebookPanelWidth}px`,
  };

  const startLayerPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = layerPanelWidth;
      // In a right-to-left layout the panels are mirrored, so pointer deltas
      // (and the deferred-resize guide anchor) flip sign.
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (moveEvent.clientX - startX),
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.left + nextWidth : panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--layer-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--layer-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setLayerPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, layerPanelWidth, shellRef, verticalResizeGuideRef],
  );

  const startStylePanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = stylePanelWidth;
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (startX - moveEvent.clientX),
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.right - nextWidth : panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--style-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--style-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setStylePanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, stylePanelWidth, shellRef, verticalResizeGuideRef],
  );

  // The notebook panel is docked on the same side as the Style panel, so its
  // map-side handle widens the panel as the pointer moves toward the map
  // (mirrors startStylePanelResize, with the notebook's own constants/CSS var).
  const startNotebookPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = notebookPanelWidth;
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (startX - moveEvent.clientX),
          MIN_NOTEBOOK_PANEL_WIDTH,
          MAX_NOTEBOOK_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.right - nextWidth : panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--notebook-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--notebook-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setNotebookPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, notebookPanelWidth, shellRef, verticalResizeGuideRef],
  );

  return {
    shellStyle,
    startLayerPanelResize,
    startNotebookPanelResize,
    startStylePanelResize,
  };
}
