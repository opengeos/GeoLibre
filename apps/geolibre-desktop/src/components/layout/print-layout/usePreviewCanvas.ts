import { useEffect, useRef } from "react";
import { drawLayout, resolvePageSize, type LayoutOptions } from "../../../lib/print-layout";

/**
 * Draw the composed page into the preview canvas while the dialog is open.
 *
 * @param open - Whether the dialog is open.
 * @param displayOptions - The page to draw (atlas tokens already resolved).
 * @returns Refs for the preview canvas and the pane it is fitted into.
 */
export function usePreviewCanvas(open: boolean, displayOptions: LayoutOptions) {
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);

  // Redraw the preview whenever the layout options change, sizing the canvas to
  // fill the preview pane (so it grows when the dialog is resized) while keeping
  // the page aspect ratio. Drawing is scheduled on an animation frame and
  // retries until the canvas exists: the dialog mounts its content in a portal,
  // so the first effect pass can run before the canvas is committed -- without
  // the retry the preview stayed blank until "Recapture map" (GH #521). A
  // ResizeObserver re-renders when the pane resizes (e.g. dragging the splitter
  // or the dialog grip).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let retries = 0;
    let observer: ResizeObserver | null = null;
    const render = () => {
      raf = 0;
      const canvas = previewRef.current;
      const box = previewBoxRef.current;
      if (!canvas || !box) {
        if (retries++ < 20) raf = requestAnimationFrame(render);
        return;
      }
      const size = resolvePageSize(displayOptions);
      const aspect = size.width / size.height;
      // Available space inside the pane (p-3 padding = 12px each side).
      const availW = Math.max(1, box.clientWidth - 24);
      const availH = Math.max(1, box.clientHeight - 24);
      let dispW = availW;
      let dispH = availW / aspect;
      if (dispH > availH) {
        dispH = availH;
        dispW = availH * aspect;
      }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(dispW * dpr));
      canvas.height = Math.max(1, Math.round(dispH * dpr));
      canvas.style.width = `${Math.round(dispW)}px`;
      canvas.style.height = `${Math.round(dispH)}px`;
      drawLayout(canvas, displayOptions);
      if (!observer) {
        // Coalesce resize-driven re-renders to one drawLayout per frame so a
        // fast splitter/grip drag doesn't run the draw synchronously per event.
        observer = new ResizeObserver(() => {
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            render();
          });
        });
        observer.observe(box);
      }
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [open, displayOptions]);

  return { previewRef, previewBoxRef };
}
