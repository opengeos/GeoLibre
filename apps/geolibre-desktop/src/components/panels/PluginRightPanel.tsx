import {
  closeRightPanel,
  collapseRightPanel,
  getRightPanel,
  moveActiveRightPanelDock,
  openRightPanel,
  type RightPanelDock,
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

/** Clamp a plugin-panel width to the allowed range. Shared with the shell. */
export function clampPluginPanelWidth(width: number): number {
  return clamp(width, MIN_WIDTH, MAX_WIDTH);
}

interface PluginRightPanelProps {
  /** Which dock position this instance renders. */
  dock: RightPanelDock;
  /**
   * The active panel's content host element, created and rendered into once by
   * the shell. The matched slot adopts it via `appendChild`, so moving the panel
   * between docks relocates the same DOM (preserving the plugin's state) instead
   * of tearing it down and re-rendering.
   */
  contentEl: HTMLElement;
  /**
   * The active panel's width in px. Owned by the shell and shared between the
   * dock-slot instances so a user's resize survives moving the panel between
   * positions. Lifting it to the shell (rather than a module-level global) keeps
   * it per-app-instance, which matters for the multi-instance Jupyter embed.
   */
  width: number;
  /** Update the shared panel width (clamped by this component). */
  onWidthChange: (width: number) => void;
}

/**
 * Renders the active plugin-owned dockable panel when it is docked at this
 * instance's `dock` position.
 *
 * One instance is mounted per dock position (`left-of-layers`, `right-of-layers`,
 * `left-of-style`, `right-of-style`); each renders only when the active panel is
 * docked there, so a user can step the panel between positions with the header's
 * move buttons (issue #712). The built-in panel on the docked side (Layers or
 * Style) collapses while the plugin panel is expanded next to it (the shell
 * handles that). The panel content is owned by the plugin via `render(container)`
 * (plain DOM); the host provides the dock chrome (header, collapse rail, resize
 * handle, move/collapse/close buttons). Renders nothing when no plugin panel is
 * docked here.
 *
 * @param props.dock - The dock position this instance renders.
 * @returns The plugin panel aside, or null when no panel is docked here.
 */
export function PluginRightPanel({
  dock,
  contentEl,
  width,
  onWidthChange,
}: PluginRightPanelProps) {
  const { t } = useTranslation();
  const { activeId, collapsed, dock: activeDock } = useRightPanelState();
  const contentRef = useRef<HTMLDivElement | null>(null);

  const panel = activeId ? getRightPanel(activeId) : undefined;
  const matched = activeId !== null && panel != null && activeDock === dock;
  // Layers-side docks sit to the left: their border and resize handle face right
  // (toward the map). Style-side docks face left (toward the map).
  const isLayersSide =
    dock === "left-of-layers" || dock === "right-of-layers";

  // Adopt the shared content host (rendered once by the shell) into this slot
  // while it owns the panel. appendChild moves the element, so stepping the
  // panel between docks relocates the same DOM and preserves the plugin's state
  // rather than re-rendering it.
  useEffect(() => {
    if (!matched) return;
    const wrapper = contentRef.current;
    if (!wrapper) return;
    wrapper.appendChild(contentEl);
  }, [matched, contentEl]);

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
      // The resizable edge faces away from the dock side: dragging it widens the
      // panel.
      const delta = isLayersSide ? move.clientX - startX : startX - move.clientX;
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
    ) : isLayersSide ? (
      <PanelLeft className="h-4 w-4" />
    ) : (
      <PanelRight className="h-4 w-4" />
    );

  const borderSide = isLayersSide ? "md:border-r" : "md:border-l";
  const canMoveLeft = activeDock !== "left-of-layers";
  const canMoveRight = activeDock !== "right-of-style";

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
          className={`absolute ${isLayersSide ? "-right-1 border-r" : "-left-1 border-l"} top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none select-none border-transparent hover:border-primary md:block`}
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
            {isLayersSide ? (
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
              title={t("pluginPanel.moveLeft")}
              aria-label={t("pluginPanel.moveLeft")}
              disabled={!canMoveLeft}
              onClick={() => moveActiveRightPanelDock("left")}
            >
              <ArrowLeftToLine className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.moveRight")}
              aria-label={t("pluginPanel.moveRight")}
              disabled={!canMoveRight}
              onClick={() => moveActiveRightPanelDock("right")}
            >
              <ArrowRightToLine className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("pluginPanel.collapse")}
              aria-label={t("pluginPanel.collapse")}
              onClick={() => collapseRightPanel(activeId)}
            >
              {isLayersSide ? (
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
