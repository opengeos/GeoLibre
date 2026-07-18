import {
  closeFloatingPanel,
  focusFloatingPanel,
  getFloatingPanel,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { GripVertical, X } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useFloatingPanels } from "../../hooks/usePluginUiSurfaces";
import { clamp } from "../../lib/clamp";
import { isImageSource } from "../../lib/icon-source";

const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;
// Manual resizing may grow the card past its default width; keep a generous cap.
const MAX_RESIZE_WIDTH = 960;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 900;
const STAGGER = 24;
const EDGE_MARGIN = 12;

function FloatingPanelCard({
  id,
  initialOffset,
}: {
  id: string;
  initialOffset: number;
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const panel = getFloatingPanel(id);
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN + initialOffset,
    y: EDGE_MARGIN + initialOffset,
  }));
  const [size, setSize] = useState(() => ({
    width: clamp(panel?.defaultWidth ?? DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
    // undefined height means "size to content" (the historical behavior).
    height:
      panel?.defaultHeight != null
        ? clamp(panel.defaultHeight, MIN_HEIGHT, MAX_HEIGHT)
        : undefined,
  }));
  const { width } = size;
  // Once the user drags or resizes the card, stop auto-anchoring it to a corner
  // so a re-render (or a re-registration that keeps the same position) does not
  // yank it back.
  const userPlacedRef = useRef(false);
  const positionPref = panel?.position;

  // Anchor the card to its preferred corner on open and whenever the plugin
  // changes the preferred position (e.g. via the Plugins-menu position submenu).
  useLayoutEffect(() => {
    if (!positionPref) return;
    userPlacedRef.current = false;
    const card = sectionRef.current;
    const bounds = card?.parentElement?.getBoundingClientRect();
    if (!card || !bounds) return;
    const isLeft = positionPref.endsWith("left");
    const isTop = positionPref.startsWith("top");
    const maxX = Math.max(0, bounds.width - card.offsetWidth - EDGE_MARGIN);
    const maxY = Math.max(0, bounds.height - card.offsetHeight - EDGE_MARGIN);
    setPosition({
      x: isLeft ? EDGE_MARGIN + initialOffset : maxX - initialOffset,
      y: isTop ? EDGE_MARGIN + initialOffset : maxY - initialOffset,
    });
  }, [positionPref, initialOffset]);

  // Populate the plugin content container once per card. The container persists
  // while the card is open, so render is not re-invoked on drag/focus.
  // Keyed on the render function identity so that re-registering the same id
  // with a new render function refreshes the content, but title resolution
  // (which returns a new object each call) does not cause spurious re-runs.
  useEffect(() => {
    const container = contentRef.current;
    if (!container || !panel) return;
    let cleanup: void | (() => void);
    try {
      cleanup = panel.render(container);
    } catch (error) {
      console.error(`Floating panel "${id}" render() threw.`, error);
    }
    return () => {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`Floating panel "${id}" cleanup threw.`, error);
      }
      container.replaceChildren();
    };
    // `panel` is intentionally narrowed to `panel?.render`: getFloatingPanel
    // returns a fresh clone each call, so the whole object would re-run this
    // effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, panel?.render]);

  if (!panel) return null;

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Ignore drags that start on the close button.
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    userPlacedRef.current = true;
    // Focus is already raised by the section's onPointerDownCapture (capture
    // phase), so no focusFloatingPanel call is needed here.
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const card = handle.parentElement as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      // Recompute bounds each move so the clamp stays correct if the viewport
      // (or the map area) resizes mid-drag.
      const bounds = card.parentElement?.getBoundingClientRect();
      const maxX = bounds
        ? bounds.width - card.offsetWidth - EDGE_MARGIN
        : Number.POSITIVE_INFINITY;
      const maxY = bounds
        ? bounds.height - card.offsetHeight - EDGE_MARGIN
        : Number.POSITIVE_INFINITY;
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), 0, Math.max(0, maxX)),
        y: clamp(origin.y + (move.clientY - startY), 0, Math.max(0, maxY)),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    // pointercancel (system gesture, lock, stylus lift) also ends the drag, so
    // the listeners do not accumulate on the handle.
    handle.addEventListener("pointercancel", handleEnd);
  };

  // Drag the bottom-right corner to resize the card (both width and height).
  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    userPlacedRef.current = true;
    const handle = event.currentTarget;
    const card = handle.parentElement as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = card.offsetWidth;
    const startHeight = card.offsetHeight;
    const handleMove = (move: PointerEvent) => {
      // Clamp to the map area so the card cannot be dragged larger than its
      // container (minus the current offset and a margin).
      const bounds = card.parentElement?.getBoundingClientRect();
      const maxWidth = bounds
        ? Math.min(MAX_RESIZE_WIDTH, bounds.width - position.x - EDGE_MARGIN)
        : MAX_RESIZE_WIDTH;
      const maxHeight = bounds
        ? Math.min(MAX_HEIGHT, bounds.height - position.y - EDGE_MARGIN)
        : MAX_HEIGHT;
      setSize({
        width: clamp(
          startWidth + (move.clientX - startX),
          MIN_WIDTH,
          Math.max(MIN_WIDTH, maxWidth),
        ),
        height: clamp(
          startHeight + (move.clientY - startY),
          MIN_HEIGHT,
          Math.max(MIN_HEIGHT, maxHeight),
        ),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };

  return (
    <section
      ref={sectionRef}
      aria-label={panel.title}
      className="pointer-events-auto absolute flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
      style={
        {
          left: position.x,
          top: position.y,
          width,
          ...(size.height != null ? { height: size.height } : {}),
        } as CSSProperties
      }
      onPointerDownCapture={() => focusFloatingPanel(id)}
    >
      <div
        className="flex cursor-move touch-none select-none items-center gap-2 border-b px-2 py-1.5"
        onPointerDown={handleDragStart}
      >
        {panel.icon && isImageSource(panel.icon) ? (
          <img src={panel.icon} alt="" className="h-4 w-4 object-contain" />
        ) : (
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="flex-1 truncate text-sm font-semibold">
          {panel.title}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={t("pluginPanel.close")}
          aria-label={t("pluginPanel.close")}
          onClick={() => closeFloatingPanel(id)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto" />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("pluginPanel.resize")}
        title={t("pluginPanel.resize")}
        onPointerDown={handleResizeStart}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
        style={{
          background:
            "linear-gradient(135deg, transparent 0 50%, var(--border) 50% 60%, transparent 60% 70%, var(--border) 70% 80%, transparent 80%)",
        }}
      />
    </section>
  );
}

/**
 * Overlays plugin-owned floating panels on the map's top-left corner. Each open
 * panel (registered via `app.registerFloatingPanel` and shown with
 * `app.openFloatingPanel`) is a draggable, closeable card stacked in open
 * order. Renders nothing when no floating panel is open. Mounted inside the map
 * area so the cards float over the map without shrinking it.
 *
 * @returns The floating-panel overlay, or null when none are open.
 */
export function FloatingPanels() {
  const { openIds } = useFloatingPanels();
  if (openIds.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {openIds.map((id, index) => (
        <FloatingPanelCard key={id} id={id} initialOffset={index * STAGGER} />
      ))}
    </div>
  );
}
