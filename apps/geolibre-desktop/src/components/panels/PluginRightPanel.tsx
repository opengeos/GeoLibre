import {
  closeRightPanel,
  collapseRightPanel,
  getRightPanel,
  openRightPanel,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { PanelRight, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useRightPanelState } from "../../hooks/useRightPanels";

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

// Shared shell classes mirror the Style panel so a plugin panel docks and
// behaves like a first-class part of the workspace. On phones (max-md) it
// overlays the map as a bottom sheet instead of squeezing it.
const EXPANDED_ASIDE_CLASS =
  "relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--plugin-right-panel-width)] md:border-l md:border-t-0";

const RAIL_ASIDE_CLASS =
  "flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-l md:border-t-0 md:py-2";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isImageSource(icon: string): boolean {
  return /^(https?:|data:|blob:|\/)/.test(icon);
}

/**
 * Renders the active plugin-owned right-sidebar panel beside the Style panel.
 *
 * The panel content is owned by the plugin: the registry's `render(container)`
 * callback is invoked once with an empty element the plugin fills with its own
 * DOM. The container stays mounted across collapse so plugin state persists;
 * the host provides the dock chrome (header, collapse/close buttons, rail, and
 * a resize handle). Renders nothing when no plugin panel is the active
 * right-side workspace.
 *
 * @returns The plugin panel aside, or null when no plugin panel is active.
 */
export function PluginRightPanel() {
  const { t } = useTranslation();
  const { activeId, collapsed } = useRightPanelState();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  const panel = activeId ? getRightPanel(activeId) : undefined;

  // Adopt the panel's preferred width when a different panel becomes active.
  // Keyed on activeId so a user resize survives collapse/expand of the same
  // panel (activeId is unchanged across those toggles).
  useEffect(() => {
    if (!panel) return;
    setWidth(clamp(panel.defaultWidth ?? DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH));
  }, [activeId, panel]);

  // Populate the plugin content container once per active panel. The container
  // persists across collapse (it is only hidden), so render is not re-invoked
  // when the user collapses or expands the rail.
  useEffect(() => {
    const container = contentRef.current;
    if (!activeId || !container) return;
    const current = getRightPanel(activeId);
    if (!current) return;
    let cleanup: void | (() => void);
    try {
      cleanup = current.render(container);
    } catch (error) {
      console.error(`Right panel "${activeId}" render() threw.`, error);
    }
    return () => {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`Right panel "${activeId}" cleanup threw.`, error);
      }
      container.replaceChildren();
    };
  }, [activeId]);

  if (!activeId || !panel) return null;

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (move: PointerEvent) => {
      // Dragging the left edge leftward (smaller clientX) widens the panel.
      setWidth(clamp(startWidth + (startX - move.clientX), MIN_WIDTH, MAX_WIDTH));
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };

  const railIcon =
    panel.icon && isImageSource(panel.icon) ? (
      <img src={panel.icon} alt="" className="h-4 w-4 object-contain" />
    ) : (
      <PanelRight className="h-4 w-4" />
    );

  return (
    <aside
      aria-label={
        collapsed
          ? t("pluginPanel.collapsedLabel", { title: panel.title })
          : panel.title
      }
      style={
        { "--plugin-right-panel-width": `${width}px` } as CSSProperties
      }
      className={collapsed ? RAIL_ASIDE_CLASS : EXPANDED_ASIDE_CLASS}
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("pluginPanel.resize")}
          className="absolute -left-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-l border-transparent hover:border-primary md:block"
          onPointerDown={handleResizeStart}
        />
      ) : null}
      {collapsed ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("pluginPanel.expand")}
            aria-label={t("pluginPanel.expand")}
            onClick={() => openRightPanel(activeId)}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 text-muted-foreground md:mt-3 md:flex-col">
            {railIcon}
            <span className="text-[10px] font-semibold uppercase tracking-wide md:[writing-mode:vertical-rl] md:rotate-180">
              {panel.title}
            </span>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="truncate text-sm font-semibold">{panel.title}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.collapse")}
              aria-label={t("pluginPanel.collapse")}
              onClick={() => collapseRightPanel(activeId)}
            >
              <PanelRightClose className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.close")}
              aria-label={t("pluginPanel.close")}
              onClick={() => closeRightPanel(activeId)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      <div
        ref={contentRef}
        className={collapsed ? "hidden" : "min-h-0 flex-1 overflow-auto"}
      />
    </aside>
  );
}
