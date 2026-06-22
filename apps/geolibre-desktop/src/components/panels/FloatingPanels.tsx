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
  const panel = getFloatingPanel(id);
  const [position, setPosition] = useState(() => ({
    x: EDGE_MARGIN + initialOffset,
    y: EDGE_MARGIN + initialOffset,
  }));
  const width = clamp(panel?.defaultWidth ?? DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);

  // Populate the plugin content container once per card. The container persists
  // while the card is open, so render is not re-invoked on drag/focus.
  // Keyed on the panel object too, so re-registering the same id (a new render
  // function) while the card is open refreshes its content.
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
  }, [id, panel]);

  if (!panel) return null;

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Ignore drags that start on the close button.
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
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

  return (
    <section
      aria-label={panel.title}
      className="pointer-events-auto absolute flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border bg-card shadow-xl"
      style={
        {
          left: position.x,
          top: position.y,
          width,
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
