import { X } from "lucide-react";
import * as React from "react";
import {
  BOTTOM_SHEET_DETENT_RATIOS,
  clampSheetHeight,
  detentToHeightPx,
  resolveNextDetent,
  sortDetents,
  stepDetent,
  type BottomSheetDetent,
} from "../lib/bottom-sheet-snap";
import { cn } from "../lib/utils";

export type { BottomSheetDetent };

export interface BottomSheetProps {
  /** Whether the sheet is currently shown. */
  open: boolean;
  /** Called when the user dismisses the sheet (swipe down, backdrop, close button, Escape). */
  onOpenChange: (open: boolean) => void;
  /** Controlled snap detent. Omit to let the sheet manage its own detent state. */
  detent?: BottomSheetDetent;
  /** Initial detent when uncontrolled. Defaults to `"half"`. */
  defaultDetent?: BottomSheetDetent;
  /** Called whenever the snap detent changes. */
  onDetentChange?: (detent: BottomSheetDetent) => void;
  /** Enabled snap detents. Defaults to `["peek", "half", "full"]`. */
  detents?: readonly BottomSheetDetent[];
  /** Optional per-detent ratio overrides (0–1 of available container height). */
  detentRatios?: Partial<Record<BottomSheetDetent, number>>;
  /**
   * When true, renders a dimmed scrim behind the sheet and blocks map taps
   * behind it. Defaults to `false` so the map stays interactive above the sheet
   * at `peek` / `half` detents.
   */
  modal?: boolean;
  /** Whether the user may swipe down / tap Escape / tap close to dismiss. Defaults to `true`. */
  dismissible?: boolean;
  /** Optional visible heading in the sheet header. */
  title?: React.ReactNode;
  /**
   * When true, renders only the slim drag handle pill without a title/close row
   * (useful when the child panel renders its own header bar).
   */
  hideHeader?: boolean;
  /** Accessible name for the sheet region/dialog. */
  ariaLabel?: string;
  /** Optional extra controls rendered beside the close button in the sheet header. */
  headerActions?: React.ReactNode;
  /** Accessible label for the close button (callers pass a translated string). */
  closeLabel?: string;
  /** Accessible label for the drag handle button (callers pass a translated string). */
  dragHandleLabel?: string;
  /** Additional classes for the sheet panel itself. */
  className?: string;
  /** Additional classes for the scrollable body container. */
  bodyClassName?: string;
  /** Inline style overrides on the sheet panel. */
  style?: React.CSSProperties;
  /** Optional data-testid for the sheet panel. */
  "data-testid"?: string;
  children: React.ReactNode;
}

const DRAG_ACTIVATION_PX = 4;

/**
 * Read the live available height for a bottom sheet hosted inside `container`,
 * factoring in `window.visualViewport` so an open mobile virtual keyboard does
 * not bury the sheet's header or active input.
 */
function measureContainerHeight(container: HTMLElement | null): number {
  const parentHeight = container?.clientHeight ?? 0;
  if (typeof window === "undefined") return parentHeight || 640;
  const visualHeight = window.visualViewport?.height ?? window.innerHeight;
  if (parentHeight > 0) return Math.min(parentHeight, visualHeight);
  return visualHeight;
}

/**
 * Draggable bottom sheet with snap detents (`peek`, `half`, `full`), swipe-to-
 * dismiss, keyboard cycling, and non-modal map-interactive support.
 *
 * Designed to sit inside a positioned host container (such as the map workspace
 * above the mobile bottom navigation bar) rather than covering the entire
 * viewport, so bottom chrome stays reachable while a sheet is open.
 */
export function BottomSheet({
  open,
  onOpenChange,
  detent: controlledDetent,
  defaultDetent = "half",
  onDetentChange,
  detents = ["peek", "half", "full"],
  detentRatios,
  modal = false,
  dismissible = true,
  title,
  hideHeader = false,
  ariaLabel,
  headerActions,
  closeLabel = "Close",
  dragHandleLabel = "Resize sheet",
  className,
  bodyClassName,
  style,
  "data-testid": testId,
  children,
}: BottomSheetProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const sheetRef = React.useRef<HTMLElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  const orderedDetents = React.useMemo(() => sortDetents(detents), [detents]);
  const [uncontrolledDetent, setUncontrolledDetent] = React.useState<BottomSheetDetent>(() =>
    orderedDetents.includes(defaultDetent) ? defaultDetent : orderedDetents[0],
  );
  const activeDetent = controlledDetent ?? uncontrolledDetent;

  const setDetent = React.useCallback(
    (next: BottomSheetDetent) => {
      if (controlledDetent === undefined) setUncontrolledDetent(next);
      onDetentChange?.(next);
    },
    [controlledDetent, onDetentChange],
  );

  // Track the bounding container height (updating on resize, orientation change,
  // and mobile virtual keyboard open/close via visualViewport).
  const [containerHeight, setContainerHeight] = React.useState<number>(() =>
    typeof window !== "undefined" ? (window.visualViewport?.height ?? window.innerHeight) : 640,
  );

  React.useLayoutEffect(() => {
    if (!open) return;
    const host = hostRef.current;
    const update = () => setContainerHeight(measureContainerHeight(host));
    update();

    const resizeObserver =
      typeof ResizeObserver !== "undefined" && host ? new ResizeObserver(update) : null;
    if (host && resizeObserver) resizeObserver.observe(host);

    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      resizeObserver?.disconnect();
      vv?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  // Reset to defaultDetent whenever the sheet reopens in uncontrolled mode.
  const prevOpenRef = React.useRef(open);
  React.useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen && controlledDetent === undefined) {
      setUncontrolledDetent(
        orderedDetents.includes(defaultDetent) ? defaultDetent : orderedDetents[0],
      );
    }
  }, [open, controlledDetent, defaultDetent, orderedDetents]);

  // Escape dismisses the sheet when dismissible (ignoring events already handled
  // by an open nested dialog or menu).
  React.useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Do not steal Escape if a Radix dialog/menu portal is stacked above us.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismissible, onOpenChange]);

  // Live drag state: `dragHeightPx` is non-null only while a pointer drag is
  // actively moving the sheet.
  const [dragHeightPx, setDragHeightPx] = React.useState<number | null>(null);
  const suppressHandleClickRef = React.useRef(false);
  const dragRef = React.useRef<{
    pointerId: number;
    startY: number;
    startHeightPx: number;
    lastY: number;
    lastTime: number;
    velocityY: number;
    moved: boolean;
  } | null>(null);

  // Release any dangling drag state if the sheet closes mid-gesture.
  React.useEffect(() => {
    if (!open) {
      dragRef.current = null;
      setDragHeightPx(null);
    }
  }, [open]);

  const targetHeightPx = detentToHeightPx(activeDetent, containerHeight, detentRatios);
  const maxRatio = Math.max(
    ...orderedDetents.map((d) => detentRatios?.[d] ?? BOTTOM_SHEET_DETENT_RATIOS[d]),
  );

  const finishDrag = React.useCallback(
    (finalHeightPx: number, velocityY: number) => {
      const next = resolveNextDetent({
        currentHeightPx: finalHeightPx,
        containerHeight,
        velocityY,
        detents: orderedDetents,
        dismissible,
        ratios: detentRatios,
      });
      setDragHeightPx(null);
      if (next === "dismiss") {
        onOpenChange(false);
      } else {
        setDetent(next);
      }
    },
    [containerHeight, orderedDetents, dismissible, detentRatios, onOpenChange, setDetent],
  );

  const handleDragPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    // Let clicks on header action buttons and close buttons work normally.
    if (
      (event.target as HTMLElement).closest("button:not([data-sheet-handle]), a, input, select")
    ) {
      return;
    }
    const startHeightPx = sheetRef.current?.getBoundingClientRect().height || targetHeightPx;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeightPx,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocityY: 0,
      moved: false,
    };
  };

  const handleDragPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(deltaY) < DRAG_ACTIVATION_PX) return;
    drag.moved = true;

    const dt = Math.max(1, event.timeStamp - drag.lastTime);
    const instantVelocity = (event.clientY - drag.lastY) / dt;
    // Light smoothing prevents single-frame jitter from faking a flick.
    drag.velocityY = drag.velocityY * 0.4 + instantVelocity * 0.6;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;

    const minPx = dismissible
      ? 0
      : detentToHeightPx(orderedDetents[0], containerHeight, detentRatios);
    const nextHeight = clampSheetHeight(
      drag.startHeightPx - deltaY,
      containerHeight,
      minPx,
      Math.min(0.96, maxRatio + 0.04),
    );
    setDragHeightPx(nextHeight);
  };

  const handleDragPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      setDragHeightPx(null);
      return;
    }
    // Suppress the synthetic click that follows a drag on the handle button.
    suppressHandleClickRef.current = true;
    const finalHeight = clampSheetHeight(
      drag.startHeightPx - (event.clientY - drag.startY),
      containerHeight,
      0,
      maxRatio,
    );
    finishDrag(finalHeight, drag.velocityY);
  };

  const handleDragPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragHeightPx(null);
  };

  // Cycle detents on drag handle tap (when not dragged) or ArrowUp/ArrowDown for keyboard users.
  const cycleDetent = () => {
    if (suppressHandleClickRef.current) {
      suppressHandleClickRef.current = false;
      return;
    }
    if (orderedDetents.length <= 1) return;
    const index = orderedDetents.indexOf(activeDetent);
    const nextIndex = index === orderedDetents.length - 1 ? 0 : index + 1;
    setDetent(orderedDetents[nextIndex]);
  };

  const handleHandleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setDetent(stepDetent(activeDetent, "up", orderedDetents));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const stepped = stepDetent(activeDetent, "down", orderedDetents);
      if (stepped === activeDetent && dismissible) {
        onOpenChange(false);
      } else {
        setDetent(stepped);
      }
    }
  };

  if (!open) return null;

  const renderedHeight = dragHeightPx ?? targetHeightPx;
  const isDragging = dragHeightPx !== null;

  return (
    <div
      ref={hostRef}
      data-bottom-sheet-host=""
      className={cn(
        "absolute inset-0 z-30 flex flex-col justify-end overflow-hidden",
        modal ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      {modal ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-black/45 transition-opacity"
          onClick={() => {
            if (dismissible) onOpenChange(false);
          }}
        />
      ) : null}
      <section
        ref={sheetRef}
        role={modal ? "dialog" : "region"}
        aria-modal={modal || undefined}
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        data-testid={testId}
        data-detent={activeDetent}
        data-mobile-bottom-sheet=""
        style={{
          height: `${renderedHeight}px`,
          ...style,
        }}
        className={cn(
          "pointer-events-auto relative z-10 flex w-full flex-col overflow-hidden rounded-t-2xl border-t bg-card text-card-foreground shadow-2xl",
          !isDragging && "transition-[height] duration-200 ease-out",
          className,
        )}
      >
        <div
          className={cn(
            "flex shrink-0 touch-none select-none flex-col bg-card",
            !hideHeader && "border-b",
          )}
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerEnd}
          onPointerCancel={handleDragPointerCancel}
        >
          <div className="flex justify-center pt-2 pb-1">
            <button
              type="button"
              data-sheet-handle=""
              aria-label={dragHandleLabel}
              onClick={cycleDetent}
              onKeyDown={handleHandleKeyDown}
              className="flex h-5 w-16 cursor-grab items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            >
              <span className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
            </button>
          </div>
          {!hideHeader && (title !== undefined || headerActions !== undefined || dismissible) ? (
            <div className="flex min-h-10 items-center gap-2 px-3 pb-2">
              <div className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</div>
              {headerActions ? (
                <div className="flex shrink-0 items-center gap-1">{headerActions}</div>
              ) : null}
              {dismissible ? (
                <button
                  type="button"
                  aria-label={closeLabel}
                  title={closeLabel}
                  onClick={() => onOpenChange(false)}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div
          ref={bodyRef}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-contain touch-pan-y",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </section>
    </div>
  );
}
