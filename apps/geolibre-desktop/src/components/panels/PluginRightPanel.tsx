import {
  closeRightPanel,
  collapseRightPanel,
  getRightPanel,
  openRightPanel,
  setActiveRightPanelSide,
  type RightPanelSide,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { useRightPanelState } from "../../hooks/useRightPanels";
import { clamp } from "../../lib/clamp";
import { isImageSource } from "../../lib/icon-source";

export const PLUGIN_PANEL_DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 640;

interface PluginRightPanelProps {
  /** Which workspace edge this instance occupies. */
  slot: RightPanelSide;
  /**
   * The active panel's width in px. Owned by the shell and shared between the
   * left and right slot instances so a user's resize survives moving the panel
   * between edges. Lifting it to the shell (rather than a module-level global)
   * keeps it per-app-instance, which matters for the multi-instance Jupyter
   * embed.
   */
  width: number;
  /** Update the shared panel width (clamped by this component). */
  onWidthChange: (width: number) => void;
}

/**
 * Renders the active plugin-owned dockable panel on the workspace edge given by
 * `slot`, beside the Style panel (right) or the Layers panel (left).
 *
 * Two instances are mounted (one per edge); each renders only when the active
 * panel's side matches its `slot`, so a user can move the panel between edges
 * with the header's move button (issue #712). The panel content is owned by the
 * plugin via `render(container)` (plain DOM); the host provides the dock chrome
 * (header, collapse rail, resize handle, move/close buttons). Renders nothing
 * when no plugin panel is docked on this edge.
 *
 * @param props.slot - The workspace edge ("left" or "right") this instance owns.
 * @returns The plugin panel aside, or null when no panel is docked on this edge.
 */
export function PluginRightPanel({
  slot,
  width,
  onWidthChange,
}: PluginRightPanelProps) {
  const { t } = useTranslation();
  const { activeId, collapsed, side } = useRightPanelState();
  const contentRef = useRef<HTMLDivElement | null>(null);

  const panel = activeId ? getRightPanel(activeId) : undefined;
  const matched = activeId !== null && panel != null && side === slot;
  const isLeft = slot === "left";

  // Adopt the panel's preferred width when a different panel becomes active.
  // Keyed on activeId only so a user resize survives collapse/expand and any
  // re-registration of the same panel; the width is read fresh from the
  // registry rather than depending on the panel object's identity. Both slot
  // instances run this with the same value, and the shared (shell-owned) width
  // means a resize survives moving between edges.
  useEffect(() => {
    if (!activeId) return;
    const current = getRightPanel(activeId);
    if (!current) return;
    onWidthChange(
      clamp(current.defaultWidth ?? PLUGIN_PANEL_DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH),
    );
  }, [activeId, onWidthChange]);

  // Populate the plugin content container while this instance owns the panel.
  // Keyed on `matched` so moving the panel between edges tears down the old
  // edge's container and renders into the new one, and on the `panel` object so
  // re-registering the same id (a new render function) refreshes the content.
  // (The width effect above is deliberately not keyed on `panel`, so a user
  // resize survives re-registration.)
  useEffect(() => {
    if (!matched) return;
    const container = contentRef.current;
    if (!activeId || !panel || !container) return;
    let cleanup: void | (() => void);
    try {
      cleanup = panel.render(container);
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
  }, [activeId, matched, panel]);

  if (!matched || !panel) return null;

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Attach the move/end listeners to the handle element (not window) so they
    // are discarded with it if the panel unmounts mid-drag, and capture the
    // pointer so a drag past the viewport edge keeps tracking. pointercancel is
    // handled alongside pointerup so an interrupted drag still cleans up.
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (move: PointerEvent) => {
      // The resizable edge faces the map: dragging it away from the dock side
      // widens the panel.
      const delta = isLeft ? move.clientX - startX : startX - move.clientX;
      onWidthChange(clamp(startWidth + delta, MIN_WIDTH, MAX_WIDTH));
    };
    const handleEnd = () => {
      if (el.hasPointerCapture(event.pointerId)) {
        el.releasePointerCapture(event.pointerId);
      }
      el.removeEventListener("pointermove", handleMove);
      el.removeEventListener("pointerup", handleEnd);
      el.removeEventListener("pointercancel", handleEnd);
    };
    el.addEventListener("pointermove", handleMove);
    el.addEventListener("pointerup", handleEnd);
    el.addEventListener("pointercancel", handleEnd);
  };

  const railIcon =
    panel.icon && isImageSource(panel.icon) ? (
      <img src={panel.icon} alt="" className="h-4 w-4 object-contain" />
    ) : isLeft ? (
      <PanelLeft className="h-4 w-4" />
    ) : (
      <PanelRight className="h-4 w-4" />
    );

  const borderSide = isLeft ? "md:border-r" : "md:border-l";

  return (
    <aside
      aria-label={
        collapsed
          ? t("pluginPanel.collapsedLabel", { title: panel.title })
          : panel.title
      }
      style={{ "--plugin-right-panel-width": `${width}px` } as CSSProperties}
      className={
        collapsed
          ? `flex h-11 w-full shrink-0 items-center gap-2 border-t bg-card px-2 md:h-auto md:w-11 md:flex-col md:border-t-0 md:py-2 ${borderSide}`
          : `relative flex max-h-[min(24rem,42vh)] supports-[max-height:1dvh]:max-h-[min(24rem,42dvh)] w-full shrink-0 flex-col border-t bg-card max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:shadow-xl md:max-h-none md:w-[var(--plugin-right-panel-width)] md:border-t-0 ${borderSide}`
      }
    >
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("pluginPanel.resize")}
          className={`absolute ${isLeft ? "-right-1 border-r" : "-left-1 border-l"} top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-transparent hover:border-primary md:block`}
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
            {isLeft ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
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
              title={isLeft ? t("pluginPanel.moveRight") : t("pluginPanel.moveLeft")}
              aria-label={
                isLeft ? t("pluginPanel.moveRight") : t("pluginPanel.moveLeft")
              }
              onClick={() => setActiveRightPanelSide(isLeft ? "right" : "left")}
            >
              {isLeft ? (
                <ArrowRightToLine className="h-4 w-4" />
              ) : (
                <ArrowLeftToLine className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.collapse")}
              aria-label={t("pluginPanel.collapse")}
              onClick={() => collapseRightPanel(activeId)}
            >
              {isLeft ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelRightClose className="h-4 w-4" />
              )}
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
