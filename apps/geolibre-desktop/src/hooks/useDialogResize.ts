import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/** A dialog size chosen by dragging its corner grip. */
export interface DialogSize {
  width: number;
  height: number;
}

/** Smallest size the grip can drag a dialog to, in CSS pixels. */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

/**
 * Corner-grip resizing for a centered `DialogContent`, the way the layer
 * metadata dialog does it: the dialog is centered with a -50% transform, so
 * each edge moves by half the size change, and growing by twice the pointer
 * delta keeps the grip under the cursor. In a right-to-left layout the grip
 * sits on the physical left, so the horizontal delta is inverted.
 *
 * @param dialogRef The `DialogContent` element.
 * @returns The chosen size (null until the user drags), an inline style for
 *   `DialogContent`, and the grip's pointer-down handler.
 */
export function useDialogResize(dialogRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<DialogSize | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const el = dialogRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const isRtl = document.documentElement.dir === "rtl";
      const startX = event.clientX;
      const startY = event.clientY;
      let next: DialogSize = { width: rect.width, height: rect.height };
      let frame: number | null = null;
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = isRtl ? "nesw-resize" : "nwse-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        const deltaX = (e.clientX - startX) * (isRtl ? -1 : 1);
        next = {
          width: Math.max(MIN_WIDTH, Math.min(window.innerWidth - 16, rect.width + deltaX * 2)),
          height: Math.max(
            MIN_HEIGHT,
            Math.min(window.innerHeight - 16, rect.height + (e.clientY - startY) * 2),
          ),
        };
        if (frame !== null) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          setSize(next);
        });
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (frame !== null) window.cancelAnimationFrame(frame);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        cleanupRef.current = null;
      };
      const onUp = () => {
        cleanup();
        setSize(next);
      };
      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [dialogRef],
  );

  // Only the width cap is lifted, and only to the viewport: a size chosen on a
  // wide window must not leave the dialog clipped once the window narrows. The
  // height keeps DialogContent's own viewport cap.
  const style: CSSProperties | undefined = size
    ? { width: size.width, height: size.height, maxWidth: "calc(100vw - 1rem)" }
    : undefined;

  return { size, style, startResize };
}
