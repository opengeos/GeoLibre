import { useCallback, useRef, type Dispatch } from "react";
import { CONTROLS_MAX_WIDTH, CONTROLS_MIN_WIDTH, type PrintLayoutAction } from "./state";

/**
 * Pointer handlers for the Print Layout dialog's two resize affordances: the
 * bottom-right grip that resizes the whole dialog, and the splitter between
 * the controls column and the preview.
 *
 * @param dispatch - The composer's reducer dispatch.
 * @param controlsWidth - The current controls column width.
 * @returns The dialog element ref, the two pointer-down handlers, and a ref
 *   holding the teardown of an in-progress drag (run it on unmount).
 */
export function useDialogResize(dispatch: Dispatch<PrintLayoutAction>, controlsWidth: number) {
  // Tears down an in-progress dialog/splitter resize drag (removes the window
  // pointer listeners) if the dialog unmounts mid-drag.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Mirror of controlsWidth so the resize handler can read the latest start
  // width without listing it as a dep (which would recreate the callback every
  // RAF tick during a drag).
  const controlsWidthRef = useRef(controlsWidth);
  controlsWidthRef.current = controlsWidth;
  // The dialog element, for reading its live size.
  const dialogRef = useRef<HTMLDivElement>(null);

  // Resize the whole dialog from its bottom-right grip. The dialog is centred
  // via a -50% transform, so the right/bottom edges move by half the size
  // change; growing by 2x the pointer delta keeps the grip under the cursor.
  const startDialogResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const el = dialogRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = rect.width;
      const startH = rect.height;
      let next = { width: startW, height: startH };
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        next = {
          width: Math.max(480, Math.min(window.innerWidth - 16, startW + (e.clientX - startX) * 2)),
          height: Math.max(
            360,
            Math.min(window.innerHeight - 16, startH + (e.clientY - startY) * 2),
          ),
        };
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          dispatch({ type: "setUi", patch: { dialogSize: next } });
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        resizeCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        dispatch({ type: "setUi", patch: { dialogSize: next } });
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [dispatch],
  );

  // Drag the splitter between the controls column and the preview. Mirrors the
  // shell's panel-resize idiom: pointer capture so the drag survives leaving the
  // handle, RAF-throttled width updates, and a col-resize body cursor.
  const startSplitterResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startWidth = controlsWidthRef.current;
      let nextWidth = startWidth;
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        nextWidth = Math.max(
          CONTROLS_MIN_WIDTH,
          Math.min(CONTROLS_MAX_WIDTH, startWidth + e.clientX - startX),
        );
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          dispatch({ type: "setControlsWidth", width: nextWidth });
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        resizeCleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        dispatch({ type: "setControlsWidth", width: nextWidth });
      };
      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [dispatch],
  );

  return { dialogRef, resizeCleanupRef, startDialogResize, startSplitterResize };
}
