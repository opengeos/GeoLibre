import { type MouseEvent as ReactMouseEvent, useEffect, useRef } from "react";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../../lib/panel-resize";
import { type SortKey } from "./table-layout";
import {
  MIN_FEATURE_ID_COLUMN_WIDTH,
  MAX_FEATURE_ID_COLUMN_WIDTH,
  MIN_ATTRIBUTE_COLUMN_WIDTH,
  MAX_ATTRIBUTE_COLUMN_WIDTH,
  MIN_TABLE_HEIGHT,
  MAX_TABLE_HEIGHT,
} from "./table-sizes";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { ColumnWidths } from "./table-sizes";

/**
 * Column and table resizing for the attribute table: pointer-driven drags with their cleanup.
 */
export function useTableResize({
  columnWidth,
  setColumnWidths,
  tableHeight,
  deferTableResize,
  tableResizeGuideRef,
  tableSectionRef,
  setTableHeight,
}: {
  columnWidth: (key: SortKey) => number;
  setColumnWidths: Dispatch<SetStateAction<ColumnWidths>>;
  tableHeight: number;
  deferTableResize: boolean;
  tableResizeGuideRef: RefObject<HTMLDivElement | null>;
  tableSectionRef: RefObject<HTMLElement | null>;
  setTableHeight: Dispatch<SetStateAction<number>>;
}) {
  const columnWidthLimits = (key: SortKey) =>
    key === "__featureId"
      ? {
          max: MAX_FEATURE_ID_COLUMN_WIDTH,
          min: MIN_FEATURE_ID_COLUMN_WIDTH,
        }
      : {
          max: MAX_ATTRIBUTE_COLUMN_WIDTH,
          min: MIN_ATTRIBUTE_COLUMN_WIDTH,
        };
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);
  const startColumnResize = (key: SortKey, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = columnWidth(key);
    const { min, max } = columnWidthLimits(key);
    // The handle sits at the column's logical inline-end (`-end-2`) — the right
    // edge in LTR, the left edge in RTL. clientX still increases to the right in
    // both, so invert the delta under RTL: dragging the (left-side) RTL handle
    // outward lowers clientX but should widen the column.
    const directionSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    let pendingWidth = startWidth;
    let resizeFrame: number | null = null;

    const flushWidth = () => {
      resizeFrame = null;
      const width = pendingWidth;
      setColumnWidths((current) =>
        current[key] === width ? current : { ...current, [key]: width },
      );
    };

    const onMouseMove = (moveEvent: MouseEvent) => {
      pendingWidth = Math.min(
        max,
        Math.max(min, startWidth + directionSign * (moveEvent.clientX - startX)),
      );
      if (resizeFrame === null) {
        resizeFrame = window.requestAnimationFrame(flushWidth);
      }
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };

    const onMouseUp = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        flushWidth();
      }
      cleanup();
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
  const startTableResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const startY = event.clientY;
    const startHeight = tableHeight;
    let nextHeight = startHeight;
    let resizeFrame: number | null = null;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMouseMove = (moveEvent: MouseEvent) => {
      const availableHeight = Math.max(MIN_TABLE_HEIGHT, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_TABLE_HEIGHT, availableHeight);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_TABLE_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (deferTableResize) {
          if (tableResizeGuideRef.current) {
            tableResizeGuideRef.current.style.top = `${startY + startHeight - nextHeight}px`;
            tableResizeGuideRef.current.classList.remove("hidden");
          }
          return;
        }
        if (tableSectionRef.current) {
          tableSectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const teardown = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      tableResizeGuideRef.current?.classList.add("hidden");
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (resizeCleanupRef.current === teardown) resizeCleanupRef.current = null;
    };

    const onMouseUp = () => {
      teardown();
      if (tableSectionRef.current) {
        tableSectionRef.current.style.height = `${nextHeight}px`;
      }
      setTableHeight(nextHeight);
    };

    resizeCleanupRef.current = teardown;
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };
  return {
    startColumnResize,
    startTableResize,
  };
}
